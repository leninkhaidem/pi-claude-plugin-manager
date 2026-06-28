import path from "node:path";
import type { FolderSkillPolicyValue, SkillPolicy, SkillPolicyRuleSet, SkillPolicyValue } from "./types.js";
import { normalizePath } from "./utils.js";

export type SkillPolicyIdentity =
	| { kind: "path"; key: string }
	| { kind: "name"; key: string };

export type SkillPolicySubject = {
	name: string;
	path?: string;
	sourceRoot?: string;
};

export type SkillPolicyEffectiveState = {
	identity: SkillPolicyIdentity;
	skillKey?: string;
	sourceKey?: string;
	nameKey: string;
	globalState: SkillPolicyValue;
	folderState: FolderSkillPolicyValue;
	effectiveState: SkillPolicyValue;
	enabled: boolean;
	winningScope: "global" | "folder";
	winningTarget: "default" | "skill" | "source" | "name";
};

type UnknownRecord = Record<string, unknown>;

export function emptySkillPolicyRuleSet(): SkillPolicyRuleSet {
	return { skills: {}, sources: {}, names: {} };
}

export function defaultSkillPolicy(): SkillPolicy {
	return {
		schemaVersion: 1,
		legacyDisabledMigrated: true,
		global: emptySkillPolicyRuleSet(),
		folders: {},
	};
}

export function normalizeStartedFolderKey(startedFolder: string): string {
	return normalizePath(startedFolder);
}

export function normalizeSkillPolicySubject(subject: SkillPolicySubject): Required<Pick<SkillPolicySubject, "name">> & Pick<SkillPolicySubject, "path" | "sourceRoot"> {
	return {
		name: subject.name,
		path: subject.path ? normalizePath(subject.path) : undefined,
		sourceRoot: subject.sourceRoot ? normalizePath(subject.sourceRoot) : undefined,
	};
}

export function selectSkillPolicyIdentity(subject: SkillPolicySubject): SkillPolicyIdentity {
	const normalized = normalizeSkillPolicySubject(subject);
	if (normalized.path) return { kind: "path", key: normalized.path };
	return { kind: "name", key: normalized.name };
}

export function isSkillPolicyDisabled(effective: SkillPolicyEffectiveState): boolean {
	return effective.effectiveState === "disabled";
}

export function evaluateSkillPolicy(policy: SkillPolicy, subject: SkillPolicySubject, startedFolder?: string): SkillPolicyEffectiveState {
	const normalized = normalizeSkillPolicySubject(subject);
	const identity = selectSkillPolicyIdentity(normalized);
	const globalRule = findRule(policy.global, normalized) ?? { state: "enabled" as const, target: "default" as const };
	const folderKey = startedFolder ? normalizeStartedFolderKey(startedFolder) : undefined;
	const folderRule = folderKey ? findRule(policy.folders[folderKey], normalized) : undefined;
	const effectiveRule = folderRule ?? globalRule;

	return {
		identity,
		skillKey: normalized.path,
		sourceKey: normalized.sourceRoot,
		nameKey: normalized.name,
		globalState: globalRule.state,
		folderState: folderRule?.state ?? "inherit",
		effectiveState: effectiveRule.state,
		enabled: effectiveRule.state === "enabled",
		winningScope: folderRule ? "folder" : "global",
		winningTarget: effectiveRule.target,
	};
}

export function evaluateSourcePolicy(policy: SkillPolicy, sourceRoot: string, startedFolder?: string): Omit<SkillPolicyEffectiveState, "identity" | "skillKey" | "nameKey"> & { sourceKey: string } {
	const sourceKey = normalizePath(sourceRoot);
	const subject = { name: sourceKey, sourceRoot: sourceKey };
	const globalRule = findSourceRule(policy.global, sourceKey) ?? { state: "enabled" as const, target: "default" as const };
	const folderKey = startedFolder ? normalizeStartedFolderKey(startedFolder) : undefined;
	const folderRule = folderKey ? findSourceRule(policy.folders[folderKey], sourceKey) : undefined;
	const effectiveRule = folderRule ?? globalRule;
	return {
		sourceKey: subject.sourceRoot,
		globalState: globalRule.state,
		folderState: folderRule?.state ?? "inherit",
		effectiveState: effectiveRule.state,
		enabled: effectiveRule.state === "enabled",
		winningScope: folderRule ? "folder" : "global",
		winningTarget: effectiveRule.target,
	};
}

export function setGlobalSkillPolicy(policy: SkillPolicy, subject: SkillPolicySubject, value: SkillPolicyValue): void {
	setSkillRule(policy.global, subject, value);
}

export function clearGlobalSkillPolicy(policy: SkillPolicy, subject: SkillPolicySubject): void {
	clearSkillRule(policy.global, subject);
}

export function setFolderSkillPolicy(policy: SkillPolicy, startedFolder: string, subject: SkillPolicySubject, value: FolderSkillPolicyValue): void {
	const rules = ensureFolderRuleSet(policy, startedFolder);
	if (value === "inherit") clearSkillRule(rules, subject);
	else setSkillRule(rules, subject, value);
}

export function setGlobalSourcePolicy(policy: SkillPolicy, sourceRoot: string, value: SkillPolicyValue): void {
	policy.global.sources[normalizePath(sourceRoot)] = value;
}

export function clearGlobalSourcePolicy(policy: SkillPolicy, sourceRoot: string): void {
	delete policy.global.sources[normalizePath(sourceRoot)];
}

