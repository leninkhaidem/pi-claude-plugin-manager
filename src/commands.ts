import { syncAgentSymlinks } from "./agents.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearAutocompleteCache, PLUGIN_BROWSE_SELECT_LIMIT } from "./autocomplete.js";
import { CONFIG_FIELDS, isConfigKey } from "./config-metadata.js";
import { clearDiscoveryCache, discoverInstalledResourcesCached } from "./discovery.js";
import { confirmInstall, emit, formatBrowseList, formatHelp, formatMarketplaceList, formatPluginList } from "./format.js";
import { installPluginFromMarketplace, uninstallPlugin } from "./installer.js";
import { addMarketplace, findMarketplacePlugin, listMarketplacePlugins, refreshMarketplace } from "./marketplace.js";
import { buildSkillList, buildSourceList, discoverSkillsFromSources, type SkillInfo, type SkillSourceInfo } from "./skills.js";
import { CheckboxSelector, type CheckboxItem, type CheckboxResult } from "./checkbox.js";
import { createManageSkillsTui, type ManageSkillsTuiResult } from "./manage-skills-tui.js";
import { formatUpdateCheckResults, runUpdateCheck } from "./update-check.js";
import { defaultConfig, formatConfig, readConfig, readState, writeConfig, writeState } from "./state.js";
import type { CommandResult, InstalledPluginEntry, MarketplacePluginListing, ManagerConfig, Scope, State } from "./types.js";
import { hasFlag, parsePluginSpec, pluginKey, splitArgs, withoutFlags } from "./utils.js";
import { rm } from "node:fs/promises";
import { collectResourcesFromPluginRoot, readPluginManifest } from "./resources.js";
import { claudePluginEntriesForCwd, installedEntriesForCwd, piManagedKeysForCwd } from "./discovery.js";

function clearRuntimeCaches(): void {
	clearDiscoveryCache();
	clearAutocompleteCache();
}

async function runCheckboxSelector(ctx: ExtensionCommandContext, title: string, items: CheckboxItem[]): Promise<CheckboxResult | undefined> {
	if (!ctx.hasUI) return undefined;
	return await ctx.ui.custom<CheckboxResult | undefined>((_ui, _theme, _keybindings, done) => {
		const selector = new CheckboxSelector(title, items);
		selector.onDone = (result) => {
			done(result);
		};
		return selector;
	});
}

async function handleConfigCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<CommandResult> {
	const sub = args[0] ?? "show";

	if (sub === "show" || sub === "list" || sub === "get") {
		if (ctx.hasUI && args.length === 0) {
			// Interactive config menu
			const choice = await ctx.ui.select("Plugin config", [
				"Show current config",
				"Edit a config key",
				"Reset a config key",
				"Reset all config",
				"Help — config keys reference",
			]);
			if (!choice) return {};
			if (choice === "Show current config") {
				await emit(pi, ctx, formatConfig(await readConfig()));
				return {};
			}
			if (choice === "Edit a config key") {
				return await handleInteractiveConfigEdit(pi, ctx);
			}
			if (choice === "Reset a config key") {
				return await handleInteractiveConfigReset(pi, ctx, false);
			}
			if (choice === "Reset all config") {
				return await handleInteractiveConfigReset(pi, ctx, true);
			}
			if (choice.startsWith("Help")) {
				await emit(pi, ctx, formatConfigHelp());
				return {};
			}
			return {};
		}
		await emit(pi, ctx, formatConfig(await readConfig()));
		return {};
	}

	if (sub === "set") {
		const key = args[1] as keyof ManagerConfig | undefined;
		const rawValue = args.slice(2).join(" ");
		if (!key || !isConfigKey(key) || rawValue === "") {
			throw new Error("Usage: /plugin config set <claudeReadOnlyImports|claudeDir|claudePluginsDir|claudeSettingsPath|claudeInstalledPluginsPath> <value>");
		}
		const config = await readConfig();
		if (key === "claudeReadOnlyImports" || key === "updateCheckEnabled") {
			const normalized = rawValue.toLowerCase();
			if (!["true", "false", "1", "0", "yes", "no"].includes(normalized)) {
				throw new Error(`${key} must be true or false`);
			}
			config[key] = normalized === "true" || normalized === "1" || normalized === "yes";
		} else if (key === "updateCheckTTL") {
			const parsed = parseInt(rawValue, 10);
			if (isNaN(parsed) || parsed < 0) throw new Error("updateCheckTTL must be a non-negative number (milliseconds)");
			config[key] = parsed;
		} else if (key === "updateCheckOnStartup") {
			const normalized = rawValue.toLowerCase();
			if (!["notify", "prompt", "off"].includes(normalized)) {
				throw new Error("updateCheckOnStartup must be: notify, prompt, or off");
			}
			config[key] = normalized as "notify" | "prompt" | "off";
		} else if (key === "skillSources") {
			await emit(pi, ctx, "Use `/plugin config set skillSources <paths>` for source configuration, or `/manage-skills` for skill policy status.");
			return {};
		} else {
			(config as Record<string, unknown>)[key] = rawValue;
		}
		await writeConfig(config);
		clearRuntimeCaches();
		await emit(pi, ctx, `Updated config ${key}.\n\n${formatConfig(config)}\n\nRun /reload or /plugin reload for resource imports to use the new paths.`);
		return { reloadRecommended: true };
	}

	if (sub === "reset") {
		const key = args[1] as keyof ManagerConfig | undefined;
		if (!key) {
			const config = defaultConfig();
			await writeConfig(config);
			clearRuntimeCaches();
			await emit(pi, ctx, `Reset plugin manager config.\n\n${formatConfig(config)}`);
			return { reloadRecommended: true };
		}
		if (!isConfigKey(key)) throw new Error(`Unknown config key: ${key}`);
		const config = await readConfig();
		delete config[key];
		await writeConfig(config);
		clearRuntimeCaches();
		await emit(pi, ctx, `Reset config ${key}.\n\n${formatConfig(config)}`);
		return { reloadRecommended: true };
	}

	throw new Error(`Unknown config command: ${sub}`);
}

