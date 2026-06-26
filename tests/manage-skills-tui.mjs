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

function makeHost(initialFocus) {
	return { renders: 0, focused: initialFocus, requestRender() { this.renders++; }, setFocus(component) { this.focused = component; } };
}

function simulateOverlayLifecycle(host, component) {
	const preFocus = host.focused;
	host.setFocus(component);
	host.setFocus(preFocus);
}

const ansiTheme = {
	fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
	bg: (_color, text) => `\x1b[7m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

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
	paths.push(skillFile(sourceRoot, "alpha", "alpha", "Alpha full description that belongs only in the detail pane. This long description has enough words to wrap across many lines in the bounded full description drawer so keyboard scrolling can reveal the final tail marker after several down-arrow presses. TAIL-MARKER-ALPHA-DESCRIPTION"));
	paths.push(skillFile(sourceRoot, "empty", "empty", ""));
	for (let i = 0; i < 18; i++) paths.push(skillFile(sourceRoot, `skill-${i}`, `skill-${i}`, `Description ${i}`));
	paths.push(skillFile(sourceRoot, "special", "special-skill", "Special searchable description"));
	paths.push(skillFile(sourceRoot, "description-only", "boring-name", "Needle only appears in this description"));

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
	assert.equal(host.focused, undefined, "component does not request focus before Pi mounts the overlay");
	const editorFocusTarget = { name: "editor" };
	const overlayHost = makeHost(editorFocusTarget);
	const overlayComponent = createManageSkillsTui({
		cwd: tmp,
		skills,
		sources,
		state,
		saveState: async () => {},
		done: () => {},
		tui: overlayHost,
	});
	simulateOverlayLifecycle(overlayHost, overlayComponent);
	assert.equal(overlayHost.focused, editorFocusTarget, "overlay close restores the prior editor focus target");

	let dashboard = renderText(component, 120);
	assert.match(dashboard, /Skill Manager/, "dashboard has a modal title");
	assert.match(dashboard, /Search all 22 skills/, "search field advertises full-inventory scope");
	assert.match(dashboard, /Skill\s+G\s+F\s+Eff\s+Source/, "skill table has compact policy columns");
	assert.match(dashboard, /1-6 of 22 matching skills/, "long list is bounded with result count");
	assert.ok(component.render(72).length <= 19, "80-col terminal at 90% overlay width keeps footer inside a 24-row 80% height cap");
	assert.ok(component.render(54).length <= 19, "60-col terminal at 90% overlay width keeps footer inside a 24-row 80% height cap");
	assert.ok(component.render(90).length <= 19, "100-col terminal at 90% overlay width keeps footer inside a 24-row 80% height cap");
	assert.match(dashboard, /Description/, "right detail pane is visible without opening a second page");
	assert.match(dashboard, /Alpha full description/, "selected skill description appears in the detail pane");
	assert.doesNotMatch(dashboard, /TAIL-MARKER-ALPHA-DESCRIPTION/, "dashboard detail preview stays compact");
	const selectedAlphaLine = dashboard.split("\n").find((line) => line.includes("❯ alpha")) ?? "";
	const leftPaneSegment = selectedAlphaLine.split("│")[1] ?? selectedAlphaLine;
	assert.ok(!leftPaneSegment.includes("Alpha full description"), "skill table row does not inline descriptions");
	assertWidthSafe(component, [50, 86, 120]);
	component.handleInput("d");
	let descriptionDrawer = renderText(component, 72);
	assert.match(descriptionDrawer, /Description: alpha/, "d opens the full description drawer");
	assert.ok(component.render(72).length <= 19, "description drawer keeps footer visible inside overlay cap");
	for (let i = 0; i < 20; i++) component.handleInput("\x1B[B");
	descriptionDrawer = renderText(component, 72);
	assert.match(descriptionDrawer, /TAIL-MARKER-ALPHA-DESCRIPTION/, "full description drawer can scroll to the complete description tail");
	component.handleInput("\x1B");
	assert.match(renderText(component, 110), /Skill Manager/, "escape returns from full description drawer to dashboard");
	const themedComponent = createManageSkillsTui({
		cwd: tmp,
		skills,
		sources,
		state,
		saveState: async () => {},
		done: () => {},
		tui: makeHost(),
		theme: ansiTheme,
	});
	assertWidthSafe(themedComponent, [50, 86, 120]);

	component.handleInput("/");
	for (const ch of "special") component.handleInput(ch);
	component.handleInput("\r");
	dashboard = renderText(component, 110);
	assert.match(dashboard, /special-skill/, "global search finds an off-screen skill by name");
	assert.match(dashboard, /1-1 of 1 matching skills/, "search result count is shown");
	assert.match(dashboard, /Special searchable description/, "detail pane follows the globally filtered selection");
	component.handleInput("\r");
	let drawer = renderText(component, 110);
	assert.match(drawer, /Actions for special-skill/, "enter opens the action drawer");
	assert.match(drawer, /Source: disable globally/, "action drawer exposes source-related actions");
	component.handleInput("\x1B");
	assert.match(renderText(component, 110), /Skill Manager/, "escape returns from actions to dashboard");

	component.handleInput("/");
	for (let i = 0; i < "special".length; i++) component.handleInput("\x7f");
	for (const ch of "Needle") component.handleInput(ch);
	component.handleInput("\r");
	dashboard = renderText(component, 110);
	assert.match(dashboard, /boring-name/, "global search scans descriptions across all skills, not only visible rows");
	assert.match(dashboard, /Needle only appears in this description/, "description-only match is selected in the detail pane");

	component.handleInput("/");
	for (let i = 0; i < "Needle".length; i++) component.handleInput("\x7f");
	for (const ch of "alpha") component.handleInput(ch);
	component.handleInput("\r");
	component.handleInput(" ");
	await component.waitForIdle();
	assert.equal(savedStates.length, 1, "space cycle saves this-folder override immediately");
	const folderRules = Object.values(savedStates.at(-1).skillPolicy.folders)[0];
	assert.equal(folderRules.skills[paths[0]], "disabled", "space writes selected skill folder override");
	component.handleInput("g");
	await component.waitForIdle();
	assert.equal(savedStates.length, 2, "g saves global default immediately");
	assert.equal(savedStates.at(-1).skillPolicy.global.skills[paths[0]], "disabled", "g writes selected skill global default");

	component.handleInput("/");
	for (let i = 0; i < "alpha".length; i++) component.handleInput("\x7f");
	for (const ch of "empty") component.handleInput(ch);
	component.handleInput("\r");
	dashboard = renderText(component, 100);
	assert.match(dashboard, /\(no description\)/, "missing descriptions render a clear placeholder in the detail pane");
	assertWidthSafe(component, [42, 120]);
	component.handleInput("\x1B");
	assert.deepEqual(doneResult, { changed: true }, "escape exits dashboard without rolling back saved changes");

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
