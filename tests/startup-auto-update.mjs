import { readFile } from "node:fs/promises";

const startupModule = await import("../src/startup-update.ts");
const { createStartupUpdateScheduler, formatStartupAutoUpdateNotification } = startupModule.default ?? startupModule;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
	for (let i = 0; i < 80; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		if (predicate()) return;
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function fakeSuccess(key, overrides = {}) {
	const [plugin, marketplace] = key.split("@");
	return {
		key,
		oldKey: key,
		newKey: key,
		marketplace,
		plugin,
		scope: "user",
		previousVersion: "1.0.0",
		currentVersion: "1.1.0",
		installPath: `/tmp/${plugin}`,
		...overrides,
	};
}

function fakeFailure(key, reason = "install failed", overrides = {}) {
	const [plugin, marketplace] = key.split("@");
	return {
		key,
		oldKey: key,
		newKey: key,
		marketplace,
		plugin,
		scope: "user",
		reason,
		...overrides,
	};
}

function fakeInstallResult({ detectedKeys = ["demo@fixture"], successes = [], failures = [], stateUpdated = true } = {}) {
	return {
		detectedKeys,
		refreshedMarketplaces: ["fixture"],
		marketplaceRenames: {},
		successes,
		failures,
		skipped: [],
		attemptedEntries: successes.length + failures.filter((failure) => failure.scope).length,
		successfulEntries: successes.length,
		failedEntries: failures.filter((failure) => failure.scope).length,
		skippedDevEntries: 0,
		pendingResults: {},
		cacheCleared: successes.length > 0,
		reloadRecommended: successes.length > 0,
		stateUpdated,
	};
}

function createHarness({ config = {}, due = true, results = { "demo@fixture": { installedVersion: "1.0.0", availableVersion: "1.1.0", marketplace: "fixture", plugin: "demo" } }, installResult } = {}) {
	const calls = { readConfig: 0, due: 0, runUpdateCheck: 0, install: 0, notifications: [], messages: [], selects: [] };
	const deps = {
		async readConfig() {
			calls.readConfig++;
			return config;
		},
		isUpdateCheckDue(state, currentConfig) {
			calls.due++;
			return typeof due === "function" ? due(state, currentConfig) : due;
		},
		async runUpdateCheck() {
			calls.runUpdateCheck++;
			if (results instanceof Error) throw results;
			return results;
		},
		async installDetectedPluginUpdates(detectedUpdates, options) {
			calls.install++;
			calls.installArgs = { detectedUpdates, options };
			if (installResult instanceof Error) throw installResult;
			return installResult ?? fakeInstallResult({ detectedKeys: Object.keys(detectedUpdates), successes: [fakeSuccess("demo@fixture")] });
		},
	};
	const scheduler = createStartupUpdateScheduler(deps);
	const ui = {
		notify(message, severity) {
			calls.notifications.push({ message, severity });
		},
		async select(title, options) {
			calls.selects.push({ title, options });
			return calls.nextSelect;
		},
	};
	const pi = {
		sendUserMessage(message, options) {
			calls.messages.push({ message, options });
		},
	};
	const args = { reason: "startup", hasUI: true, ui, pi, cwd: "/tmp/project", state: {}, piManagedCount: 1 };
	return { scheduler, calls, args };
}

// Formatting distinguishes entry counts, keys, bounded detail, severity, and reload guidance.
{
	const successes = Array.from({ length: 7 }, (_, index) => fakeSuccess(`plugin-${index}@fixture`, { plugin: `plugin-${index}` }));
	const notice = formatStartupAutoUpdateNotification(fakeInstallResult({ detectedKeys: successes.map((success) => success.key), successes }));
	assert(notice.severity === "success", "all-success notification should be success");
	assert(notice.message.includes("7 installed plugin entries"), "success message should count installed entries");
	assert(notice.message.includes("/reload or /plugin reload"), "success message should include reload guidance");
	assert(notice.message.includes("and 2 more"), "success details should be bounded");
}

{
	const partial = formatStartupAutoUpdateNotification(fakeInstallResult({
		detectedKeys: ["demo@fixture", "bad@fixture"],
		successes: [fakeSuccess("demo@fixture")],
		failures: [fakeFailure("bad@fixture", "missing source")],
	}));
	assert(partial.severity === "error", "partial failure notification should be error");
	assert(partial.message.includes("Auto-updated 1 installed plugin entry, but 1 update item failed"), "partial failure should distinguish success/failure counts");
	assert(partial.message.includes("bad@fixture"), "partial failure should include failed key");
	assert(partial.message.includes("/reload or /plugin reload"), "partial failure with success should include reload guidance");
}

{
	const complete = formatStartupAutoUpdateNotification(fakeInstallResult({
		detectedKeys: ["bad@fixture"],
		failures: [fakeFailure("bad@fixture", "install failed")],
	}));
	assert(complete.severity === "error", "complete failure notification should be error");
	assert(!complete.message.includes("/reload or /plugin reload"), "complete failure without success should not imply reload is needed");
}

// Hard startup gates: only startup + UI + Pi-managed entries schedule background work.
{
	const { scheduler, calls, args } = createHarness();
	assert(!scheduler({ ...args, reason: "reload" }), "reload event should not schedule");
	assert(!scheduler({ ...args, hasUI: false, ui: undefined }), "non-UI event should not schedule");
	assert(!scheduler({ ...args, piManagedCount: 0 }), "no Pi-managed entries should not schedule");
	await new Promise((resolve) => setImmediate(resolve));
	assert(calls.runUpdateCheck === 0 && calls.install === 0, "gated events should not run checks or installs");
}

// Due check suppresses remote check/install inside the background task.
{
	const { scheduler, calls, args } = createHarness({ due: false });
	assert(scheduler(args), "eligible startup should schedule due evaluation");
	await waitFor(() => calls.due === 1, "due check");
	await new Promise((resolve) => setImmediate(resolve));
	assert(calls.runUpdateCheck === 0 && calls.install === 0, "not-due startup should not check or install");
}

// Default/unset auto installs detected keys in background and notifies success only after install completes.
{
	const installDeferred = deferred();
	const { scheduler, calls, args } = createHarness({ installResult: installDeferred.promise });
	assert(scheduler(args), "default startup should schedule auto mode");
	await waitFor(() => calls.install === 1, "auto install call");
	assert(Object.keys(calls.installArgs.detectedUpdates).join(",") === "demo@fixture", "auto mode should pass detected keys to helper");
	assert(calls.installArgs.options.cwd === "/tmp/project", "auto mode should pass cwd to helper");
	assert(calls.notifications.length === 0, "success should not notify before install completes");
	installDeferred.resolve(fakeInstallResult({ successes: [fakeSuccess("demo@fixture")] }));
	await waitFor(() => calls.notifications.length === 1, "success notification");
	assert(calls.notifications[0].severity === "success", "auto all-success should notify success");
	assert(calls.notifications[0].message.includes("/reload or /plugin reload"), "auto success should include reload guidance");
}

// Same-process guard prevents duplicate startup batches while the first run is in flight.
{
	const checkDeferred = deferred();
	const { scheduler, calls, args } = createHarness({ results: checkDeferred.promise });
	assert(scheduler(args), "first startup should schedule");
	assert(!scheduler(args), "second startup while in flight should be skipped");
	await waitFor(() => calls.runUpdateCheck === 1, "single update check");
	checkDeferred.resolve({ "demo@fixture": { installedVersion: "1.0.0", availableVersion: "1.1.0", marketplace: "fixture", plugin: "demo" } });
	await waitFor(() => calls.install === 1, "single install after guard");
}

// notify remains check-only info; prompt remains user-mediated follow-up commands.
{
	const notifyHarness = createHarness({ config: { updateCheckOnStartup: "notify" } });
	assert(notifyHarness.scheduler(notifyHarness.args), "notify mode should schedule check");
	await waitFor(() => notifyHarness.calls.notifications.length === 1, "notify mode info");
	assert(notifyHarness.calls.install === 0, "notify mode should not install");
	assert(notifyHarness.calls.notifications[0].severity === "info", "notify mode should use info severity");

	const promptHarness = createHarness({ config: { updateCheckOnStartup: "prompt" } });
	promptHarness.calls.nextSelect = "Select which to update";
	assert(promptHarness.scheduler(promptHarness.args), "prompt mode should schedule check");
	await waitFor(() => promptHarness.calls.messages.length === 1, "prompt follow-up");
	assert(promptHarness.calls.install === 0, "prompt mode should not call auto installer");
	assert(promptHarness.calls.messages[0].message === "/plugin check-updates", "prompt select should send manual review command");
	assert(promptHarness.calls.messages[0].options.deliverAs === "followUp", "prompt should send follow-up command");
}

// Manual check commands remain review/selection by default and non-UI formatting stays separate from explicit /plugin update.
{
	const commandsSource = await readFile(new URL("../src/commands.ts", import.meta.url), "utf8");
	const start = commandsSource.indexOf("if (command === \"check-updates\" || command === \"check-update\")");
	const end = commandsSource.indexOf("if (command === \"reload\")", start);
	assert(start > 0 && end > start, "check-updates command block should remain present");
	const checkBlock = commandsSource.slice(start, end);
	assert(checkBlock.includes("runUpdateCheck(state, true)"), "manual check should force detection");
	assert(checkBlock.includes("runCheckboxSelector"), "UI manual check should present selection UI");
	assert(checkBlock.includes("selection.items.filter((item) => item.checked)"), "manual check should update only selected items");
	assert(checkBlock.includes("formatUpdateCheckResults(results)"), "non-UI manual check should format results instead of installing");
	assert(!checkBlock.includes("installDetectedPluginUpdates"), "manual check should not delegate to startup auto-update helper");
}

// off/disabled configs suppress checks through the due gate; top-level auto check failures are visible errors.
{
	const startupDue = (_state, currentConfig) => currentConfig.updateCheckEnabled !== false && currentConfig.updateCheckOnStartup !== "off";
	const offHarness = createHarness({ due: startupDue, config: { updateCheckOnStartup: "off" } });
	assert(offHarness.scheduler(offHarness.args), "off config should schedule local gate evaluation");
	await waitFor(() => offHarness.calls.due === 1, "off due gate");
	assert(offHarness.calls.runUpdateCheck === 0 && offHarness.calls.install === 0, "off config should suppress checks and installs");

	const disabledHarness = createHarness({ due: startupDue, config: { updateCheckEnabled: false } });
	assert(disabledHarness.scheduler(disabledHarness.args), "disabled config should schedule local gate evaluation");
	await waitFor(() => disabledHarness.calls.due === 1, "disabled due gate");
	assert(disabledHarness.calls.runUpdateCheck === 0 && disabledHarness.calls.install === 0, "disabled config should suppress checks and installs");

	const rejectionHarness = createHarness({ results: new Error("network unavailable") });
	assert(rejectionHarness.scheduler(rejectionHarness.args), "auto rejection harness should schedule");
	await waitFor(() => rejectionHarness.calls.notifications.length === 1, "auto rejection notification");
	assert(rejectionHarness.calls.notifications[0].severity === "error", "auto runUpdateCheck rejection should be error severity");
	assert(rejectionHarness.calls.notifications[0].message.includes("network unavailable"), "auto rejection should include error detail");
}

console.log("startup auto update tests ok");