function formatConfigHelp(): string {
	const lines = ["# Config keys reference", ""];
	for (const field of CONFIG_FIELDS) {
		const values = field.values ? ` (valid: ${field.values.join(", ")})` : "";
		lines.push(`- **${field.key}**${values}`);
		lines.push(`  ${field.description}`);
	}
	lines.push("", "Use `/plugin config set <key> <value>` to change a value.");
	lines.push("Use `/plugin config reset [key]` to reset one key or all config.");
	return lines.join("\n");
}

async function handleInteractiveConfigEdit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const config = await readConfig();
	const keyLabels = CONFIG_FIELDS.map((field) => {
		const current = config[field.key];
		const currentStr = current !== undefined ? ` [current: ${JSON.stringify(current)}]` : " [not set]";
		return `${field.key}${currentStr} \u2014 ${field.description}`;
	});
	const selected = await ctx.ui.select("Select config key to edit", keyLabels);
	if (!selected) return {};
	const selectedIndex = keyLabels.indexOf(selected);
	const field = CONFIG_FIELDS[selectedIndex];
	if (!field) return {};

	if (field.key === "skillSources") {
		await emit(pi, ctx, "Use `/plugin config set skillSources <paths>` for source configuration, or `/manage-skills` for skill policy status.");
		return {};
	}

	let newValue: string | undefined;
	if (field.values) {
		newValue = await ctx.ui.select(`Set ${field.key}`, field.values);
	} else {
		const currentValue = config[field.key];
		newValue = await ctx.ui.input(`Set ${field.key}`, typeof currentValue === "string" ? currentValue : "");
	}
	if (newValue === undefined) return {};

	if (field.key === "claudeReadOnlyImports" || field.key === "updateCheckEnabled") {
		config[field.key] = newValue === "true";
	} else if (field.key === "updateCheckTTL") {
		config[field.key] = parseInt(newValue, 10);
	} else if (field.key === "updateCheckOnStartup") {
		config[field.key] = newValue as "notify" | "prompt" | "off";
	} else {
		(config as Record<string, unknown>)[field.key] = newValue;
	}
	await writeConfig(config);
	clearRuntimeCaches();
	await emit(pi, ctx, `Updated ${field.key}.\n\n${formatConfig(config)}\n\nRun /reload or /plugin reload for changes to take effect.`);
	return { reloadRecommended: true };
}

async function handleInteractiveConfigReset(pi: ExtensionAPI, ctx: ExtensionCommandContext, resetAll: boolean): Promise<CommandResult> {
	if (resetAll) {
		const confirmed = await ctx.ui.confirm("Reset all config?", "This will restore all config keys to their defaults.");
		if (!confirmed) return {};
		const config = defaultConfig();
		await writeConfig(config);
		clearRuntimeCaches();
		await emit(pi, ctx, `Reset all plugin manager config.\n\n${formatConfig(config)}`);
		return { reloadRecommended: true };
	}

	const config = await readConfig();
	const keyLabels = CONFIG_FIELDS.map((field) => {
		const current = config[field.key];
		const currentStr = current !== undefined ? ` [current: ${JSON.stringify(current)}]` : " [not set]";
		return `${field.key}${currentStr}`;
	});
	const selected = await ctx.ui.select("Reset which key?", keyLabels);
	if (!selected) return {};
	const selectedIndex = keyLabels.indexOf(selected);
	const field = CONFIG_FIELDS[selectedIndex];
	if (!field) return {};

	delete config[field.key];
	await writeConfig(config);
	clearRuntimeCaches();
	await emit(pi, ctx, `Reset config ${field.key}.\n\n${formatConfig(config)}`);
	return { reloadRecommended: true };
}

