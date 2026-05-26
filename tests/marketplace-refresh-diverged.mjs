import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const marketplaceModule = await import("../src/marketplace.ts");
const { refreshMarketplace } = marketplaceModule.default ?? marketplaceModule;

function git(cwd, args, options = {}) {
	execFileSync("git", args, {
		cwd,
		stdio: options.stdio ?? "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Pi Test",
			GIT_AUTHOR_EMAIL: "pi-test@example.invalid",
			GIT_COMMITTER_NAME: "Pi Test",
			GIT_COMMITTER_EMAIL: "pi-test@example.invalid",
		},
	});
}

async function writeMarketplace(repoPath, version) {
	const dir = path.join(repoPath, ".claude-plugin");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "marketplace.json"),
		`${JSON.stringify({ name: "fixture-marketplace", description: `version ${version}`, plugins: [] }, null, 2)}\n`,
	);
}

async function readMarketplaceVersion(repoPath) {
	const file = path.join(repoPath, ".claude-plugin", "marketplace.json");
	const json = JSON.parse(await readFile(file, "utf8"));
	return json.description;
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-marketplace-refresh-"));
try {
	const remoteWork = path.join(tmp, "remote-work");
	const remoteBare = path.join(tmp, "remote.git");
	const cacheCheckout = path.join(tmp, "cache-checkout");

	await mkdir(remoteWork, { recursive: true });
	git(remoteWork, ["init", "-b", "main"]);
	await writeMarketplace(remoteWork, "1.0.0");
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "initial marketplace"]);
	git(tmp, ["clone", "--bare", remoteWork, remoteBare]);
	git(tmp, ["clone", remoteBare, cacheCheckout]);

	git(remoteWork, ["remote", "add", "origin", remoteBare]);
	await writeMarketplace(remoteWork, "2.0.0");
	git(remoteWork, ["add", "."]);
	git(remoteWork, ["commit", "-m", "remote marketplace update"]);
	git(remoteWork, ["push", "origin", "main"]);

	await writeMarketplace(cacheCheckout, "local-only");
	git(cacheCheckout, ["add", "."]);
	git(cacheCheckout, ["commit", "-m", "local divergent cache commit"]);

	let pullFailed = false;
	try {
		git(cacheCheckout, ["pull", "--ff-only"]);
	} catch {
		pullFailed = true;
	}
	if (!pullFailed) throw new Error("test setup failed: git pull --ff-only should fail for diverged cache checkout");

	const refreshed = await refreshMarketplace({
		name: "fixture-marketplace",
		description: "version 1.0.0",
		source: { kind: "git", input: "fixture", url: remoteBare },
		path: cacheCheckout,
		addedAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	});

	if (refreshed.name !== "fixture-marketplace") throw new Error(`unexpected refreshed name: ${refreshed.name}`);
	if ((await readMarketplaceVersion(cacheCheckout)) !== "version 2.0.0") {
		throw new Error("refreshMarketplace did not hard-sync the cache checkout to the remote marketplace update");
	}
	const aheadBehind = execFileSync("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: cacheCheckout, encoding: "utf8" }).trim();
	if (aheadBehind !== "0\t0") throw new Error(`cache checkout should be in sync after refresh, got ${JSON.stringify(aheadBehind)}`);
	if (existsSync(path.join(cacheCheckout, ".git", "MERGE_HEAD"))) throw new Error("refresh should not leave a merge in progress");

	console.log("marketplace refresh diverged smoke ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
