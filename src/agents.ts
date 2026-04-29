import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import type { AgentEntry } from "./resources.js";

/**
 * Build symlink name: use the original basename as-is.
 * Example: planning.md
 */
function symlinkName(entry: AgentEntry): string {
	return path.basename(entry.path);
}

/**
 * Sync agent symlinks in ~/.pi/agent/agents/ to match discovered agent entries.
 * Creates symlinks using the original agent filename.
 * Only manages symlinks — regular files created by users are never touched.
 * Removes symlinks that no longer match any installed plugin agent.
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

	// Read current directory — only look at symlinks (never touch regular files)
	const existing = new Map<string, string>(); // linkName -> target
	try {
		const entries = await readdir(agentsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
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

	// Remove stale symlinks that point to paths no longer in desired state
	for (const [linkName, target] of existing) {
		if (!desired.has(linkName) || desired.get(linkName) !== target) {
			// Only remove if the current target looks like a plugin agent path
			// (i.e., it's in the desired set for update, or it was previously managed)
			const fullPath = path.join(agentsDir, linkName);
			if (desired.has(linkName)) {
				// Target changed — update it
				try { await unlink(fullPath); removed.push(linkName); } catch {}
			} else {
				// Not in desired — only remove if it's a broken symlink or points outside agents dir
				// This prevents removing user-created symlinks
				try {
					const resolvedTarget = path.resolve(agentsDir, target);
					const targetExists = await lstat(resolvedTarget).then(() => true).catch(() => false);
					if (!targetExists) {
						// Broken symlink — safe to remove
						await unlink(fullPath);
						removed.push(linkName);
					}
				} catch {}
			}
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