async function getPluginSkillPaths(cwd: string): Promise<string[]> {
	const state = await readState();
	const piManaged = installedEntriesForCwd(state, cwd);
	const piManagedKeys = piManagedKeysForCwd(state, cwd);
	const skillPaths: string[] = [];

	for (const { entry } of piManaged) {
		const resources = await collectResourcesFromPluginRoot(entry.installPath, entry.manifest, entry.marketplaceEntry);
		skillPaths.push(...resources.skillPaths);
	}

	for (const { installPath } of await claudePluginEntriesForCwd(cwd, piManagedKeys)) {
		const manifest = await readPluginManifest(installPath);
		const resources = await collectResourcesFromPluginRoot(installPath, manifest);
		skillPaths.push(...resources.skillPaths);
	}

	return [...new Set(skillPaths)];
}

export async function handleManageSkillsCommand(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const args = splitArgs(rawArgs);
	const command = args[0] ?? "";

	if (command === "help" || command === "--help" || command === "-h") {
		await emit(pi, ctx, formatManageSkillsHelp());
		return {};
	}

	if (command === "status") {
		const { skills, sources } = await loadManageSkillsInventory(pi, ctx.cwd);
		await emit(pi, ctx, formatManageSkillsStatus(skills, sources));
		return {};
	}

	if (command === "") {
		if (ctx.hasUI) return await runManageSkillsTui(pi, ctx);
		const { skills, sources } = await loadManageSkillsInventory(pi, ctx.cwd);
		await emit(pi, ctx, `${formatManageSkillsStatus(skills, sources)}\n\nInteractive editing requires Pi TUI mode. Run /manage-skills in an interactive terminal, or use /manage-skills help for details.`);
		return {};
	}

	await emit(pi, ctx, `Unsupported /manage-skills command: ${command}\n\n${formatManageSkillsHelp()}`);
	return {};
}

async function loadManageSkillsInventory(pi: ExtensionAPI, cwd: string): Promise<{ state: State; config: ManagerConfig; skills: SkillInfo[]; sources: SkillSourceInfo[] }> {
	const state = await readState();
	const config = await readConfig();
	const pluginSkillPaths = await getPluginSkillPaths(cwd);
	const customSkillPaths = await discoverSkillsFromSources(config.skillSources ?? []);
	const skills = await buildSkillList(pi, pluginSkillPaths, customSkillPaths, state.skillPolicy, cwd, config.skillSources ?? []);
	const sources = buildSourceList(skills, config.skillSources ?? [], state.skillPolicy, cwd);
	return { state, config, skills, sources };
}

async function runManageSkillsTui(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const { state, skills, sources } = await loadManageSkillsInventory(pi, ctx.cwd);
	const result = await ctx.ui.custom<ManageSkillsTuiResult>((tui, theme, _keybindings, done) => createManageSkillsTui({
		cwd: ctx.cwd,
		skills,
		sources,
		state,
		saveState: writeState,
		done,
		tui,
		theme,
		onSaved: clearRuntimeCaches,
	}), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", minWidth: 50, maxHeight: "90%" },
	});
	if (result?.changed) {
		await emit(pi, ctx, "Skill policy updated. Disabled skills are prompt-filtered and /skill blocked immediately; run /reload to refresh manager-owned discovered skills.");
		return { reloadRecommended: true };
	}
	return {};
}

function formatManageSkillsHelp(): string {
	return `# /manage-skills — Skill manager

/manage-skills            # Open the interactive skill manager in Pi TUI mode
/manage-skills status     # Compact skill policy status
/manage-skills help       # Show this help

The interactive manager shows a searchable per-skill table with Current/Rule status. Space toggles the selected skill for this folder, Enter opens read-only details, and advanced policy controls live behind the 'a' screen.

Disabled skills are removed from the model prompt and explicit /skill:<name> invocations are blocked before skill expansion. Manager-owned disabled skills and sources are omitted from resource discovery after /reload; re-enabled resources reappear after /reload.

Non-TUI mode intentionally shows compact status/help instead of printing a full manager.`;
}

export function formatManageSkillsStatus(skills: SkillInfo[], sources: SkillSourceInfo[]): string {
	const enabledSkills = skills.filter((skill) => skill.enabled).length;
	const disabledSkills = skills.filter((skill) => !skill.enabled);
	const disabledSources = sources.filter((source) => !source.enabled);
	const lines = ["# Skill policy status", ""];
	lines.push(`Skills: ${skills.length} total, ${enabledSkills} enabled, ${disabledSkills.length} disabled.`);
	lines.push(`Sources: ${sources.length} total, ${disabledSources.length} disabled.`);
	lines.push("");
	if (disabledSkills.length > 0) {
		lines.push("Disabled skills:");
		for (const skill of disabledSkills.slice(0, 10)) {
			lines.push(`- ${skill.name} (${skill.sourceLabel}) — ${skill.effectiveState} by ${skill.winningScope}/${skill.winningTarget}`);
		}
		if (disabledSkills.length > 10) lines.push(`- …and ${disabledSkills.length - 10} more`);
	} else {
		lines.push("Disabled skills: none");
	}
	lines.push("");
	if (disabledSources.length > 0) {
		lines.push("Disabled sources:");
		for (const source of disabledSources.slice(0, 10)) {
			lines.push(`- ${source.label} (${source.skillCount} skill${source.skillCount === 1 ? "" : "s"}) — ${source.effectiveState} by ${source.winningScope}/${source.winningTarget}`);
		}
		if (disabledSources.length > 10) lines.push(`- …and ${disabledSources.length - 10} more`);
	} else {
		lines.push("Disabled sources: none");
	}
	lines.push("", "Run /reload after policy changes to refresh manager-owned discovered resources.", "Use /manage-skills help for command help.");
	return lines.join("\n");
}

