import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginSpec, State } from "./types.js";
import { exists } from "./fs-utils.js";

export function now(): string {
	return new Date().toISOString();
}

export function safeSegment(value: string): string {
	const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "unknown";
}

export function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function normalizePath(value: string): string {
	const normalized = path.resolve(expandHome(value)).replace(/\\/g, "/");
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function isSameOrDescendant(parent: string, target: string): boolean {
	return target === parent || target.startsWith(`${parent}/`);
}

export function isInstallPathReferenced(state: State, installPath: string): boolean {
	return Object.values(state.plugins).some((entries) => entries.some((entry) => entry.installPath === installPath));
}

export async function resolveExistingInside(baseDir: string, relativePath: string, label: string): Promise<string | undefined> {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`${label} must be relative: ${relativePath}`);
	}
	if (!(await exists(baseDir))) return undefined;
	const target = path.resolve(baseDir, relativePath);
	if (!(await exists(target))) return undefined;
	const baseReal = normalizePath(await realpath(baseDir));
	const targetReal = normalizePath(await realpath(target));
	if (!isSameOrDescendant(baseReal, targetReal)) {
		throw new Error(`${label} escapes its root: ${relativePath}`);
	}
	return targetReal;
}

export function pluginKey(plugin: string, marketplace: string): string {
	return `${plugin}@${marketplace}`;
}

export function parsePluginSpec(spec: string): PluginSpec {
	const at = spec.lastIndexOf("@");
	if (at > 0 && at < spec.length - 1) {
		return { plugin: spec.slice(0, at), marketplace: spec.slice(at + 1) };
	}
	return { plugin: spec };
}

export function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaping) current += "\\";
	if (current) args.push(current);
	return args;
}

export function hasFlag(args: string[], ...flags: string[]): boolean {
	return args.some((arg) => flags.includes(arg));
}

export function withoutFlags(args: string[]): string[] {
	return args.filter((arg) => !arg.startsWith("--"));
}
