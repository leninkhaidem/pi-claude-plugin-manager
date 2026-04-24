import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { claudePluginEntriesForCwd } from "./discovery.js";
import { stateDir } from "./state.js";
import type { State } from "./types.js";

export function formatHelp(): string {
	return `# /plugin — Claude Code marketplace plugin manager for Pi

Standalone Pi adapter. Stores marketplaces and installed plugins under:
${stateDir()}

## Common flow
/plugin marketplace add leninkhaidem/super-developer
/plugin install super-developer@super-developer-marketplace
/reload

## Commands
/plugin help
/plugin list
/plugin config [show]
/plugin config set <key> <value>
/plugin config reset [key]
/plugin marketplace list
/plugin marketplace add <github-owner/repo | git-url | local-path[#ref]>
/plugin marketplace update [marketplace]
/plugin marketplace remove <marketplace>
/plugin install <plugin[@marketplace]> [--project]
/plugin update [plugin[@marketplace]]
/plugin enable <plugin[@marketplace]>
/plugin disable <plugin[@marketplace]>
/plugin uninstall <plugin[@marketplace]> [--project|--all]
/plugin reload

## Current adapter coverage
Loaded into Pi: Claude plugin skills and command markdown files from both Pi-managed installs and read-only Claude Code installs in ~/.claude/plugins.
Not executed/imported yet: Claude hooks, MCP servers, LSP servers, monitors, agents, plugin settings.

## GitHub Enterprise
Use a full public Git URL or host shorthand, for example:
/plugin marketplace add https://github.enterprise.example.com/org/plugins.git
/plugin marketplace add github.enterprise.example.com/org/plugins`;
}

export function formatMarketplaceList(state: State): string {
	const records = Object.values(state.marketplaces).sort((a, b) => a.name.localeCompare(b.name));
	if (records.length === 0) return "No marketplaces added. Use `/plugin marketplace add <source>`.";
	return [
		"# Claude plugin marketplaces",
		"",
		...records.map((record) => {
			const source = record.source.input;
			const desc = record.description ? `\n  ${record.description}` : "";
			return `- ${record.name}\n  source: ${source}\n  path: ${record.path}${desc}`;
		}),
	].join("\n");
}

export async function formatPluginList(state: State, cwd: string): Promise<string> {
	const keys = Object.keys(state.plugins).sort();
	const piManagedKeys = new Set(keys);
	const claudeReadOnly = await claudePluginEntriesForCwd(cwd, piManagedKeys);

	if (keys.length === 0 && claudeReadOnly.length === 0) {
		return "No plugins installed. Use `/plugin marketplace add <source>` and `/plugin install <plugin@marketplace>`.";
	}

	const lines = ["# Claude plugins", ""];
	lines.push("## Pi-managed installs");
	if (keys.length === 0) {
		lines.push("No Pi-managed plugins installed.");
	} else {
		for (const key of keys) {
			const enabled = state.enabledPlugins[key] !== false;
			lines.push(`- ${enabled ? "✓" : "○"} ${key}`);
			for (const entry of state.plugins[key] ?? []) {
				const scope = entry.scope === "project" ? `project (${entry.projectPath})` : "user";
				lines.push(`  - version: ${entry.version}`);
				lines.push(`    scope: ${scope}`);
				lines.push(`    path: ${entry.installPath}`);
				if (entry.description) lines.push(`    description: ${entry.description}`);
			}
		}
	}

	lines.push("", "## Claude Code read-only imports");
	if (claudeReadOnly.length === 0) {
		lines.push("No enabled Claude Code plugins found for this cwd, or they are already installed in Pi-managed state.");
	} else {
		for (const { key, entry, installPath } of claudeReadOnly.sort((a, b) => a.key.localeCompare(b.key))) {
			const scope = entry.scope === "project" ? `project (${entry.projectPath})` : (entry.scope ?? "user");
			lines.push(`- ↪ ${key}`);
			lines.push(`  - version: ${entry.version ?? "unknown"}`);
			lines.push(`    scope: ${scope}`);
			lines.push(`    path: ${installPath}`);
		}
	}

	return lines.join("\n");
}

export async function emit(pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<void> {
	if (ctx.hasUI) {
		pi.sendMessage({ customType: "claude-plugin-manager", content: text, display: true });
	} else {
		console.log(text);
	}
}

export async function confirmInstall(ctx: ExtensionCommandContext, key: string, scope: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return await ctx.ui.confirm(
		"Install Claude plugin?",
		`Install ${key} to ${scope} scope. This adapter exposes plugin skills and command markdown in Pi. Hooks/MCP/LSP/monitors are not executed by this adapter.`,
	);
}
