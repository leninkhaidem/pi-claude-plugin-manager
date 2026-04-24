const mod = await import("../src/autocomplete.ts");
const { getPluginArgumentCompletions, PLUGIN_AUTOCOMPLETE_LIMIT } = mod.default ?? mod;

async function values(prefix) {
	const items = await getPluginArgumentCompletions(prefix);
	return (items ?? []).map((item) => item.value);
}

async function assertIncludes(prefix, expected) {
	const actual = await values(prefix);
	if (!actual.includes(expected)) {
		throw new Error(`Expected completions for ${JSON.stringify(prefix)} to include ${JSON.stringify(expected)}. Got: ${actual.join(", ")}`);
	}
}

await assertIncludes("", "browse");
await assertIncludes("ma", "marketplace");
await assertIncludes("marketplace br", "marketplace browse");
await assertIncludes("marketplace browse f", "marketplace browse fixture-marketplace");
await assertIncludes("marketplace remove f", "marketplace remove fixture-marketplace");
await assertIncludes("install d", "install demo@fixture-marketplace");
await assertIncludes("install s", "install 'space plugin@fixture-marketplace'");
await assertIncludes("disable d", "disable demo@fixture-marketplace");
await assertIncludes("update d", "update demo@fixture-marketplace");
await assertIncludes("uninstall demo@fixture-marketplace --", "uninstall demo@fixture-marketplace --all");
await assertIncludes("config set claudeReadOnlyImports ", "config set claudeReadOnlyImports false");

const flagLike = await values("install --");
if (flagLike.includes("install --flaggy@fixture-marketplace")) {
	throw new Error("Flag-like plugin spec should not be suggested as an install completion");
}

const many = await values("install ");
if (many.length > PLUGIN_AUTOCOMPLETE_LIMIT) {
	throw new Error(`Expected autocomplete results to be capped at ${PLUGIN_AUTOCOMPLETE_LIMIT}, got ${many.length}`);
}

console.log("autocomplete smoke ok");
