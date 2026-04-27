import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CLAUDE_DIR, STATE_VERSION } from "./constants.js";
import { exists, readJsonFile } from "./fs-utils.js";
import type { ManagerConfig, ResolvedManagerConfig, State } from "./types.js";
import { normalizePath } from "./utils.js";

export function stateDir(): string {
	return path.join(getAgentDir(), "claude-plugin-manager");
}

export function statePath(): string {
	return path.join(stateDir(), "state.json");
}

export function configPath(): string {
	return path.join(stateDir(), "config.json");
}

export function cacheDir(): string {
	return path.join(stateDir(), "cache");
}

export function marketplacesDir(): string {
	return path.join(stateDir(), "marketplaces");
}

export function defaultState(): State {
	return {
		version: STATE_VERSION,
		marketplaces: {},
		plugins: {},
		enabledPlugins: {},
		disabledSkills: {},
		disabledSkillSources: {},
	};
}

export function defaultConfig(): ManagerConfig {
	return {
		claudeReadOnlyImports: true,
		claudeDir: DEFAULT_CLAUDE_DIR,
	};
}

export async function readState(): Promise<State> {
	if (!(await exists(statePath()))) return defaultState();
	try {
		const parsed = await readJsonFile<Partial<State>>(statePath());
		return {
			version: STATE_VERSION,
			marketplaces: parsed.marketplaces ?? {},
			plugins: parsed.plugins ?? {},
			enabledPlugins: parsed.enabledPlugins ?? {},
			disabledSkills: parsed.disabledSkills ?? {},
			disabledSkillSources: parsed.disabledSkillSources ?? {},
			lastUpdateCheckAt: parsed.lastUpdateCheckAt,
			lastUpdateCheckResults: parsed.lastUpdateCheckResults,
		};
	} catch (error) {
		throw new Error(`Failed to read ${statePath()}: ${(error as Error).message}`);
	}
}

export async function writeState(state: State): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readConfig(): Promise<ManagerConfig> {
	if (!(await exists(configPath()))) return defaultConfig();
	try {
		return { ...defaultConfig(), ...(await readJsonFile<ManagerConfig>(configPath())) };
	} catch (error) {
		throw new Error(`Failed to read ${configPath()}: ${(error as Error).message}`);
	}
}

export async function writeConfig(config: ManagerConfig): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveManagerConfig(config: ManagerConfig): ResolvedManagerConfig {
	const claudeReadOnlyImports = config.claudeReadOnlyImports ?? true;
	const claudeDir = normalizePath(config.claudeDir ?? DEFAULT_CLAUDE_DIR);
	const claudePluginsDir = normalizePath(config.claudePluginsDir ?? path.join(claudeDir, "plugins"));
	const claudeSettingsPath = normalizePath(config.claudeSettingsPath ?? path.join(claudeDir, "settings.json"));
	const claudeInstalledPluginsPath = normalizePath(config.claudeInstalledPluginsPath ?? path.join(claudePluginsDir, "installed_plugins.json"));
	return { claudeReadOnlyImports, claudeDir, claudePluginsDir, claudeSettingsPath, claudeInstalledPluginsPath };
}

export function formatConfig(config: ManagerConfig): string {
	const resolved = resolveManagerConfig(config);
	const lines = [
		"# Claude plugin manager config",
		"",
		`config path: ${configPath()}`,
		`claudeReadOnlyImports: ${resolved.claudeReadOnlyImports}`,
		`claudeDir: ${resolved.claudeDir}`,
		`claudePluginsDir: ${resolved.claudePluginsDir}`,
		`claudeSettingsPath: ${resolved.claudeSettingsPath}`,
		`claudeInstalledPluginsPath: ${resolved.claudeInstalledPluginsPath}`,
	];
	if (config.skillSources && config.skillSources.length > 0) {
		lines.push(`skillSources:`);
		for (const source of config.skillSources) {
			lines.push(`  - ${source}`);
		}
	} else {
		lines.push(`skillSources: (none)`);
	}
	lines.push(`updateCheckEnabled: ${config.updateCheckEnabled ?? true}`);
	lines.push(`updateCheckTTL: ${config.updateCheckTTL ?? "86400000 (24h)"}`);
	lines.push(`updateCheckOnStartup: ${config.updateCheckOnStartup ?? "notify"}`);
	return lines.join("\n");
}
