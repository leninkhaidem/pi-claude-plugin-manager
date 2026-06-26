import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists, readDirectories, readEntries } from "./fs-utils.js";
import { evaluateSkillPolicy, evaluateSourcePolicy, type SkillPolicyEffectiveState } from "./skill-policy.js";
import type { FolderSkillPolicyValue, SkillPolicy, SkillPolicyValue } from "./types.js";
import { normalizePath } from "./utils.js";

export type SkillInfo = {
	name: string;
	description: string;
	path: string;
	source: "plugin" | "claude-readonly" | "custom-source" | "pi-native";
	sourceLabel: string;
	sourceRoot: string;
	enabled: boolean;
	globalState: SkillPolicyValue;
	folderState: FolderSkillPolicyValue;
	effectiveState: SkillPolicyValue;
	winningScope: "global" | "folder";
	winningTarget: SkillPolicyEffectiveState["winningTarget"];
	identityKind: "path" | "name";
	identityKey: string;
	duplicateName: boolean;
	sameNameCount: number;
};

export type SkillSourceInfo = {
	path: string;
	label: string;
	kind: "pi-path" | "pi-package" | "plugin-marketplace" | "custom-source";
	skillCount: number;
	enabled: boolean;
	globalState: SkillPolicyValue;
	folderState: FolderSkillPolicyValue;
	effectiveState: SkillPolicyValue;
	winningScope: "global" | "folder";
	winningTarget: SkillPolicyEffectiveState["winningTarget"];
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

export function sourceRootForSkillPath(skillPath: string, options: { cwd?: string; customSourceRoots?: string[] } = {}): { sourceRoot: string; sourceLabel: string; source: SkillInfo["source"] } {
	const normalizedSkillPath = normalizePath(skillPath);
	const customSourceRoots = (options.customSourceRoots ?? []).map(normalizePath).sort((a, b) => b.length - a.length);
	for (const customRoot of customSourceRoots) {
		if (normalizedSkillPath === customRoot || normalizedSkillPath.startsWith(`${customRoot}/`)) {
			return { sourceRoot: customRoot, sourceLabel: shortenHomePath(customRoot), source: "custom-source" };
		}
	}

	const marketplaceName = deriveMarketplaceName(normalizedSkillPath);
	const marketplaceRoot = deriveMarketplaceRoot(normalizedSkillPath);
	if (marketplaceRoot) {
		return {
			sourceRoot: marketplaceRoot,
			sourceLabel: marketplaceName ? `marketplace: ${marketplaceName}` : shortenHomePath(marketplaceRoot),
			source: "plugin",
		};
	}

	const knownRoot = findKnownRoot(normalizedSkillPath, getPiKnownRoots(options.cwd || process.cwd()));
	if (knownRoot) return { sourceRoot: knownRoot, sourceLabel: shortenHomePath(knownRoot), source: "pi-native" };

	const packageRoot = getPackageRoot(normalizedSkillPath);
	const packageName = detectPackageName(normalizedSkillPath);
	if (packageRoot && packageName) return { sourceRoot: packageRoot, sourceLabel: `package: ${packageName}`, source: "pi-native" };

	const fallbackRoot = path.dirname(normalizedSkillPath);
	return { sourceRoot: fallbackRoot, sourceLabel: shortenHomePath(fallbackRoot), source: "pi-native" };
}

function skillInfoFromPolicy(base: Omit<SkillInfo, "enabled" | "globalState" | "folderState" | "effectiveState" | "winningScope" | "winningTarget" | "identityKind" | "identityKey" | "duplicateName" | "sameNameCount">, policy: SkillPolicy, cwd?: string): SkillInfo {
	const effective = evaluateSkillPolicy(policy, { name: base.name, path: base.path, sourceRoot: base.sourceRoot }, cwd);
	return {
		...base,
		enabled: effective.enabled,
		globalState: effective.globalState,
		folderState: effective.folderState,
		effectiveState: effective.effectiveState,
		winningScope: effective.winningScope,
		winningTarget: effective.winningTarget,
		identityKind: effective.identity.kind,
		identityKey: effective.identity.key,
		duplicateName: false,
		sameNameCount: 1,
	};
}

export async function buildSkillList(
	pi: ExtensionAPI,
	pluginSkillPaths: string[],
	customSourceSkillPaths: string[],
	policy: SkillPolicy,
	cwd?: string,
	customSourceRoots: string[] = [],
): Promise<SkillInfo[]> {
	const skills: SkillInfo[] = [];
	const seen = new Set<string>();
	// Gather all Pi-native skills from pi.getCommands()
	const commands = pi.getCommands();
	const piNativeSkills = commands.filter((cmd) => cmd.source === "skill");
	const extensionPaths = new Set([...pluginSkillPaths, ...customSourceSkillPaths].map(normalizePath));

	// Add Pi-native skills (ones NOT contributed by our extension)
	for (const cmd of piNativeSkills) {
		const skillPath = normalizePath(cmd.sourceInfo.path);
		if (extensionPaths.has(skillPath)) continue;
		if (seen.has(skillPath)) continue;
		seen.add(skillPath);

		const sourceInfo = sourceRootForSkillPath(skillPath, { cwd, customSourceRoots });
		const sourceRoot = sourceInfo.sourceRoot;
		const sourceLabel = sourceInfo.sourceLabel;

		skills.push(skillInfoFromPolicy({
			name: cmd.name.replace(/^skill:/, ""),
			description: cmd.description || "",
			path: skillPath,
			source: "pi-native",
			sourceLabel,
			sourceRoot,
		}, policy, cwd));
	}

	// Add plugin skills — group by marketplace
	for (const skillPath of pluginSkillPaths) {
		const normalizedSkillPath = normalizePath(skillPath);
		if (seen.has(normalizedSkillPath)) continue;
		seen.add(normalizedSkillPath);
		const info = await readSkillInfo(normalizedSkillPath);
		const sourceInfo = sourceRootForSkillPath(normalizedSkillPath, { cwd, customSourceRoots });

		skills.push(skillInfoFromPolicy({
			name: info?.name || path.basename(path.dirname(normalizedSkillPath)),
			description: info?.description || "",
			path: normalizedSkillPath,
			source: "plugin",
			sourceLabel: sourceInfo.sourceLabel,
			sourceRoot: sourceInfo.sourceRoot,
		}, policy, cwd));
	}

	// Add custom source skills
	for (const skillPath of customSourceSkillPaths) {
		const normalizedSkillPath = normalizePath(skillPath);
		if (seen.has(normalizedSkillPath)) continue;
		seen.add(normalizedSkillPath);
		const info = await readSkillInfo(normalizedSkillPath);
		const sourceInfo = sourceRootForSkillPath(normalizedSkillPath, { cwd, customSourceRoots });

		skills.push(skillInfoFromPolicy({
			name: info?.name || path.basename(path.dirname(normalizedSkillPath)),
			description: info?.description || "",
			path: normalizedSkillPath,
			source: "custom-source",
			sourceLabel: sourceInfo.sourceLabel,
			sourceRoot: sourceInfo.sourceRoot,
		}, policy, cwd));
	}

	const nameCounts = new Map<string, number>();
	for (const skill of skills) nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
	for (const skill of skills) {
		skill.sameNameCount = nameCounts.get(skill.name) ?? 1;
		skill.duplicateName = skill.sameNameCount > 1;
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name) || a.sourceLabel.localeCompare(b.sourceLabel) || a.path.localeCompare(b.path));
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
	policy: SkillPolicy,
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
		const effective = evaluateSourcePolicy(policy, sourcePath, cwd);
		sources.push({
			path: sourcePath,
			label: info.label,
			kind: info.kind,
			skillCount: info.count,
			enabled: effective.enabled,
			globalState: effective.globalState,
			folderState: effective.folderState,
			effectiveState: effective.effectiveState,
			winningScope: effective.winningScope,
			winningTarget: effective.winningTarget,
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
		return "No skills found. Install plugins with skills or add skill source directories with `/plugin config set skillSources <paths>`.";
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
	lines.push("Use `/manage-skills` to inspect source policy status.");
	lines.push("Use `/plugin config set skillSources <paths>` to add a custom source.");

	return lines.join("\n");
}

export function formatSkillsHelp(): string {
	return `# /manage-skills — Skill manager

Manage skills from all sources: Pi-native, plugins, and custom directories.
Toggle individual skills or entire source directories on/off.

## Commands
/manage-skills                       # Compact status or interactive manager when available
/manage-skills status                # Compact skill policy status
/manage-skills                       # Toggle skills in the interactive TUI when available
/manage-skills status                # Include source policy summary
/manage-skills                       # Manage source policy from the interactive TUI when available
/plugin config set skillSources <paths> # Configure custom source directories
/plugin config set skillSources <paths> # Remove paths by setting the desired list
/manage-skills help                  # Show this help

## Skill sources
Pi discovers skills from built-in paths:
  ~/.pi/agent/skills/    (global)
  ~/.agents/skills/      (global)
  .pi/skills/            (project)
  .agents/skills/        (project, up to git root)
  Installed packages

This extension also discovers skills from:
  - Claude Code plugin marketplaces
  - Custom source directories (see /plugin config set skillSources)

## Toggling skills
Toggle individual skills or entire source directories.
Disabled skills are stripped from the system prompt.

/manage-skills                       # Interactive table in TUI-capable builds
/manage-skills status                # Compact status in non-TUI mode
/manage-skills                       # Source controls live in the interactive detail view

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
	const disabledPaths = new Set(Object.keys(disabledSkills).filter((p) => disabledSkills[p] === true).map(normalizePath));
	const disabledSourcePrefixes = Object.keys(disabledSkillSources).filter((p) => disabledSkillSources[p] === true).map(normalizePath);

	if (disabledPaths.size === 0 && disabledSourcePrefixes.length === 0) return systemPrompt;

	return systemPrompt.replace(/<skill>\s*\n([\s\S]*?)<\/skill>/g, (match, inner: string) => {
		const locationMatch = inner.match(/<location>(.*?)<\/location>/);
		if (!locationMatch?.[1]) return match;
		const skillPath = normalizePath(locationMatch[1]);

		if (disabledPaths.has(skillPath)) return "";

		for (const prefix of disabledSourcePrefixes) {
			if (skillPath.startsWith(prefix + "/") || skillPath === prefix) return "";
		}

		return match;
	});
}

export function filterSkillsFromPromptByPolicy(systemPrompt: string, policy: SkillPolicy, cwd?: string, customSourceRoots: string[] = []): string {
	return systemPrompt.replace(/<skill>\s*\n([\s\S]*?)<\/skill>/g, (match, inner: string) => {
		const locationMatch = inner.match(/<location>(.*?)<\/location>/);
		const nameMatch = inner.match(/<name>(.*?)<\/name>/);
		const rawPath = locationMatch?.[1]?.trim();
		const skillPath = rawPath ? normalizePath(rawPath) : undefined;
		const name = nameMatch?.[1]?.trim() || (skillPath ? path.basename(path.dirname(skillPath)) : "");
		if (!name) return match;
		const sourceRoot = skillPath ? sourceRootForSkillPath(skillPath, { cwd, customSourceRoots }).sourceRoot : undefined;
		return evaluateSkillPolicy(policy, { name, path: skillPath, sourceRoot }, cwd).enabled ? match : "";
	});
}
