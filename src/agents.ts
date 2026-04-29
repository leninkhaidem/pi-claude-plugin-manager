import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { lstat, mkdir, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEntry } from "./resources.js";

const MANAGED_MANIFEST = ".managed.json";

interface ManagedManifest {
	/** Map of symlink filename → absolute target path */
	symlinks: Record<string, string>;
}

async function readManifest(agentsDir: string): Promise<ManagedManifest> {
	try {
		const content = await readFile(path.join(agentsDir, MANAGED_MANIFEST), "utf-8");
		const data = JSON.parse(content);
		if (data && typeof data === "object" && typeof data.symlinks === "object") {
			return data as ManagedManifest;
		}
	} catch {}
	return { symlinks: {} };
}

async function writeManifest(agentsDir: string, manifest: ManagedManifest): Promise<void> {
	await writeFile(
		path.join(agentsDir, MANAGED_MANIFEST),
		JSON.stringify(manifest, null, 2) + "\n",
		"utf-8",
	);
}

/**
 * Sync agent symlinks in ~/.pi/agent/agents/ to match discovered agent entries.
 * Uses .managed.json to track which symlinks are owned by the plugin manager.
 * Never touches regular files or symlinks not tracked in the manifest.
 */
export async function syncAgentSymlinks(agentEntries: AgentEntry[]): Promise<{ added: string[]; removed: string[] }> {
	const agentsDir = path.join(getAgentDir(), "agents");
	await mkdir(agentsDir, { recursive: true });

	const manifest = await readManifest(agentsDir);
	const previouslyManaged = new Set(Object.keys(manifest.symlinks));

	// Build desired state: Map<filename, targetPath>
	// First entry wins when multiple plugins provide same filename
	const desired = new Map<string, string>();
	for (const entry of agentEntries) {
		const linkName = path.basename(entry.path);
		if (!desired.has(linkName)) {
			desired.set(linkName, entry.path);
		}
	}

	const added: string[] = [];
	const removed: string[] = [];

	// Remove stale managed symlinks that are no longer in desired state
	for (const linkName of previouslyManaged) {
		if (desired.has(linkName)) continue; // Still needed — will be updated below if target changed
		const fullPath = path.join(agentsDir, linkName);
		try {
			const stats = await lstat(fullPath);
			if (stats.isSymbolicLink()) {
				await unlink(fullPath);
				removed.push(linkName);
			}
		} catch {} // Already gone — fine
	}

	// Create/update symlinks for desired state
	for (const [linkName, target] of desired) {
		const fullPath = path.join(agentsDir, linkName);

		// Check if a non-managed file exists at this path
		if (!previouslyManaged.has(linkName)) {
			try {
				const stats = await lstat(fullPath);
				// Something exists and we don't own it — skip to avoid data loss
				if (!stats.isSymbolicLink()) continue;
				// It's a symlink we don't own — skip unless it's broken
				continue;
			} catch {
				// ENOENT — path is free, safe to create
			}
		}

		// Check if existing symlink already points to correct target
		if (previouslyManaged.has(linkName) && manifest.symlinks[linkName] === target) {
			// Verify it still exists on disk
			try {
				const stats = await lstat(fullPath);
				if (stats.isSymbolicLink()) continue; // All good
			} catch {}
			// Fell through — symlink is missing, recreate below
		}

		// Remove old symlink if we own it
		if (previouslyManaged.has(linkName)) {
			try { await unlink(fullPath); } catch {}
		}

		// Create new symlink
		try {
			await symlink(target, fullPath);
			added.push(linkName);
		} catch {}
	}

	// Also clean up old-format symlinks (migration from nso--*.md pattern)
	try {
		const entries = await readdir(agentsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			if (!entry.name.includes("--")) continue; // Old format used -- separator
			if (desired.has(entry.name)) continue; // Don't touch if it's now a desired name
			const fullPath = path.join(agentsDir, entry.name);
			try {
				const stats = await lstat(fullPath);
				if (stats.isSymbolicLink()) {
					await unlink(fullPath);
					removed.push(entry.name);
				}
			} catch {}
		}
	} catch {}

	// Write updated manifest
	const newManifest: ManagedManifest = { symlinks: {} };
	for (const [linkName, target] of desired) {
		// Only record if we successfully created/kept the symlink
		const fullPath = path.join(agentsDir, linkName);
		try {
			const stats = await lstat(fullPath);
			if (stats.isSymbolicLink()) {
				newManifest.symlinks[linkName] = target;
			}
		} catch {}
	}
	await writeManifest(agentsDir, newManifest);

	return { added, removed };
}
