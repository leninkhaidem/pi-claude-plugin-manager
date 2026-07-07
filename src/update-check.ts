import { DEFAULT_UPDATE_CHECK_TTL } from "./constants.js";
import { clearRuntimeCaches } from "./runtime-cache.js";
import { run, gitHead } from "./git.js";
import { commitDeferredInstallCleanup, installPluginFromMarketplaceWithDeferredCleanup, rollbackDeferredInstallCleanup, type DeferredInstallCleanup } from "./installer.js";
import { refreshMarketplaceRecords } from "./marketplace.js";
import { readConfig, readState, writeState } from "./state.js";
import type { InstalledPluginEntry, ManagerConfig, MarketplaceRecord, Scope, State, UpdateCheckResult } from "./types.js";
import { now, pluginKey } from "./utils.js";

/**
 * Lightweight remote HEAD check using `git ls-remote`.
 * Returns the remote HEAD SHA without fetching any objects (~1-2 seconds).
 */
async function getRemoteHeadSha(repoPath: string, ref?: string): Promise<string | undefined> {
	try {
		const targetRef = ref ?? "HEAD";
		const result = await run("git", ["ls-remote", "origin", targetRef], { cwd: repoPath, timeoutMs: 15_000 });
		const line = result.stdout.trim().split("\n")[0];
		return line?.split(/\s+/)[0] || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Get the local HEAD SHA for a marketplace's git repo.
 */
async function getLocalHeadSha(repoPath: string): Promise<string | undefined> {
	return await gitHead(repoPath);
}

/**
 * Check whether the TTL has expired since the last update check.
 */
export function isUpdateCheckDue(state: State, config: ManagerConfig): boolean {
	if ((config.updateCheckEnabled ?? true) === false) return false;
	if ((config.updateCheckOnStartup ?? "auto") === "off") return false;
	if (!state.lastUpdateCheckAt) return true;
	const ttl = config.updateCheckTTL ?? DEFAULT_UPDATE_CHECK_TTL;
	const lastCheck = new Date(state.lastUpdateCheckAt).getTime();
	return Date.now() - lastCheck >= ttl;
}

type MarketplaceUpdateInfo = {
	record: MarketplaceRecord;
	localSha?: string;
	remoteSha?: string;
	hasRemoteChanges: boolean;
};

/**
 * Lightweight check: compare local vs remote HEAD for each git marketplace.
 * Only runs `git ls-remote` — no fetch, no clone.
 */
async function checkMarketplaceHeads(state: State): Promise<MarketplaceUpdateInfo[]> {
	const results: MarketplaceUpdateInfo[] = [];
	for (const record of Object.values(state.marketplaces)) {
		if (record.source.kind !== "git") continue;
		const localSha = await getLocalHeadSha(record.path);
		const remoteSha = await getRemoteHeadSha(record.path, record.source.ref);
		results.push({
			record,
			localSha,
			remoteSha,
			hasRemoteChanges: !!remoteSha && !!localSha && remoteSha !== localSha,
		});
	}
	return results;
}

/**
 * For marketplaces with remote changes, fetch the new marketplace.json
 * and compare plugin versions against installed plugins.
 * This does a `git fetch` + temp read, but does NOT reinstall anything.
 */
async function comparePluginVersions(
	state: State,
	changedMarketplaces: MarketplaceUpdateInfo[],
): Promise<Record<string, UpdateCheckResult>> {
	const updates: Record<string, UpdateCheckResult> = {};

	for (const info of changedMarketplaces) {
		if (!info.hasRemoteChanges) continue;

		try {
			// Fetch latest from remote (lightweight, just updates refs)
			if (info.record.source.ref) {
				await run("git", ["fetch", "--depth", "1", "origin", info.record.source.ref], { cwd: info.record.path, timeoutMs: 30_000 });
			} else {
				await run("git", ["fetch", "--depth", "1", "origin"], { cwd: info.record.path, timeoutMs: 30_000 });
			}

			// Read marketplace.json from FETCH_HEAD without checking out
			let remoteMarketplaceJson: string;
			try {
				const result = await run("git", ["show", "FETCH_HEAD:.claude-plugin/marketplace.json"], { cwd: info.record.path, timeoutMs: 10_000 });
				remoteMarketplaceJson = result.stdout;
			} catch {
				// Marketplace structure might differ; skip
				continue;
			}

			const remoteMarketplace = JSON.parse(remoteMarketplaceJson) as { plugins?: Array<{ name: string; version?: string }> };
			if (!remoteMarketplace.plugins) continue;

			// Compare each installed plugin from this marketplace
			for (const remotePlugin of remoteMarketplace.plugins) {
				const key = pluginKey(remotePlugin.name, info.record.name);
				const installedEntries = state.plugins[key];
				if (!installedEntries || installedEntries.length === 0) continue;

				// Skip dev-linked plugins — they're always "latest"
				if (installedEntries.every((e) => e.dev)) continue;

				const installed = installedEntries.find((e) => !e.dev) ?? installedEntries[0]!;
				const remoteVersion = remotePlugin.version ?? info.remoteSha?.slice(0, 12) ?? "unknown";
				const installedVersion = installed.version;

				if (remoteVersion !== installedVersion) {
					updates[key] = {
						installedVersion,
						availableVersion: remoteVersion,
						marketplace: info.record.name,
						plugin: remotePlugin.name,
					};
				}
			}
		} catch {
			// Skip marketplaces that fail to fetch
		}
	}

	return updates;
}

/**
 * Run the full update check: compare marketplace HEADs, then compare plugin versions.
 * Saves results to state.
 */
export async function runUpdateCheck(state: State, force = false): Promise<Record<string, UpdateCheckResult>> {
	const config = await readConfig();
	if (!force && !isUpdateCheckDue(state, config)) {
		return state.lastUpdateCheckResults ?? {};
	}

	const marketplaceHeads = await checkMarketplaceHeads(state);
	const changedMarketplaces = marketplaceHeads.filter((m) => m.hasRemoteChanges);

	let results: Record<string, UpdateCheckResult>;
	if (changedMarketplaces.length > 0) {
		results = await comparePluginVersions(state, changedMarketplaces);
	} else {
		results = {};
	}

	const checkedAt = now();
	state.lastUpdateCheckAt = checkedAt;
	state.lastUpdateCheckResults = results;

	const latestState = await readState();
	latestState.lastUpdateCheckAt = checkedAt;
	latestState.lastUpdateCheckResults = results;
	await writeState(latestState);

	return results;
}

export type TargetedUpdateInstallSuccess = {
	key: string;
	oldKey: string;
	newKey: string;
	marketplace: string;
	plugin: string;
	scope: Scope;
	projectPath?: string;
	previousVersion: string;
	currentVersion: string;
	installPath: string;
};

export type TargetedUpdateInstallFailure = {
	key: string;
	oldKey: string;
	newKey?: string;
	marketplace: string;
	plugin: string;
	scope?: Scope;
	projectPath?: string;
	reason: string;
};

export type TargetedUpdateInstallSkipped = {
	key: string;
	marketplace: string;
	plugin: string;
	scope?: Scope;
	projectPath?: string;
	reason: "dev" | "not-installed";
};

export type TargetedUpdateInstallResult = {
	detectedKeys: string[];
	refreshedMarketplaces: string[];
	marketplaceRenames: Record<string, string>;
	successes: TargetedUpdateInstallSuccess[];
	failures: TargetedUpdateInstallFailure[];
	skipped: TargetedUpdateInstallSkipped[];
	attemptedEntries: number;
	successfulEntries: number;
	failedEntries: number;
	skippedDevEntries: number;
	pendingResults: Record<string, UpdateCheckResult>;
	cacheCleared: boolean;
	reloadRecommended: boolean;
	stateUpdated: boolean;
};

type SuccessfulStateApplication = {
	success: TargetedUpdateInstallSuccess;
	originalEntry: InstalledPluginEntry;
	installedEntry: InstalledPluginEntry;
	cleanup: DeferredInstallCleanup;
};

function cloneState(state: State): State {
	return JSON.parse(JSON.stringify(state)) as State;
}

function entryIdentity(entry: { scope: Scope; projectPath?: string }): string {
	return `${entry.scope}\u0000${entry.projectPath ?? ""}`;
}

function sameEntryIdentity(a: { scope: Scope; projectPath?: string }, b: { scope: Scope; projectPath?: string }): boolean {
	return entryIdentity(a) === entryIdentity(b);
}

function entryMatchesSnapshot(candidate: InstalledPluginEntry | undefined, snapshot: InstalledPluginEntry): boolean {
	return !!candidate &&
		candidate.scope === snapshot.scope &&
		(candidate.projectPath ?? "") === (snapshot.projectPath ?? "") &&
		candidate.marketplace === snapshot.marketplace &&
		candidate.plugin === snapshot.plugin &&
		candidate.version === snapshot.version &&
		candidate.installPath === snapshot.installPath &&
		(candidate.dev ?? false) === (snapshot.dev ?? false);
}

function collectDetectedEntries(state: State, oldKey: string, newKey: string): InstalledPluginEntry[] {
	const entries: InstalledPluginEntry[] = [];
	const seen = new Set<string>();
	for (const key of [...new Set([oldKey, newKey])]) {
		for (const entry of state.plugins[key] ?? []) {
			const identity = `${key}\u0000${entryIdentity(entry)}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			entries.push({ ...entry });
		}
	}
	return entries;
}

function removeRenamedOriginalEntry(state: State, oldKey: string, newKey: string, originalEntry: InstalledPluginEntry): void {
	if (oldKey === newKey) return;
	if (Object.prototype.hasOwnProperty.call(state.enabledPlugins, oldKey)) {
		state.enabledPlugins[newKey] = state.enabledPlugins[oldKey]!;
	}
	const remaining = (state.plugins[oldKey] ?? []).filter((candidate) => !sameEntryIdentity(candidate, originalEntry));
	if (remaining.length > 0) state.plugins[oldKey] = remaining;
	else {
		delete state.plugins[oldKey];
		delete state.enabledPlugins[oldKey];
	}
}

function replaceEntry(entries: InstalledPluginEntry[], installedEntry: InstalledPluginEntry): InstalledPluginEntry[] {
	const withoutCurrent = entries.filter((entry) => !sameEntryIdentity(entry, installedEntry));
	return [...withoutCurrent, installedEntry];
}

function addFailureOnce(failures: TargetedUpdateInstallFailure[], failure: TargetedUpdateInstallFailure): void {
	const exists = failures.some((candidate) =>
		candidate.key === failure.key &&
		candidate.scope === failure.scope &&
		(candidate.projectPath ?? "") === (failure.projectPath ?? "") &&
		candidate.reason === failure.reason,
	);
	if (!exists) failures.push(failure);
}

function sameUpdateResult(a: UpdateCheckResult | undefined, b: UpdateCheckResult | undefined): boolean {
	return !!a && !!b &&
		a.installedVersion === b.installedVersion &&
		a.availableVersion === b.availableVersion &&
		a.marketplace === b.marketplace &&
		a.plugin === b.plugin;
}

function renameUpdateCheckResult(key: string, result: UpdateCheckResult, renamedMarketplaces: Map<string, string>): { key: string; result: UpdateCheckResult } {
	const marketplace = renamedMarketplaces.get(result.marketplace) ?? result.marketplace;
	if (marketplace === result.marketplace) return { key, result };
	return {
		key: pluginKey(result.plugin, marketplace),
		result: { ...result, marketplace },
	};
}

function migratePendingUpdateResults(
	pendingResults: Record<string, UpdateCheckResult>,
	renamedMarketplaces: Map<string, string>,
): Record<string, UpdateCheckResult> {
	const migrated: Record<string, UpdateCheckResult> = {};
	for (const [key, result] of Object.entries(pendingResults)) {
		const renamed = renameUpdateCheckResult(key, result, renamedMarketplaces);
		migrated[renamed.key] = renamed.result;
	}
	return migrated;
}

function computePendingResults(
	latestState: State,
	detectedUpdates: Record<string, UpdateCheckResult>,
	failedKeys: Set<string>,
	renamedMarketplaces: Map<string, string>,
): Record<string, UpdateCheckResult> {
	const pending = migratePendingUpdateResults(latestState.lastUpdateCheckResults ?? {}, renamedMarketplaces);
	for (const [key, result] of Object.entries(detectedUpdates)) {
		const renamed = renameUpdateCheckResult(key, result, renamedMarketplaces);
		if (failedKeys.has(key)) pending[renamed.key] = renamed.result;
		else if (!pending[renamed.key] || sameUpdateResult(pending[renamed.key], renamed.result)) delete pending[renamed.key];
		if (renamed.key !== key) delete pending[key];
	}
	return pending;
}

function entryIsFromMarketplace(entry: InstalledPluginEntry, marketplace: string): boolean {
	return entry.marketplace === marketplace;
}

function migrateRenamedMarketplacePluginState(state: State, renamedMarketplaces: Map<string, string>): TargetedUpdateInstallFailure[] {
	const conflicts: TargetedUpdateInstallFailure[] = [];
	const migrations: Array<{
		currentKey: string;
		oldKey: string;
		newKey: string;
		oldMarketplace: string;
		entry: InstalledPluginEntry;
		migratedEntry: InstalledPluginEntry;
	}> = [];

	for (const [oldMarketplace, newMarketplace] of renamedMarketplaces) {
		if (oldMarketplace === newMarketplace) continue;
		for (const [currentKey, entries] of Object.entries(state.plugins)) {
			for (const entry of entries) {
				if (!entryIsFromMarketplace(entry, oldMarketplace)) continue;
				const oldKey = pluginKey(entry.plugin, oldMarketplace);
				const newKey = pluginKey(entry.plugin, newMarketplace);
				const migratedEntry: InstalledPluginEntry = { ...entry, marketplace: newMarketplace };
				const existingTarget = (state.plugins[newKey] ?? []).find((candidate) => sameEntryIdentity(candidate, migratedEntry));
				if (existingTarget) {
					conflicts.push({
						key: oldKey,
						oldKey,
						newKey,
						marketplace: oldMarketplace,
						plugin: entry.plugin,
						scope: entry.scope,
						projectPath: entry.projectPath,
						reason: `Marketplace rename conflict: ${oldKey} cannot be migrated to ${newKey} because the target entry already exists`,
					});
					continue;
				}
				migrations.push({ currentKey, oldKey, newKey, oldMarketplace, entry, migratedEntry });
			}
		}
	}

	if (conflicts.length > 0) return conflicts;

	for (const migration of migrations) {
		const hadOldEnabledState = Object.prototype.hasOwnProperty.call(state.enabledPlugins, migration.oldKey);
		const oldEnabledState = state.enabledPlugins[migration.oldKey];
		const currentEntries = state.plugins[migration.currentKey] ?? [];
		const remaining = currentEntries.filter((candidate) =>
			!(sameEntryIdentity(candidate, migration.entry) && candidate.plugin === migration.entry.plugin && candidate.marketplace === migration.oldMarketplace),
		);
		if (remaining.length > 0) state.plugins[migration.currentKey] = remaining;
		else {
			delete state.plugins[migration.currentKey];
			delete state.enabledPlugins[migration.currentKey];
		}

		if (hadOldEnabledState && !Object.prototype.hasOwnProperty.call(state.enabledPlugins, migration.newKey)) {
			state.enabledPlugins[migration.newKey] = oldEnabledState!;
		}
		state.plugins[migration.newKey] = replaceEntry(state.plugins[migration.newKey] ?? [], migration.migratedEntry);
	}

	for (const migration of migrations) {
		if (!state.plugins[migration.oldKey] || state.plugins[migration.oldKey].length === 0) {
			delete state.plugins[migration.oldKey];
			delete state.enabledPlugins[migration.oldKey];
		}
	}

	return [];
}

function mergeSuccessfulApplications(
	baseState: State,
	latestState: State,
	workingState: State,
	applications: SuccessfulStateApplication[],
	renamedMarketplaces: Map<string, string>,
): { merged: State; conflicts: TargetedUpdateInstallFailure[] } {
	const merged = cloneState(latestState);
	const conflicts: TargetedUpdateInstallFailure[] = [];

	for (const [oldName, newName] of renamedMarketplaces) {
		const refreshed = workingState.marketplaces[newName];
		if (!refreshed) continue;
		const latestOld = latestState.marketplaces[oldName];
		const latestNew = latestState.marketplaces[newName];
		if (oldName !== newName && latestNew && !baseState.marketplaces[newName]) {
			conflicts.push({
				key: pluginKey("*", oldName),
				oldKey: pluginKey("*", oldName),
				newKey: pluginKey("*", newName),
				marketplace: oldName,
				plugin: "*",
				reason: `Marketplace rename conflict: refreshed ${oldName} to ${newName}, but ${newName} was added concurrently`,
			});
			continue;
		}
		if (latestOld && baseState.marketplaces[oldName] && latestOld.path !== baseState.marketplaces[oldName].path) {
			conflicts.push({
				key: pluginKey("*", oldName),
				oldKey: pluginKey("*", oldName),
				newKey: pluginKey("*", newName),
				marketplace: oldName,
				plugin: "*",
				reason: `Marketplace conflict: ${oldName} changed while auto-update was installing`,
			});
			continue;
		}
		if (oldName !== newName) delete merged.marketplaces[oldName];
		merged.marketplaces[newName] = refreshed;
	}

	for (const application of applications) {
		const { success, originalEntry, installedEntry } = application;
		const latestOriginal = (latestState.plugins[success.oldKey] ?? []).find((entry) => sameEntryIdentity(entry, originalEntry));
		if (!entryMatchesSnapshot(latestOriginal, originalEntry)) {
			conflicts.push({
				key: success.key,
				oldKey: success.oldKey,
				newKey: success.newKey,
				marketplace: success.marketplace,
				plugin: success.plugin,
				scope: success.scope,
				projectPath: success.projectPath,
				reason: `Installed entry changed or was removed while auto-update was installing: ${success.oldKey} (${success.scope})`,
			});
			continue;
		}

		if (success.oldKey !== success.newKey) {
			const oldEntries = (merged.plugins[success.oldKey] ?? []).filter((entry) => !sameEntryIdentity(entry, originalEntry));
			if (oldEntries.length > 0) merged.plugins[success.oldKey] = oldEntries;
			else {
				delete merged.plugins[success.oldKey];
				delete merged.enabledPlugins[success.oldKey];
			}
			if (Object.prototype.hasOwnProperty.call(latestState.enabledPlugins, success.oldKey) && !Object.prototype.hasOwnProperty.call(merged.enabledPlugins, success.newKey)) {
				merged.enabledPlugins[success.newKey] = latestState.enabledPlugins[success.oldKey]!;
			}
		}

		merged.plugins[success.newKey] = replaceEntry(merged.plugins[success.newKey] ?? [], installedEntry);
		if (!Object.prototype.hasOwnProperty.call(merged.enabledPlugins, success.newKey)) merged.enabledPlugins[success.newKey] = true;
	}

	return { merged, conflicts };
}

/**
 * Install only the plugin keys returned by update detection.
 * The helper refreshes affected marketplaces, skips dev-linked entries per entry,
 * continues after per-entry failures, and writes a targeted merge into fresh state.
 */
type InstallDetectedPluginUpdatesOptions = {
	cwd: string;
	/** @internal deterministic race-injection seam for persistence/conflict regression tests. */
	beforeFreshStateRead?: () => Promise<void> | void;
};

export async function installDetectedPluginUpdates(detectedUpdates: Record<string, UpdateCheckResult>, options: InstallDetectedPluginUpdatesOptions): Promise<TargetedUpdateInstallResult> {
	const detectedKeys = Object.keys(detectedUpdates).sort();
	const baseState = cloneState(await readState());
	let workingState = cloneState(baseState);
	const refreshedMarketplaces: string[] = [];
	const marketplaceRenames = new Map<string, string>();
	const failures: TargetedUpdateInstallFailure[] = [];
	const successes: TargetedUpdateInstallSuccess[] = [];
	const skipped: TargetedUpdateInstallSkipped[] = [];
	const successfulApplications: SuccessfulStateApplication[] = [];
	const failedKeys = new Set<string>();
	let attemptedEntries = 0;
	let skippedDevEntries = 0;

	const keysByMarketplace = new Map<string, string[]>();
	for (const [key, update] of Object.entries(detectedUpdates)) {
		const keys = keysByMarketplace.get(update.marketplace) ?? [];
		keys.push(key);
		keysByMarketplace.set(update.marketplace, keys);
	}

	for (const marketplaceName of [...keysByMarketplace.keys()].sort()) {
		try {
			const renamed = await refreshMarketplaceRecords(workingState, [marketplaceName]);
			const refreshedName = renamed.get(marketplaceName) ?? marketplaceName;
			refreshedMarketplaces.push(refreshedName);
			for (const [oldName, newName] of renamed) marketplaceRenames.set(oldName, newName);
		} catch (error) {
			for (const key of keysByMarketplace.get(marketplaceName) ?? []) {
				const update = detectedUpdates[key]!;
				failedKeys.add(key);
				addFailureOnce(failures, {
					key,
					oldKey: key,
					marketplace: update.marketplace,
					plugin: update.plugin,
					reason: `Failed to refresh marketplace ${marketplaceName}: ${(error as Error).message}`,
				});
			}
		}
	}

	for (const key of detectedKeys) {
		const update = detectedUpdates[key]!;
		if (failedKeys.has(key)) continue;
		const marketplace = marketplaceRenames.get(update.marketplace) ?? update.marketplace;
		const newKey = pluginKey(update.plugin, marketplace);
		const entries = collectDetectedEntries(workingState, key, newKey);
		if (entries.length === 0) {
			skipped.push({ key, marketplace: update.marketplace, plugin: update.plugin, reason: "not-installed" });
			continue;
		}

		for (const entry of entries) {
			if (entry.dev) {
				skippedDevEntries++;
				skipped.push({ key, marketplace: entry.marketplace, plugin: entry.plugin, scope: entry.scope, projectPath: entry.projectPath, reason: "dev" });
				continue;
			}

			attemptedEntries++;
			const beforeAttempt = cloneState(workingState);
			try {
				const { installed, cleanup } = await installPluginFromMarketplaceWithDeferredCleanup(workingState, newKey, entry.scope, entry.projectPath ?? options.cwd);
				removeRenamedOriginalEntry(workingState, key, newKey, entry);
				const success: TargetedUpdateInstallSuccess = {
					key,
					oldKey: key,
					newKey,
					marketplace,
					plugin: update.plugin,
					scope: entry.scope,
					projectPath: entry.projectPath,
					previousVersion: entry.version,
					currentVersion: installed.version,
					installPath: installed.installPath,
				};
				successes.push(success);
				successfulApplications.push({ success, originalEntry: entry, installedEntry: installed, cleanup });
			} catch (error) {
				workingState = beforeAttempt;
				failedKeys.add(key);
				addFailureOnce(failures, {
					key,
					oldKey: key,
					newKey,
					marketplace,
					plugin: update.plugin,
					scope: entry.scope,
					projectPath: entry.projectPath,
					reason: (error as Error).message,
				});
			}
		}
	}

	if (options.beforeFreshStateRead) await options.beforeFreshStateRead();
	const latestState = await readState();
	const { merged, conflicts } = mergeSuccessfulApplications(baseState, latestState, workingState, successfulApplications, marketplaceRenames);
	conflicts.push(...migrateRenamedMarketplacePluginState(merged, marketplaceRenames));
	for (const conflict of conflicts) {
		const conflictKeys = conflict.plugin === "*"
			? Object.entries(detectedUpdates).filter(([, update]) => update.marketplace === conflict.marketplace).map(([detectedKey]) => detectedKey)
			: [conflict.key];
		for (const conflictKey of conflictKeys) {
			const update = detectedUpdates[conflictKey];
			failedKeys.add(conflictKey);
			addFailureOnce(failures, update ? { ...conflict, key: conflictKey, oldKey: conflictKey, plugin: update.plugin } : conflict);
		}
	}

	const pendingResults = computePendingResults(latestState, detectedUpdates, failedKeys, marketplaceRenames);
	merged.lastUpdateCheckAt = latestState.lastUpdateCheckAt;
	if (Object.keys(pendingResults).length > 0) merged.lastUpdateCheckResults = pendingResults;
	else delete merged.lastUpdateCheckResults;

	const stateUpdated = conflicts.length === 0;
	if (stateUpdated) {
		await writeState(merged);
		for (const application of successfulApplications) {
			await commitDeferredInstallCleanup(merged, application.cleanup);
		}
		if (successes.length > 0) clearRuntimeCaches();
	} else {
		for (const application of [...successfulApplications].reverse()) {
			await rollbackDeferredInstallCleanup(latestState, application.cleanup);
		}
	}

	const committedSuccesses = stateUpdated ? successes : [];
	return {
		detectedKeys,
		refreshedMarketplaces,
		marketplaceRenames: Object.fromEntries(marketplaceRenames),
		successes: committedSuccesses,
		failures,
		skipped,
		attemptedEntries,
		successfulEntries: committedSuccesses.length,
		failedEntries: failures.filter((failure) => failure.scope).length,
		skippedDevEntries,
		pendingResults: stateUpdated ? pendingResults : (latestState.lastUpdateCheckResults ?? {}),
		cacheCleared: stateUpdated && successes.length > 0,
		reloadRecommended: committedSuccesses.length > 0,
		stateUpdated,
	};
}

/**
 * Format update check results for display.
 */
export function formatUpdateCheckResults(results: Record<string, UpdateCheckResult>): string {
	const entries = Object.entries(results);
	if (entries.length === 0) return "All plugins are up to date.";

	const lines = ["# Plugin updates available", ""];
	for (const [key, result] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`- ${key}: ${result.installedVersion} → ${result.availableVersion}`);
	}
	lines.push("");
	lines.push("Run `/plugin update` to update all, or `/plugin check-updates` to review.");
	return lines.join("\n");
}
