import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-config-auto-mode-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

const stateModule = await import("../src/state.ts");
const updateCheckModule = await import("../src/update-check.ts");
const metadataModule = await import("../src/config-metadata.ts");
const formatModule = await import("../src/format.ts");
const { defaultState, formatConfig, resolveManagerConfig } = stateModule.default ?? stateModule;
const { isUpdateCheckDue } = updateCheckModule.default ?? updateCheckModule;
const { CONFIG_FIELDS } = metadataModule.default ?? metadataModule;
const { formatHelp } = formatModule.default ?? formatModule;

try {
	const resolved = resolveManagerConfig({});
	if (resolved.updateCheckOnStartup !== "auto") throw new Error(`expected unset mode to resolve as auto, got ${resolved.updateCheckOnStartup}`);
	if (!formatConfig({}).includes("updateCheckOnStartup: auto")) throw new Error("formatted config did not show auto default");

	const startupField = CONFIG_FIELDS.find((field) => field.key === "updateCheckOnStartup");
	const values = startupField?.values?.join(",");
	if (values !== "auto,notify,prompt,off") throw new Error(`unexpected updateCheckOnStartup values: ${values}`);
	if (!startupField.description.includes("auto")) throw new Error("metadata description does not mention auto");
	if (!formatHelp().includes("auto (default), notify, prompt, or off")) throw new Error("help text does not describe auto startup mode");

	const freshState = defaultState();
	if (!isUpdateCheckDue(freshState, {})) throw new Error("unset config should be due with no lastUpdateCheckAt");
	if (isUpdateCheckDue(freshState, { updateCheckEnabled: false })) throw new Error("updateCheckEnabled=false should disable due checks");
	if (isUpdateCheckDue(freshState, { updateCheckOnStartup: "off" })) throw new Error("off should disable due checks");
	for (const mode of ["auto", "notify", "prompt"]) {
		const oldState = { ...freshState, lastUpdateCheckAt: new Date().toISOString() };
		if (isUpdateCheckDue(oldState, { updateCheckOnStartup: mode, updateCheckTTL: 86_400_000 })) {
			throw new Error(`${mode} should preserve TTL gating`);
		}
	}

	console.log("config auto mode tests ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
