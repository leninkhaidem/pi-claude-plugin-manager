import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getPluginArgumentCompletions } from "./autocomplete.js";
import { CUSTOM_MESSAGE_TYPE } from "./constants.js";
import { claudePluginEntriesForCwd, discoverInstalledResourcesCached, installedEntriesForCwd, piManagedKeysForCwd } from "./discovery.js";
import { emit } from "./format.js";
import { handleCommand } from "./commands.js";
import { readState } from "./state.js";

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
					const reload = await ctx.ui.confirm("Reload Pi resources?", "Plugin changes require /reload before skills/commands appear or disappear. Reload now?");
					if (reload) {
						await ctx.reload();
						return;
					}
				}
			} catch (error) {
				await emit(pi, ctx, `Error: ${(error as Error).message}`);
			}
		},
	});

	pi.on("resources_discover", async (event) => {
		return await discoverInstalledResourcesCached(event.cwd);
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const state = await readState();
			const piManaged = installedEntriesForCwd(state, ctx.cwd);
			const claudeReadOnly = await claudePluginEntriesForCwd(ctx.cwd, piManagedKeysForCwd(state, ctx.cwd));
			const resources = await discoverInstalledResourcesCached(ctx.cwd);
			const total = piManaged.length + claudeReadOnly.length;
			if (ctx.hasUI && (total > 0 || resources.skillPaths.length > 0 || resources.promptPaths.length > 0)) {
				ctx.ui.notify(
					`[plugin] Loaded ${resources.skillPaths.length} skill file${resources.skillPaths.length === 1 ? "" : "s"} and ${resources.promptPaths.length} command file${resources.promptPaths.length === 1 ? "" : "s"} from ${piManaged.length} Pi-managed and ${claudeReadOnly.length} Claude Code read-only plugin${total === 1 ? "" : "s"}.`,
					"success",
				);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`[plugin] Failed to discover Claude plugin resources: ${(error as Error).message}`, "error");
		}
	});
}
