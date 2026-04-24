import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitClone, gitHead } from "./git.js";
import { findMarketplacePlugin, resolveMarketplacePluginSource } from "./marketplace.js";
import { readPluginManifest } from "./resources.js";
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

export async function installPluginFromMarketplace(state: State, spec: string, scope: Scope, cwd: string): Promise<InstalledPluginEntry> {
	const { key, record, marketplaceFile, entry } = await findMarketplacePlugin(state, spec);
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-plugin-install-"));
	try {
		const checkout = path.join(tmp, "plugin");
		await mkdir(checkout, { recursive: true });
		await rm(checkout, { recursive: true, force: true });
		const copied = await copyPluginSourceFromEntry(record, marketplaceFile, entry, checkout);
		const manifest = await readPluginManifest(checkout);
		const version = manifest?.version ?? entry.version ?? copied.gitCommitSha?.slice(0, 12) ?? "unknown";
		const installPath = path.join(cacheDir(), safeSegment(record.name), safeSegment(entry.name), safeSegment(version));
		await rm(installPath, { recursive: true, force: true });
		await mkdir(path.dirname(installPath), { recursive: true });
		await cp(checkout, installPath, { recursive: true });
		await rm(path.join(installPath, ".git"), { recursive: true, force: true });

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
		for (const oldEntry of replaced) {
			if (oldEntry.installPath !== installed.installPath && !isInstallPathReferenced(state, oldEntry.installPath)) {
				await rm(oldEntry.installPath, { recursive: true, force: true });
			}
		}
		return installed;
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
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
			await rm(installPath, { recursive: true, force: true });
		}
	}
	return removed;
}
