/**
 * Skill Manager Spike Extension
 *
 * Purpose: empirically test the mechanics needed to make skill toggling enforceable in Pi
 * before changing the production plugin manager.
 *
 * What it proves:
 * 1. A manager-owned skill can disappear from `/skill:<name>` commands after reload by
 *    omitting its path from `resources_discover`.
 * 2. A Pi-native/package/external skill can be disabled by policy, blocked before invocation,
 *    and stripped from the prompt, but an extension cannot currently remove that skill from
 *    Pi core's startup resource list or command registry if another loader contributed it.
 * 3. Disabled `/skill:<name>` invocations can be blocked immediately by intercepting the
 *    `input` event before Pi expands skill commands.
 * 4. Disabled skill XML can still be stripped from the system prompt as a safety fallback.
 *
 * Try manually:
 *   pi -e ./spikes/skill-manager-spike.ts
 *   /skill-spike status
 *   /skill-spike disable
 *   /reload
 *   /skill-spike status
 *   /skill:spike-managed
 *
 * Test an existing skill such as ctx-index:
 *   /skill-spike status ctx-index
 *   /skill-spike disable ctx-index
 *   /reload
 *   /skill-spike status ctx-index
 *   /skill:ctx-index
 *
 * Expected ctx-index result: it may still appear in Pi's startup [Skills] list and command
 * registry, but `/skill:ctx-index` should be blocked by this extension before expansion.
 *
 * Automated smoke:
 *   ./spikes/skill-manager-spike-smoke.sh
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CUSTOM_TYPE = "skill-manager-spike";
const FIXTURE_SKILL_NAME = "spike-managed";
const STATE_FILE = "state.json";

type SpikeState = {
	disabledSkillNames: Record<string, true>;
	disabledSkillPaths: Record<string, true>;
	disabledSourcePaths: Record<string, true>;
	blockSlashCommands: boolean;
};

type SkillCommandSnapshot = {
	name: string;
	commandName: string;
	description?: string;
	path?: string;
	sourceLabel: string;
	source: string;
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function spikeRoot(): string {
	return path.join(agentDir(), "skill-manager-spike");
}

function fixtureSkillSourceRoot(): string {
	return path.join(spikeRoot(), "skills");
}

function fixtureSkillDir(): string {
	return path.join(fixtureSkillSourceRoot(), FIXTURE_SKILL_NAME);
}

function fixtureSkillPath(): string {
	return path.join(fixtureSkillDir(), "SKILL.md");
}

function statePath(): string {
	return path.join(spikeRoot(), STATE_FILE);
}

function defaultState(): SpikeState {
	return {
		disabledSkillNames: {},
		disabledSkillPaths: {},
		disabledSourcePaths: {},
		blockSlashCommands: true,
	};
}

async function ensureFixtureSkill(): Promise<void> {
	await mkdir(fixtureSkillDir(), { recursive: true });
	await writeFile(
		fixtureSkillPath(),
		`---
name: ${FIXTURE_SKILL_NAME}
description: Spike fixture skill used to test whether skill manager toggles remove slash commands and block disabled invocations.
---

# Spike Managed Skill

If this text is loaded while the spike state says the skill is disabled, the manager failed to enforce the toggle.
`,
		"utf8",
	);
}

async function readState(): Promise<SpikeState> {
	try {
		const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<SpikeState>;
		return {
			...defaultState(),
			...parsed,
			disabledSkillNames: parsed.disabledSkillNames ?? {},
			disabledSkillPaths: parsed.disabledSkillPaths ?? {},
			disabledSourcePaths: parsed.disabledSourcePaths ?? {},
			blockSlashCommands: parsed.blockSlashCommands ?? true,
		};
	} catch {
		return defaultState();
	}
}

async function writeState(state: SpikeState): Promise<void> {
	await mkdir(spikeRoot(), { recursive: true });
	await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function emit(pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<void> {
	if (ctx.hasUI) {
		pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true });
	} else {
		console.log(text);
	}
}

function parseArgs(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean);
}

function normalizeSkillName(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/^\//, "").replace(/^skill:/, "").toLowerCase();
}

function nameFromCommandName(commandName: string): string {
	return commandName.replace(/^skill:/, "").toLowerCase();
}

function skillCommands(pi: ExtensionAPI): SkillCommandSnapshot[] {
	return pi.getCommands()
		.filter((cmd) => cmd.source === "skill")
		.map((cmd) => ({
			name: nameFromCommandName(cmd.name),
			commandName: cmd.name,
			description: cmd.description,
			path: cmd.sourceInfo?.path,
			sourceLabel: cmd.sourceInfo?.source ?? "unknown",
			source: cmd.source,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkillCommand(pi: ExtensionAPI, skillName: string): SkillCommandSnapshot | undefined {
	return skillCommands(pi).find((cmd) => cmd.name === skillName);
}

function sourceDisabledForPath(skillPath: string | undefined, state: SpikeState): string | undefined {
	if (!skillPath) return undefined;
	return Object.keys(state.disabledSourcePaths).find((sourcePath) => (
		state.disabledSourcePaths[sourcePath] === true && (skillPath === sourcePath || skillPath.startsWith(sourcePath + "/"))
	));
}

function isDisabledByState(state: SpikeState, skillName: string | undefined, skillPath: string | undefined): boolean {
	if (skillName && state.disabledSkillNames[skillName] === true) return true;
	if (skillPath && state.disabledSkillPaths[skillPath] === true) return true;
	if (sourceDisabledForPath(skillPath, state)) return true;
	return false;
}

function isFixtureDisabled(state: SpikeState): boolean {
	return isDisabledByState(state, FIXTURE_SKILL_NAME, fixtureSkillPath()) || sourceDisabledForPath(fixtureSkillPath(), state) !== undefined;
}

function parseSkillInvocation(input: string): string | undefined {
	const match = input.trim().match(/^\/skill:([^\s]+)(?:\s|$)/);
	return normalizeSkillName(match?.[1]);
}

function stripDisabledSkillXml(systemPrompt: string, state: SpikeState): string {
	return systemPrompt.replace(/<skill>\s*\n([\s\S]*?)<\/skill>/g, (match, inner: string) => {
		const nameMatch = inner.match(/<name>(.*?)<\/name>/);
		const locationMatch = inner.match(/<location>(.*?)<\/location>/);
		const name = normalizeSkillName(nameMatch?.[1]);
		const location = locationMatch?.[1]?.trim();
		if (isDisabledByState(state, name, location)) return "";
		return match;
	});
}

function controlLevelForSkill(skill: SkillCommandSnapshot | undefined, skillName: string): string {
	if (skillName === FIXTURE_SKILL_NAME) {
		return "manager-owned fixture: can remove from command registry after reload via resources_discover";
	}
	if (!skill) {
		return "not currently visible in pi.getCommands(); can still store disabled name policy";
	}
	return "external/Pi-native/package skill: extension can block invocation and strip prompt, but cannot remove Pi core command/header entry";
}

async function formatStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, requestedName?: string): Promise<string> {
	await ensureFixtureSkill();
	const state = await readState();
	const targetName = normalizeSkillName(requestedName) ?? FIXTURE_SKILL_NAME;
	const skill = findSkillCommand(pi, targetName);
	const skillPath = targetName === FIXTURE_SKILL_NAME ? fixtureSkillPath() : skill?.path;
	const disabledByName = state.disabledSkillNames[targetName] === true;
	const disabledByPath = skillPath ? state.disabledSkillPaths[skillPath] === true : false;
	const disabledBySource = sourceDisabledForPath(skillPath, state);
	const disabled = isDisabledByState(state, targetName, skillPath);
	const commands = skillCommands(pi);
	const options = ctx.getSystemPromptOptions();
	const promptSkills = ((options as unknown as { skills?: Array<{ name?: string; path?: string; location?: string }> }).skills ?? []);
	const promptSkill = promptSkills.find((candidate) => (
		normalizeSkillName(candidate.name) === targetName || candidate.path === skillPath || candidate.location === skillPath
	));

	return [
		"# Skill manager spike status",
		"",
		`target skill: ${targetName}`,
		`control level: ${controlLevelForSkill(skill, targetName)}`,
		`state: ${statePath()}`,
		`skill path: ${skillPath ?? "unknown"}`,
		`source path: ${targetName === FIXTURE_SKILL_NAME ? fixtureSkillSourceRoot() : disabledBySource ?? "unknown"}`,
		`disabled by skill name: ${disabledByName ? "yes" : "no"}`,
		`disabled by skill path: ${disabledByPath ? "yes" : "no"}`,
		`disabled by source path: ${disabledBySource ? `yes (${disabledBySource})` : "no"}`,
		`effective disabled: ${disabled ? "yes" : "no"}`,
		`resource_discover can hide this skill: ${targetName === FIXTURE_SKILL_NAME ? "yes" : "no"}`,
		`resource_discover enabled for fixture: ${isFixtureDisabled(state) ? "no" : "yes"}`,
		`slash blocker enabled: ${state.blockSlashCommands ? "yes" : "no"}`,
		`slash command present: ${skill ? "yes" : "no"}`,
		`base prompt options skill present (pre-filter): ${promptSkill ? "yes" : "no"}`,
		`before_agent_start strip policy active: ${disabled ? "yes" : "no"}`,
		`total skill commands visible to pi.getCommands(): ${commands.length}`,
		"",
		"Visible skill commands:",
		...commands.map((cmd) => `- /${cmd.commandName}${cmd.path ? ` (${cmd.path})` : ""}`),
		"",
		"Commands:",
		"/skill-spike status [skill-name]      # inspect fixture or an existing skill such as ctx-index",
		"/skill-spike disable [skill-name]     # disable fixture or named skill",
		"/skill-spike enable [skill-name]      # re-enable fixture or named skill",
		"/skill-spike disable-source [path]    # disable fixture source or explicit source directory",
		"/skill-spike enable-source [path]     # re-enable fixture source or explicit source directory",
		"/skill-spike block-on                 # block disabled /skill:<name> invocations in input hook",
		"/skill-spike block-off                # allow disabled slash invocations through (negative control)",
		"/skill-spike reset                    # clear all spike state",
		"/skill-spike reload                   # call ctx.reload(); terminal for this handler",
	].join("\n");
}

function applyDisable(pi: ExtensionAPI, state: SpikeState, rawName: string | undefined): string {
	const skillName = normalizeSkillName(rawName) ?? FIXTURE_SKILL_NAME;
	const skill = skillName === FIXTURE_SKILL_NAME ? undefined : findSkillCommand(pi, skillName);
	state.disabledSkillNames[skillName] = true;
	if (skillName === FIXTURE_SKILL_NAME) state.disabledSkillPaths[fixtureSkillPath()] = true;
	if (skill?.path) state.disabledSkillPaths[skill.path] = true;
	return skillName;
}

function applyEnable(pi: ExtensionAPI, state: SpikeState, rawName: string | undefined): string {
	const skillName = normalizeSkillName(rawName) ?? FIXTURE_SKILL_NAME;
	const skill = skillName === FIXTURE_SKILL_NAME ? undefined : findSkillCommand(pi, skillName);
	delete state.disabledSkillNames[skillName];
	if (skillName === FIXTURE_SKILL_NAME) delete state.disabledSkillPaths[fixtureSkillPath()];
	if (skill?.path) delete state.disabledSkillPaths[skill.path];
	return skillName;
}

export default function skillManagerSpike(pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return {
			render(width: number) {
				return text.split("\n").map((line) => theme.fg("accent", line.length > width ? line.slice(0, Math.max(0, width - 1)) : line));
			},
			invalidate() {},
		};
	});

	pi.on("session_start", async () => {
		await ensureFixtureSkill();
	});

	pi.on("resources_discover", async () => {
		await ensureFixtureSkill();
		const state = await readState();
		return {
			skillPaths: isFixtureDisabled(state) ? [] : [fixtureSkillPath()],
		};
	});

	pi.on("input", async (event, ctx) => {
		const invokedSkillName = parseSkillInvocation(event.text);
		if (!invokedSkillName) return { action: "continue" };

		const state = await readState();
		const skill = findSkillCommand(pi, invokedSkillName);
		const skillPath = invokedSkillName === FIXTURE_SKILL_NAME ? fixtureSkillPath() : skill?.path;
		if (!isDisabledByState(state, invokedSkillName, skillPath) || !state.blockSlashCommands) {
			return { action: "continue" };
		}

		await emit(
			pi,
			ctx,
			`Blocked disabled skill invocation: /skill:${invokedSkillName}\n\nThis proves an extension can enforce disabled skill slash commands before Pi expands them.`,
		);
		return { action: "handled" };
	});

	pi.on("before_agent_start", async (event) => {
		const state = await readState();
		const hasDisabled = Object.keys(state.disabledSkillNames).length > 0 ||
			Object.keys(state.disabledSkillPaths).length > 0 ||
			Object.keys(state.disabledSourcePaths).length > 0;
		if (!hasDisabled) return;
		const filtered = stripDisabledSkillXml(event.systemPrompt, state);
		if (filtered !== event.systemPrompt) return { systemPrompt: filtered };
	});

	pi.registerCommand("skill-spike", {
		description: "Spike: test enforceable skill toggling and disabled /skill command blocking",
		handler: async (rawArgs, ctx) => {
			const [command = "status", arg] = parseArgs(rawArgs);
			await ensureFixtureSkill();
			const state = await readState();

			if (command === "status" || command === "help") {
				await emit(pi, ctx, await formatStatus(pi, ctx, arg));
				return;
			}

			if (command === "disable") {
				const skillName = applyDisable(pi, state, arg);
				await writeState(state);
				await emit(pi, ctx, `Disabled skill policy for ${skillName}. Run /reload, then /skill-spike status ${skillName}.`);
				return;
			}

			if (command === "enable") {
				const skillName = applyEnable(pi, state, arg);
				await writeState(state);
				await emit(pi, ctx, `Enabled skill policy for ${skillName}. Run /reload, then /skill-spike status ${skillName}.`);
				return;
			}

			if (command === "disable-source") {
				const sourcePath = arg ? path.resolve(arg.replace(/^~(?=\/|$)/, os.homedir())) : fixtureSkillSourceRoot();
				state.disabledSourcePaths[sourcePath] = true;
				await writeState(state);
				await emit(pi, ctx, `Disabled source policy for ${sourcePath}. Run /reload, then /skill-spike status.`);
				return;
			}

			if (command === "enable-source") {
				const sourcePath = arg ? path.resolve(arg.replace(/^~(?=\/|$)/, os.homedir())) : fixtureSkillSourceRoot();
				delete state.disabledSourcePaths[sourcePath];
				await writeState(state);
				await emit(pi, ctx, `Enabled source policy for ${sourcePath}. Run /reload, then /skill-spike status.`);
				return;
			}

			if (command === "block-on") {
				state.blockSlashCommands = true;
				await writeState(state);
				await emit(pi, ctx, "Enabled disabled-skill slash command blocker.");
				return;
			}

			if (command === "block-off") {
				state.blockSlashCommands = false;
				await writeState(state);
				await emit(pi, ctx, "Disabled disabled-skill slash command blocker (negative control).");
				return;
			}

			if (command === "reset") {
				await writeState(defaultState());
				await emit(pi, ctx, "Reset spike state. Run /reload, then /skill-spike status.");
				return;
			}

			if (command === "reload") {
				await ctx.reload();
				return;
			}

			throw new Error(`Unknown /skill-spike command: ${command}`);
		},
	});
}
