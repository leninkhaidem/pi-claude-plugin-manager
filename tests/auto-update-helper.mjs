import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
	const marketplaceName = options.marketplaceName ?? "fixture-marketplace";
	const missingPlugins = new Set(options.missingPlugins ?? (options.badMissing ? ["bad"] : []));
	const plugins = ["demo", "bad", "other"].map((name) => ({
		name,
		version: versions[name],
		source: missingPlugins.has(name) ? `plugins/missing-${name}` : `plugins/${name}`,
		description: `${name[0].toUpperCase()}${name.slice(1)} plugin`,
	}));
	await writeFile(
		path.join(repoPath, ".claude-plugin/marketplace.json"),
		`${JSON.stringify({ name: marketplaceName, description: "Fixture marketplace", plugins }, null, 2)}\n`,
	);
	for (const name of ["demo", "bad", "other"]) {
		if (!missingPlugins.has(name)) await writePlugin(repoPath, name, versions[name]);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function versionsFor(state, key) {
	return (state.plugins[key] ?? []).map((entry) => ({ scope: entry.scope, projectPath: entry.projectPath, version: entry.version, dev: !!entry.dev, installPath: entry.installPath }));
}

function assertNoInstallTemps(agentDir) {
	const cache = path.join(agentDir, "claude-plugin-manager/cache");
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

function assertNoMarketplaceReferences(state, marketplace) {
	assert(!state.marketplaces[marketplace], `stale marketplace record remained for ${marketplace}`);
	for (const key of Object.keys(state.plugins)) {
		assert(!key.endsWith(`@${marketplace}`), `stale plugin key remained: ${key}`);
	}
	for (const entries of Object.values(state.plugins)) {
		for (const entry of entries) assert(entry.marketplace !== marketplace, `stale plugin entry marketplace remained: ${JSON.stringify(entry)}`);
	}
	for (const [key, result] of Object.entries(state.lastUpdateCheckResults ?? {})) {
		assert(!key.endsWith(`@${marketplace}`), `stale pending result key remained: ${key}`);
		assert(result.marketplace !== marketplace, `stale pending result marketplace remained: ${JSON.stringify(result)}`);
	}
}

function assertInstallPathVersion(entry, expectedVersion, label) {
	const manifestPath = path.join(entry.installPath, ".claude-plugin/plugin.json");
	assert(existsSync(manifestPath), `${label} install path is missing: ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert(manifest.version === expectedVersion, `${label} install path version mismatch: expected ${expectedVersion}, got ${manifest.version}`);
}

async function createRenameFixture(root, marketplaceName) {
	const remoteWork = path.join(root, "remote-work");
	const remoteBare = path.join(root, "remote.git");
	const cacheCheckout = path.join(root, "cache-checkout");
	await mkdir(remoteWork, { recursive: true });
	git(remoteWork, ["init", "-b", "main"]);
	await writeMarketplace(remoteWork, { demo: "1.0.0", bad: "1.0.0", other: "1.0.0" }, { marketplaceName });
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "initial marketplace"]);
	git(root, ["clone", "--bare", remoteWork, remoteBare]);
	git(root, ["clone", remoteBare, cacheCheckout]);
	git(remoteWork, ["remote", "add", "origin", remoteBare]);

	const state = defaultState();
	state.marketplaces[marketplaceName] = {
		name: marketplaceName,
		description: "Fixture marketplace",
		source: { kind: "git", input: marketplaceName, url: remoteBare },
		path: cacheCheckout,
		addedAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
	await installPluginFromMarketplace(state, `demo@${marketplaceName}`, "user", root);
	await installPluginFromMarketplace(state, `bad@${marketplaceName}`, "user", root);
	await writeState(state);
	return { remoteWork, remoteBare, cacheCheckout };
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

	const gitWrapperDir = path.join(tmp, "git-wrapper");
	const gitWrapper = path.join(gitWrapperDir, "git");
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	await mkdir(gitWrapperDir, { recursive: true });
	await writeFile(gitWrapper, `#!/usr/bin/env bash
set -euo pipefail
REAL_GIT=${JSON.stringify(realGit)}
if [[ "\${PI_TEST_MUTATE_STATE_ON_SHOW:-}" != "" && "\${1:-}" == "show" && "\${2:-}" == "FETCH_HEAD:.claude-plugin/marketplace.json" ]]; then
	node "$PI_TEST_MUTATE_STATE_ON_SHOW"
fi
exec "$REAL_GIT" "$@"
`);
	await chmod(gitWrapper, 0o755);
	const mutateStateScript = path.join(tmp, "mutate-state-during-check.mjs");
	await writeFile(mutateStateScript, `import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const statePath = path.join(process.env.PI_CODING_AGENT_DIR, "claude-plugin-manager/state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
state.plugins["manual@fixture-marketplace"] = [{
	scope: "user",
	marketplace: "fixture-marketplace",
	plugin: "manual",
	version: "manual",
	installPath: "/tmp/manual-plugin-path",
	source: "plugins/manual",
	installedAt: new Date(0).toISOString()
}];
state.enabledPlugins["manual@fixture-marketplace"] = false;
await writeFile(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
`);
	const originalPath = process.env.PATH;
	let detected;
	process.env.PATH = `${gitWrapperDir}:${originalPath}`;
	process.env.PI_TEST_MUTATE_STATE_ON_SHOW = mutateStateScript;
	try {
		detected = await runUpdateCheck(await readState(), true);
	} finally {
		process.env.PATH = originalPath;
		delete process.env.PI_TEST_MUTATE_STATE_ON_SHOW;
	}
	let stateAfterCheck = await readState();
	assert(stateAfterCheck.plugins["manual@fixture-marketplace"]?.[0]?.version === "manual", "runUpdateCheck clobbered concurrent plugin state mutation");
	assert(stateAfterCheck.enabledPlugins["manual@fixture-marketplace"] === false, "runUpdateCheck clobbered concurrent enabled-state mutation");
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

	const dueState = await readState();
	dueState.lastUpdateCheckAt = new Date(0).toISOString();
	await writeState(dueState);
	const dueRecheck = await runUpdateCheck(await readState());
	assert(dueRecheck["bad@fixture-marketplace"], "due runUpdateCheck with unchanged marketplace HEAD should preserve failed bad pending result");
	assert(dueRecheck["other@fixture-marketplace"], "due runUpdateCheck with unchanged marketplace HEAD should preserve unresolved other pending result");
	updatedState = await readState();
	assert(updatedState.lastUpdateCheckResults?.["bad@fixture-marketplace"], "due runUpdateCheck cleared failed bad pending result from state");

	const forcedRecheck = await runUpdateCheck(await readState(), true);
	assert(forcedRecheck["bad@fixture-marketplace"], "forced runUpdateCheck with unchanged marketplace HEAD should preserve failed bad pending result");
	updatedState = await readState();
	assert(updatedState.lastUpdateCheckResults?.["bad@fixture-marketplace"], "forced runUpdateCheck cleared failed bad pending result from state");

	const unresolvedBeforeResolvedCheck = JSON.parse(JSON.stringify(await readState()));
	const stateWithResolvedBad = JSON.parse(JSON.stringify(unresolvedBeforeResolvedCheck));
	const resolvedBadVersion = stateWithResolvedBad.lastUpdateCheckResults["bad@fixture-marketplace"].availableVersion;
	for (const entry of stateWithResolvedBad.plugins["bad@fixture-marketplace"]) entry.version = resolvedBadVersion;
	await writeState(stateWithResolvedBad);
	const resolvedRecheck = await runUpdateCheck(await readState(), true);
	assert(!resolvedRecheck["bad@fixture-marketplace"], "runUpdateCheck should clear failed pending result once installed version matches available version");
	assert(resolvedRecheck["other@fixture-marketplace"], "resolved failed key should not clear unrelated unresolved pending result");
	updatedState = await readState();
	assert(!updatedState.lastUpdateCheckResults?.["bad@fixture-marketplace"], "resolved failed key remained persisted after runUpdateCheck reconciliation");
	assert(updatedState.lastUpdateCheckResults?.["other@fixture-marketplace"], "resolved failed key reconciliation should preserve unrelated unresolved pending result");
	await writeState(unresolvedBeforeResolvedCheck);

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

	const partialRenameRoot = path.join(tmp, "rename-partial");
	await mkdir(partialRenameRoot, { recursive: true });
	await writeState(defaultState());
	const partialOldMarketplace = "rename-partial-old";
	const partialNewMarketplace = "rename-partial-new";
	const partialFixture = await createRenameFixture(partialRenameRoot, partialOldMarketplace);
	await writeMarketplace(
		partialFixture.remoteWork,
		{ demo: "1.1.0", bad: "1.1.0", other: "1.0.0" },
		{ marketplaceName: partialNewMarketplace, missingPlugins: ["bad"] },
	);
	git(partialFixture.remoteWork, ["add", "."]);
	git(partialFixture.remoteWork, ["commit", "-m", "rename with partial failure"]);
	git(partialFixture.remoteWork, ["push", "origin", "main"]);

	const partialDetected = await runUpdateCheck(await readState(), true);
	const partialDetectedDemoKey = `demo@${partialOldMarketplace}`;
	const partialDetectedBadKey = `bad@${partialOldMarketplace}`;
	assert(partialDetected[partialDetectedDemoKey], "rename partial check did not detect demo update under old key");
	assert(partialDetected[partialDetectedBadKey], "rename partial check did not detect bad update under old key");
	const partialRename = await installDetectedPluginUpdates({
		[partialDetectedDemoKey]: partialDetected[partialDetectedDemoKey],
		[partialDetectedBadKey]: partialDetected[partialDetectedBadKey],
	}, { cwd: partialRenameRoot });
	assert(partialRename.marketplaceRenames[partialOldMarketplace] === partialNewMarketplace, `expected partial rename map: ${JSON.stringify(partialRename.marketplaceRenames)}`);
	assert(partialRename.successfulEntries === 1, `expected one successful renamed install: ${JSON.stringify(partialRename)}`);
	assert(partialRename.failures.length === 1 && partialRename.failures[0].newKey === `bad@${partialNewMarketplace}`, `expected renamed bad failure: ${JSON.stringify(partialRename.failures)}`);
	updatedState = await readState();
	assert(updatedState.marketplaces[partialNewMarketplace], "renamed marketplace record was not persisted after partial rename");
	assertNoMarketplaceReferences(updatedState, partialOldMarketplace);
	assert(versionsFor(updatedState, `demo@${partialNewMarketplace}`).every((entry) => entry.version === "1.1.0"), "renamed demo success was not stored under new key");
	assert(versionsFor(updatedState, `bad@${partialNewMarketplace}`).every((entry) => entry.version === "1.0.0"), "renamed failed bad entry should keep previous version under new key");
	assert(updatedState.enabledPlugins[`bad@${partialNewMarketplace}`] === true, "renamed failed bad enabled state was not migrated");
	assert(updatedState.lastUpdateCheckResults?.[`bad@${partialNewMarketplace}`], "renamed failed bad pending result was not migrated to new key");
	assert(updatedState.lastUpdateCheckResults[`bad@${partialNewMarketplace}`].marketplace === partialNewMarketplace, "renamed failed bad pending result kept old marketplace");

	await writeMarketplace(partialFixture.remoteWork, { demo: "1.1.0", bad: "1.2.0", other: "1.0.0" }, { marketplaceName: partialNewMarketplace });
	git(partialFixture.remoteWork, ["add", "."]);
	git(partialFixture.remoteWork, ["commit", "-m", "repair renamed partial failure"]);
	git(partialFixture.remoteWork, ["push", "origin", "main"]);
	const partialRetry = await installDetectedPluginUpdates((await readState()).lastUpdateCheckResults, { cwd: partialRenameRoot });
	assert(partialRetry.failures.length === 0, `renamed partial retry should proceed without failures: ${JSON.stringify(partialRetry.failures)}`);
	assert(partialRetry.successfulEntries === 1, `renamed partial retry should update one entry: ${JSON.stringify(partialRetry)}`);
	updatedState = await readState();
	assert(!updatedState.lastUpdateCheckResults || Object.keys(updatedState.lastUpdateCheckResults).length === 0, "renamed partial retry should clear pending results");
	assert(versionsFor(updatedState, `bad@${partialNewMarketplace}`).every((entry) => entry.version === "1.2.0"), "renamed bad retry did not install repaired version");
	assertNoInstallTemps(agentDir);

	const completeRenameRoot = path.join(tmp, "rename-complete");
	await mkdir(completeRenameRoot, { recursive: true });
	await writeState(defaultState());
	const completeOldMarketplace = "rename-complete-old";
	const completeNewMarketplace = "rename-complete-new";
	const completeFixture = await createRenameFixture(completeRenameRoot, completeOldMarketplace);
	await writeMarketplace(
		completeFixture.remoteWork,
		{ demo: "1.1.0", bad: "1.1.0", other: "1.0.0" },
		{ marketplaceName: completeNewMarketplace, missingPlugins: ["demo", "bad"] },
	);
	git(completeFixture.remoteWork, ["add", "."]);
	git(completeFixture.remoteWork, ["commit", "-m", "rename with complete failure"]);
	git(completeFixture.remoteWork, ["push", "origin", "main"]);

	const completeDetected = await runUpdateCheck(await readState(), true);
	const completeDetectedDemoKey = `demo@${completeOldMarketplace}`;
	const completeDetectedBadKey = `bad@${completeOldMarketplace}`;
	assert(completeDetected[completeDetectedDemoKey], "rename complete check did not detect demo update under old key");
	assert(completeDetected[completeDetectedBadKey], "rename complete check did not detect bad update under old key");
	const completeRename = await installDetectedPluginUpdates(completeDetected, { cwd: completeRenameRoot });
	assert(completeRename.marketplaceRenames[completeOldMarketplace] === completeNewMarketplace, `expected complete rename map: ${JSON.stringify(completeRename.marketplaceRenames)}`);
	assert(completeRename.successfulEntries === 0, `expected no successful entries for complete failure: ${JSON.stringify(completeRename)}`);
	assert(completeRename.failures.length === 2, `expected two failures for complete rename failure: ${JSON.stringify(completeRename.failures)}`);
	updatedState = await readState();
	assert(updatedState.marketplaces[completeNewMarketplace], "renamed marketplace record was not persisted after complete failure");
	assertNoMarketplaceReferences(updatedState, completeOldMarketplace);
	assert(versionsFor(updatedState, `demo@${completeNewMarketplace}`).every((entry) => entry.version === "1.0.0"), "renamed failed demo entry should keep previous version under new key");
	assert(versionsFor(updatedState, `bad@${completeNewMarketplace}`).every((entry) => entry.version === "1.0.0"), "renamed failed bad entry should keep previous version under new key");
	assert(updatedState.lastUpdateCheckResults?.[`demo@${completeNewMarketplace}`]?.marketplace === completeNewMarketplace, "renamed complete demo pending result was not migrated");
	assert(updatedState.lastUpdateCheckResults?.[`bad@${completeNewMarketplace}`]?.marketplace === completeNewMarketplace, "renamed complete bad pending result was not migrated");

	await writeMarketplace(completeFixture.remoteWork, { demo: "1.2.0", bad: "1.2.0", other: "1.0.0" }, { marketplaceName: completeNewMarketplace });
	git(completeFixture.remoteWork, ["add", "."]);
	git(completeFixture.remoteWork, ["commit", "-m", "repair renamed complete failure"]);
	git(completeFixture.remoteWork, ["push", "origin", "main"]);
	const completeRetry = await installDetectedPluginUpdates((await readState()).lastUpdateCheckResults, { cwd: completeRenameRoot });
	assert(completeRetry.failures.length === 0, `renamed complete retry should proceed without failures: ${JSON.stringify(completeRetry.failures)}`);
	assert(completeRetry.successfulEntries === 2, `renamed complete retry should update both entries: ${JSON.stringify(completeRetry)}`);
	updatedState = await readState();
	assert(!updatedState.lastUpdateCheckResults || Object.keys(updatedState.lastUpdateCheckResults).length === 0, "renamed complete retry should clear pending results");
	assert(versionsFor(updatedState, `demo@${completeNewMarketplace}`).every((entry) => entry.version === "1.2.0"), "renamed complete demo retry did not install repaired version");
	assert(versionsFor(updatedState, `bad@${completeNewMarketplace}`).every((entry) => entry.version === "1.2.0"), "renamed complete bad retry did not install repaired version");
	assertNoInstallTemps(agentDir);

	const conflictRoot = path.join(tmp, "conflict-rollback");
	await mkdir(conflictRoot, { recursive: true });
	await writeState(defaultState());
	const conflictMarketplace = "conflict-marketplace";
	const conflictFixture = await createRenameFixture(conflictRoot, conflictMarketplace);
	const conflictKey = `demo@${conflictMarketplace}`;
	const conflictOriginal = (await readState()).plugins[conflictKey][0];
	const conflictOriginalPath = conflictOriginal.installPath;
	assertInstallPathVersion(conflictOriginal, "1.0.0", "conflict original before update");
	await writeMarketplace(conflictFixture.remoteWork, { demo: "1.1.0", bad: "1.0.0", other: "1.0.0" }, { marketplaceName: conflictMarketplace });
	git(conflictFixture.remoteWork, ["add", "."]);
	git(conflictFixture.remoteWork, ["commit", "-m", "bump demo for conflict rollback"]);
	git(conflictFixture.remoteWork, ["push", "origin", "main"]);
	const conflictDetected = await runUpdateCheck(await readState(), true);
	assert(conflictDetected[conflictKey], "conflict rollback check did not detect demo update");
	const conflictResult = await installDetectedPluginUpdates({ [conflictKey]: conflictDetected[conflictKey] }, {
		cwd: conflictRoot,
		beforeFreshStateRead: async () => {
			const concurrent = await readState();
			const entry = concurrent.plugins[conflictKey][0];
			concurrent.plugins[conflictKey] = [{ ...entry, scope: "project", projectPath: conflictRoot }];
			await writeState(concurrent);
		},
	});
	assert(!conflictResult.stateUpdated, "conflicting auto-update should not write stale successful state");
	assert(conflictResult.successfulEntries === 0, `conflicting auto-update should not report committed successes: ${JSON.stringify(conflictResult)}`);
	assert(conflictResult.failures.some((failure) => failure.key === conflictKey && failure.reason.includes("changed or was removed")), `expected conflict failure: ${JSON.stringify(conflictResult.failures)}`);
	updatedState = await readState();
	const conflictPersisted = updatedState.plugins[conflictKey][0];
	assert(conflictPersisted.scope === "project" && conflictPersisted.projectPath === conflictRoot, "concurrent conflict state mutation was not preserved");
	assert(conflictPersisted.installPath === conflictOriginalPath, "conflicted state should still point at the previous install path");
	assertInstallPathVersion(conflictPersisted, "1.0.0", "conflict original after rollback");
	assert(!existsSync(path.join(agentDir, "claude-plugin-manager/cache", conflictMarketplace, "demo", "1.1.0")), "uncommitted conflict install path should be rolled back");
	assertNoInstallTemps(agentDir);

	console.log("auto update helper tests ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
