import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { syncAgentSymlinks } from "./agents.js";
import { getManageSkillsArgumentCompletions, getPluginArgumentCompletions } from "./autocomplete.js";
import { CUSTOM_MESSAGE_TYPE } from "./constants.js";
import { claudePluginEntriesForCwd, clearDiscoveryCache, discoverInstalledResourcesCached, installedEntriesForCwd, piManagedKeysForCwd } from "./discovery.js";
import { emit } from "./format.js";
import { handleCommand, handleManageSkillsCommand } from "./commands.js";
import { installPluginFromMarketplace } from "./installer.js";
import { evaluateSkillInvocationBlock } from "./enforcement.js";
import { filterSkillsFromPromptByPolicy } from "./skills.js";
import { readConfig, readState, writeState } from "./state.js";
import { isUpdateCheckDue, runUpdateCheck } from "./update-check.js";

export default function claudePluginManager(pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Text(theme.fg("accent", "Claude Plugin Manager") + "\n" + content, 0, 0);
	});

	pi.registerCommand("plugin", {
		description: "Manage Claude Code marketplace plugins directly from Pi",
		getArgumentCompletions: getPluginArgumentCompletions,
		handler: async (args, ctx) => {
			try {
				const result = await handleCommand(pi, args, ctx);
				if (result.reloadRecommended && ctx.hasUI) {
					ctx.ui.notify("Run /reload when ready to apply changes.", "info");
				}
			} catch (error) {
				await emit(pi, ctx, `Error: ${(error as Error).message}`);
			}
		},
	});

	pi.registerCommand("manage-skills", {
		description: "Manage skill enablement and enforcement policy",
		getArgumentCompletions: getManageSkillsArgumentCompletions,
		handler: async (args, ctx) => {
			try {
				const result = await handleManageSkillsCommand(pi, args, ctx);
				if (result.reloadRecommended && ctx.hasUI) {
					ctx.ui.notify("Run /reload when ready to apply changes.", "info");
				}
			} catch (error) {
				await emit(pi, ctx, `Error: ${(error as Error).message}`);
			}
		},
	});

	pi.on("resources_discover", async (event) => {
		return await discoverInstalledResourcesCached(event.cwd);
	});

	pi.on("before_agent_start", async (event) => {
		const state = await readState();
		const config = await readConfig();
		const filtered = filterSkillsFromPromptByPolicy(event.systemPrompt, state.skillPolicy, (event as { cwd?: string }).cwd, config.skillSources ?? []);
		if (filtered !== event.systemPrompt) {
			return { systemPrompt: filtered };
		}
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.trimStart().startsWith("/skill:")) return { action: "continue" };
		try {
			const state = await readState();
			const config = await readConfig();
			const block = evaluateSkillInvocationBlock(pi, state.skillPolicy, ctx.cwd, event.text, config.skillSources ?? []);
			if (!block.blocked) return { action: "continue" };
			await emit(pi, ctx, `Blocked /skill invocation. ${block.reason ?? "Skill invocation is not allowed."}`);
			return { action: "handled" };
		} catch (error) {
			await emit(pi, ctx, `Blocked /skill invocation because skill policy could not be read: ${(error as Error).message}`);
			return { action: "handled" };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		try {
			const state = await readState();

			// Auto-migrate: convert copied installs from local marketplaces to symlinks
			let migrated = 0;
			for (const [key, entries] of Object.entries(state.plugins)) {
				const snapshot = [...entries];
				for (const entry of snapshot) {
					if (entry.dev) continue; // Already symlinked
					const marketplace = state.marketplaces[entry.marketplace];
					if (!marketplace || marketplace.source.kind !== "local") continue;
					try {
						await installPluginFromMarketplace(state, key, entry.scope, entry.projectPath ?? ctx.cwd);
						migrated++;
					} catch (error) {
						console.warn(`[plugin] Failed to auto-migrate ${key} to dev mode: ${(error as Error).message}`);
					}
				}
			}
			if (migrated > 0) {
				await writeState(state);
				clearDiscoveryCache();
				if (ctx.hasUI) {
					ctx.ui.notify(`[plugin] Auto-migrated ${migrated} local plugin${migrated === 1 ? "" : "s"} to dev (symlink) mode.`, "info");
				}
			}

			const piManaged = installedEntriesForCwd(state, ctx.cwd);
			const claudeReadOnly = await claudePluginEntriesForCwd(ctx.cwd, piManagedKeysForCwd(state, ctx.cwd));
			const resources = await discoverInstalledResourcesCached(ctx.cwd);
			const total = piManaged.length + claudeReadOnly.length;

			// Sync agent symlinks into ~/.pi/agent/agents/ (always run to clean up stale symlinks)
			try {
				await syncAgentSymlinks(resources.agentEntries);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`[plugin] Failed to sync agent symlinks: ${(error as Error).message}`, "error");
			}

			if (ctx.hasUI && (total > 0 || resources.skillPaths.length > 0 || resources.promptPaths.length > 0 || resources.agentEntries.length > 0)) {
				const parts: string[] = [];
				parts.push(`${resources.skillPaths.length} skill file${resources.skillPaths.length === 1 ? "" : "s"}`);
				parts.push(`${resources.promptPaths.length} command file${resources.promptPaths.length === 1 ? "" : "s"}`);
				if (resources.agentEntries.length > 0) {
					parts.push(`${resources.agentEntries.length} agent file${resources.agentEntries.length === 1 ? "" : "s"}`);
				}
				ctx.ui.notify(
					`[plugin] Loaded ${parts.join(", ")} from ${piManaged.length} Pi-managed and ${claudeReadOnly.length} Claude Code read-only plugin${total === 1 ? "" : "s"}.`,
					"success",
				);
			}

			// Auto-update check on startup only (not reload/fork/resume)
			if (event.reason === "startup" && ctx.hasUI && piManaged.length > 0) {
				const config = await readConfig();
				if (isUpdateCheckDue(state, config)) {
					// Run in background — don't block session start
					runUpdateCheck(state).then(async (results) => {
						const updateCount = Object.keys(results).length;
						if (updateCount === 0) return;

						const mode = config.updateCheckOnStartup ?? "notify";
						if (mode === "notify") {
							ctx.ui.notify(
								`[plugin] ${updateCount} plugin update${updateCount === 1 ? "" : "s"} available. Run /plugin check-updates to review.`,
								"info",
							);
						} else if (mode === "prompt") {
							const entries = Object.entries(results);
							const summary = entries.map(([key, r]) => `${key}: ${r.installedVersion} → ${r.availableVersion}`).join("\n");
							const choice = await ctx.ui.select(
								`${updateCount} plugin update${updateCount === 1 ? "" : "s"} available`,
								[
									`Update all (${updateCount})`,
									"Select which to update",
									"Skip for now",
									"Disable update checks",
								],
							);
							if (choice === `Update all (${updateCount})`) {
								pi.sendUserMessage("/plugin update", { deliverAs: "followUp" });
							} else if (choice === "Select which to update") {
								pi.sendUserMessage("/plugin check-updates", { deliverAs: "followUp" });
							} else if (choice === "Disable update checks") {
								pi.sendUserMessage("/plugin config set updateCheckOnStartup off", { deliverAs: "followUp" });
							}
						}
					}).catch(() => {
						// Silently ignore update check failures
					});
				}
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`[plugin] Failed to discover Claude plugin resources: ${(error as Error).message}`, "error");
		}
	});
}