function searchablePluginText(plugin: MarketplacePluginListing): string {
	return [plugin.plugin, plugin.displaySpec, plugin.description, plugin.category, ...(plugin.keywords ?? [])].filter(Boolean).join(" ").toLowerCase();
}

function filterPlugins(plugins: MarketplacePluginListing[], filter: string): MarketplacePluginListing[] {
	const trimmed = filter.trim().toLowerCase();
	if (!trimmed) return plugins;
	return plugins.filter((plugin) => searchablePluginText(plugin).includes(trimmed));
}

function pluginChoiceLabel(plugin: MarketplacePluginListing, index: number): string {
	const metadata = [plugin.version ? `v${plugin.version}` : undefined, plugin.category].filter(Boolean).join(" · ");
	const description = plugin.description ? ` — ${plugin.description}` : "";
	const state = plugin.installable ? "" : " [not installable]";
	return `${index + 1}. ${plugin.displaySpec}${metadata ? ` (${metadata})` : ""}${state}${description}`;
}

async function selectPluginFromMarketplace(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: State, marketplaceName?: string): Promise<CommandResult> {
	const records = Object.values(state.marketplaces).sort((a, b) => a.name.localeCompare(b.name));
	if (records.length === 0) {
		await emit(pi, ctx, "No marketplaces added. Use `/plugin marketplace add <source>`, then `/plugin browse`.");
		return {};
	}

	let selectedMarketplace = marketplaceName;
	if (!selectedMarketplace) {
		if (records.length === 1) selectedMarketplace = records[0]!.name;
		else {
			selectedMarketplace = await ctx.ui.select("Choose marketplace", records.map((record) => record.name));
			if (!selectedMarketplace) return {};
		}
	}

	const listing = await listMarketplacePlugins(state, selectedMarketplace);
	if (listing.diagnostics.length > 0) {
		await emit(pi, ctx, listing.diagnostics.map((diagnostic) => `Marketplace warning for ${diagnostic.marketplace}: ${diagnostic.message}`).join("\n"));
	}
	if (listing.plugins.length === 0) {
		await emit(pi, ctx, `No plugins found in ${selectedMarketplace}.`);
		return {};
	}

	let filter = "";
	let visiblePlugins = listing.plugins;
	if (visiblePlugins.length > PLUGIN_BROWSE_SELECT_LIMIT) {
		const input = await ctx.ui.input("Filter plugins", `${visiblePlugins.length} plugins; type name, category, keyword, or description`);
		if (input === undefined) return {};
		filter = input;
		visiblePlugins = filterPlugins(listing.plugins, filter);
		if (visiblePlugins.length === 0) {
			await emit(pi, ctx, `No plugins in ${selectedMarketplace} match ${JSON.stringify(filter)}.`);
			return {};
		}
	}

	const cappedPlugins = visiblePlugins.slice(0, PLUGIN_BROWSE_SELECT_LIMIT);
	if (visiblePlugins.length > PLUGIN_BROWSE_SELECT_LIMIT) {
		await emit(pi, ctx, `Showing first ${PLUGIN_BROWSE_SELECT_LIMIT} of ${visiblePlugins.length} matching plugins in ${selectedMarketplace}. Run /plugin browse ${selectedMarketplace} again with a narrower filter to see fewer results.`);
	}

	const labels = cappedPlugins.map(pluginChoiceLabel);
	const selectedLabel = await ctx.ui.select(`Browse ${selectedMarketplace}`, labels);
	if (!selectedLabel) return {};
	const selectedIndex = labels.indexOf(selectedLabel);
	const selectedPlugin = cappedPlugins[selectedIndex];
	if (!selectedPlugin) return {};
	if (!selectedPlugin.installSpec) {
		await emit(pi, ctx, `${selectedPlugin.displaySpec} is not installable: ${selectedPlugin.nonInstallableReason ?? "ambiguous plugin spec"}`);
		return {};
	}

	const marketplaceRecord = state.marketplaces[selectedMarketplace!];
	const isLocal = marketplaceRecord?.source.kind === "local";
	const installOptions = isLocal
		? ["Install for user", "Install for project", "Install for dev (symlinked)", "Cancel"]
		: ["Install for user", "Install for project", "Cancel"];
	const action = await ctx.ui.select(`Install ${selectedPlugin.displaySpec}?`, installOptions);
	if (action === "Install for user" || action === "Install for project" || action === "Install for dev (symlinked)") {
		const scope: Scope = action === "Install for project" ? "project" : "user";
		const dev = action === "Install for dev (symlinked)";
		const installed = await installPluginFromMarketplace(state, selectedPlugin.installSpec, scope, ctx.cwd, { dev });
		await writeState(state);
		clearRuntimeCaches();
		const devLabel = installed.dev ? ` [dev \u2194 ${installed.devSourcePath}]` : "";
		await emit(pi, ctx, `Installed ${installed.plugin}@${installed.marketplace}\nversion: ${installed.version}${devLabel}\nscope: ${installed.scope}\npath: ${installed.installPath}\n\nRun /reload or /plugin reload to load newly installed resources.`);
		return { reloadRecommended: true };
	}
	return {};
}

