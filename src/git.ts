import { spawn } from "node:child_process";

export async function run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		const timeout = options?.timeoutMs
			? setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error(`${command} ${args.join(" ")} timed out`));
			}, options.timeoutMs)
			: undefined;

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
		});
	});
}

export async function gitClone(url: string, destination: string, options?: { ref?: string; sha?: string; sparsePath?: string }): Promise<void> {
	const args = ["clone"];
	if (!options?.sha) args.push("--depth", "1");
	if (options?.sparsePath) args.push("--filter=blob:none", "--sparse");
	if (options?.ref) args.push("--branch", options.ref);
	args.push(url, destination);
	await run("git", args, { timeoutMs: 120_000 });
	if (options?.sparsePath) {
		await run("git", ["sparse-checkout", "set", options.sparsePath], { cwd: destination, timeoutMs: 30_000 });
	}
	if (options?.sha) {
		await run("git", ["checkout", options.sha], { cwd: destination, timeoutMs: 30_000 });
	}
}

export async function gitHead(cwd: string): Promise<string | undefined> {
	try {
		const result = await run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 });
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}
