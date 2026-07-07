import { cp, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitClone, gitHead } from "./git.js";
import { findMarketplacePlugin, resolveMarketplacePluginSource } from "./marketplace.js";
import { readPluginManifest } from "./resources.js";
import { exists } from "./fs-utils.js";
import { cacheDir } from "./state.js";
import type { InstalledPluginEntry, MarketplaceFile, MarketplacePluginEntry, MarketplaceRecord, Scope, State } from "./types.js";
import { isInstallPathReferenced, normalizePath, parsePluginSpec, pluginKey, resolveExistingInside, safeSegment, now } from "./utils.js";

async function copyPluginSourceFromEntry(record: MarketplaceRecord, marketplaceFile: MarketplaceFile, entry: MarketplacePluginEntry, destination: string): Promise<{ sourceRoot: string; gitCommitSha?: string }> {
	const source = entry.source;
	if (typeof source === "string") {
		const sourcePath = await resolveMarketplacePluginSource(record, marketplaceFile, source);
		await cp(sourcePath, destination, { recursive: true });
		return { sourceRoot: sourcePath };
	}

	const sourceKind = source.source;
	if (sourceKind === "github" && source.repo) {
		if (source.path) {
			const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-plugin-github-"));
			try {
				await gitClone(`https://github.com/${source.repo}.git`, tmp, { ref: source.ref, sha: source.sha, sparsePath: source.path });
				const sourceRoot = await resolveExistingInside(tmp, source.path, "github plugin source.path");
				if (!sourceRoot) throw new Error(`github plugin source.path not found: ${source.path}`);
				await cp(sourceRoot, destination, { recursive: true });
				return { sourceRoot, gitCommitSha: await gitHead(tmp) };
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		}
		await gitClone(`https://github.com/${source.repo}.git`, destination, { ref: source.ref, sha: source.sha });
		return { sourceRoot: destination, gitCommitSha: await gitHead(destination) };
	}

	if (sourceKind === "url" && source.url) {
		if (source.path) {
			const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-plugin-url-"));
			try {
				await gitClone(source.url, tmp, { ref: source.ref, sha: source.sha, sparsePath: source.path });
				const sourceRoot = await resolveExistingInside(tmp, source.path, "url plugin source.path");
				if (!sourceRoot) throw new Error(`url plugin source.path not found: ${source.path}`);
				await cp(sourceRoot, destination, { recursive: true });
				return { sourceRoot, gitCommitSha: await gitHead(tmp) };
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		}
		await gitClone(source.url, destination, { ref: source.ref, sha: source.sha });
		return { sourceRoot: destination, gitCommitSha: await gitHead(destination) };
	}

	if (sourceKind === "git-subdir" && source.url && source.path) {
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-plugin-subdir-"));
		try {
			await gitClone(source.url, tmp, { ref: source.ref, sha: source.sha, sparsePath: source.path });
			const sourceRoot = await resolveExistingInside(tmp, source.path, "git-subdir plugin path");
			if (!sourceRoot) throw new Error(`git-subdir plugin path not found: ${source.path}`);
			await cp(sourceRoot, destination, { recursive: true });
			return { sourceRoot, gitCommitSha: await gitHead(tmp) };
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	if (sourceKind === "npm") {
		throw new Error(`NPM plugin sources are not supported yet for ${entry.name}. Supported sources: relative path, github, url, git-subdir.`);
	}

	throw new Error(`Unsupported plugin source for ${entry.name}: ${JSON.stringify(source)}`);
}

async function resolveDevSourcePath(record: MarketplaceRecord, marketplaceFile: MarketplaceFile, entry: MarketplacePluginEntry): Promise<string> {
	const source = entry.source;
	if (typeof source === "string") {
		return await resolveMarketplacePluginSource(record, marketplaceFile, source);
	}
	// For object sources, only relative/local paths make sense in dev mode
	if (source.path) {
		const resolved = await resolveExistingInside(record.path, source.path, "dev plugin source.path");
		if (resolved) return resolved;
	}
	throw new Error(`Cannot resolve dev source path for ${entry.name}. Only local/relative plugin sources support --dev mode.`);
}

async function isSymlink(p: string): Promise<boolean> {
	try {
		const stats = await lstat(p);
		return stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Safely remove an install path — uses filesystem state (not the dev flag) to decide strategy. */
async function removeInstallPath(installPath: string): Promise<void> {
	if (await isSymlink(installPath)) {
		await rm(installPath, { force: true });
	} else {
		await rm(installPath, { recursive: true, force: true });
	}
}

/** Clean up replaced entries that are no longer referenced by any other install. */
async function cleanUpReplacedEntries(state: State, replaced: InstalledPluginEntry[], newInstallPath: string): Promise<void> {
	for (const oldEntry of replaced) {
		if (oldEntry.installPath !== newInstallPath && !isInstallPathReferenced(state, oldEntry.installPath)) {
			await removeInstallPath(oldEntry.installPath);
		}
	}
}

export type DeferredInstallCleanup = {
	installed: InstalledPluginEntry;
	replaced: InstalledPluginEntry[];
	/** Backup of an overwritten same-version install path; retained until state commit or rollback. */
	backupPath?: string;
};

type InstallPluginFromMarketplaceOptions = { dev?: boolean; deferCleanup?: boolean };

type InstallPluginFromMarketplaceResult = {
	installed: InstalledPluginEntry;
	deferredCleanup?: DeferredInstallCleanup;
};

export async function commitDeferredInstallCleanup(state: State, cleanup: DeferredInstallCleanup): Promise<void> {
	await cleanUpReplacedEntries(state, cleanup.replaced, cleanup.installed.installPath);
	if (cleanup.backupPath) await rm(cleanup.backupPath, { recursive: true, force: true });
}

export async function rollbackDeferredInstallCleanup(state: State, cleanup: DeferredInstallCleanup): Promise<void> {
	const installPath = cleanup.installed.installPath;
	if (cleanup.backupPath) {
		await removeInstallPath(installPath);
		if (isInstallPathReferenced(state, installPath)) {
			await mkdir(path.dirname(installPath), { recursive: true });
			await rename(cleanup.backupPath, installPath);
		} else {
			await rm(cleanup.backupPath, { recursive: true, force: true });
		}
		return;
	}

	if (!isInstallPathReferenced(state, installPath)) {
		await removeInstallPath(installPath);
	}
}

async function installPluginFromMarketplaceInternal(state: State, spec: string, scope: Scope, cwd: string, options?: InstallPluginFromMarketplaceOptions): Promise<InstallPluginFromMarketplaceResult> {
	const { key, record, marketplaceFile, entry } = await findMarketplacePlugin(state, spec);
	// Auto-detect: local marketplaces always use symlink (dev) mode unless explicitly overridden
	const dev = options?.dev ?? (record.source.kind === "local");

	if (dev) {
		if (options?.deferCleanup) throw new Error("Deferred cleanup is not supported for dev-mode installs.");
		if (record.source.kind !== "local") {
			throw new Error(`--dev mode requires a local marketplace. ${record.name} is a ${record.source.kind} marketplace. Add it as a local path first.`);
		}
		const devSourcePath = await resolveDevSourcePath(record, marketplaceFile, entry);
		const manifest = await readPluginManifest(devSourcePath);
		const installPath = path.join(cacheDir(), safeSegment(record.name), safeSegment(entry.name), "__dev__");

		// Remove existing entry (symlink or directory)
		await removeInstallPath(installPath);
		await mkdir(path.dirname(installPath), { recursive: true });
		await symlink(devSourcePath, installPath);

		const installed: InstalledPluginEntry = {
			scope,
			projectPath: scope === "project" ? normalizePath(cwd) : undefined,
			marketplace: record.name,
			plugin: entry.name,
			version: "dev",
			installPath,
			source: entry.source,
			description: manifest?.description ?? entry.description,
			installedAt: now(),
			updatedAt: now(),
			manifest,
			marketplaceEntry: entry,
			dev: true,
			devSourcePath: normalizePath(devSourcePath),
		};

		const current = state.plugins[key] ?? [];
		const replaced = current.filter((existing) => existing.scope === scope && existing.projectPath === installed.projectPath);
		const hadEnabledState = Object.prototype.hasOwnProperty.call(state.enabledPlugins, key);
		state.plugins[key] = [...current.filter((existing) => existing.scope !== scope || existing.projectPath !== installed.projectPath), installed];
		if (!hadEnabledState) state.enabledPlugins[key] = true;
		await cleanUpReplacedEntries(state, replaced, installed.installPath);
		return { installed };
	}

	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-plugin-install-"));
	let stagingPath: string | undefined;
	let backupPath: string | undefined;
	try {
		const checkout = path.join(tmp, "plugin");
		await mkdir(checkout, { recursive: true });
		await rm(checkout, { recursive: true, force: true });
		const copied = await copyPluginSourceFromEntry(record, marketplaceFile, entry, checkout);
		const manifest = await readPluginManifest(checkout);
		const version = manifest?.version ?? entry.version ?? copied.gitCommitSha?.slice(0, 12) ?? "unknown";
		const installPath = path.join(cacheDir(), safeSegment(record.name), safeSegment(entry.name), safeSegment(version));
		const installDir = path.dirname(installPath);
		const stagingSegment = `.${safeSegment(entry.name)}-${safeSegment(version)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		stagingPath = path.join(installDir, `${stagingSegment}.tmp`);
		backupPath = path.join(installDir, `${stagingSegment}.bak`);
		await mkdir(installDir, { recursive: true });
		await rm(stagingPath, { recursive: true, force: true });
		await rm(backupPath, { recursive: true, force: true });
		await cp(checkout, stagingPath, { recursive: true });
		await rm(path.join(stagingPath, ".git"), { recursive: true, force: true });

		let backupCommitted = false;
		try {
			if (await exists(installPath)) {
				await rename(installPath, backupPath);
				backupCommitted = true;
			}
			await rename(stagingPath, installPath);
			stagingPath = undefined;
		} catch (error) {
			if (backupCommitted && !(await exists(installPath))) {
				try {
					await rename(backupPath, installPath);
					backupCommitted = false;
				} catch (restoreError) {
					throw new Error(`Failed to commit install for ${entry.name}; restore failed: ${(restoreError as Error).message}; original error: ${(error as Error).message}`);
				}
			}
			throw error;
		}

		const installed: InstalledPluginEntry = {
			scope,
			projectPath: scope === "project" ? normalizePath(cwd) : undefined,
			marketplace: record.name,
			plugin: entry.name,
			version,
			installPath,
			source: entry.source,
			description: manifest?.description ?? entry.description,
			installedAt: now(),
			updatedAt: now(),
			gitCommitSha: copied.gitCommitSha,
			manifest,
			marketplaceEntry: entry,
		};

		const current = state.plugins[key] ?? [];
		const replaced = current.filter((existing) => existing.scope === scope && existing.projectPath === installed.projectPath);
		const hadEnabledState = Object.prototype.hasOwnProperty.call(state.enabledPlugins, key);
		state.plugins[key] = [...current.filter((existing) => existing.scope !== scope || existing.projectPath !== installed.projectPath), installed];
		if (!hadEnabledState) state.enabledPlugins[key] = true;
		if (options?.deferCleanup) {
			const deferredCleanup: DeferredInstallCleanup = {
				installed,
				replaced,
				backupPath: backupCommitted ? backupPath : undefined,
			};
			if (backupCommitted) backupPath = undefined;
			return { installed, deferredCleanup };
		}
		await cleanUpReplacedEntries(state, replaced, installed.installPath);
		if (backupCommitted && backupPath) {
			await rm(backupPath, { recursive: true, force: true });
			backupPath = undefined;
		}
		return { installed };
	} finally {
		if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
		if (backupPath) await rm(backupPath, { recursive: true, force: true });
		await rm(tmp, { recursive: true, force: true });
	}
}

export async function installPluginFromMarketplace(state: State, spec: string, scope: Scope, cwd: string, options?: { dev?: boolean }): Promise<InstalledPluginEntry> {
	return (await installPluginFromMarketplaceInternal(state, spec, scope, cwd, options)).installed;
}

export async function installPluginFromMarketplaceWithDeferredCleanup(state: State, spec: string, scope: Scope, cwd: string): Promise<{ installed: InstalledPluginEntry; cleanup: DeferredInstallCleanup }> {
	const result = await installPluginFromMarketplaceInternal(state, spec, scope, cwd, { deferCleanup: true });
	return {
		installed: result.installed,
		cleanup: result.deferredCleanup ?? { installed: result.installed, replaced: [] },
	};
}

export async function uninstallPlugin(state: State, spec: string, scope?: Scope, cwd?: string): Promise<string[]> {
	const parsed = parsePluginSpec(spec);
	const keys = parsed.marketplace ? [pluginKey(parsed.plugin, parsed.marketplace)] : Object.keys(state.plugins).filter((key) => key.startsWith(`${parsed.plugin}@`));
	if (keys.length === 0) throw new Error(`Plugin is not installed: ${spec}`);
	if (!parsed.marketplace && keys.length > 1) throw new Error(`Plugin name is ambiguous. Use plugin@marketplace. Matches: ${keys.join(", ")}`);

	const removed: string[] = [];
	const candidatePathsToRemove = new Set<string>();
	for (const key of keys) {
		const entries = state.plugins[key] ?? [];
		const keep: InstalledPluginEntry[] = [];
		for (const entry of entries) {
			const scopeMatches = !scope || entry.scope === scope;
			const projectMatches = scope !== "project" || !cwd || (entry.projectPath ? entry.projectPath === normalizePath(cwd) || normalizePath(cwd).startsWith(`${entry.projectPath}/`) : false);
			if (scopeMatches && projectMatches) {
				candidatePathsToRemove.add(entry.installPath);
				removed.push(`${entry.plugin}@${entry.marketplace} (${entry.scope})`);
			} else {
				keep.push(entry);
			}
		}
		if (keep.length > 0) state.plugins[key] = keep;
		else {
			delete state.plugins[key];
			delete state.enabledPlugins[key];
		}
	}
	if (removed.length === 0) throw new Error(`No matching installed plugin entries for ${spec}`);
	for (const installPath of candidatePathsToRemove) {
		if (!isInstallPathReferenced(state, installPath)) {
			await removeInstallPath(installPath);
		}
	}
	return removed;
}