async function handleBrowseCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<CommandResult> {
	const marketplaceName = args[0];
	const state = await readState();
	if (ctx.hasUI) return await selectPluginFromMarketplace(pi, ctx, state, marketplaceName);
	await emit(pi, ctx, formatBrowseList(await listMarketplacePlugins(state, marketplaceName), marketplaceName));
	return {};
}

async function refreshMarketplaceRecords(state: State, marketplaceNames?: string[]): Promise<Map<string, string>> {
	const targets = marketplaceNames
		? [...new Set(marketplaceNames)].map((name) => {
			const record = state.marketplaces[name];
			if (!record) throw new Error(`Unknown marketplace: ${name}`);
			return record;
		})
		: Object.values(state.marketplaces);
	const renamed = new Map<string, string>();
	for (const target of targets) {
		const refreshed = await refreshMarketplace(target);
		delete state.marketplaces[target.name];
		state.marketplaces[refreshed.name] = refreshed;
		renamed.set(target.name, refreshed.name);
	}
	return renamed;
}

function removeUpdatedEntryForRenamedMarketplace(state: State, oldKey: string, newKey: string, entry: { scope: Scope; projectPath?: string }): void {
	if (oldKey === newKey) return;
	if (Object.prototype.hasOwnProperty.call(state.enabledPlugins, oldKey) && !Object.prototype.hasOwnProperty.call(state.enabledPlugins, newKey)) {
		state.enabledPlugins[newKey] = state.enabledPlugins[oldKey]!;
	}
	const remaining = (state.plugins[oldKey] ?? []).filter((candidate) => candidate.scope !== entry.scope || candidate.projectPath !== entry.projectPath);
	if (remaining.length > 0) state.plugins[oldKey] = remaining;
	else {
		delete state.plugins[oldKey];
		delete state.enabledPlugins[oldKey];
	}
}

type PluginUpdateVersionReport = {
	oldKey: string;
	newKey: string;
	scope: Scope;
	projectPath?: string;
	previousVersion: string;
	currentVersion: string;
};

function updateVersionReport(oldKey: string, previous: InstalledPluginEntry, current: InstalledPluginEntry): PluginUpdateVersionReport {
	return {
		oldKey,
		newKey: pluginKey(current.plugin, current.marketplace),
		scope: current.scope,
		projectPath: current.projectPath,
		previousVersion: previous.version,
		currentVersion: current.version,
	};
}

function formatUpdateScope(report: PluginUpdateVersionReport): string {
	return report.scope === "project" ? `project${report.projectPath ? ` (${report.projectPath})` : ""}` : "user";
}

function formatPluginUpdateVersionSummary(reports: PluginUpdateVersionReport[]): string {
	if (reports.length === 0) return "";
	const lines = ["Plugin versions:"];
	const sorted = [...reports].sort((a, b) => a.newKey.localeCompare(b.newKey) || formatUpdateScope(a).localeCompare(formatUpdateScope(b)));
	for (const report of sorted) {
		const key = report.oldKey === report.newKey ? report.newKey : `${report.oldKey} → ${report.newKey}`;
		const version = report.previousVersion === report.currentVersion ? `unchanged ${report.currentVersion}` : `${report.previousVersion} → ${report.currentVersion}`;
		lines.push(`- ${key} (${formatUpdateScope(report)}): ${version}`);
	}
	return lines.join("\n");
}

