import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "manage-skills-enforcement-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

function skillFile(root, dir, name) {
	const file = path.join(root, dir, "SKILL.md");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`, "utf8");
	return path.resolve(file);
}

try {
	const stateModuleRaw = await import(path.join(repoRoot, "src/state.ts"));
	const policyModuleRaw = await import(path.join(repoRoot, "src/skill-policy.ts"));
	const discoveryModuleRaw = await import(path.join(repoRoot, "src/discovery.ts"));
	const skillsModuleRaw = await import(path.join(repoRoot, "src/skills.ts"));
	const enforcementModuleRaw = await import(path.join(repoRoot, "src/enforcement.ts"));
	const commandsModuleRaw = await import(path.join(repoRoot, "src/commands.ts"));
	const extensionModuleRaw = await import(path.join(repoRoot, "src/index.ts"));
	const stateModule = stateModuleRaw.default ?? stateModuleRaw;
	const policyModule = policyModuleRaw.default ?? policyModuleRaw;
	const discoveryModule = discoveryModuleRaw.default ?? discoveryModuleRaw;
	const skillsModule = skillsModuleRaw.default ?? skillsModuleRaw;
	const enforcementModule = enforcementModuleRaw.default ?? enforcementModuleRaw;
	const commandsModule = commandsModuleRaw.default ?? commandsModuleRaw;
	const extensionFactory = extensionModuleRaw.default?.default ?? extensionModuleRaw.default ?? extensionModuleRaw;
	const { defaultState, writeConfig, writeState } = stateModule;
	const { defaultSkillPolicy, setFolderSkillPolicy, setFolderSourcePolicy, setGlobalSkillPolicy, setGlobalSourcePolicy } = policyModule;
	const { clearDiscoveryCache, discoverInstalledResourcesCached } = discoveryModule;
	const { buildSkillList, buildSourceList, filterSkillsFromPromptByPolicy } = skillsModule;
	const { evaluateSkillInvocationBlock, evaluateSkillInvocationBlockWithManagedSkills, parseSkillInvocation } = enforcementModule;
	const { formatManageSkillsStatus } = commandsModule;

	const sourceRoot = path.join(tmp, "custom-skills");
	const alpha = skillFile(sourceRoot, "alpha", "alpha");
	const beta = skillFile(sourceRoot, "beta", "beta");
	await writeConfig({ claudeReadOnlyImports: false, skillSources: [sourceRoot] });

	let state = defaultState();
	setGlobalSkillPolicy(state.skillPolicy, { name: "alpha", path: alpha, sourceRoot }, "disabled");
	await writeState(state);
	clearDiscoveryCache();
	let resources = await discoverInstalledResourcesCached(tmp);
	assert.ok(resources.skillPaths.includes(alpha), "legacy global disabled skill path is ignored for discovery");
	assert.ok(resources.skillPaths.includes(beta), "enabled manager-owned skill remains discoverable");

	state = defaultState();
	setGlobalSkillPolicy(state.skillPolicy, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	await writeState(state);
	clearDiscoveryCache();
	resources = await discoverInstalledResourcesCached(tmp);
	assert.ok(resources.skillPaths.includes(alpha), "re-enabled manager-owned skill path reappears after cache/reload semantics");

	state = defaultState();
	setGlobalSkillPolicy(state.skillPolicy, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	setGlobalSourcePolicy(state.skillPolicy, sourceRoot, "disabled");
	await writeState(state);
	clearDiscoveryCache();
	resources = await discoverInstalledResourcesCached(tmp);
	assert.ok(resources.skillPaths.includes(alpha) && resources.skillPaths.includes(beta), "legacy global source disable is ignored for discovery");
	const inventoryPi = { getCommands: () => [] };
	const statusSkills = await buildSkillList(inventoryPi, [], [alpha, beta], state.skillPolicy, tmp, [sourceRoot]);
	const statusSources = buildSourceList(statusSkills, [sourceRoot], state.skillPolicy, tmp);
	const statusText = formatManageSkillsStatus(statusSkills, statusSources, state.skillPolicy);
	assert.match(statusText, /Active scope: current folder only/, "non-TUI status states folder-only policy");
	assert.match(statusText, /Ignored legacy global rules: 2/, "non-TUI status exposes ignored legacy global rule count");
	assert.match(statusText, /Disabled sources: none/, "legacy global source disable is not reported as active");
	assert.ok(!statusText.includes("undefined"), "disabled source status never renders undefined policy target");

	let policy = defaultSkillPolicy();
	setGlobalSkillPolicy(policy, { name: "alpha", path: alpha, sourceRoot }, "disabled");
	setGlobalSkillPolicy(policy, { name: "external-disabled" }, "disabled");
	const prompt = `<skill>\n<name>alpha</name>\n<location>${alpha}</location>\n</skill>\n<skill>\n<name>beta</name>\n<location>${beta}</location>\n</skill>\n<skill>\n<name>external-disabled</name>\n</skill>`;
	let filtered = filterSkillsFromPromptByPolicy(prompt, policy, tmp, [sourceRoot]);
	assert.equal(filtered.includes("<name>alpha</name>"), true, "prompt filter ignores legacy global path disable");
	assert.equal(filtered.includes("<name>external-disabled</name>"), true, "prompt filter ignores legacy global name disable");
	assert.equal(filtered.includes("<name>beta</name>"), true, "prompt filter keeps enabled skills");

	policy = defaultSkillPolicy();
	setGlobalSkillPolicy(policy, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	setGlobalSourcePolicy(policy, sourceRoot, "disabled");
	filtered = filterSkillsFromPromptByPolicy(prompt, policy, tmp, [sourceRoot]);
	assert.equal(filtered.includes("<name>alpha</name>"), true, "prompt filter ignores legacy global source disable even with path rule");
	assert.equal(filtered.includes("<name>beta</name>"), true, "legacy global source-level prompt filtering is inert");
	setFolderSourcePolicy(policy, tmp, sourceRoot, "disabled");
	setFolderSkillPolicy(policy, tmp, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	filtered = filterSkillsFromPromptByPolicy(prompt, policy, tmp, [sourceRoot]);
	assert.equal(filtered.includes("<name>alpha</name>"), true, "current-folder skill enable overrides current-folder source disable in prompt filtering");
	assert.equal(filtered.includes("<name>beta</name>"), false, "current-folder source disable filters skills without explicit skill enable");

	assert.deepEqual(parseSkillInvocation("ask about /skill:alpha"), { kind: "not-skill" });
	assert.deepEqual(parseSkillInvocation("/skill:"), { kind: "malformed", reason: "Missing skill name after /skill:." });
	assert.equal(parseSkillInvocation(" /skill:alpha with args").kind, "skill");
	assert.equal(parseSkillInvocation("/skill:bad/name").kind, "malformed");

	const dupeA = skillFile(path.join(tmp, "dupe-a"), "shared", "shared");
	const dupeB = skillFile(path.join(tmp, "dupe-b"), "shared", "shared");
	const packageSkill = skillFile(path.join(tmp, "node_modules", "pkg"), "ctx-index", "ctx-index");
	const pi = { getCommands: () => [
		{ source: "skill", name: "skill:ctx-index", sourceInfo: { path: packageSkill }, description: "external" },
		{ source: "skill", name: "skill:shared", sourceInfo: { path: dupeA }, description: "dupe a" },
		{ source: "skill", name: "skill:shared", sourceInfo: { path: dupeB }, description: "dupe b" },
		{ source: "skill", name: "skill:alpha", sourceInfo: { path: alpha }, description: "source-disabled" },
		{ source: "skill", name: "skill:enabled", sourceInfo: { path: beta }, description: "enabled" },
	] };
	policy = defaultSkillPolicy();
	setGlobalSkillPolicy(policy, { name: "ctx-index" }, "disabled");
	setGlobalSkillPolicy(policy, { name: "shared", path: dupeA }, "disabled");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:ctx-index trailing args").blocked, false, "legacy global disabled package/native skill is not blocked");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "  /skill:ctx-index").blocked, false, "legacy global disabled skill remains allowed with leading whitespace");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:ctx-indexing").blocked, false, "substring names do not false-positive");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:shared").blocked, false, "legacy global duplicate disable is ignored");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:enabled").blocked, false, "enabled skill invocation continues");
	const staleNamePolicy = defaultSkillPolicy();
	setGlobalSkillPolicy(staleNamePolicy, { name: "alpha" }, "disabled");
	setGlobalSkillPolicy(staleNamePolicy, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	filtered = filterSkillsFromPromptByPolicy(prompt, staleNamePolicy, tmp, [sourceRoot]);
	assert.equal(filtered.includes("<name>alpha</name>"), true, "path-enabled skill remains in prompt despite stale name disable");
	assert.equal(evaluateSkillInvocationBlock(pi, staleNamePolicy, tmp, "/skill:alpha", [sourceRoot]).blocked, false, "path-enabled command is not blocked by stale name-only fallback");
	setFolderSkillPolicy(policy, tmp, { name: "alpha", path: alpha, sourceRoot }, "enabled");
	setFolderSourcePolicy(policy, tmp, sourceRoot, "disabled");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:alpha", [sourceRoot]).blocked, false, "folder skill enable overrides folder source disable for loaded skill invocation");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:enabled", [sourceRoot]).blocked, true, "folder source-disabled loaded skill invocation is blocked without explicit skill enable");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:").blocked, true, "empty skill invocation fails closed");
	assert.equal(evaluateSkillInvocationBlock(pi, policy, tmp, "/skill:bad/name").blocked, true, "malformed skill invocation fails closed");

	const folderA = path.join(tmp, "folder-a");
	const folderB = path.join(tmp, "folder-b");
	mkdirSync(folderA, { recursive: true });
	mkdirSync(folderB, { recursive: true });
	state = defaultState();
	setFolderSkillPolicy(state.skillPolicy, folderA, { name: "alpha", path: alpha, sourceRoot }, "disabled");
	await writeState(state);
	clearDiscoveryCache();
	const folderAResources = await discoverInstalledResourcesCached(folderA);
	const folderBResources = await discoverInstalledResourcesCached(folderB);
	assert.ok(!folderAResources.skillPaths.includes(alpha), "folder A disable omits manager-owned skill in folder A discovery");
	assert.ok(folderBResources.skillPaths.includes(alpha), "folder A disable does not omit manager-owned skill in folder B discovery");
	const folderASkills = await buildSkillList(inventoryPi, [], [alpha, beta], state.skillPolicy, folderA, [sourceRoot]);
	const folderBSkills = await buildSkillList(inventoryPi, [], [alpha, beta], state.skillPolicy, folderB, [sourceRoot]);
	assert.equal(folderASkills.find((skill) => skill.path === alpha)?.enabled, false, "folder A status shows alpha disabled");
	assert.equal(folderBSkills.find((skill) => skill.path === alpha)?.enabled, true, "folder B status keeps alpha enabled");
	const externalAlpha = skillFile(path.join(tmp, "external-alpha"), "alpha", "alpha");
	const mixedDuplicatePi = { getCommands: () => [
		{ source: "skill", name: "skill:alpha", sourceInfo: { path: externalAlpha }, description: "external enabled duplicate" },
	] };
	assert.equal((await evaluateSkillInvocationBlockWithManagedSkills(mixedDuplicatePi, state.skillPolicy, folderA, "/skill:alpha", [sourceRoot], [alpha, beta])).blocked, true, "pathful enabled duplicate is blocked when a manager-owned same-name skill is disabled but omitted from discovery");
	assert.equal((await evaluateSkillInvocationBlockWithManagedSkills(mixedDuplicatePi, state.skillPolicy, folderB, "/skill:alpha", [sourceRoot], [alpha, beta])).blocked, false, "same mixed duplicate remains allowed outside the disabled folder");

	const registeredCommands = new Map();
	const registeredEvents = new Map();
	const emittedMessages = [];
	const extensionPi = {
		registerMessageRenderer() {},
		registerCommand(name, options) { registeredCommands.set(name, options); },
		on(name, handler) { registeredEvents.set(name, handler); },
		getCommands: () => [],
		sendMessage(message) { emittedMessages.push(message); },
	};
	extensionFactory(extensionPi);
	assert.ok(registeredCommands.has("manage-skills"), "/manage-skills is registered");
	assert.equal(registeredCommands.has("skills"), false, "/skills is not registered by this extension");
	const completionValues = (await registeredCommands.get("manage-skills").getArgumentCompletions(""))?.map((item) => item.value) ?? [];
	assert.ok(completionValues.includes("status"), "/manage-skills autocomplete exposes status");
	assert.ok(!completionValues.includes("sources"), "old /skills sources autocomplete is not exposed");
	assert.ok(registeredEvents.has("input"), "input interception hook registered before skill expansion path");
	assert.ok(registeredEvents.has("before_agent_start"), "before_agent_start prompt filtering hook registered");

	const folderPrompt = `<skill>\n<name>alpha</name>\n<location>${alpha}</location>\n</skill>\n<skill>\n<name>beta</name>\n<location>${beta}</location>\n</skill>`;
	const beforeAgentStart = registeredEvents.get("before_agent_start");
	const promptResultA = await beforeAgentStart({ systemPrompt: folderPrompt, systemPromptOptions: { cwd: folderA }, cwd: folderB }, { cwd: folderB });
	assert.equal(promptResultA.systemPrompt.includes("<name>alpha</name>"), false, "before_agent_start filters using systemPromptOptions.cwd instead of stale top-level cwd");
	assert.equal(promptResultA.systemPrompt.includes("<name>beta</name>"), true, "before_agent_start keeps enabled folder skill");
	const promptResultB = await beforeAgentStart({ systemPrompt: folderPrompt, systemPromptOptions: { cwd: folderB }, cwd: folderA }, { cwd: folderA });
	assert.equal(promptResultB, undefined, "before_agent_start does not filter another folder without the folder rule");

	const inputHandler = registeredEvents.get("input");
	let inputResult = await inputHandler({ text: "/skill:alpha" }, { cwd: folderA, hasUI: true });
	assert.equal(inputResult.action, "handled", "manager-owned disabled skill is blocked in disabled folder even when command discovery has no path");
	assert.match(emittedMessages.at(-1)?.content ?? "", /Blocked \/skill invocation/);
	inputResult = await inputHandler({ text: "/skill:alpha" }, { cwd: folderB, hasUI: true });
	assert.equal(inputResult.action, "continue", "manager-owned folder disable does not block explicit /skill in another folder");

	console.log("manage skills enforcement tests ok");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
