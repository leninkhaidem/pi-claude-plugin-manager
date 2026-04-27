import { DEFAULT_UPDATE_CHECK_TTL } from "./constants.js";
import { run, gitHead } from "./git.js";
import { loadMarketplace } from "./marketplace.js";
import { readConfig, readState, writeState } from "./state.js";
import type { InstalledPluginEntry, ManagerConfig, MarketplaceRecord, State, UpdateCheckResult } from "./types.js";
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
	if ((config.updateCheckOnStartup ?? "notify") === "off") return false;
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

				const installed = installedEntries[0]!;
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

	state.lastUpdateCheckAt = now();
	state.lastUpdateCheckResults = results;
	await writeState(state);

	return results;
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
