import type { ManagerConfig } from "./types.js";

export type ConfigKey = keyof ManagerConfig;

export type ConfigField = {
	key: ConfigKey;
	description: string;
	values?: string[];
};

export const CONFIG_FIELDS: ConfigField[] = [
	{
		key: "claudeReadOnlyImports",
		description: "Enable or disable read-only imports from Claude Code installs",
		values: ["true", "false"],
	},
	{
		key: "claudeDir",
		description: "Base Claude Code directory",
	},
	{
		key: "claudePluginsDir",
		description: "Claude Code plugin directory override",
	},
	{
		key: "claudeSettingsPath",
		description: "Claude Code settings.json path override",
	},
	{
		key: "claudeInstalledPluginsPath",
		description: "Claude Code installed_plugins.json path override",
	},
];

export const CONFIG_KEYS = CONFIG_FIELDS.map((field) => field.key);
export const CONFIG_KEY_SET = new Set<ConfigKey>(CONFIG_KEYS);

export function isConfigKey(value: string): value is ConfigKey {
	return CONFIG_KEY_SET.has(value as ConfigKey);
}

export function configFieldForKey(key: string): ConfigField | undefined {
	return CONFIG_FIELDS.find((field) => field.key === key);
}
