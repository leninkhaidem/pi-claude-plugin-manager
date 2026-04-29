import { realpath } from "node:fs/promises";
import path from "node:path";
import { exists, readOptionalJsonFile } from "./fs-utils.js";
import { type AgentEntry, collectResourcesFromPluginRoot, readPluginManifest } from "./resources.js";
import { discoverSkillsFromSources } from "./skills.js";
import { readConfig, readState, resolveManagerConfig } from "./state.js";
import type { ClaudeInstalledPluginEntry, ClaudeInstalledPluginsFile, ClaudeSettingsFile, InstalledPluginEntry, State } from "./types.js";
import { isSameOrDescendant, normalizePath } from "./utils.js";

const discoveryCache = new Map<string, Promise<{ skillPaths: string[]; promptPaths: string[]; agentEntries: AgentEntry[] }>>();

export function clearDiscoveryCache() {
	discoveryCache.clear();
}

export function installedEntriesForCwd(state: State, cwd: string): Array<{ key: string; entry: InstalledPluginEntry }> {
	const normalizedCwd = normalizePath(cwd);
	const result: Array<{ key: string; entry: InstalledPluginEntry }> = [];
	for (const [key, entries] of Object.entries(state.plugins)) {
		if (state.enabledPlugins[key] === false) continue;
		for (const entry of entries) {
			if (entry.scope === "user") result.push({ key, entry });
			else if (entry.scope === "project" && entry.projectPath && isSameOrDescendant(entry.projectPath, normalizedCwd)) result.push({ key, entry });
		}
	}
	return result;
}

export function piManagedKeysForCwd(state: State, cwd: string): Set<string> {
	const normalizedCwd = normalizePath(cwd);
	const keys = new Set<string>();
	for (const [key, entries] of Object.entries(state.plugins)) {
		if (entries.some((entry) => entry.scope === "user" || (entry.scope === "project" && entry.projectPath && isSameOrDescendant(entry.projectPath, normalizedCwd)))) {
			keys.add(key);
		}
	}
	return keys;
}

export async function claudePluginEntriesForCwd(cwd: string, skipKeys = new Set<string>()): Promise<Array<{ key: string; entry: ClaudeInstalledPluginEntry; installPath: string }>> {
	const config = resolveManagerConfig(await readConfig());
	if (!config.claudeReadOnlyImports) return [];
	const installed = await readOptionalJsonFile<ClaudeInstalledPluginsFile>(config.claudeInstalledPluginsPath);
	if (!installed?.plugins) return [];
	if (!(await exists(config.claudePluginsDir))) return [];

	const claudePluginsRoot = normalizePath(await realpath(config.claudePluginsDir));
	const settings = await readOptionalJsonFile<ClaudeSettingsFile>(config.claudeSettingsPath);
	const enabledStates = settings?.enabledPlugins ?? {};
	const normalizedCwd = normalizePath(cwd);
	const result: Array<{ key: string; entry: ClaudeInstalledPluginEntry; installPath: string }> = [];

	for (const [key, entries] of Object.entries(installed.plugins)) {
		if (skipKeys.has(key)) continue;
		if (enabledStates[key] === false) continue;
		if (!Array.isArray(entries)) continue;

		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || typeof entry.installPath !== "string") continue;
			const inScope =
				entry.scope === "user" ||
				(entry.scope === "project" && typeof entry.projectPath === "string" && isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd)) ||
				(entry.scope !== "user" && entry.scope !== "project");
			if (!inScope) continue;
			if (!(await exists(entry.installPath))) continue;
			const installPath = normalizePath(await realpath(entry.installPath));
			if (!isSameOrDescendant(claudePluginsRoot, installPath)) continue;
			result.push({ key, entry, installPath });
		}
	}

	return result;
}

async function discoverInstalledResources(cwd: string): Promise<{ skillPaths: string[]; promptPaths: string[]; agentEntries: AgentEntry[] }> {
	const state = await readState();
	const piManaged = installedEntriesForCwd(state, cwd);
	const piManagedKeys = piManagedKeysForCwd(state, cwd);
	const skillPaths: string[] = [];
	const promptPaths: string[] = [];
	const agentEntries: AgentEntry[] = [];

	for (const { entry } of piManaged) {
		const resources = await collectResourcesFromPluginRoot(entry.installPath, entry.manifest, entry.marketplaceEntry);
		skillPaths.push(...resources.skillPaths);
		promptPaths.push(...resources.promptPaths);
		agentEntries.push(...resources.agentEntries);
	}

	for (const { installPath } of await claudePluginEntriesForCwd(cwd, piManagedKeys)) {
		const manifest = await readPluginManifest(installPath);
		const resources = await collectResourcesFromPluginRoot(installPath, manifest);
		skillPaths.push(...resources.skillPaths);
		promptPaths.push(...resources.promptPaths);
		agentEntries.push(...resources.agentEntries);
	}

	// Discover skills from custom skill sources
	const config = await readConfig();
	if (config.skillSources && config.skillSources.length > 0) {
		const customSkills = await discoverSkillsFromSources(config.skillSources);
		skillPaths.push(...customSkills);
	}

	// Filter out disabled skills
	const enabledSkillPaths = skillPaths.filter((p) => state.disabledSkills[p] !== true);

	// Deduplicate agent entries by basename (last one wins if conflict)
	const seenAgents = new Set<string>();
	const uniqueAgentEntries = agentEntries.filter(e => {
		const key = path.basename(e.path);
		if (seenAgents.has(key)) return false;
		seenAgents.add(key);
		return true;
	});

	return {
		skillPaths: [...new Set(enabledSkillPaths)].sort((a, b) => a.localeCompare(b)),
		promptPaths: [...new Set(promptPaths)].sort((a, b) => a.localeCompare(b)),
		agentEntries: uniqueAgentEntries,
	};
}

export async function discoverInstalledResourcesCached(cwd: string): Promise<{ skillPaths: string[]; promptPaths: string[]; agentEntries: AgentEntry[] }> {
	const key = normalizePath(cwd);
	let cached = discoveryCache.get(key);
	if (!cached) {
		cached = discoverInstalledResources(cwd);
		discoveryCache.set(key, cached);
	}
	return await cached;
}
