export type Scope = "user" | "project";

export type MarketplaceSource = {
	kind: "git" | "local";
	input: string;
	url?: string;
	ref?: string;
	localPath?: string;
};

export type MarketplaceRecord = {
	name: string;
	description?: string;
	owner?: unknown;
	source: MarketplaceSource;
	path: string;
	addedAt: string;
	updatedAt?: string;
};

export type PluginSource =
	| string
	| {
			source?: string;
			repo?: string;
			url?: string;
			path?: string;
			ref?: string;
			sha?: string;
			package?: string;
			version?: string;
			registry?: string;
		};

export type MarketplacePluginEntry = {
	name: string;
	source: PluginSource;
	description?: string;
	version?: string;
	category?: string;
	keywords?: string[];
	author?: unknown;
	homepage?: string;
	repository?: string;
	license?: string;
	skills?: string | string[];
	commands?: string | string[];
	strict?: boolean;
	[key: string]: unknown;
};

export type MarketplaceFile = {
	name: string;
	description?: string;
	owner?: unknown;
	metadata?: {
		description?: string;
		version?: string;
		pluginRoot?: string;
		[key: string]: unknown;
	};
	plugins?: MarketplacePluginEntry[];
};

export type PluginManifest = {
	name?: string;
	version?: string;
	description?: string;
	author?: unknown;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	skills?: string | string[];
	commands?: string | string[];
	[key: string]: unknown;
};

export type InstalledPluginEntry = {
	scope: Scope;
	projectPath?: string;
	marketplace: string;
	plugin: string;
	version: string;
	installPath: string;
	source: PluginSource;
	description?: string;
	installedAt: string;
	updatedAt?: string;
	gitCommitSha?: string;
	manifest?: PluginManifest;
	marketplaceEntry?: MarketplacePluginEntry;
};

export type ClaudeInstalledPluginEntry = {
	scope?: string;
	projectPath?: string;
	installPath?: string;
	version?: string;
	installedAt?: string;
	lastUpdated?: string;
	gitCommitSha?: string;
};

export type ClaudeInstalledPluginsFile = {
	plugins?: Record<string, ClaudeInstalledPluginEntry[]>;
};

export type ClaudeSettingsFile = {
	enabledPlugins?: Record<string, boolean>;
};

export type ManagerConfig = {
	claudeReadOnlyImports?: boolean;
	claudeDir?: string;
	claudePluginsDir?: string;
	claudeSettingsPath?: string;
	claudeInstalledPluginsPath?: string;
	skillSources?: string[];
	updateCheckEnabled?: boolean;
	updateCheckTTL?: number;
	updateCheckOnStartup?: "notify" | "prompt" | "off";
};

export type ResolvedManagerConfig = Required<ManagerConfig>;

export type UpdateCheckResult = {
	installedVersion: string;
	availableVersion: string;
	marketplace: string;
	plugin: string;
};

export type State = {
	version: 1;
	marketplaces: Record<string, MarketplaceRecord>;
	plugins: Record<string, InstalledPluginEntry[]>;
	enabledPlugins: Record<string, boolean>;
	disabledSkills: Record<string, boolean>;
	disabledSkillSources: Record<string, boolean>;
	lastUpdateCheckAt?: string;
	lastUpdateCheckResults?: Record<string, UpdateCheckResult>;
};

export type PluginSpec = {
	plugin: string;
	marketplace?: string;
};

export type CommandResult = {
	reloadRecommended?: boolean;
};

export type MarketplacePluginListing = {
	marketplace: string;
	marketplaceDescription?: string;
	plugin: string;
	displaySpec: string;
	installSpec?: string;
	installable: boolean;
	nonInstallableReason?: string;
	description?: string;
	version?: string;
	category?: string;
	keywords?: string[];
	entry: MarketplacePluginEntry;
};

export type MarketplacePluginListingDiagnostic = {
	marketplace: string;
	message: string;
};

export type MarketplacePluginListingResult = {
	marketplaces: MarketplaceRecord[];
	plugins: MarketplacePluginListing[];
	diagnostics: MarketplacePluginListingDiagnostic[];
};