async function handleMarketplaceCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<CommandResult> {
	const sub = args[0] ?? "list";
	const state = await readState();

	if (sub === "list" || sub === "ls") {
		await emit(pi, ctx, formatMarketplaceList(state));
		return {};
	}

	if (sub === "add") {
		const source = args[1];
		if (!source) throw new Error("Usage: /plugin marketplace add <source>");
		const record = await addMarketplace(source);
		state.marketplaces[record.name] = record;
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Added marketplace ${record.name}\nsource: ${record.source.input}\npath: ${record.path}`);
		return {};
	}

	if (sub === "update" || sub === "refresh") {
		const name = args[1];
		const count = name ? 1 : Object.keys(state.marketplaces).length;
		if (count === 0) throw new Error(name ? `Unknown marketplace: ${name}` : "No marketplaces added");
		await refreshMarketplaceRecords(state, name ? [name] : undefined);
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Updated ${count} marketplace${count === 1 ? "" : "s"}. Installed plugin versions were not changed by this command; run /plugin update to reinstall plugins and see version results.`);
		return {};
	}

	if (sub === "remove" || sub === "rm") {
		const name = args[1];
		if (!name) throw new Error("Usage: /plugin marketplace remove <marketplace>");
		const record = state.marketplaces[name];
		if (!record) throw new Error(`Unknown marketplace: ${name}`);
		delete state.marketplaces[name];
		if (record.source.kind === "git") await rm(record.path, { recursive: true, force: true });
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Removed marketplace ${name}. Installed plugin cache entries were not removed.`);
		return {};
	}

	if (sub === "browse") {
		return await handleBrowseCommand(pi, args.slice(1), ctx);
	}

	throw new Error(`Unknown marketplace command: ${sub}`);
}

async function handlePluginToggle(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const state = await readState();
	const keys = Object.keys(state.plugins).sort();
	if (keys.length === 0) {
		await emit(pi, ctx, "No plugins installed. Use `/plugin install` first.");
		return {};
	}

	if (ctx.hasUI) {
		const checkboxItems: CheckboxItem[] = keys.map((key) => {
			const entries = state.plugins[key] ?? [];
			const desc = entries[0]?.description ? ` \u2014 ${entries[0].description}` : "";
			return {
				label: `${key}${desc}`,
				checked: state.enabledPlugins[key] !== false,
				key,
			};
		});
		const result = await runCheckboxSelector(ctx, "Toggle plugins (space=toggle, enter=apply, esc=cancel)", checkboxItems);
		if (!result || !result.applied) return {};

		let changeCount = 0;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i]!;
			const wasEnabled = state.enabledPlugins[key] !== false;
			const newEnabled = result.items[i]!.checked;
			if (newEnabled !== wasEnabled) {
				changeCount++;
				state.enabledPlugins[key] = newEnabled;
			}
		}
		if (changeCount === 0) {
			await emit(pi, ctx, "No changes made.");
			return {};
		}
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Toggled ${changeCount} plugin${changeCount === 1 ? "" : "s"}. Run /reload or /plugin reload for changes to take effect.`);
		return { reloadRecommended: true };
	}

	await emit(pi, ctx, "Use `/plugin enable <plugin>` or `/plugin disable <plugin>` in non-interactive mode.");
	return {};
}

