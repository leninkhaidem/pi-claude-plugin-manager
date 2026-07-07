import { installDetectedPluginUpdates, isUpdateCheckDue, runUpdateCheck, type TargetedUpdateInstallFailure, type TargetedUpdateInstallResult, type TargetedUpdateInstallSuccess } from "./update-check.js";
import { readConfig } from "./state.js";
import type { ManagerConfig, State, UpdateCheckResult, UpdateCheckStartupMode } from "./types.js";

type StartupUpdateUi = {
	notify(message: string, severity?: "info" | "success" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
};

type StartupUpdatePi = {
	sendUserMessage(message: string, options?: { deliverAs?: string }): void;
};

type StartupUpdateScheduleArgs = {
	reason?: string;
	hasUI: boolean;
	ui?: StartupUpdateUi;
	pi: StartupUpdatePi;
	cwd: string;
	state: State;
	piManagedCount: number;
};

export type StartupUpdateDependencies = {
	readConfig(): Promise<ManagerConfig>;
	isUpdateCheckDue(state: State, config: ManagerConfig): boolean;
	runUpdateCheck(state: State): Promise<Record<string, UpdateCheckResult>>;
	installDetectedPluginUpdates(detectedUpdates: Record<string, UpdateCheckResult>, options: { cwd: string }): Promise<TargetedUpdateInstallResult>;
};

export type StartupUpdateNotification = {
	message: string;
	severity: "info" | "success" | "error";
};

const DEFAULT_DEPS: StartupUpdateDependencies = {
	readConfig,
	isUpdateCheckDue,
	runUpdateCheck,
	installDetectedPluginUpdates,
};

const DETAIL_LIMIT = 5;
const RELOAD_GUIDANCE = "Run /reload or /plugin reload when ready to load updated resources.";
const REVIEW_GUIDANCE = "Run /plugin check-updates to review or retry.";
const STARTUP_MODES = new Set<UpdateCheckStartupMode>(["auto", "notify", "prompt", "off"]);

function resolveStartupMode(value: unknown): UpdateCheckStartupMode {
	return typeof value === "string" && STARTUP_MODES.has(value as UpdateCheckStartupMode) ? value as UpdateCheckStartupMode : "auto";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function boundedList(items: string[], limit = DETAIL_LIMIT): string {
	const shown = items.slice(0, limit).join(", ");
	const remaining = items.length - limit;
	return remaining > 0 ? `${shown}, and ${remaining} more` : shown;
}

function truncateDetail(value: string, maxLength = 160): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

function displayKey(oldKey: string, newKey?: string): string {
	return newKey && newKey !== oldKey ? `${oldKey} → ${newKey}` : oldKey;
}

function scopeLabel(scope?: string, projectPath?: string): string | undefined {
	if (!scope) return undefined;
	if (scope === "project") return projectPath ? `project ${projectPath}` : "project";
	return scope;
}

function successEntryLabel(success: TargetedUpdateInstallSuccess): string {
	const scope = scopeLabel(success.scope, success.projectPath);
	const version = success.previousVersion === success.currentVersion ? success.currentVersion : `${success.previousVersion} → ${success.currentVersion}`;
	return `${displayKey(success.oldKey, success.newKey)}${scope ? ` (${scope})` : ""}: ${version}`;
}

function failureEntryLabel(failure: TargetedUpdateInstallFailure): string {
	const scope = scopeLabel(failure.scope, failure.projectPath);
	const detail = truncateDetail(failure.reason);
	return `${displayKey(failure.oldKey, failure.newKey)}${scope ? ` (${scope})` : ""}: ${detail}`;
}

function successKeys(result: TargetedUpdateInstallResult): string[] {
	return uniqueSorted(result.successes.map((success) => displayKey(success.oldKey, success.newKey)));
}

function failureKeys(result: TargetedUpdateInstallResult): string[] {
	return uniqueSorted(result.failures.map((failure) => displayKey(failure.oldKey, failure.newKey)));
}

export function formatStartupAutoUpdateNotification(result: TargetedUpdateInstallResult): StartupUpdateNotification | undefined {
	const successfulEntries = result.successfulEntries;
	const failedItems = result.failures.length;
	const detectedKeys = result.detectedKeys.length;
	const updatedKeys = successKeys(result);
	const failedKeys = failureKeys(result);

	if (failedItems === 0 && result.stateUpdated && successfulEntries > 0) {
		const parts = [
			`[plugin] Auto-updated ${plural(successfulEntries, "installed plugin entry", "installed plugin entries")} across ${plural(updatedKeys.length, "plugin key")}.`,
			`Updated entries: ${boundedList(result.successes.map(successEntryLabel))}.`,
			RELOAD_GUIDANCE,
		];
		return { message: parts.join(" "), severity: "success" };
	}

	if (failedItems > 0 || !result.stateUpdated) {
		const parts = successfulEntries > 0
			? [
				`[plugin] Auto-updated ${plural(successfulEntries, "installed plugin entry", "installed plugin entries")}, but ${plural(failedItems, "update item")} failed.`,
				`Updated keys: ${boundedList(updatedKeys)}.`,
			]
			: [
				`[plugin] Failed to auto-update ${plural(Math.max(detectedKeys, failedKeys.length), "detected plugin update")}.`,
			];
		if (failedKeys.length > 0) parts.push(`Failed keys: ${boundedList(failedKeys)}.`);
		if (result.failures.length > 0) parts.push(`Failure details: ${boundedList(result.failures.map(failureEntryLabel))}.`);
		if (!result.stateUpdated) parts.push("Update state was not saved because a concurrent state change conflicted with the install results.");
		if (successfulEntries > 0) parts.push(RELOAD_GUIDANCE);
		parts.push(REVIEW_GUIDANCE);
		return { message: parts.join(" "), severity: "error" };
	}

	if (detectedKeys > 0) {
		return {
			message: `[plugin] ${plural(detectedKeys, "detected plugin update")} had no eligible installed entries to auto-update. ${REVIEW_GUIDANCE}`,
			severity: "info",
		};
	}

	return undefined;
}

function formatUpdateAvailableNotification(updateCount: number): string {
	return `[plugin] ${plural(updateCount, "plugin update")} available. Run /plugin check-updates to review; /plugin update remains the explicit install command.`;
}

async function promptForStartupUpdates(pi: StartupUpdatePi, ui: StartupUpdateUi, updateCount: number): Promise<void> {
	const updateAll = `Update all (${updateCount})`;
	const choice = await ui.select(
		`${plural(updateCount, "plugin update")} available`,
		[
			updateAll,
			"Select which to update",
			"Skip for now",
			"Disable update checks",
		],
	);
	if (choice === updateAll) {
		pi.sendUserMessage("/plugin update", { deliverAs: "followUp" });
	} else if (choice === "Select which to update") {
		pi.sendUserMessage("/plugin check-updates", { deliverAs: "followUp" });
	} else if (choice === "Disable update checks") {
		pi.sendUserMessage("/plugin config set updateCheckOnStartup off", { deliverAs: "followUp" });
	}
}

async function runScheduledStartupUpdate(args: StartupUpdateScheduleArgs, deps: StartupUpdateDependencies): Promise<void> {
	const ui = args.ui;
	if (!ui) return;
	let mode: UpdateCheckStartupMode = "auto";
	try {
		const config = await deps.readConfig();
		mode = resolveStartupMode(config.updateCheckOnStartup);
		if (!deps.isUpdateCheckDue(args.state, config)) return;
		if (mode === "off") return;

		const results = await deps.runUpdateCheck(args.state);
		const updateCount = Object.keys(results).length;
		if (updateCount === 0) return;

		if (mode === "notify") {
			ui.notify(formatUpdateAvailableNotification(updateCount), "info");
			return;
		}

		if (mode === "prompt") {
			await promptForStartupUpdates(args.pi, ui, updateCount);
			return;
		}

		const installResult = await deps.installDetectedPluginUpdates(results, { cwd: args.cwd });
		const notification = formatStartupAutoUpdateNotification(installResult);
		if (notification) ui.notify(notification.message, notification.severity);
	} catch (error) {
		if (mode === "auto") {
			ui.notify(`[plugin] Failed to automatically update plugins: ${(error as Error).message}. ${REVIEW_GUIDANCE}`, "error");
		}
	}
}

export function createStartupUpdateScheduler(deps: StartupUpdateDependencies = DEFAULT_DEPS): (args: StartupUpdateScheduleArgs) => boolean {
	let startupUpdateInFlight = false;
	return (args: StartupUpdateScheduleArgs): boolean => {
		if (args.reason !== "startup" || !args.hasUI || !args.ui || args.piManagedCount === 0) return false;
		if (startupUpdateInFlight) return false;
		startupUpdateInFlight = true;
		void runScheduledStartupUpdate(args, deps).finally(() => {
			startupUpdateInFlight = false;
		});
		return true;
	};
}
