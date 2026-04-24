import { cp, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitClone, run } from "./git.js";
import { readJsonFile } from "./fs-utils.js";
import { marketplacesDir } from "./state.js";
import type { MarketplaceFile, MarketplacePluginEntry, MarketplacePluginListing, MarketplacePluginListingResult, MarketplaceRecord, MarketplaceSource, State } from "./types.js";
import { isSameOrDescendant, normalizePath, now, parsePluginSpec, pluginKey, resolveExistingInside, safeSegment } from "./utils.js";

function isLocalInput(input: string): boolean {
	return (
		input === "~" ||
		input.startsWith("~/") ||
		input.startsWith("./") ||
		input.startsWith("../") ||
		input.startsWith("/")
	);
}

function splitRef(input: string): { base: string; ref?: string } {
	const hash = input.lastIndexOf("#");
	if (hash > 0 && hash < input.length - 1) {
		return { base: input.slice(0, hash), ref: input.slice(hash + 1) };
	}
	return { base: input };
}

export function parseMarketplaceSource(input: string): MarketplaceSource {
	const { base, ref } = splitRef(input.trim());
	if (!base) throw new Error("Missing marketplace source");

	if (isLocalInput(base)) {
		return { kind: "local", input, localPath: normalizePath(base), ref };
	}

	if (/^[^\s/:]+\/[^\s/:]+$/.test(base)) {
		return { kind: "git", input, url: `https://github.com/${base}.git`, ref };
	}

	if (/^[A-Za-z0-9.-]+\/[^/\s]+\/[^/\s]+$/.test(base)) {
		const url = base.endsWith(".git") ? `https://${base}` : `https://${base}.git`;
		return { kind: "git", input, url, ref };
	}

	if (/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(base)) {
		return { kind: "git", input, url: base, ref };
	}

	throw new Error(`Unsupported marketplace source: ${input}`);
}

async function marketplaceFileForRoot(root: string): Promise<{ file: string; root: string }> {
	const stats = await stat(root);
	if (stats.isFile()) {
		const resolved = await realpath(root);
		const parent = path.dirname(resolved);
		const marketplaceRoot = path.basename(parent) === ".claude-plugin" ? path.dirname(parent) : parent;
		return { file: resolved, root: marketplaceRoot };
	}
	const marketplaceRoot = await realpath(root);
	return { file: path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), root: marketplaceRoot };
}

export async function readMarketplaceAt(rootOrFile: string): Promise<{ marketplace: MarketplaceFile; root: string; file: string }> {
	const resolved = await marketplaceFileForRoot(rootOrFile);
	const marketplace = await readJsonFile<MarketplaceFile>(resolved.file);
	if (!marketplace.name) throw new Error(`Marketplace file is missing name: ${resolved.file}`);
	return { marketplace, root: resolved.root, file: resolved.file };
}

