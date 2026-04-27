import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { PLUGIN_AUTOCOMPLETE_LIMIT, PLUGIN_BROWSE_SELECT_LIMIT } from "./constants.js";
import { CONFIG_FIELDS, configFieldForKey } from "./config-metadata.js";
import { listMarketplacePlugins } from "./marketplace.js";
import { readState } from "./state.js";
import type { MarketplacePluginListingResult, State } from "./types.js";
import { parsePluginSpec, pluginKey, splitArgs } from "./utils.js";

export { PLUGIN_AUTOCOMPLETE_LIMIT, PLUGIN_BROWSE_SELECT_LIMIT };

const SKILLS_TOP_LEVEL_COMMANDS = [
	{ value: "help", description: "Show /skills help" },
	{ value: "list", description: "List all managed skills with status" },
	{ value: "toggle", description: "Toggle a skill on or off" },
	{ value: "sources", description: "Manage skill source directories" },
];

const SKILLS_SOURCES_COMMANDS = [
	{ value: "list", description: "List all skill sources with status" },
	{ value: "toggle", description: "Toggle a skill source on/off" },
	{ value: "add", description: "Add a custom skill source directory" },
	{ value: "remove", description: "Remove a custom skill source directory" },
];

const TOP_LEVEL_COMMANDS = [
	{ value: "help", description: "Show /plugin help" },
	{ value: "list", description: "List installed and imported plugins" },
	{ value: "config", description: "Show or edit plugin manager config" },
	{ value: "marketplace", description: "Manage marketplaces" },
	{ value: "browse", description: "Browse plugins in added marketplaces" },
	{ value: "install", description: "Install a plugin" },
	{ value: "update", description: "Update installed plugins" },
	{ value: "enable", description: "Enable an installed plugin" },
	{ value: "disable", description: "Disable an installed plugin" },
	{ value: "uninstall", description: "Uninstall a plugin" },
	{ value: "check-updates", description: "Check for available plugin updates" },
	{ value: "reload", description: "Reload Pi resources" },
];

const MARKETPLACE_COMMANDS = [
	{ value: "list", description: "List added marketplaces" },
	{ value: "add", description: "Add a marketplace source" },
	{ value: "update", description: "Update one or all marketplaces" },
	{ value: "remove", description: "Remove a marketplace" },
	{ value: "browse", description: "Browse plugins in a marketplace" },
];

const CONFIG_COMMANDS = [
	{ value: "show", description: "Show resolved config" },
	{ value: "set", description: "Set a config value" },
	{ value: "reset", description: "Reset one key or all config" },
];

let marketplaceCacheKey: string | undefined;
let marketplaceCache: Promise<MarketplacePluginListingResult> | undefined;

export function clearAutocompleteCache(): void {
	marketplaceCacheKey = undefined;
	marketplaceCache = undefined;
}

function marketplaceStateCacheKey(state: State): string {
	return JSON.stringify(Object.values(state.marketplaces).map((record) => ({
		name: record.name,
		path: record.path,
		updatedAt: record.updatedAt,
		addedAt: record.addedAt,
		source: record.source.input,
	})).sort((a, b) => a.name.localeCompare(b.name)));
}

async function listMarketplacePluginsCached(state: State): Promise<MarketplacePluginListingResult> {
	const key = marketplaceStateCacheKey(state);
	if (marketplaceCacheKey !== key || !marketplaceCache) {
		marketplaceCacheKey = key;
		marketplaceCache = listMarketplacePlugins(state).catch((error) => {
			clearAutocompleteCache();
			throw error;
		});
	}
	return await marketplaceCache;
}

function hasOpenQuoteOrTrailingEscape(value: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of value) {
		if (escaping) {
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
	}
	return escaping || quote !== undefined;
}

function parseCompletionPrefix(argumentPrefix: string): { tokens: string[]; current: string; before: string[] } | undefined {
	if (hasOpenQuoteOrTrailingEscape(argumentPrefix)) return undefined;
	const trailingSpace = /\s$/.test(argumentPrefix);
	const tokens = splitArgs(argumentPrefix);
	const current = trailingSpace ? "" : tokens[tokens.length - 1] ?? "";
	const before = trailingSpace ? tokens : tokens.slice(0, -1);
	return { tokens, current, before };
}

