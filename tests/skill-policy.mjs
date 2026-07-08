import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "skill-policy-"));
const agentDir = path.join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	const stateModuleRaw = await import(path.join(repoRoot, "src/state.ts"));
	const policyModuleRaw = await import(path.join(repoRoot, "src/skill-policy.ts"));
	const skillsModuleRaw = await import(path.join(repoRoot, "src/skills.ts"));
	const stateModule = stateModuleRaw.default ?? stateModuleRaw;
	const policyModule = policyModuleRaw.default ?? policyModuleRaw;
	const skillsModule = skillsModuleRaw.default ?? skillsModuleRaw;
	const {
		defaultSkillPolicy,
		evaluateSkillPolicy,
		normalizeStartedFolderKey,
		setFolderSkillPolicy,
		setFolderSourcePolicy,
		setGlobalSkillPolicy,
		setGlobalSourcePolicy,
	} = policyModule;
	const { readState, statePath, writeState } = stateModule;
	const { buildSkillList } = skillsModule;

	const legacySkillPath = path.join(tmp, "legacy", "skill-a", "SKILL.md");
	const legacySourcePath = path.join(tmp, "legacy");
	mkdirSync(path.dirname(legacySkillPath), { recursive: true });
	writeFileSync(legacySkillPath, "---\nname: legacy-a\ndescription: Legacy A\n---\n", "utf8");
	mkdirSync(path.dirname(statePath()), { recursive: true });
	writeFileSync(statePath(), JSON.stringify({
		version: 1,
		marketplaces: [],
		plugins: {},
		enabledPlugins: {},
		disabledSkills: {
			[legacySkillPath]: true,
			"legacy-name-only": true,
			ignoredFalse: false,
		},
		disabledSkillSources: { [legacySourcePath]: true },
	}, null, 2));

	let state = await readState();
	assert.equal(state.skillPolicy.legacyDisabledMigrated, true);
	assert.equal(state.skillPolicy.global.skills[path.resolve(legacySkillPath)], "disabled");
	assert.equal(state.skillPolicy.global.names["legacy-name-only"], "disabled");
	assert.equal(state.skillPolicy.global.sources[path.resolve(legacySourcePath)], "disabled");
	assert.equal(state.disabledSkills[path.resolve(legacySkillPath)], true);
	assert.equal(state.disabledSkillSources[path.resolve(legacySourcePath)], true);
	const migratedInventory = await buildSkillList({ getCommands: () => [] }, [legacySkillPath], [], state.skillPolicy, tmp, [legacySourcePath]);
	assert.equal(migratedInventory.find((row) => row.path === path.resolve(legacySkillPath))?.enabled, true, "migrated legacy global disables are inert for current-folder policy");

	setGlobalSkillPolicy(state.skillPolicy, { name: "legacy-a", path: legacySkillPath }, "enabled");
	setGlobalSourcePolicy(state.skillPolicy, legacySourcePath, "enabled");
	await writeState(state);
	const persisted = JSON.parse(readFileSync(statePath(), "utf8"));
	assert.deepEqual(persisted.disabledSkills, {});
	assert.deepEqual(persisted.disabledSkillSources, {});
	assert.equal(persisted.skillPolicy.global.skills[path.resolve(legacySkillPath)], "enabled");
	assert.equal(persisted.skillPolicy.global.sources[path.resolve(legacySourcePath)], "enabled");

	state = await readState();
	assert.equal(state.skillPolicy.global.skills[path.resolve(legacySkillPath)], "enabled", "legacy skill disable was not resurrected after re-enable");
	assert.equal(state.skillPolicy.global.sources[path.resolve(legacySourcePath)], "enabled", "legacy source disable was not resurrected after re-enable");

	writeFileSync(statePath(), JSON.stringify({ version: 1, disabledSkills: "bad", disabledSkillSources: ["bad"], skillPolicy: { global: "bad", folders: "bad" } }, null, 2));
	state = await readState();
	assert.deepEqual(state.skillPolicy.global.skills, {});
	assert.deepEqual(state.skillPolicy.global.sources, {});
	assert.deepEqual(state.skillPolicy.folders, {});

	const policy = defaultSkillPolicy();
	const subject = { name: "folder-skill", path: path.join(tmp, "skills", "folder-skill", "SKILL.md"), sourceRoot: path.join(tmp, "skills") };
	setGlobalSkillPolicy(policy, subject, "disabled");
	let effective = evaluateSkillPolicy(policy, subject, path.join(tmp, "project"));
	assert.equal(effective.effectiveState, "enabled", "legacy global skill disable is ignored for effective policy");
	assert.equal(effective.globalState, "disabled", "legacy global skill rule remains visible");
	setFolderSkillPolicy(policy, path.join(tmp, "project", "..", "project"), subject, "disabled");
	assert.equal(Object.keys(policy.folders)[0], normalizeStartedFolderKey(path.join(tmp, "project")));
	const sameFolder = evaluateSkillPolicy(policy, subject, path.join(tmp, "project"));
	assert.equal(sameFolder.effectiveState, "disabled");
	assert.equal(sameFolder.winningScope, "folder");
	assert.equal(evaluateSkillPolicy(policy, subject, path.join(tmp, "other")).effectiveState, "enabled", "folder A disable does not affect folder B");
	assert.equal(JSON.stringify(policy).includes("effectiveState"), false, "effective state is derived, not persisted in policy");

	const sourcePrecedence = defaultSkillPolicy();
	const sourcePrecedenceSubject = { name: "source-precedence", path: path.join(tmp, "source-precedence", "source-precedence", "SKILL.md"), sourceRoot: path.join(tmp, "source-precedence") };
	setGlobalSkillPolicy(sourcePrecedence, sourcePrecedenceSubject, "disabled");
	setGlobalSourcePolicy(sourcePrecedence, sourcePrecedenceSubject.sourceRoot, "disabled");
	let sourcePrecedenceResult = evaluateSkillPolicy(sourcePrecedence, sourcePrecedenceSubject, tmp);
	assert.equal(sourcePrecedenceResult.effectiveState, "enabled", "legacy global source and skill disables are ignored");
	assert.equal(sourcePrecedenceResult.globalState, "disabled", "ignored global source/skill rule remains visible");
	const sourceNamePrecedenceSubject = { name: "source-name-precedence", path: path.join(sourcePrecedenceSubject.sourceRoot, "source-name-precedence", "SKILL.md"), sourceRoot: sourcePrecedenceSubject.sourceRoot };
	setFolderSourcePolicy(sourcePrecedence, tmp, sourcePrecedenceSubject.sourceRoot, "disabled");
	assert.equal(evaluateSkillPolicy(sourcePrecedence, sourceNamePrecedenceSubject, tmp).effectiveState, "disabled", "folder source disable applies when no explicit current-folder skill rule exists");
	setFolderSkillPolicy(sourcePrecedence, tmp, sourcePrecedenceSubject, "enabled");
	sourcePrecedenceResult = evaluateSkillPolicy(sourcePrecedence, sourcePrecedenceSubject, tmp);
	assert.equal(sourcePrecedenceResult.effectiveState, "enabled", "current-folder skill enable overrides current-folder source disable for that skill");
	assert.equal(sourcePrecedenceResult.winningScope, "folder");
	assert.equal(sourcePrecedenceResult.winningTarget, "skill");

	const dupRootA = path.join(tmp, "dup-a");
	const dupRootB = path.join(tmp, "dup-b");
	const dupSkillA = path.join(dupRootA, "shared", "SKILL.md");
	const dupSkillB = path.join(dupRootB, "shared", "SKILL.md");
	mkdirSync(path.dirname(dupSkillA), { recursive: true });
	mkdirSync(path.dirname(dupSkillB), { recursive: true });
	writeFileSync(dupSkillA, "---\nname: shared\ndescription: First\n---\n", "utf8");
	writeFileSync(dupSkillB, "---\nname: shared\ndescription: Second\n---\n", "utf8");
	const inventoryPolicy = defaultSkillPolicy();
	setGlobalSourcePolicy(inventoryPolicy, dupRootA, "disabled");
	const pi = { getCommands: () => [] };
	const inventory = await buildSkillList(pi, [dupSkillA, dupSkillB], [], inventoryPolicy, tmp, [dupRootA, dupRootB]);
	assert.equal(inventory.length, 2);
	assert.ok(inventory.every((row) => row.duplicateName && row.sameNameCount === 2));
	assert.ok(inventory.every((row) => row.identityKind === "path" && row.path && row.sourceRoot && row.sourceLabel));
	assert.equal(inventory.find((row) => row.path === path.resolve(dupSkillA)).effectiveState, "enabled", "legacy global source disable is ignored in inventory");
	assert.equal(inventory.find((row) => row.path === path.resolve(dupSkillB)).effectiveState, "enabled");

	assert.equal(statePath().startsWith(path.join(agentDir, "claude-plugin-manager")), true);
	assert.equal(existsSync(path.join(tmp, "project", ".pi")), false, "policy write did not create repo-local .pi state");

	console.log("skill policy tests ok");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
