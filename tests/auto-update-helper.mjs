import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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

async function writePlugin(repoPath, name, version) {
	await mkdir(path.join(repoPath, `plugins/${name}/.claude-plugin`), { recursive: true });
	await writeFile(
		path.join(repoPath, `plugins/${name}/.claude-plugin/plugin.json`),
		`${JSON.stringify({ name, version, description: `${name} manifest` }, null, 2)}\n`,
	);
}

async function writeMarketplace(repoPath, versions, options = {}) {
	await mkdir(path.join(repoPath, ".claude-plugin"), { recursive: true });
	const plugins = [
		{ name: "demo", version: versions.demo, source: "plugins/demo", description: "Demo plugin" },
		{ name: "bad", version: versions.bad, source: options.badMissing ? "plugins/missing" : "plugins/bad", description: "Bad plugin" },
		{ name: "other", version: versions.other, source: "plugins/other", description: "Other plugin" },
	];
	await writeFile(
		path.join(repoPath, ".claude-plugin/marketplace.json"),
		`${JSON.stringify({ name: "fixture-marketplace", description: "Fixture marketplace", plugins }, null, 2)}\n`,
	);
	await writePlugin(repoPath, "demo", versions.demo);
	if (!options.badMissing) await writePlugin(repoPath, "bad", versions.bad);
	await writePlugin(repoPath, "other", versions.other);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function versionsFor(state, key) {
	return (state.plugins[key] ?? []).map((entry) => ({ scope: entry.scope, projectPath: entry.projectPath, version: entry.version, dev: !!entry.dev, installPath: entry.installPath }));
}

function assertNoInstallTemps(agentDir) {
	const cache = path.join(agentDir, "claude-plugin-manager/cache/fixture-marketplace");
	if (!existsSync(cache)) return;
	const stack = [cache];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			if (name.name.endsWith(".tmp") || name.name.endsWith(".bak")) throw new Error(`left temporary install artifact: ${path.join(dir, name.name)}`);
			if (name.isDirectory()) stack.push(path.join(dir, name.name));
		}
	}
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-auto-update-helper-"));
const agentDir = path.join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const stateModule = await import("../src/state.ts");
const installerModule = await import("../src/installer.ts");
const updateCheckModule = await import("../src/update-check.ts");
const { defaultState, readState, writeState } = stateModule.default ?? stateModule;
const { installPluginFromMarketplace } = installerModule.default ?? installerModule;
const { installDetectedPluginUpdates, runUpdateCheck } = updateCheckModule.default ?? updateCheckModule;

