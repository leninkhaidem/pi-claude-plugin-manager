import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import type { AgentEntry } from "./resources.js";

/**
 * Derive a filesystem-safe slug from a plugin name.
 * Replaces non-alphanumeric characters with hyphens, collapses runs, trims edges.
 */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		|| "unknown";
}

/**
 * Build symlink name: <plugin-slug>--<basename>
 * Example: nso--planning.md
 */
function symlinkName(entry: AgentEntry): string {
	const slug = slugify(entry.pluginName);
	const basename = path.basename(entry.path);
	return `${slug}--${basename}`;
}

/**
 * Check if a symlink name was created by this manager.
 * Plugin-managed agent symlinks use the pattern: <slug>--<name>.md
 * They are always symlinks (not regular files), so we check both naming and symlink status.
 */
function isPluginManagedName(name: string): boolean {
	return name.includes("--") && name.endsWith(".md");
}

/**
 * Sync agent symlinks in ~/.pi/agent/agents/ to match discovered agent entries.
 * Creates symlinks with "<plugin>--" prefix for namespace isolation.
 * Removes stale plugin-managed symlinks that no longer match any installed plugin.
 */
export async function syncAgentSymlinks(agentEntries: AgentEntry[]): Promise<{ added: string[]; removed: string[] }> {
	const agentsDir = path.join(getAgentDir(), "agents");
	await mkdir(agentsDir, { recursive: true });

	// Build desired state: Map<symlinkName, targetPath>
	const desired = new Map<string, string>();
	for (const entry of agentEntries) {
		const linkName = symlinkName(entry);
		desired.set(linkName, entry.path);
	}

	// Read current directory — only look at plugin-managed symlinks
	const existing = new Map<string, string>(); // linkName -> target
	try {
		const entries = await readdir(agentsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!isPluginManagedName(entry.name)) continue;
			const fullPath = path.join(agentsDir, entry.name);
			try {
				const stats = await lstat(fullPath);
				if (stats.isSymbolicLink()) {
					const target = await readlink(fullPath);
					existing.set(entry.name, target);
				}
			} catch {}
		}
	} catch {}

	const added: string[] = [];
	const removed: string[] = [];

	// Remove stale symlinks (managed by us but no longer needed)
	for (const [linkName, target] of existing) {
		if (!desired.has(linkName) || desired.get(linkName) !== target) {
			const fullPath = path.join(agentsDir, linkName);
			try {
				await unlink(fullPath);
				removed.push(linkName);
			} catch {}
		}
	}

	// Create/update symlinks
	for (const [linkName, target] of desired) {
		if (existing.get(linkName) === target) continue; // Already correct
		const fullPath = path.join(agentsDir, linkName);
		try {
			await unlink(fullPath);
		} catch {} // Remove if exists
		try {
			await symlink(target, fullPath);
			added.push(linkName);
		} catch {}
	}

	return { added, removed };
}