function quoteArg(value: string): string {
	if (/^[^\s"'\\]+$/.test(value)) return value;
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function itemValue(before: string[], value: string): string {
	return [...before, value].map(quoteArg).join(" ");
}

function specRoundTrips(spec: string): boolean {
	if (spec.startsWith("--")) return false;
	const parsed = parsePluginSpec(spec);
	return parsed.marketplace !== undefined && pluginKey(parsed.plugin, parsed.marketplace) === spec;
}

function makeItems(before: string[], current: string, candidates: Array<{ value: string; label?: string; description?: string }>, limit = PLUGIN_AUTOCOMPLETE_LIMIT): AutocompleteItem[] | null {
	const lower = current.toLowerCase();
	const filtered = candidates
		.filter((candidate) => candidate.value.toLowerCase().startsWith(lower))
		.sort((a, b) => a.value.localeCompare(b.value))
		.slice(0, limit)
		.map((candidate) => ({
			value: itemValue(before, candidate.value),
			label: candidate.label ?? candidate.value,
			description: candidate.description,
		}));
	return filtered.length > 0 ? filtered : null;
}

function marketplaceNameItems(state: State): Array<{ value: string; description?: string }> {
	return Object.values(state.marketplaces).map((record) => ({ value: record.name, description: record.description })).sort((a, b) => a.value.localeCompare(b.value));
}

function installedPluginItems(state: State): Array<{ value: string; description?: string }> {
	return Object.keys(state.plugins)
		.filter(specRoundTrips)
		.sort()
		.map((key) => ({
			value: key,
			description: state.enabledPlugins[key] === false ? "disabled" : "installed",
		}));
}

async function installablePluginItems(state: State): Promise<Array<{ value: string; description?: string }>> {
	const listings = await listMarketplacePluginsCached(state);
	return listings.plugins
		.filter((plugin) => plugin.installSpec)
		.map((plugin) => ({
			value: plugin.installSpec!,
			description: plugin.description ?? plugin.category ?? plugin.marketplace,
		}))
		.sort((a, b) => a.value.localeCompare(b.value));
}

function flagItems(flags: string[]): Array<{ value: string; description?: string }> {
	return flags.map((flag) => ({ value: flag }));
}

export async function getSkillsArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	try {
		const parsedPrefix = parseCompletionPrefix(argumentPrefix);
		if (!parsedPrefix) return null;
		const { tokens, current, before } = parsedPrefix;
		const command = tokens[0] ?? "";

		if (before.length === 0) return makeItems([], current, SKILLS_TOP_LEVEL_COMMANDS);

		if (command === "sources") {
			if (before.length === 1) return makeItems(before, current, SKILLS_SOURCES_COMMANDS);
			return null;
		}

		if (command === "toggle" && before.length === 1) {
			const state = await readState();
			const allDisabled = Object.keys(state.disabledSkills);
			// We can't easily list all skill names here without full discovery,
			// but we can suggest disabled skill paths for re-enabling
			if (allDisabled.length > 0) {
				return makeItems(before, current, allDisabled.map((p) => {
					const name = p.split("/").slice(-2, -1)[0] ?? p;
					return { value: name, description: "disabled" };
				}));
			}
			return null;
		}

		return null;
	} catch {
		return null;
	}
}

export async function getPluginArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	try {
		const parsedPrefix = parseCompletionPrefix(argumentPrefix);
		if (!parsedPrefix) return null;
		const { tokens, current, before } = parsedPrefix;
		const command = tokens[0] ?? "";

		if (before.length === 0) return makeItems([], current, TOP_LEVEL_COMMANDS);
		const needsState = !["config", "cfg", "help", "reload", "list", "ls", "installed"].includes(command);
		const state = needsState ? await readState() : undefined;

		if (command === "marketplace" || command === "market" || command === "mp") {
			const sub = tokens[1] ?? "";
			if (before.length === 1) return makeItems(before, current, MARKETPLACE_COMMANDS);
			if (["update", "refresh", "remove", "rm", "browse"].includes(sub) && before.length === 2 && state) {
				return makeItems(before, current, marketplaceNameItems(state));
			}
			return null;
		}

		if (command === "config" || command === "cfg") {
			const sub = tokens[1] ?? "";
			if (before.length === 1) return makeItems(before, current, CONFIG_COMMANDS);
			if ((sub === "set" || sub === "reset") && before.length === 2) {
				return makeItems(before, current, CONFIG_FIELDS.map((field) => ({ value: field.key, description: field.description })));
			}
			if (sub === "set" && before.length === 3) {
				const field = configFieldForKey(tokens[2] ?? "");
				if (field?.values) return makeItems(before, current, field.values.map((value) => ({ value })));
			}
			return null;
		}

		if (command === "browse") {
			if (before.length === 1 && state) return makeItems(before, current, marketplaceNameItems(state));
			return null;
		}

		if ((command === "install" || command === "add") && state) {
			if (before.length === 1) {
				if (current.startsWith("--")) return makeItems(before, current, flagItems(["--project"]));
				return makeItems(before, current, await installablePluginItems(state));
			}
			if (before.length >= 2 && current.startsWith("--")) return makeItems(before, current, flagItems(["--project"]));
			return null;
		}

		if ((command === "uninstall" || command === "remove" || command === "rm") && state) {
			if (before.length === 1) {
				if (current.startsWith("--")) return makeItems(before, current, flagItems(["--project", "--all"]));
				return makeItems(before, current, installedPluginItems(state));
			}
			if (before.length >= 2 && current.startsWith("--")) return makeItems(before, current, flagItems(["--project", "--all"]));
			return null;
		}

		if ((command === "enable" || command === "disable" || command === "update") && state) {
			if (before.length === 1) return makeItems(before, current, installedPluginItems(state));
			return null;
		}

		return null;
	} catch {
		return null;
	}
}