export async function addMarketplace(input: string): Promise<MarketplaceRecord> {
	const source = parseMarketplaceSource(input);
	await mkdir(marketplacesDir(), { recursive: true });

	if (source.kind === "local") {
		if (!source.localPath) throw new Error("Local marketplace source missing path");
		const { marketplace, root } = await readMarketplaceAt(source.localPath);
		return {
			name: marketplace.name,
			description: marketplace.description ?? marketplace.metadata?.description,
			owner: marketplace.owner,
			source,
			path: root,
			addedAt: now(),
			updatedAt: now(),
		};
	}

	if (!source.url) throw new Error("Git marketplace source missing URL");
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-claude-marketplace-"));
	try {
		const checkout = path.join(tmp, "checkout");
		await gitClone(source.url, checkout, { ref: source.ref });
		const { marketplace } = await readMarketplaceAt(checkout);
		const target = path.join(marketplacesDir(), safeSegment(marketplace.name));
		await rm(target, { recursive: true, force: true });
		await mkdir(path.dirname(target), { recursive: true });
		await cp(checkout, target, { recursive: true });
		return {
			name: marketplace.name,
			description: marketplace.description ?? marketplace.metadata?.description,
			owner: marketplace.owner,
			source,
			path: target,
			addedAt: now(),
			updatedAt: now(),
		};
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

export async function refreshMarketplace(record: MarketplaceRecord): Promise<MarketplaceRecord> {
	if (record.source.kind === "local") {
		const { marketplace, root } = await readMarketplaceAt(record.source.localPath ?? record.path);
		return {
			...record,
			name: marketplace.name,
			description: marketplace.description ?? marketplace.metadata?.description,
			owner: marketplace.owner,
			path: root,
			updatedAt: now(),
		};
	}

	if (record.source.ref) {
		await run("git", ["fetch", "--depth", "1", "origin", record.source.ref], { cwd: record.path, timeoutMs: 120_000 });
		await run("git", ["checkout", "FETCH_HEAD"], { cwd: record.path, timeoutMs: 30_000 });
	} else {
		await run("git", ["pull", "--ff-only"], { cwd: record.path, timeoutMs: 120_000 });
	}
	const { marketplace } = await readMarketplaceAt(record.path);
	return {
		...record,
		name: marketplace.name,
		description: marketplace.description ?? marketplace.metadata?.description,
		owner: marketplace.owner,
		updatedAt: now(),
	};
}

export async function loadMarketplace(record: MarketplaceRecord): Promise<MarketplaceFile> {
	const { marketplace } = await readMarketplaceAt(record.path);
	return marketplace;
}

export async function findMarketplacePlugin(state: State, spec: string): Promise<{ key: string; record: MarketplaceRecord; marketplaceFile: MarketplaceFile; entry: MarketplacePluginEntry }> {
	const parsed = parsePluginSpec(spec);
	const candidates = parsed.marketplace
		? [state.marketplaces[parsed.marketplace]].filter(Boolean)
		: Object.values(state.marketplaces);

	const matches: Array<{ record: MarketplaceRecord; marketplaceFile: MarketplaceFile; entry: MarketplacePluginEntry }> = [];
	for (const record of candidates) {
		const marketplaceFile = await loadMarketplace(record);
		const entry = (marketplaceFile.plugins ?? []).find((plugin) => plugin.name === parsed.plugin);
		if (entry) matches.push({ record, marketplaceFile, entry });
	}

	if (matches.length === 0) {
		const suffix = parsed.marketplace ? ` in ${parsed.marketplace}` : "";
		throw new Error(`Plugin not found${suffix}: ${parsed.plugin}`);
	}
	if (matches.length > 1) {
		throw new Error(`Plugin ${parsed.plugin} exists in multiple marketplaces. Use plugin@marketplace. Matches: ${matches.map((m) => pluginKey(parsed.plugin, m.record.name)).join(", ")}`);
	}
	const match = matches[0]!;
	return {
		key: pluginKey(match.entry.name, match.record.name),
		record: match.record,
		marketplaceFile: match.marketplaceFile,
		entry: match.entry,
	};
}

function listingForEntry(record: MarketplaceRecord, marketplaceFile: MarketplaceFile, entry: MarketplacePluginEntry): MarketplacePluginListing {
	const displaySpec = pluginKey(entry.name, record.name);
	const parsed = parsePluginSpec(displaySpec);
	const installable = !displaySpec.startsWith("--") && parsed.plugin === entry.name && parsed.marketplace === record.name;
	return {
		marketplace: record.name,
		marketplaceDescription: record.description ?? marketplaceFile.description ?? marketplaceFile.metadata?.description,
		plugin: entry.name,
		displaySpec,
		installSpec: installable ? displaySpec : undefined,
		installable,
		nonInstallableReason: installable ? undefined : `Plugin or marketplace name cannot be represented unambiguously as ${displaySpec}`,
		description: entry.description,
		version: entry.version,
		category: entry.category,
		keywords: entry.keywords,
		entry,
	};
}

export async function listMarketplacePlugins(state: State, marketplaceName?: string): Promise<MarketplacePluginListingResult> {
	const marketplaces = marketplaceName
		? [state.marketplaces[marketplaceName]].filter(Boolean)
		: Object.values(state.marketplaces);
	if (marketplaceName && marketplaces.length === 0) throw new Error(`Unknown marketplace: ${marketplaceName}`);

	const result: MarketplacePluginListingResult = {
		marketplaces: marketplaces.sort((a, b) => a.name.localeCompare(b.name)),
		plugins: [],
		diagnostics: [],
	};

	for (const record of result.marketplaces) {
		try {
			const marketplaceFile = await loadMarketplace(record);
			for (const entry of marketplaceFile.plugins ?? []) {
				result.plugins.push(listingForEntry(record, marketplaceFile, entry));
			}
		} catch (error) {
			result.diagnostics.push({ marketplace: record.name, message: (error as Error).message });
		}
	}

	result.plugins.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || a.plugin.localeCompare(b.plugin));
	return result;
}

export async function resolveMarketplacePluginSource(record: MarketplaceRecord, marketplaceFile: MarketplaceFile, source: string): Promise<string> {
	let sourceBase = record.path;
	let sourceRel = source;
	if (!source.startsWith("./") && !source.startsWith("../") && marketplaceFile.metadata?.pluginRoot) {
		const pluginRoot = await resolveExistingInside(record.path, marketplaceFile.metadata.pluginRoot, "marketplace metadata.pluginRoot");
		if (!pluginRoot) throw new Error(`Marketplace pluginRoot not found: ${marketplaceFile.metadata.pluginRoot}`);
		sourceBase = pluginRoot;
	}
	const sourcePath = await resolveExistingInside(sourceBase, sourceRel, "marketplace plugin source");
	if (!sourcePath) throw new Error(`Marketplace plugin source not found: ${source}`);
	return sourcePath;
}
