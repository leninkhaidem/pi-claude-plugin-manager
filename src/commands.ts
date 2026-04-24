import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { clearDiscoveryCache } from "./discovery.js";
import { confirmInstall, emit, formatHelp, formatMarketplaceList, formatPluginList } from "./format.js";
import { installPluginFromMarketplace, uninstallPlugin } from "./installer.js";
import { addMarketplace, findMarketplacePlugin, refreshMarketplace } from "./marketplace.js";
import { defaultConfig, formatConfig, readConfig, readState, writeConfig, writeState } from "./state.js";
import type { CommandResult, ManagerConfig, Scope } from "./types.js";
import { hasFlag, parsePluginSpec, pluginKey, splitArgs, withoutFlags } from "./utils.js";
import { rm } from "node:fs/promises";

async function handleConfigCommand(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<CommandResult> {
	const sub = args[0] ?? "show";
	const validKeys = new Set<keyof ManagerConfig>(["claudeReadOnlyImports", "claudeDir", "claudePluginsDir", "claudeSettingsPath", "claudeInstalledPluginsPath"]);

	if (sub === "show" || sub === "list" || sub === "get") {
		await emit(pi, ctx, formatConfig(await readConfig()));
		return {};
	}

	if (sub === "set") {
		const key = args[1] as keyof ManagerConfig | undefined;
		const rawValue = args.slice(2).join(" ");
		if (!key || !validKeys.has(key) || rawValue === "") {
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
		clearDiscoveryCache();
		await emit(pi, ctx, `Updated config ${key}.\n\n${formatConfig(config)}\n\nRun /reload or /plugin reload for resource imports to use the new paths.`);
		return { reloadRecommended: true };
	}

	if (sub === "reset") {
		const key = args[1] as keyof ManagerConfig | undefined;
		if (!key) {
			const config = defaultConfig();
			await writeConfig(config);
			clearDiscoveryCache();
			await emit(pi, ctx, `Reset plugin manager config.\n\n${formatConfig(config)}`);
			return { reloadRecommended: true };
		}
		if (!validKeys.has(key)) throw new Error(`Unknown config key: ${key}`);
		const config = await readConfig();
		delete config[key];
		await writeConfig(config);
		clearDiscoveryCache();
		await emit(pi, ctx, `Reset config ${key}.\n\n${formatConfig(config)}`);
		return { reloadRecommended: true };
	}

	throw new Error(`Unknown config command: ${sub}`);
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
		clearDiscoveryCache();
		await emit(pi, ctx, `Added marketplace ${record.name}\nsource: ${record.source.input}\npath: ${record.path}`);
		return {};
	}

	if (sub === "update" || sub === "refresh") {
		const name = args[1];
		const targets = name ? [state.marketplaces[name]].filter(Boolean) : Object.values(state.marketplaces);
		if (targets.length === 0) throw new Error(name ? `Unknown marketplace: ${name}` : "No marketplaces added");
		for (const target of targets) {
			const refreshed = await refreshMarketplace(target);
			delete state.marketplaces[target.name];
			state.marketplaces[refreshed.name] = refreshed;
		}
		await writeState(state);
		clearDiscoveryCache();
		await emit(pi, ctx, `Updated ${targets.length} marketplace${targets.length === 1 ? "" : "s"}.`);
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
		clearDiscoveryCache();
		await emit(pi, ctx, `Removed marketplace ${name}. Installed plugin cache entries were not removed.`);
		return {};
	}

	throw new Error(`Unknown marketplace command: ${sub}`);
}

export async function handleCommand(pi: ExtensionAPI, rawArgs: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const args = splitArgs(rawArgs);
	const command = args[0] ?? "";

	if (!command || command === "help" || command === "--help" || command === "-h") {
		if (!command && ctx.hasUI) {
			const choice = await ctx.ui.select("Plugin manager", [
				"List installed plugins",
				"Show config",
				"List marketplaces",
				"Add marketplace",
				"Install plugin",
				"Update all marketplaces",
				"Show help",
			]);
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
		clearDiscoveryCache();
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
		clearDiscoveryCache();
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
		clearDiscoveryCache();
		await emit(pi, ctx, `${command === "enable" ? "Enabled" : "Disabled"} ${keys.join(", ")}\n\nRun /reload or /plugin reload for the change to affect loaded resources.`);
		return { reloadRecommended: true };
	}

	if (command === "update") {
		const spec = args[1];
		const state = await readState();
		if (!spec) {
			for (const record of Object.values(state.marketplaces)) {
				const refreshed = await refreshMarketplace(record);
				delete state.marketplaces[record.name];
				state.marketplaces[refreshed.name] = refreshed;
			}
			const installedKeys = Object.keys(state.plugins);
			for (const key of installedKeys) {
				const entries = [...(state.plugins[key] ?? [])];
				for (const entry of entries) {
					await installPluginFromMarketplace(state, key, entry.scope, entry.projectPath ?? ctx.cwd);
				}
			}
			await writeState(state);
			clearDiscoveryCache();
			await emit(pi, ctx, `Updated ${installedKeys.length} installed plugin${installedKeys.length === 1 ? "" : "s"}.\n\nRun /reload or /plugin reload to load updated resources.`);
			return { reloadRecommended: true };
		}
		const parsed = parsePluginSpec(spec);
		const keys = parsed.marketplace ? [pluginKey(parsed.plugin, parsed.marketplace)] : Object.keys(state.plugins).filter((key) => key.startsWith(`${parsed.plugin}@`));
		if (keys.length === 0) throw new Error(`Plugin is not installed: ${spec}`);
		if (!parsed.marketplace && keys.length > 1) throw new Error(`Plugin name is ambiguous. Use plugin@marketplace. Matches: ${keys.join(", ")}`);
		for (const key of keys) {
			const entries = state.plugins[key] ?? [];
			for (const entry of [...entries]) {
				await installPluginFromMarketplace(state, pluginKey(entry.plugin, entry.marketplace), entry.scope, entry.projectPath ?? ctx.cwd);
			}
		}
		await writeState(state);
		clearDiscoveryCache();
		await emit(pi, ctx, `Updated ${spec}.\n\nRun /reload or /plugin reload to load updated resources.`);
		return { reloadRecommended: true };
	}

	if (command === "reload") {
		await ctx.reload();
		return {};
	}

	throw new Error(`Unknown /plugin command: ${command}. Use /plugin help.`);
}
