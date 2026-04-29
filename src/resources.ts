import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { exists, readDirectories, readJsonFile, readMarkdownFiles } from "./fs-utils.js";
import type { MarketplacePluginEntry, PluginManifest } from "./types.js";
import { isSameOrDescendant, normalizePath, resolveExistingInside } from "./utils.js";

export function arrayify(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

export async function readPluginManifest(pluginRoot: string): Promise<PluginManifest | undefined> {
	const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
	if (!(await exists(manifestPath))) return undefined;
	return await readJsonFile<PluginManifest>(manifestPath);
}

function resourcePaths(manifest: PluginManifest | undefined, entry: MarketplacePluginEntry | undefined, kind: "skills" | "commands" | "agents"): string[] {
	const fromManifest = arrayify(manifest?.[kind] as string | string[] | undefined);
	if (fromManifest.length > 0) return fromManifest;
	const fromEntry = arrayify(entry?.[kind] as string | string[] | undefined);
	if (fromEntry.length > 0) return fromEntry;
	return [kind];
}

export type AgentEntry = { pluginName: string; path: string };

export async function collectResourcesFromPluginRoot(pluginRoot: string, manifest?: PluginManifest, entry?: MarketplacePluginEntry): Promise<{ skillPaths: string[]; promptPaths: string[]; agentEntries: AgentEntry[] }> {
	const pluginName = manifest?.name ?? entry?.name ?? path.basename(pluginRoot);
	const skillPaths: string[] = [];
	const promptPaths: string[] = [];
	const agentEntries: AgentEntry[] = [];
	for (const rel of resourcePaths(manifest, entry, "skills")) {
		const target = await resolveExistingInside(pluginRoot, rel, "plugin skills path");
		if (target) skillPaths.push(...(await collectSkillPathsFromDir(target, pluginRoot)));
	}
	for (const rel of resourcePaths(manifest, entry, "commands")) {
		const target = await resolveExistingInside(pluginRoot, rel, "plugin commands path");
		if (target) promptPaths.push(...(await collectMarkdownFromPath(target)));
	}
	for (const rel of resourcePaths(manifest, entry, "agents")) {
		const target = await resolveExistingInside(pluginRoot, rel, "plugin agents path");
		if (target) {
			const paths = await collectMarkdownFromPath(target);
			agentEntries.push(...paths.map(p => ({ pluginName, path: p })));
		}
	}
	return { skillPaths, promptPaths, agentEntries };
}

async function collectSkillPathsFromDir(dir: string, pluginRoot: string): Promise<string[]> {
	const pluginRootReal = normalizePath(await realpath(pluginRoot));
	const skillFile = path.join(dir, "SKILL.md");
	if (await exists(skillFile)) {
		const skillFileReal = normalizePath(await realpath(skillFile));
		if (!isSameOrDescendant(pluginRootReal, skillFileReal)) {
			throw new Error(`plugin skill file escapes plugin root: ${skillFile}`);
		}
		return [skillFileReal];
	}
	const result: string[] = [];
	for (const child of await readDirectories(dir)) {
		result.push(...(await collectSkillPathsFromDir(child, pluginRootReal)));
	}
	return result;
}

async function collectMarkdownFromPath(root: string): Promise<string[]> {
	if (!(await exists(root))) return [];
	const stats = await stat(root);
	if (stats.isFile()) return root.endsWith(".md") ? [root] : [];
	return await readMarkdownFiles(root);
}
