import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "manage-skills-tui-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

function skillFile(root, dir, name, description) {
	const file = path.join(root, dir, "SKILL.md");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${name} body\n`, "utf8");
	return path.resolve(file);
}

function rawSkillFile(root, dir, frontmatter, body = "body") {
	const file = path.join(root, dir, "SKILL.md");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
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

function stripAnsi(value) {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function setSearch(component, query) {
	component.handleInput("/");
	component.handleInput("\x15");
	for (const ch of query) component.handleInput(ch);
	component.handleInput("\r");
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
	paths.push(rawSkillFile(sourceRoot, "code-doc", `name: code-doc\ndescription: >\n  Generates comprehensive documentation for any codebase via hybrid analysis\n  (native extractors + LLM agents). Triggers on phrases like "document this codebase",\n  "generate documentation", or "create architecture docs".`));
	for (let i = 0; i < 18; i++) paths.push(skillFile(sourceRoot, `skill-${i}`, `skill-${i}`, `Description ${i}`));
	paths.push(skillFile(sourceRoot, "special", "special-skill", "Special searchable description"));
	paths.push(skillFile(sourceRoot, "description-only", "boring-name", "Needle only appears in this description"));

	const pi = { getCommands: () => [] };
	let state = defaultState();
	let skills = await buildSkillList(pi, paths, [], state.skillPolicy, tmp, [sourceRoot]);
	let sources = buildSourceList(skills, [sourceRoot], state.skillPolicy, tmp);
	const folded = skills.find((skill) => skill.name === "code-doc");
	assert.ok(folded, "folded YAML test skill is discovered");
	assert.notEqual(folded.description, ">", "folded YAML description is not stored as the block marker");
	assert.match(folded.description, /Generates comprehensive documentation.*native extractors \+ LLM agents/s, "folded YAML description is parsed into full text");

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
	assert.match(dashboard, /Search all 23 skills/, "search field advertises full-inventory scope");
	assert.match(dashboard, /Skill\s+Current\s+Rule\s+Source/, "skill table uses user-facing policy labels");
	assert.doesNotMatch(dashboard, /Skill\s+G\s+F\s+Eff\s+Source/, "old compact policy columns are gone");
	assert.match(dashboard, /1-8 of 23 matching skills/, "wide dashboard shows the increased row limit");
	assert.ok(component.render(72).length <= 21, "80-col terminal at 90% overlay width keeps footer inside a 24-row 90% height cap");
	assert.ok(component.render(54).length <= 21, "60-col terminal at 90% overlay width keeps footer inside a 24-row 90% height cap");
	assert.ok(component.render(90).length <= 21, "100-col terminal at 90% overlay width keeps footer inside a 24-row 90% height cap");
	assert.match(dashboard, /Description/, "right detail pane is visible without opening a second page");
	assert.match(dashboard, /Alpha full description/, "selected skill description appears in the detail pane");
	assert.doesNotMatch(dashboard, /TAIL-MARKER-ALPHA-DESCRIPTION/, "dashboard detail preview stays compact");
	assert.doesNotMatch(dashboard, /g global|Enter actions|Set source globally|G\s+F\s+Eff/, "main dashboard does not advertise old global/source/action shortcuts");
	assert.match(renderText(component, 50), /Esc close/, "narrow dashboard footer keeps the close shortcut visible");
	assert.match(renderText(component, 72), /Esc close/, "common-width dashboard footer keeps the close shortcut visible");
	const selectedAlphaLine = dashboard.split("\n").find((line) => line.includes("❯ alpha")) ?? "";
	const leftPaneSegment = selectedAlphaLine.split("│")[1] ?? selectedAlphaLine;
	assert.ok(!leftPaneSegment.includes("Alpha full description"), "skill table row does not inline descriptions");
	assertWidthSafe(component, [50, 86, 120]);

	component.handleInput("s");
	component.handleInput("p");
	dashboard = renderText(component, 120);
	assert.match(dashboard, /23\/23 matching/, "plain typing before slash does not start or mutate search");
	assert.doesNotMatch(dashboard, /Search all 23 skills: sp/, "plain typing is ignored until slash activates search");

	component.handleInput("/");
	let searchMode = renderText(component, 110);
	assert.match(searchMode, /Esc close search\s+• Type filter all skills\s+• Backspace delete\s+• Ctrl-U clear\s+• Enter apply/, "active search mode shows search-specific key hints");
	assert.match(renderText(component, 72), /Esc close search/, "common-width search footer keeps the close-search shortcut visible");
	assert.doesNotMatch(searchMode, /Space toggle this folder|Enter details|a advanced|r reset/, "search footer does not advertise dashboard mutation keys");
	for (const ch of "special") component.handleInput(ch);
	component.handleInput("\r");
	dashboard = renderText(component, 110);
	assert.match(dashboard, /special-skill/, "slash-activated global search finds an off-screen skill by name");
	assert.match(dashboard, /1-1 of 1 matching skills/, "search result count is shown");
	assert.match(dashboard, /Special searchable description/, "detail pane follows the globally filtered selection");
	component.handleInput("\r");
	let details = renderText(component, 110);
	assert.match(details, /Details: special-skill/, "enter opens read-only details");
	assert.match(details, /Special searchable description/, "details include the selected skill description");
	assert.doesNotMatch(details, /Actions for|Set source globally|Source: disable globally/, "enter no longer opens the policy action drawer");
	component.handleInput("\x1B");
	assert.match(renderText(component, 110), /Skill Manager/, "escape returns from details to dashboard");

	setSearch(component, "Needle");
	dashboard = renderText(component, 110);
	assert.match(dashboard, /boring-name/, "global search scans descriptions across all skills, not only visible rows");
	assert.match(dashboard, /Needle only appears in this description/, "description-only match is selected in the detail pane");

	setSearch(component, "code-doc");
	component.handleInput("\r");
	details = renderText(component, 120);
	assert.match(details, /Details: code-doc/, "enter opens details for folded-description skills");
	assert.match(details, /Generates comprehensive documentation/, "details show folded block description content");
	assert.match(details, /native extractors \+ LLM agents/, "details show more than the folded block marker");
	component.handleInput("\x1B");

	setSearch(component, "alpha");
	component.handleInput(" ");
	await component.waitForIdle();
	assert.equal(savedStates.length, 1, "space saves this-folder override immediately");
	let folderRules = Object.values(savedStates.at(-1).skillPolicy.folders)[0];
	assert.equal(folderRules.skills[paths[0]], "disabled", "space toggles effective enabled skill to disabled in this folder");
	component.handleInput(" ");
	await component.waitForIdle();
	assert.equal(savedStates.length, 2, "space can toggle back from effective disabled to enabled");
	folderRules = Object.values(savedStates.at(-1).skillPolicy.folders)[0];
	assert.equal(folderRules.skills[paths[0]], "enabled", "second space toggles effective disabled skill to enabled in this folder");
	component.handleInput("r");
	await component.waitForIdle();
	assert.equal(savedStates.length, 3, "r saves a reset of the this-folder override");
	folderRules = Object.values(savedStates.at(-1).skillPolicy.folders)[0];
	assert.equal(folderRules.skills[paths[0]], undefined, "r resets the selected skill to inherit for this folder");
	component.handleInput("g");
	component.handleInput("s");
	await component.waitForIdle();
	assert.equal(savedStates.length, 3, "dashboard g/s keys do not mutate hidden global/source policy");

	component.handleInput("a");
	let advanced = renderText(component, 110);
	assert.match(advanced, /Advanced policy: alpha/, "a opens the advanced policy screen");
	assert.match(advanced, /Set global default: disabled/, "advanced screen contains global controls");
	assert.match(advanced, /Set source globally: disabled/, "advanced screen contains source controls");
	assertWidthSafe(component, [72, 110]);
	component.handleInput("\x1B");
	assert.match(renderText(component, 110), /Skill Manager/, "escape returns from advanced screen to dashboard");

	component.handleInput("\r");
	details = renderText(component, 72);
	assert.match(details, /Details: alpha/, "enter opens the full details drawer");
	assert.ok(component.render(72).length <= 21, "details drawer keeps footer visible inside the 90% overlay cap");
	for (let i = 0; i < 20; i++) component.handleInput("\x1B[B");
	details = renderText(component, 72);
	assert.match(details, /TAIL-MARKER-ALPHA-DESCRIPTION/, "details drawer can scroll to the complete description tail");
	component.handleInput("\x1B");

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
	const themedRaw = renderText(themedComponent, 120);
	assert.match(themedRaw, /\x1b\[/, "themed shortcut legend uses ANSI styling through the theme callback");
	let themedPlain = stripAnsi(themedRaw);
	assert.match(themedPlain, /Esc close\s+• Space toggle this folder\s+• Enter details\s+• \/ search\s+• a advanced\s+• r reset/, "stripped shortcut legend remains clear");
	themedComponent.handleInput("/");
	themedPlain = stripAnsi(renderText(themedComponent, 120));
	assert.match(themedPlain, /Esc close search\s+• Type filter all skills\s+• Backspace delete\s+• Ctrl-U clear\s+• Enter apply/, "themed search footer switches to search-specific hints");
	assert.doesNotMatch(themedPlain, /Space toggle this folder|Enter details|a advanced|r reset/, "themed search footer hides dashboard mutation hints");
	assertWidthSafe(themedComponent, [50, 86, 120]);

	setSearch(component, "empty");
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
