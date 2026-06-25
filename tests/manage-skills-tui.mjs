import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "manage-skills-tui-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

function skillFile(root, dir, name, description) {
	const file = path.join(root, dir, "SKILL.md");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${name} body\n`, "utf8");
	return path.resolve(file);
}

function renderText(component, width = 100) {
	return component.render(width).join("\n");
}

function assertWidthSafe(component, widths) {
	for (const width of widths) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${line} (${visibleWidth(line)})`);
		}
	}
}

function makeHost() {
	return { renders: 0, focused: undefined, requestRender() { this.renders++; }, setFocus(component) { this.focused = component; } };
}

try {
	const stateModuleRaw = await import(path.join(repoRoot, "src/state.ts"));
	const skillsModuleRaw = await import(path.join(repoRoot, "src/skills.ts"));
	const tuiModuleRaw = await import(path.join(repoRoot, "src/manage-skills-tui.ts"));
	const stateModule = stateModuleRaw.default ?? stateModuleRaw;
	const skillsModule = skillsModuleRaw.default ?? skillsModuleRaw;
	const tuiModule = tuiModuleRaw.default ?? tuiModuleRaw;
	const { defaultState } = stateModule;
	const { buildSkillList, buildSourceList } = skillsModule;
	const { createManageSkillsTui } = tuiModule;

	const sourceRoot = path.join(tmp, "skills");
	const paths = [];
	paths.push(skillFile(sourceRoot, "alpha", "alpha", "Alpha full description that belongs only in detail view."));
	paths.push(skillFile(sourceRoot, "empty", "empty", ""));
	for (let i = 0; i < 18; i++) paths.push(skillFile(sourceRoot, `skill-${i}`, `skill-${i}`, `Description ${i}`));
	paths.push(skillFile(sourceRoot, "special", "special-skill", "Special searchable description"));

	const pi = { getCommands: () => [] };
	let state = defaultState();
	let skills = await buildSkillList(pi, paths, [], state.skillPolicy, tmp, [sourceRoot]);
	let sources = buildSourceList(skills, [sourceRoot], state.skillPolicy, tmp);
	const savedStates = [];
	let doneResult;
	const host = makeHost();
	const component = createManageSkillsTui({
		cwd: tmp,
		skills,
		sources,
		state,
		saveState: async (next) => { savedStates.push(JSON.parse(JSON.stringify(next))); state = next; },
		done: (result) => { doneResult = result; },
		tui: host,
	});
	assert.equal(host.focused, component, "component requests focus in custom TUI host");

	let table = renderText(component, 110);
	assert.match(table, /Skill\s+Global\*?\s+This folder\*?\s+Effective\s+Scope\s+Enforce/, "table has required policy columns");
	assert.match(table, /showing 1-10 of 21 matching skills/, "long list is bounded with result count");
	assert.ok(!table.includes("Alpha full description"), "main table does not render descriptions");
	assertWidthSafe(component, [50, 110]);

	component.handleInput("/");
	for (const ch of "special") component.handleInput(ch);
	component.handleInput("\r");
	table = renderText(component, 100);
	assert.match(table, /special-skill/, "search filters over the full list, not just visible rows");
	assert.match(table, /showing 1-1 of 1 matching skills/, "search result count is shown");
	component.handleInput("\r");
	let detail = renderText(component, 100);
	assert.match(detail, /Description/, "detail view has description section");
	assert.match(detail, /Special searchable description/, "detail view renders full description");
	assert.match(detail, /Source:/, "detail shows source label");
	assert.match(detail, /Path:/, "detail shows path");
	assert.match(detail, /Global default\s+enabled/, "detail shows global default");
	assert.match(detail, /This folder\s+inherit/, "detail shows folder override");
	assert.match(detail, /Effective state\s+enabled by global\/default/, "detail shows effective state and winner");
	assert.match(detail, /Enforcement\s+active/, "detail shows enforcement mode");
	assert.match(detail, /Disable this source globally/, "detail exposes source-related actions");
	component.handleInput("\x1B");
	assert.match(renderText(component, 100), /Manage Skills/, "escape returns from detail to table");

	component.handleInput("/");
	for (let i = 0; i < "special".length; i++) component.handleInput("\x7f");
	for (const ch of "alpha") component.handleInput(ch);
	component.handleInput("\r");
	component.handleInput(" ");
	await component.waitForIdle();
	assert.equal(savedStates.length, 1, "space cycle saves immediately");
	const folderRules = Object.values(savedStates.at(-1).skillPolicy.folders)[0];
	assert.equal(folderRules.skills[paths[0]], "disabled", "table cycle writes selected skill folder override");
	component.handleInput("\t");
	component.handleInput(" ");
	await component.waitForIdle();
	assert.equal(savedStates.length, 2, "tab to global column plus space saves immediately");
	assert.equal(savedStates.at(-1).skillPolicy.global.skills[paths[0]], "disabled", "global column cycle writes global default");

	component.handleInput("/");
	for (const ch of "empty") component.handleInput(ch);
	component.handleInput("\r");
	component.handleInput("\r");
	detail = renderText(component, 100);
	assert.match(detail, /\(no description\)/, "missing descriptions render a clear placeholder");
	assertWidthSafe(component, [42, 120]);
	component.handleInput("\x1B");
	component.handleInput("\x1B");
	assert.deepEqual(doneResult, { changed: true }, "escape exits table without rolling back saved changes");

	const failingState = defaultState();
	skills = await buildSkillList(pi, paths.slice(0, 2), [], failingState.skillPolicy, tmp, [sourceRoot]);
	sources = buildSourceList(skills, [sourceRoot], failingState.skillPolicy, tmp);
	let failedDone;
	const failingComponent = createManageSkillsTui({
		cwd: tmp,
		skills,
		sources,
		state: failingState,
		saveState: async () => { throw new Error("disk is read-only"); },
		done: (result) => { failedDone = result; },
		tui: makeHost(),
	});
	failingComponent.handleInput(" ");
	await failingComponent.waitForIdle();
	const failedRender = renderText(failingComponent, 160);
	assert.match(failedRender, /Save failed: disk is read-only/, "failed writes surface an error");
	assert.ok(!failedRender.includes("Saved "), "failed writes do not show durable success");
	failingComponent.handleInput("\x1B");
	assert.equal(failedDone, undefined, "escape does not hide an unsaved failed policy change");

	console.log("manage skills tui tests ok");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