try {
	const remoteWork = path.join(tmp, "remote-work");
	const remoteBare = path.join(tmp, "remote.git");
	const cacheCheckout = path.join(tmp, "cache-checkout");
	const projectDir = path.join(tmp, "project");
	const devProjectDir = path.join(tmp, "dev-project");
	await mkdir(remoteWork, { recursive: true });
	await mkdir(projectDir, { recursive: true });
	await mkdir(devProjectDir, { recursive: true });
	git(remoteWork, ["init", "-b", "main"]);
	await writeMarketplace(remoteWork, { demo: "1.0.0", bad: "1.0.0", other: "1.0.0" });
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "initial marketplace"]);
	git(tmp, ["clone", "--bare", remoteWork, remoteBare]);
	git(tmp, ["clone", remoteBare, cacheCheckout]);
	git(remoteWork, ["remote", "add", "origin", remoteBare]);

	const state = defaultState();
	state.marketplaces["fixture-marketplace"] = {
		name: "fixture-marketplace",
		description: "Fixture marketplace",
		source: { kind: "git", input: "fixture", url: remoteBare },
		path: cacheCheckout,
		addedAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
	await installPluginFromMarketplace(state, "demo@fixture-marketplace", "user", tmp);
	await installPluginFromMarketplace(state, "demo@fixture-marketplace", "project", projectDir);
	await installPluginFromMarketplace(state, "bad@fixture-marketplace", "user", tmp);
	await installPluginFromMarketplace(state, "other@fixture-marketplace", "user", tmp);
	state.plugins["demo@fixture-marketplace"].push({
		...state.plugins["demo@fixture-marketplace"][0],
		scope: "project",
		projectPath: devProjectDir,
		version: "dev",
		dev: true,
		installPath: path.join(tmp, "dev-demo"),
		devSourcePath: path.join(tmp, "dev-demo-source"),
	});
	await writeState(state);

	await writeMarketplace(remoteWork, { demo: "1.1.0", bad: "1.1.0", other: "1.1.0" }, { badMissing: true });
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "bump with bad source"]);
	git(remoteWork, ["push", "origin", "main"]);

	const detected = await runUpdateCheck(await readState(), true);
	assert(detected["demo@fixture-marketplace"], "runUpdateCheck did not detect demo update");
	assert(detected["bad@fixture-marketplace"], "runUpdateCheck did not detect bad update");
	assert(detected["other@fixture-marketplace"], "runUpdateCheck did not detect other update");

	const targeted = {
		"bad@fixture-marketplace": detected["bad@fixture-marketplace"],
		"demo@fixture-marketplace": detected["demo@fixture-marketplace"],
	};
	const partial = await installDetectedPluginUpdates(targeted, { cwd: tmp });
	assert(partial.refreshedMarketplaces.length === 1, `expected one refreshed marketplace, got ${partial.refreshedMarketplaces.length}`);
	assert(partial.attemptedEntries === 3, `expected bad + two demo attempts, got ${partial.attemptedEntries}`);
	assert(partial.successfulEntries === 2, `expected two successful demo entries, got ${partial.successfulEntries}`);
	assert(partial.failures.length === 1 && partial.failures[0].key === "bad@fixture-marketplace", `expected one bad failure: ${JSON.stringify(partial.failures)}`);
	assert(partial.skippedDevEntries === 1, `expected one dev skip, got ${partial.skippedDevEntries}`);
	assert(partial.cacheCleared && partial.reloadRecommended, "successes should clear runtime caches and recommend reload without reloading");

	let updatedState = await readState();
	const demoVersions = versionsFor(updatedState, "demo@fixture-marketplace");
	assert(demoVersions.filter((entry) => !entry.dev && entry.version === "1.1.0").length === 2, `demo non-dev entries were not both updated: ${JSON.stringify(demoVersions)}`);
	assert(demoVersions.some((entry) => entry.dev && entry.version === "dev"), "dev-linked demo entry was not preserved/skipped");
	assert(versionsFor(updatedState, "bad@fixture-marketplace").every((entry) => entry.version === "1.0.0"), "failed bad install should remain on previous version");
	assert(versionsFor(updatedState, "other@fixture-marketplace").every((entry) => entry.version === "1.0.0"), "unselected other plugin should not be reinstalled");
	assert(!updatedState.lastUpdateCheckResults["demo@fixture-marketplace"], "successful demo key should be cleared from pending results");
	assert(updatedState.lastUpdateCheckResults["bad@fixture-marketplace"], "failed bad key should remain pending");
	assert(updatedState.lastUpdateCheckResults["other@fixture-marketplace"], "unrelated pending other key should be preserved");
	assertNoInstallTemps(agentDir);

	await writeMarketplace(remoteWork, { demo: "1.1.0", bad: "1.2.0", other: "1.1.0" });
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "repair bad source"]);
	git(remoteWork, ["push", "origin", "main"]);

	const pendingBeforeSuccess = (await readState()).lastUpdateCheckResults;
	const allSuccess = await installDetectedPluginUpdates(pendingBeforeSuccess, { cwd: tmp });
	assert(allSuccess.failures.length === 0, `expected all pending updates to succeed: ${JSON.stringify(allSuccess.failures)}`);
	assert(allSuccess.successfulEntries === 2, `expected bad and other to update, got ${allSuccess.successfulEntries}`);
	updatedState = await readState();
	assert(!updatedState.lastUpdateCheckResults || Object.keys(updatedState.lastUpdateCheckResults).length === 0, "all-success helper run should clear pending results");
	assert(versionsFor(updatedState, "bad@fixture-marketplace").every((entry) => entry.version === "1.2.0"), "bad should update after source is repaired");
	assert(versionsFor(updatedState, "other@fixture-marketplace").every((entry) => entry.version === "1.1.0"), "other should update when explicitly pending");
	assertNoInstallTemps(agentDir);

	console.log("auto update helper tests ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
