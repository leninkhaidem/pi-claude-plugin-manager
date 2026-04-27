import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists, readDirectories, readEntries } from "./fs-utils.js";
import { normalizePath } from "./utils.js";

export type SkillInfo = {
	name: string;
	description: string;
	path: string;
	source: "plugin" | "claude-readonly" | "custom-source" | "pi-native";
	sourceLabel: string;
	sourceRoot: string;
	enabled: boolean;
};

export type SkillSourceInfo = {
	path: string;
	label: string;
	kind: "pi-path" | "pi-package" | "plugin-marketplace" | "custom-source";
	skillCount: number;
	enabled: boolean;
};

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return {};
	const result: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon > 0) {
			const key = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			result[key] = value;
		}
	}
	return result;
}

export async function readSkillInfo(skillPath: string): Promise<{ name: string; description: string } | undefined> {
	try {
		const content = await readFile(skillPath, "utf8");
		const frontmatter = parseFrontmatter(content);
		const name = frontmatter.name || path.basename(path.dirname(skillPath));
		const description = frontmatter.description || "";
		return { name, description };
	} catch {
		return undefined;
	}
}

async function collectSkillPathsFromSourceDir(dir: string): Promise<string[]> {
	if (!(await exists(dir))) return [];
	const resolvedDir = normalizePath(await realpath(dir));

	const skillFile = path.join(resolvedDir, "SKILL.md");
	if (await exists(skillFile)) {
		return [normalizePath(await realpath(skillFile))];
	}

	const entries = await readEntries(resolvedDir);
	const result: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(resolvedDir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
			result.push(normalizePath(await realpath(fullPath)));
		}
	}

	for (const childDir of await readDirectories(resolvedDir)) {
		const childSkill = path.join(childDir, "SKILL.md");
		if (await exists(childSkill)) {
			result.push(normalizePath(await realpath(childSkill)));
		} else {
			result.push(...(await collectSkillPathsFromSourceDir(childDir)));
		}
	}

	return result;
}

export async function discoverSkillsFromSources(sources: string[]): Promise<string[]> {
	const allPaths: string[] = [];
	for (const source of sources) {
		const resolved = normalizePath(source);
		const paths = await collectSkillPathsFromSourceDir(resolved);
		allPaths.push(...paths);
	}
	return [...new Set(allPaths)].sort((a, b) => a.localeCompare(b));
}

// ── Source root detection ────────────────────────────────────

const PI_KNOWN_ROOTS = [
	normalizePath("~/.pi/agent/skills"),
	normalizePath("~/.agents/skills"),
];

function getPiKnownRoots(cwd: string): string[] {
	const projectRoots = [
		normalizePath(path.join(cwd, ".pi/skills")),
		normalizePath(path.join(cwd, ".agents/skills")),
	];
	return [...PI_KNOWN_ROOTS, ...projectRoots];
}

function findKnownRoot(skillPath: string, knownRoots: string[]): string | undefined {
	for (const root of knownRoots) {
		if (skillPath.startsWith(root + "/") || skillPath === root) return root;
	}
	return undefined;
}

function detectPackageName(skillPath: string): string | undefined {
	// Match .../node_modules/<package-name>/... or .../node_modules/@scope/package/...
	const match = skillPath.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
	return match?.[1];
}

function getPackageRoot(skillPath: string): string | undefined {
	const match = skillPath.match(/(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)/);
	return match?.[1];
}

/**
 * Derive the marketplace name from a plugin skill path.
 * Path structure: .../cache/<marketplace>/<plugin>/<version>/skills/...
 */