export async function handleCommand(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const args = splitArgs(rawArgs);
	const command = args[0] ?? "";

	if (!command || command === "help" || command === "--help" || command === "-h") {
		if (!command && ctx.hasUI) {
			const choice = await ctx.ui.select("Plugin manager", [
				"Browse marketplaces and plugins",
				"List installed plugins",
				"Toggle plugins on/off",
				"Show config",
				"List marketplaces",
				"Add marketplace",
				"Install plugin",
				"Update all marketplaces",
				"Check for plugin updates",
				"Show help",
			]);
			if (choice === "Browse marketplaces and plugins") return await handleCommand(pi, "browse", ctx);
			if (choice === "List installed plugins") return await handleCommand(pi, "list", ctx);
			if (choice === "Toggle plugins on/off") return await handlePluginToggle(pi, ctx);
			if (choice === "Show config") return await handleCommand(pi, "config", ctx);
			if (choice === "List marketplaces") return await handleCommand(pi, "marketplace list", ctx);
			if (choice === "Add marketplace") {
				const source = await ctx.ui.input("Marketplace source", "leninkhaidem/super-developer");
				return source ? await handleCommand(pi, `marketplace add ${source}`, ctx) : {};
			}
			if (choice === "Install plugin") {
				const spec = await ctx.ui.input("Plugin", "super-developer@super-developer-marketplace");
				return spec ? await handleCommand(pi, `install ${spec}`, ctx) : {};
			}
			if (choice === "Update all marketplaces") return await handleCommand(pi, "marketplace update", ctx);
			if (choice === "Check for plugin updates") return await handleCommand(pi, "check-updates", ctx);
		}
		await emit(pi, ctx, formatHelp());
		return {};
	}

	if (command === "config" || command === "cfg") {
		return await handleConfigCommand(pi, args.slice(1), ctx);
	}

	if (command === "marketplace" || command === "market" || command === "mp") {
		return await handleMarketplaceCommand(pi, args.slice(1), ctx);
	}

	if (command === "browse") {
		return await handleBrowseCommand(pi, args.slice(1), ctx);
	}

	if (command === "list" || command === "ls" || command === "installed") {
		const state = await readState();
		await emit(pi, ctx, await formatPluginList(state, ctx.cwd));
		return {};
	}

	if (command === "install" || command === "add") {
		const clean = withoutFlags(args.slice(1));
		const spec = clean[0];
		if (!spec) throw new Error("Usage: /plugin install <plugin[@marketplace]> [--project] [--dev]");
		const scope: Scope = hasFlag(args, "--project", "-p") ? "project" : "user";
		const dev = hasFlag(args, "--dev", "--link", "-d");
		const state = await readState();
		const found = await findMarketplacePlugin(state, spec);
		if (!(await confirmInstall(ctx, found.key, scope, dev))) {
			await emit(pi, ctx, `Cancelled install of ${found.key}.`);
			return {};
		}
		const installed = await installPluginFromMarketplace(state, spec, scope, ctx.cwd, { dev });
		await writeState(state);
		clearRuntimeCaches();
		const devLabel = installed.dev ? ` [dev ↔ ${installed.devSourcePath}]` : "";
		await emit(pi, ctx, `Installed ${installed.plugin}@${installed.marketplace}\nversion: ${installed.version}${devLabel}\nscope: ${installed.scope}\npath: ${installed.installPath}\n\nRun /reload or /plugin reload to load newly installed resources.`);
		return { reloadRecommended: true };
	}

	if (command === "uninstall" || command === "remove" || command === "rm") {
		const clean = withoutFlags(args.slice(1));
		const spec = clean[0];
		if (!spec) throw new Error("Usage: /plugin uninstall <plugin[@marketplace]> [--project|--all]");
		const scope = hasFlag(args, "--all") ? undefined : hasFlag(args, "--project", "-p") ? "project" : "user";
		const state = await readState();
		const removed = await uninstallPlugin(state, spec, scope, ctx.cwd);
		await writeState(state);
		clearRuntimeCaches();
		// Sync agent symlinks immediately to clean up stale ones
		try {
			const resources = await discoverInstalledResourcesCached(ctx.cwd);
			await syncAgentSymlinks(resources.agentEntries);
		} catch {}
		await emit(pi, ctx, `Uninstalled:\n${removed.map((item) => `- ${item}`).join("\n")}\n\nRun /reload or /plugin reload to unload removed resources.`);
		return { reloadRecommended: true };
	}

	if (command === "enable" || command === "disable") {
		const spec = args[1];
		if (!spec) throw new Error(`Usage: /plugin ${command} <plugin[@marketplace]>`);
		const state = await readState();
		const parsed = parsePluginSpec(spec);
		const keys = parsed.marketplace ? [pluginKey(parsed.plugin, parsed.marketplace)] : Object.keys(state.plugins).filter((key) => key.startsWith(`${parsed.plugin}@`));
		if (keys.length === 0) throw new Error(`Plugin is not installed: ${spec}`);
		if (!parsed.marketplace && keys.length > 1) throw new Error(`Plugin name is ambiguous. Use plugin@marketplace. Matches: ${keys.join(", ")}`);
		for (const key of keys) state.enabledPlugins[key] = command === "enable";
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `${command === "enable" ? "Enabled" : "Disabled"} ${keys.join(", ")}\n\nRun /reload or /plugin reload for the change to affect loaded resources.`);
		return { reloadRecommended: true };
	}

	if (command === "update") {
		const spec = args[1];
		const state = await readState();
		if (!spec) {
			const allEntries = Object.values(state.plugins).flatMap((entries) => entries.map((entry) => ({ ...entry })));
			const entriesToUpdate = allEntries.filter((entry) => !entry.dev);
			const skippedDev = allEntries.length - entriesToUpdate.length;
			const marketplaceCount = Object.keys(state.marketplaces).length;
			const versionReports: PluginUpdateVersionReport[] = [];
			const renamed = await refreshMarketplaceRecords(state);
			for (const entry of entriesToUpdate) {
				const oldKey = pluginKey(entry.plugin, entry.marketplace);
				const marketplace = renamed.get(entry.marketplace) ?? entry.marketplace;
				const newKey = pluginKey(entry.plugin, marketplace);
				removeUpdatedEntryForRenamedMarketplace(state, oldKey, newKey, entry);
				const installed = await installPluginFromMarketplace(state, newKey, entry.scope, entry.projectPath ?? ctx.cwd);
				versionReports.push(updateVersionReport(oldKey, entry, installed));
			}
			await writeState(state);
			clearRuntimeCaches();
			const devNote = skippedDev > 0 ? ` (skipped ${skippedDev} dev-linked plugin${skippedDev === 1 ? "" : "s"})` : "";
			const versionSummary = formatPluginUpdateVersionSummary(versionReports);
			const versionBlock = versionSummary ? `\n\n${versionSummary}` : "";
			await emit(pi, ctx, `Updated ${marketplaceCount} marketplace${marketplaceCount === 1 ? "" : "s"} and ${entriesToUpdate.length} installed plugin entr${entriesToUpdate.length === 1 ? "y" : "ies"}${devNote}.${versionBlock}\n\nRun /reload or /plugin reload to load updated resources.`);
			return { reloadRecommended: true };
		}
		const parsed = parsePluginSpec(spec);
		const keys = parsed.marketplace ? [pluginKey(parsed.plugin, parsed.marketplace)] : Object.keys(state.plugins).filter((key) => key.startsWith(`${parsed.plugin}@`));
		if (keys.length === 0) throw new Error(`Plugin is not installed: ${spec}`);
		if (!parsed.marketplace && keys.length > 1) throw new Error(`Plugin name is ambiguous. Use plugin@marketplace. Matches: ${keys.join(", ")}`);
		const allEntries = keys.flatMap((key) => (state.plugins[key] ?? []).map((entry) => ({ ...entry })));
		const entriesToUpdate = allEntries.filter((entry) => !entry.dev);
		if (entriesToUpdate.length === 0 && allEntries.length > 0) {
			await emit(pi, ctx, `${spec} is installed in dev mode (symlinked). Changes are picked up automatically on /reload — no update needed.`);
			return {};
		}
		const versionReports: PluginUpdateVersionReport[] = [];
		const refreshedMarketplaceCount = new Set(entriesToUpdate.map((entry) => entry.marketplace)).size;
		const renamed = await refreshMarketplaceRecords(state, entriesToUpdate.map((entry) => entry.marketplace));
		for (const entry of entriesToUpdate) {
			const oldKey = pluginKey(entry.plugin, entry.marketplace);
			const marketplace = renamed.get(entry.marketplace) ?? entry.marketplace;
			const newKey = pluginKey(entry.plugin, marketplace);
			removeUpdatedEntryForRenamedMarketplace(state, oldKey, newKey, entry);
			const installed = await installPluginFromMarketplace(state, newKey, entry.scope, entry.projectPath ?? ctx.cwd);
			versionReports.push(updateVersionReport(oldKey, entry, installed));
		}
		await writeState(state);
		clearRuntimeCaches();
		const versionSummary = formatPluginUpdateVersionSummary(versionReports);
		const versionBlock = versionSummary ? `\n\n${versionSummary}` : "";
		await emit(pi, ctx, `Updated ${entriesToUpdate.length} installed plugin entr${entriesToUpdate.length === 1 ? "y" : "ies"} for ${spec} after refreshing ${refreshedMarketplaceCount} marketplace${refreshedMarketplaceCount === 1 ? "" : "s"}.${versionBlock}\n\nRun /reload or /plugin reload to load updated resources.`);
		return { reloadRecommended: true };
	}

	if (command === "check-updates" || command === "check-update") {
		const state = await readState();
		const gitMarketplaces = Object.values(state.marketplaces).filter((m) => m.source.kind === "git");
		if (gitMarketplaces.length === 0) {
			await emit(pi, ctx, "No git marketplaces added. Update checks only work with git-based marketplaces.");
			return {};
		}
		if (Object.keys(state.plugins).length === 0) {
			await emit(pi, ctx, "No plugins installed.");
			return {};
		}
		await emit(pi, ctx, "Checking for plugin updates...");
		const results = await runUpdateCheck(state, true);
		const entries = Object.entries(results);
		if (entries.length === 0) {
			await emit(pi, ctx, "All plugins are up to date.");
			return {};
		}

		if (ctx.hasUI) {
			const checkboxItems: CheckboxItem[] = entries.map(([key, result]) => ({
				label: `${key}: ${result.installedVersion} \u2192 ${result.availableVersion}`,
				checked: true,
				key,
			}));
			const selection = await runCheckboxSelector(ctx, `${entries.length} update${entries.length === 1 ? "" : "s"} available (space=toggle, enter=update selected, esc=cancel)`, checkboxItems);
			if (!selection || !selection.applied) {
				await emit(pi, ctx, "Update cancelled.");
				return {};
			}
			const selected = selection.items.filter((item) => item.checked);
			if (selected.length === 0) {
				await emit(pi, ctx, "No plugins selected for update.");
				return {};
			}
			// Update selected plugins
			for (const item of selected) {
				try {
					const refreshedState = await readState();
					const entryList = refreshedState.plugins[item.key] ?? [];
					for (const entry of entryList) {
						await installPluginFromMarketplace(refreshedState, item.key, entry.scope, entry.projectPath ?? ctx.cwd);
					}
					await writeState(refreshedState);
				} catch (error) {
					await emit(pi, ctx, `Failed to update ${item.key}: ${(error as Error).message}`);
				}
			}
			clearRuntimeCaches();
			await emit(pi, ctx, `Updated ${selected.length} plugin${selected.length === 1 ? "" : "s"}. Run /reload for changes to take effect.`);
			return { reloadRecommended: true };
		}

		await emit(pi, ctx, formatUpdateCheckResults(results));
		return {};
	}

	if (command === "reload") {
		await ctx.reload();
		return {};
	}

	throw new Error(`Unknown /plugin command: ${command}. Use /plugin help.`);
}
