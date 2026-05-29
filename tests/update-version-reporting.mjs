import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function git(cwd, args) {
	execFileSync("git", args, {
		cwd,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Pi Test",
			GIT_AUTHOR_EMAIL: "pi-test@example.invalid",
			GIT_COMMITTER_NAME: "Pi Test",
			GIT_COMMITTER_EMAIL: "pi-test@example.invalid",
		},
	});
}

async function writePlugin(repoPath, version) {
	await mkdir(path.join(repoPath, ".claude-plugin"), { recursive: true });
	await mkdir(path.join(repoPath, "plugins/demo/.claude-plugin"), { recursive: true });
	await writeFile(
		path.join(repoPath, ".claude-plugin/marketplace.json"),
		`${JSON.stringify({
			name: "fixture-marketplace",
			description: "Fixture marketplace",
			plugins: [{ name: "demo", version, source: "plugins/demo", description: "Demo plugin" }],
		}, null, 2)}\n`,
	);
	await writeFile(
		path.join(repoPath, "plugins/demo/.claude-plugin/plugin.json"),
		`${JSON.stringify({ name: "demo", version, description: "Demo manifest" }, null, 2)}\n`,
	);
}

async function runPluginCommand(args, cwd) {
	const logs = [];
	const originalLog = console.log;
	console.log = (...parts) => logs.push(parts.join(" "));
	try {
		await handleCommand({}, args, { hasUI: false, cwd, reload: async () => {} });
	} finally {
		console.log = originalLog;
	}
	return logs.join("\n");
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-update-version-reporting-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

const commandsModule = await import("../src/commands.ts");
const stateModule = await import("../src/state.ts");
const { handleCommand } = commandsModule.default ?? commandsModule;
const { writeState } = stateModule.default ?? stateModule;

try {
	const remoteWork = path.join(tmp, "remote-work");
	const remoteBare = path.join(tmp, "remote.git");
	const cacheCheckout = path.join(tmp, "cache-checkout");
	await mkdir(remoteWork, { recursive: true });
	git(remoteWork, ["init", "-b", "main"]);
	await writePlugin(remoteWork, "1.0.0");
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "initial plugin"]);
	git(tmp, ["clone", "--bare", remoteWork, remoteBare]);
	git(tmp, ["clone", remoteBare, cacheCheckout]);
	git(remoteWork, ["remote", "add", "origin", remoteBare]);

	await writeState({
		version: 1,
		marketplaces: {
			"fixture-marketplace": {
				name: "fixture-marketplace",
				description: "Fixture marketplace",
				source: { kind: "git", input: "fixture", url: remoteBare },
				path: cacheCheckout,
				addedAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		},
		plugins: {},
		enabledPlugins: {},
		disabledSkills: {},
		disabledSkillSources: {},
	});

	await runPluginCommand("install demo@fixture-marketplace", tmp);

	await writePlugin(remoteWork, "1.1.0");
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "bump demo plugin"]);
	git(remoteWork, ["push", "origin", "main"]);

	const changedOutput = await runPluginCommand("update demo@fixture-marketplace", tmp);
	if (!changedOutput.includes("Plugin versions:")) throw new Error(`missing version summary:\n${changedOutput}`);
	if (!changedOutput.includes("demo@fixture-marketplace (user): 1.0.0 → 1.1.0")) {
		throw new Error(`missing changed version line:\n${changedOutput}`);
	}

	const unchangedOutput = await runPluginCommand("update demo@fixture-marketplace", tmp);
	if (!unchangedOutput.includes("demo@fixture-marketplace (user): unchanged 1.1.0")) {
		throw new Error(`missing unchanged version line:\n${unchangedOutput}`);
	}

	console.log("update version reporting smoke ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