function deriveMarketplaceName(skillPath: string): string | undefined {
	const match = skillPath.match(/\/cache\/([^/]+)\/[^/]+\/[^/]+\/skills\//);
	return match?.[1];
}

function deriveMarketplaceRoot(skillPath: string): string | undefined {
	const match = skillPath.match(/(.*\/cache\/[^/]+)\//);
	return match?.[1];
}

function isSourceDisabled(sourceRoot: string, disabledSkillSources: Record<string, boolean>): boolean {
	return disabledSkillSources[sourceRoot] === true;
}

function isSkillEffectivelyDisabled(
	skillPath: string,
	sourceRoot: string,
	disabledSkills: Record<string, boolean>,
	disabledSkillSources: Record<string, boolean>,
): boolean {
	if (disabledSkills[skillPath] === true) return true;
	if (isSourceDisabled(sourceRoot, disabledSkillSources)) return true;
	return false;
}

export async function buildSkillList(
	pi: ExtensionAPI,
	pluginSkillPaths: string[],
	customSourceSkillPaths: string[],
	disabledSkills: Record<string, boolean>,
	disabledSkillSources: Record<string, boolean>,
	cwd?: string,
): Promise<SkillInfo[]> {
	const skills: SkillInfo[] = [];
	const seen = new Set<string>();
	const knownRoots = getPiKnownRoots(cwd || process.cwd());

	// Gather all Pi-native skills from pi.getCommands()
	const commands = pi.getCommands();
	const piNativeSkills = commands.filter((cmd) => cmd.source === "skill");
	const extensionPaths = new Set([...pluginSkillPaths, ...customSourceSkillPaths]);

	// Add Pi-native skills (ones NOT contributed by our extension)
	for (const cmd of piNativeSkills) {
		const skillPath = cmd.sourceInfo.path;
		if (extensionPaths.has(skillPath)) continue;
		if (seen.has(skillPath)) continue;
		seen.add(skillPath);

		// Determine the source root
		const knownRoot = findKnownRoot(skillPath, knownRoots);
		const packageRoot = getPackageRoot(skillPath);
		const packageName = detectPackageName(skillPath);

		let sourceRoot: string;
		let sourceLabel: string;

		if (knownRoot) {
			sourceRoot = knownRoot;
			sourceLabel = shortenHomePath(knownRoot);
		} else if (packageRoot && packageName) {
			sourceRoot = packageRoot;
			sourceLabel = `package: ${packageName}`;
		} else {
			sourceRoot = cmd.sourceInfo.baseDir || path.dirname(skillPath);
			sourceLabel = shortenHomePath(sourceRoot);
		}

		skills.push({
			name: cmd.name.replace(/^skill:/, ""),
			description: cmd.description || "",
			path: skillPath,
			source: "pi-native",
			sourceLabel,
			sourceRoot,
			enabled: !isSkillEffectivelyDisabled(skillPath, sourceRoot, disabledSkills, disabledSkillSources),
		});
	}

	// Add plugin skills — group by marketplace
	for (const skillPath of pluginSkillPaths) {
		if (seen.has(skillPath)) continue;
		seen.add(skillPath);
		const info = await readSkillInfo(skillPath);
		const marketplaceName = deriveMarketplaceName(skillPath);
		const marketplaceRoot = deriveMarketplaceRoot(skillPath);
		const sourceRoot = marketplaceRoot || path.dirname(skillPath);
		const sourceLabel = marketplaceName ? `marketplace: ${marketplaceName}` : shortenHomePath(sourceRoot);

		skills.push({
			name: info?.name || path.basename(path.dirname(skillPath)),
			description: info?.description || "",
			path: skillPath,
			source: "plugin",
			sourceLabel,
			sourceRoot,
			enabled: !isSkillEffectivelyDisabled(skillPath, sourceRoot, disabledSkills, disabledSkillSources),
		});
	}

	// Add custom source skills
	for (const skillPath of customSourceSkillPaths) {
		if (seen.has(skillPath)) continue;
		seen.add(skillPath);
		const info = await readSkillInfo(skillPath);
		// Find which custom source directory this belongs to
		let sourceRoot = path.dirname(skillPath);
		for (const src of customSourceSkillPaths) {
			const srcDir = normalizePath(src);
			if (skillPath.startsWith(srcDir)) {
				sourceRoot = srcDir;
				break;
			}
		}

		skills.push({
			name: info?.name || path.basename(path.dirname(skillPath)),
			description: info?.description || "",
			path: skillPath,
			source: "custom-source",
			sourceLabel: shortenHomePath(sourceRoot),
			sourceRoot,
			enabled: !isSkillEffectivelyDisabled(skillPath, sourceRoot, disabledSkills, disabledSkillSources),
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function shortenHomePath(p: string): string {
	const home = os.homedir();
	if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
	if (p === home) return "~";
	return p;
}

export function buildSourceList(
	skills: SkillInfo[],
	customSources: string[],
	disabledSkillSources: Record<string, boolean>,
	cwd?: string,
): SkillSourceInfo[] {
	const sourceMap = new Map<string, { label: string; kind: SkillSourceInfo["kind"]; count: number }>();

	// Group skills by sourceRoot
	for (const skill of skills) {
		const existing = sourceMap.get(skill.sourceRoot);
		if (existing) {
			existing.count++;
		} else {
			let kind: SkillSourceInfo["kind"];
			if (skill.source === "custom-source") kind = "custom-source";
			else if (skill.source === "plugin") kind = "plugin-marketplace";
			else if (skill.sourceLabel.startsWith("package:")) kind = "pi-package";
			else kind = "pi-path";
			sourceMap.set(skill.sourceRoot, { label: skill.sourceLabel, kind, count: 1 });
		}
	}

	// Add known Pi roots even if they have no skills
	const knownRoots = getPiKnownRoots(cwd || process.cwd());
	for (const root of knownRoots) {
		if (!sourceMap.has(root)) {
			sourceMap.set(root, { label: shortenHomePath(root), kind: "pi-path", count: 0 });
		}
	}

	// Add custom sources that might have 0 skills
	for (const source of customSources) {
		const normalized = normalizePath(source);
		if (!sourceMap.has(normalized)) {
			sourceMap.set(normalized, { label: shortenHomePath(normalized), kind: "custom-source", count: 0 });
		}
	}

	const sources: SkillSourceInfo[] = [];
	for (const [sourcePath, info] of sourceMap) {
		sources.push({
			path: sourcePath,
			label: info.label,
			kind: info.kind,
			skillCount: info.count,
			enabled: !isSourceDisabled(sourcePath, disabledSkillSources),
		});
	}

	return sources.sort((a, b) => {
		const kindOrder = { "pi-path": 0, "pi-package": 1, "plugin-marketplace": 2, "custom-source": 3 };
		const aOrder = kindOrder[a.kind] ?? 4;
		const bOrder = kindOrder[b.kind] ?? 4;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return a.label.localeCompare(b.label);
	});
}

export function formatSkillList(skills: SkillInfo[]): string {
	if (skills.length === 0) {
		return "No skills found. Install plugins with skills or add skill source directories with `/skills sources add <path>`.";
	}

	const lines = ["# All skills", ""];
	const enabledCount = skills.filter((s) => s.enabled).length;
	const disabledCount = skills.length - enabledCount;
	lines.push(`Total: ${skills.length} skill${skills.length === 1 ? "" : "s"} (${enabledCount} enabled, ${disabledCount} disabled)`);
	lines.push("");

	// Group by sourceLabel
	const bySource = new Map<string, SkillInfo[]>();
	for (const skill of skills) {
		const group = bySource.get(skill.sourceLabel) ?? [];
		group.push(skill);
		bySource.set(skill.sourceLabel, group);
	}

	for (const [sourceLabel, sourceSkills] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`## ${sourceLabel} (${sourceSkills.length})`);
		for (const skill of sourceSkills) {
			const status = skill.enabled ? "✓" : "○";
			const desc = skill.description ? ` — ${skill.description}` : "";
			lines.push(`- ${status} ${skill.name}${desc}`);
			lines.push(`  path: ${skill.path}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

export function formatSourceList(sources: SkillSourceInfo[]): string {
	const lines = ["# Skill sources", ""];

	const kindLabels: Record<string, string> = {
		"pi-path": "Pi discovery paths",
		"pi-package": "Pi packages",
		"plugin-marketplace": "Plugin marketplaces",
		"custom-source": "Custom sources",
	};

	const byKind = new Map<string, SkillSourceInfo[]>();
	for (const source of sources) {
		const group = byKind.get(source.kind) ?? [];
		group.push(source);
		byKind.set(source.kind, group);
	}

	const kindOrder = ["pi-path", "pi-package", "plugin-marketplace", "custom-source"];

	for (const kind of kindOrder) {
		const kindSources = byKind.get(kind);
		if (!kindSources || kindSources.length === 0) continue;
		lines.push(`## ${kindLabels[kind] || kind}`);
		for (const source of kindSources) {
			const status = source.enabled ? "✓" : "○";
			const skillInfo = source.skillCount > 0
				? `${source.skillCount} skill${source.skillCount === 1 ? "" : "s"}`
				: "no skills found";
			lines.push(`- ${status} ${source.label} (${skillInfo})`);
		}
		lines.push("");
	}

	// Show note about available actions
	lines.push("Use `/skills sources toggle` to enable/disable a source.");
	lines.push("Use `/skills sources add <path>` to add a custom source.");

	return lines.join("\n");
}

export function formatSkillsHelp(): string {
	return `# /skills — Skill manager

Manage skills from all sources: Pi-native, plugins, and custom directories.
Toggle individual skills or entire source directories on/off.

## Commands
/skills                              # Interactive menu (TUI) or list skills
/skills list                         # List all skills with status
/skills toggle [skill-name]          # Toggle a skill on/off
/skills sources                      # List all skill sources with status
/skills sources toggle [source-path] # Toggle an entire source on/off
/skills sources add <path>           # Add a custom source directory
/skills sources remove [path]        # Remove a custom source directory
/skills help                         # Show this help

## Skill sources
Pi discovers skills from built-in paths:
  ~/.pi/agent/skills/    (global)
  ~/.agents/skills/      (global)
  .pi/skills/            (project)
  .agents/skills/        (project, up to git root)
  Installed packages

This extension also discovers skills from:
  - Claude Code plugin marketplaces
  - Custom source directories (see /skills sources add)

## Toggling skills
Toggle individual skills or entire source directories.
Disabled skills are stripped from the system prompt.

/skills toggle                       # Interactive select in TUI
/skills toggle my-skill              # Toggle by skill name
/skills sources toggle               # Interactive source toggle in TUI

This works for ALL skills — Pi-native, plugin, and custom source.`;
}

/**
 * Filter disabled skills from the system prompt by removing their XML blocks.
 */
export function filterDisabledSkillsFromPrompt(
	systemPrompt: string,
	disabledSkills: Record<string, boolean>,
	disabledSkillSources: Record<string, boolean>,
): string {
	const disabledPaths = new Set(Object.keys(disabledSkills).filter((p) => disabledSkills[p] === true));
	const disabledSourcePrefixes = Object.keys(disabledSkillSources).filter((p) => disabledSkillSources[p] === true);

	if (disabledPaths.size === 0 && disabledSourcePrefixes.length === 0) return systemPrompt;

	return systemPrompt.replace(/<skill>\s*\n([\s\S]*?)<\/skill>/g, (match, inner: string) => {
		const locationMatch = inner.match(/<location>(.*?)<\/location>/);
		if (!locationMatch?.[1]) return match;
		const skillPath = locationMatch[1];

		if (disabledPaths.has(skillPath)) return "";

		for (const prefix of disabledSourcePrefixes) {
			if (skillPath.startsWith(prefix + "/") || skillPath === prefix) return "";
		}

		return match;
	});
}
