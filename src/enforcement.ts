import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { evaluateSkillPolicy } from "./skill-policy.js";
import type { SkillPolicy } from "./types.js";
import { normalizePath } from "./utils.js";
import { sourceRootForSkillPath } from "./skills.js";

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

export function evaluateSkillInvocationBlock(pi: ExtensionAPI, policy: SkillPolicy, cwd: string | undefined, text: string, customSourceRoots: string[] = []): SkillInvocationBlock {
	const parsed = parseSkillInvocation(text);
	if (parsed.kind === "not-skill") return { blocked: false };
	if (parsed.kind === "malformed") return { blocked: true, reason: parsed.reason };

	const name = parsed.name;
	const commandMatches = pi.getCommands()
		.filter((cmd) => cmd.source === "skill" && cmd.name.replace(/^skill:/, "") === name)
		.map((cmd) => {
			const rawPath = cmd.sourceInfo?.path;
			const skillPath = typeof rawPath === "string" && rawPath.length > 0 ? normalizePath(rawPath) : undefined;
			const sourceRoot = skillPath ? sourceRootForSkillPath(skillPath, { cwd, customSourceRoots }).sourceRoot : undefined;
			return { path: skillPath, sourceRoot };
		});

	const disabledMatches = commandMatches.filter((match) => !evaluateSkillPolicy(policy, { name, path: match.path, sourceRoot: match.sourceRoot }, cwd).enabled);
	if (disabledMatches.length > 0) {
		return {
			blocked: true,
			name,
			reason: `Skill is disabled by policy: ${name}`,
			matchedPaths: disabledMatches.map((match) => match.path).filter((path): path is string => Boolean(path)),
		};
	}
	if (commandMatches.length > 0) return { blocked: false, name };

	const nameOnly = evaluateSkillPolicy(policy, { name }, cwd);
	if (!nameOnly.enabled) return { blocked: true, name, reason: `Skill is disabled by policy: ${name}` };
	return { blocked: false, name };
}
