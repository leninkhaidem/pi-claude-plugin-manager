import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { clearAutocompleteCache, PLUGIN_BROWSE_SELECT_LIMIT } from "./autocomplete.js";
import { isConfigKey } from "./config-metadata.js";
import { clearDiscoveryCache } from "./discovery.js";
import { confirmInstall, emit, formatBrowseList, formatHelp, formatMarketplaceList, formatPluginList } from "./format.js";
import { installPluginFromMarketplace, uninstallPlugin } from "./installer.js";
import { addMarketplace, findMarketplacePlugin, listMarketplacePlugins, refreshMarketplace } from "./marketplace.js";
import { defaultConfig, formatConfig, readConfig, readState, writeConfig, writeState } from "./state.js";
import type { CommandResult, MarketplacePluginListing, ManagerConfig, Scope, State } from "./types.js";
import { hasFlag, parsePluginSpec, pluginKey, splitArgs, withoutFlags } from "./utils.js";
import { rm } from "node:fs/promises";

function clearRuntimeCaches(): void {
	clearDiscoveryCache();
	clearAutocompleteCache();
}

async function handleConfigCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<CommandResult> {
	const sub = args[0] ?? "show";

	if (sub === "show" || sub === "list" || sub === "get") {
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
		if (key === "claudeReadOnlyImports") {
			const normalized = rawValue.toLowerCase();
			if (!["true", "false", "1", "0", "yes", "no"].includes(normalized)) {
				throw new Error("claudeReadOnlyImports must be true or false");
			}
			config[key] = normalized === "true" || normalized === "1" || normalized === "yes";
		} else {
			config[key] = rawValue;
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

	const action = await ctx.ui.select(`Install ${selectedPlugin.displaySpec}?`, ["Install for user", "Install for project", "Cancel"]);
	if (action === "Install for user" || action === "Install for project") {
		const scope: Scope = action === "Install for project" ? "project" : "user";
		const installed = await installPluginFromMarketplace(state, selectedPlugin.installSpec, scope, ctx.cwd);
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Installed ${installed.plugin}@${installed.marketplace}\nversion: ${installed.version}\nscope: ${installed.scope}\npath: ${installed.installPath}\n\nRun /reload or /plugin reload to load newly installed resources.`);
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
		await emit(pi, ctx, `Updated ${count} marketplace${count === 1 ? "" : "s"}.`);
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

export async function handleCommand(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const args = splitArgs(rawArgs);
	const command = args[0] ?? "";

	if (!command || command === "help" || command === "--help" || command === "-h") {
		if (!command && ctx.hasUI) {
			const choice = await ctx.ui.select("Plugin manager", [
				"Browse marketplaces and plugins",
				"List installed plugins",
				"Show config",
				"List marketplaces",
				"Add marketplace",
				"Install plugin",
				"Update all marketplaces",
				"Show help",
			]);
			if (choice === "Browse marketplaces and plugins") return await handleCommand(pi, "browse", ctx);
			if (choice === "List installed plugins") return await handleCommand(pi, "list", ctx);
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
		if (!spec) throw new Error("Usage: /plugin install <plugin[@marketplace]> [--project]");
		const scope: Scope = hasFlag(args, "--project", "-p") ? "project" : "user";
		const state = await readState();
		const found = await findMarketplacePlugin(state, spec);
		if (!(await confirmInstall(ctx, found.key, scope))) {
			await emit(pi, ctx, `Cancelled install of ${found.key}.`);
			return {};
		}
		const installed = await installPluginFromMarketplace(state, spec, scope, ctx.cwd);
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Installed ${installed.plugin}@${installed.marketplace}\nversion: ${installed.version}\nscope: ${installed.scope}\npath: ${installed.installPath}\n\nRun /reload or /plugin reload to load newly installed resources.`);
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
			const entriesToUpdate = Object.values(state.plugins).flatMap((entries) => entries.map((entry) => ({ ...entry })));
			const marketplaceCount = Object.keys(state.marketplaces).length;
			const renamed = await refreshMarketplaceRecords(state);
			for (const entry of entriesToUpdate) {
				const oldKey = pluginKey(entry.plugin, entry.marketplace);
				const marketplace = renamed.get(entry.marketplace) ?? entry.marketplace;
				const newKey = pluginKey(entry.plugin, marketplace);
				removeUpdatedEntryForRenamedMarketplace(state, oldKey, newKey, entry);
				await installPluginFromMarketplace(state, newKey, entry.scope, entry.projectPath ?? ctx.cwd);
			}
			await writeState(state);
			clearRuntimeCaches();
			await emit(pi, ctx, `Updated ${marketplaceCount} marketplace${marketplaceCount === 1 ? "" : "s"} and ${entriesToUpdate.length} installed plugin entr${entriesToUpdate.length === 1 ? "y" : "ies"}.\n\nRun /reload or /plugin reload to load updated resources.`);
			return { reloadRecommended: true };
		}
		const parsed = parsePluginSpec(spec);
		const keys = parsed.marketplace ? [pluginKey(parsed.plugin, parsed.marketplace)] : Object.keys(state.plugins).filter((key) => key.startsWith(`${parsed.plugin}@`));
		if (keys.length === 0) throw new Error(`Plugin is not installed: ${spec}`);
		if (!parsed.marketplace && keys.length > 1) throw new Error(`Plugin name is ambiguous. Use plugin@marketplace. Matches: ${keys.join(", ")}`);
		const entriesToUpdate = keys.flatMap((key) => (state.plugins[key] ?? []).map((entry) => ({ ...entry })));
		const renamed = await refreshMarketplaceRecords(state, entriesToUpdate.map((entry) => entry.marketplace));
		for (const entry of entriesToUpdate) {
			const oldKey = pluginKey(entry.plugin, entry.marketplace);
			const marketplace = renamed.get(entry.marketplace) ?? entry.marketplace;
			const newKey = pluginKey(entry.plugin, marketplace);
			removeUpdatedEntryForRenamedMarketplace(state, oldKey, newKey, entry);
			await installPluginFromMarketplace(state, newKey, entry.scope, entry.projectPath ?? ctx.cwd);
		}
		await writeState(state);
		clearRuntimeCaches();
		await emit(pi, ctx, `Updated ${entriesToUpdate.length} installed plugin entr${entriesToUpdate.length === 1 ? "y" : "ies"} for ${spec} after refreshing ${new Set(entriesToUpdate.map((entry) => entry.marketplace)).size} marketplace${new Set(entriesToUpdate.map((entry) => entry.marketplace)).size === 1 ? "" : "s"}.\n\nRun /reload or /plugin reload to load updated resources.`);
		return { reloadRecommended: true };
	}

	if (command === "reload") {
		await ctx.reload();
		return {};
	}

	throw new Error(`Unknown /plugin command: ${command}. Use /plugin help.`);
}
