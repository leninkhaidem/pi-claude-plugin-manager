import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { evaluateSkillPolicy } from "./skill-policy.js";
import type { SkillPolicy } from "./types.js";
import { normalizePath } from "./utils.js";
import { readSkillInfo, sourceRootForSkillPath } from "./skills.js";

export type ParsedSkillInvocation =
	| { kind: "not-skill" }
	| { kind: "malformed"; reason: string }
	| { kind: "skill"; name: string };

export type SkillInvocationBlock = {
	blocked: boolean;
	name?: string;
	reason?: string;
	matchedPaths?: string[];
};

type SkillInvocationMatch = {
	path?: string;
	sourceRoot?: string;
};

const SKILL_PREFIX = "/skill:";
const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseSkillInvocation(text: string): ParsedSkillInvocation {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(SKILL_PREFIX)) return { kind: "not-skill" };
	const afterPrefix = trimmed.slice(SKILL_PREFIX.length);
	const token = afterPrefix.split(/\s+/, 1)[0] ?? "";
	if (token.length === 0) return { kind: "malformed", reason: "Missing skill name after /skill:." };
	if (!VALID_SKILL_NAME.test(token)) return { kind: "malformed", reason: `Invalid skill name: ${token}` };
	return { kind: "skill", name: token };
}

function commandMatchesForName(pi: ExtensionAPI, name: string, cwd: string | undefined, customSourceRoots: string[]): SkillInvocationMatch[] {
	return pi.getCommands()
		.filter((cmd) => cmd.source === "skill" && cmd.name.replace(/^skill:/, "") === name)
		.map((cmd) => {
			const rawPath = cmd.sourceInfo?.path;
			const skillPath = typeof rawPath === "string" && rawPath.length > 0 ? normalizePath(rawPath) : undefined;
			const sourceRoot = skillPath ? sourceRootForSkillPath(skillPath, { cwd, customSourceRoots }).sourceRoot : undefined;
			return { path: skillPath, sourceRoot };
		});
}

function blockFromMatches(policy: SkillPolicy, cwd: string | undefined, name: string, matches: SkillInvocationMatch[]): SkillInvocationBlock | undefined {
	const disabledMatches = matches.filter((match) => !evaluateSkillPolicy(policy, { name, path: match.path, sourceRoot: match.sourceRoot }, cwd).enabled);
	if (disabledMatches.length > 0) {
		return {
			blocked: true,
			name,
			reason: `Skill is disabled by policy: ${name}`,
			matchedPaths: disabledMatches.map((match) => match.path).filter((matchPath): matchPath is string => Boolean(matchPath)),
		};
	}
	if (matches.length > 0) return { blocked: false, name };
	return undefined;
}

async function managedSkillMatchesForName(name: string, cwd: string | undefined, customSourceRoots: string[], managedSkillPaths: string[]): Promise<SkillInvocationMatch[]> {
	const matches: SkillInvocationMatch[] = [];
	for (const skillPath of managedSkillPaths) {
		const normalizedSkillPath = normalizePath(skillPath);
		const info = await readSkillInfo(normalizedSkillPath);
		const skillName = info?.name || path.basename(path.dirname(normalizedSkillPath));
		if (skillName !== name) continue;
		const sourceRoot = sourceRootForSkillPath(normalizedSkillPath, { cwd, customSourceRoots }).sourceRoot;
		matches.push({ path: normalizedSkillPath, sourceRoot });
	}
	return matches;
}

export function evaluateSkillInvocationBlock(pi: ExtensionAPI, policy: SkillPolicy, cwd: string | undefined, text: string, customSourceRoots: string[] = []): SkillInvocationBlock {
	const parsed = parseSkillInvocation(text);
	if (parsed.kind === "not-skill") return { blocked: false };
	if (parsed.kind === "malformed") return { blocked: true, reason: parsed.reason };

	const name = parsed.name;
	const commandMatches = commandMatchesForName(pi, name, cwd, customSourceRoots);
	const commandBlock = blockFromMatches(policy, cwd, name, commandMatches);
	if (commandBlock?.blocked) return commandBlock;
	if (commandMatches.length > 0) return commandBlock ?? { blocked: false, name };

	const nameOnly = evaluateSkillPolicy(policy, { name }, cwd);
	if (!nameOnly.enabled) return { blocked: true, name, reason: `Skill is disabled by policy: ${name}` };
	return { blocked: false, name };
}

export async function evaluateSkillInvocationBlockWithManagedSkills(
	pi: ExtensionAPI,
	policy: SkillPolicy,
	cwd: string | undefined,
	text: string,
	customSourceRoots: string[] = [],
	managedSkillPaths: string[] = [],
): Promise<SkillInvocationBlock> {
	const parsed = parseSkillInvocation(text);
	if (parsed.kind === "not-skill") return { blocked: false };
	if (parsed.kind === "malformed") return { blocked: true, reason: parsed.reason };

	const name = parsed.name;
	const commandMatches = commandMatchesForName(pi, name, cwd, customSourceRoots);
	const commandBlock = blockFromMatches(policy, cwd, name, commandMatches);
	if (commandBlock?.blocked) return commandBlock;

	const managedMatches = await managedSkillMatchesForName(name, cwd, customSourceRoots, managedSkillPaths);
	const managedBlock = blockFromMatches(policy, cwd, name, managedMatches);
	if (managedBlock?.blocked) return managedBlock;
	if (commandMatches.some((match) => match.path)) return commandBlock ?? { blocked: false, name };
	if (managedBlock) return managedBlock;
	if (commandMatches.length > 0) return commandBlock ?? { blocked: false, name };

	const nameOnly = evaluateSkillPolicy(policy, { name }, cwd);
	if (!nameOnly.enabled) return { blocked: true, name, reason: `Skill is disabled by policy: ${name}` };
	return { blocked: false, name };
}
