import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRECTORY_NAMES } from "./constants.js";

export async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		throw error;
	}
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
	const raw = await readFile(filePath, "utf8");
	return JSON.parse(raw) as T;
}

export async function readOptionalJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return await readJsonFile<T>(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readEntries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw error;
	}
}

export async function readDirectories(dir: string): Promise<string[]> {
	const entries = await readEntries(dir);
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !IGNORED_DIRECTORY_NAMES.has(entry.name))
		.map((entry) => path.join(dir, entry.name));
}

export async function readMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await readEntries(dir);
	return entries
		.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".md"))
		.map((entry) => path.join(dir, entry.name));
}