export function setFolderSourcePolicy(policy: SkillPolicy, startedFolder: string, sourceRoot: string, value: FolderSkillPolicyValue): void {
	const rules = ensureFolderRuleSet(policy, startedFolder);
	const sourceKey = normalizePath(sourceRoot);
	if (value === "inherit") delete rules.sources[sourceKey];
	else rules.sources[sourceKey] = value;
}

export function disabledSkillPathRecordForCompatibility(policy: SkillPolicy): Record<string, boolean> {
	return Object.fromEntries(Object.entries(policy.global.skills).filter(([, value]) => value === "disabled").map(([key]) => [key, true]));
}

export function disabledSourcePathRecordForCompatibility(policy: SkillPolicy): Record<string, boolean> {
	return Object.fromEntries(Object.entries(policy.global.sources).filter(([, value]) => value === "disabled").map(([key]) => [key, true]));
}

export function normalizeSkillPolicy(rawPolicy: unknown, legacyDisabledSkills: unknown, legacyDisabledSources: unknown): SkillPolicy {
	const raw = isRecord(rawPolicy) ? rawPolicy : undefined;
	const policy: SkillPolicy = {
		schemaVersion: 1,
		legacyDisabledMigrated: raw?.legacyDisabledMigrated === true,
		global: normalizeRuleSet(raw?.global),
		folders: normalizeFolders(raw?.folders),
	};

	if (!policy.legacyDisabledMigrated) {
		migrateLegacyDisabledRecords(policy, legacyDisabledSkills, legacyDisabledSources);
		policy.legacyDisabledMigrated = true;
	}

	return policy;
}

function ensureFolderRuleSet(policy: SkillPolicy, startedFolder: string): SkillPolicyRuleSet {
	const key = normalizeStartedFolderKey(startedFolder);
	policy.folders[key] ??= emptySkillPolicyRuleSet();
	return policy.folders[key]!;
}

function findRule(rules: SkillPolicyRuleSet | undefined, subject: SkillPolicySubject): { state: SkillPolicyValue; target: "skill" | "source" | "name" } | undefined {
	if (!rules) return undefined;
	const sourceRule = subject.sourceRoot ? rules.sources[normalizePath(subject.sourceRoot)] : undefined;
	if (sourceRule === "disabled") return { state: sourceRule, target: "source" };
	if (subject.path) {
		const skillRule = rules.skills[normalizePath(subject.path)];
		if (skillRule) return { state: skillRule, target: "skill" };
	}
	if (sourceRule) return { state: sourceRule, target: "source" };
	const nameRule = rules.names[subject.name];
	if (nameRule) return { state: nameRule, target: "name" };
	return undefined;
}

function findSourceRule(rules: SkillPolicyRuleSet | undefined, sourceKey: string): { state: SkillPolicyValue; target: "source" } | undefined {
	const sourceRule = rules?.sources[normalizePath(sourceKey)];
	return sourceRule ? { state: sourceRule, target: "source" } : undefined;
}

function setSkillRule(rules: SkillPolicyRuleSet, subject: SkillPolicySubject, value: SkillPolicyValue): void {
	const identity = selectSkillPolicyIdentity(subject);
	if (identity.kind === "path") rules.skills[identity.key] = value;
	else rules.names[identity.key] = value;
}

function clearSkillRule(rules: SkillPolicyRuleSet, subject: SkillPolicySubject): void {
	const identity = selectSkillPolicyIdentity(subject);
	if (identity.kind === "path") delete rules.skills[identity.key];
	else delete rules.names[identity.key];
}

function normalizeFolders(rawFolders: unknown): Record<string, SkillPolicyRuleSet> {
	if (!isRecord(rawFolders)) return {};
	const folders: Record<string, SkillPolicyRuleSet> = {};
	for (const [key, value] of Object.entries(rawFolders)) {
		folders[normalizeStartedFolderKey(key)] = normalizeRuleSet(value);
	}
	return folders;
}

function normalizeRuleSet(rawRules: unknown): SkillPolicyRuleSet {
	if (!isRecord(rawRules)) return emptySkillPolicyRuleSet();
	return {
		skills: normalizePolicyValueRecord(rawRules.skills, "path"),
		sources: normalizePolicyValueRecord(rawRules.sources, "path"),
		names: normalizePolicyValueRecord(rawRules.names, "name"),
	};
}

function normalizePolicyValueRecord(rawRecord: unknown, keyKind: "path" | "name"): Record<string, SkillPolicyValue> {
	if (!isRecord(rawRecord)) return {};
	const result: Record<string, SkillPolicyValue> = {};
	for (const [rawKey, rawValue] of Object.entries(rawRecord)) {
		if (rawValue !== "enabled" && rawValue !== "disabled") continue;
		const key = keyKind === "path" ? normalizePath(rawKey) : rawKey;
		result[key] = rawValue;
	}
	return result;
}

function migrateLegacyDisabledRecords(policy: SkillPolicy, legacyDisabledSkills: unknown, legacyDisabledSources: unknown): void {
	for (const key of trueBooleanKeys(legacyDisabledSkills)) {
		if (looksPathLike(key)) policy.global.skills[normalizePath(key)] = "disabled";
		else policy.global.names[key] = "disabled";
	}
	for (const key of trueBooleanKeys(legacyDisabledSources)) {
		policy.global.sources[normalizePath(key)] = "disabled";
	}
}

function trueBooleanKeys(rawRecord: unknown): string[] {
	if (!isRecord(rawRecord)) return [];
	return Object.entries(rawRecord).filter(([, value]) => value === true).map(([key]) => key);
}

function looksPathLike(value: string): boolean {
	return value === "~" || value.startsWith("~/") || path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
