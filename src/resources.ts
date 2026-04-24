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

function resourcePaths(manifest: PluginManifest | undefined, entry: MarketplacePluginEntry | undefined, kind: "skills" | "commands"): string[] {
	const fromManifest = arrayify(manifest?.[kind] as string | string[] | undefined);
	if (fromManifest.length > 0) return fromManifest;
	const fromEntry = arrayify(entry?.[kind] as string | string[] | undefined);
	if (fromEntry.length > 0) return fromEntry;
	return [kind];
}

export async function collectResourcesFromPluginRoot(pluginRoot: string, manifest?: PluginManifest, entry?: MarketplacePluginEntry): Promise<{ skillPaths: string[]; promptPaths: string[] }> {
	const skillPaths: string[] = [];
	const promptPaths: string[] = [];
	for (const rel of resourcePaths(manifest, entry, "skills")) {
		const target = await resolveExistingInside(pluginRoot, rel, "plugin skills path");
		if (target) skillPaths.push(...(await collectSkillPathsFromDir(target, pluginRoot)));
	}
	for (const rel of resourcePaths(manifest, entry, "commands")) {
		const target = await resolveExistingInside(pluginRoot, rel, "plugin commands path");
		if (target) promptPaths.push(...(await collectCommandMarkdownFromPath(target)));
	}
	return { skillPaths, promptPaths };
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

async function collectCommandMarkdownFromPath(root: string): Promise<string[]> {
	if (!(await exists(root))) return [];
	const stats = await stat(root);
	if (stats.isFile()) return root.endsWith(".md") ? [root] : [];
	return await readMarkdownFiles(root);
}
