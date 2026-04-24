const commandsMod = await import("../src/commands.ts");
const { handleCommand } = commandsMod.default ?? commandsMod;

function createMockPi(messages) {
	return {
		sendMessage(message) {
			messages.push(String(message.content ?? ""));
		},
	};
}

function createCtx(action, messages) {
	const choices = [];
	return {
		cwd: process.cwd(),
		hasUI: true,
		async reload() {},
		ui: {
			async input(title) {
				if (title !== "Filter plugins") throw new Error(`Unexpected input title: ${title}`);
				return "browse";
			},
			async select(title, options) {
				choices.push({ title, options });
				if (title === "Browse fixture-marketplace") {
					const option = options.find((item) => item.includes("browse-demo@fixture-marketplace"));
					if (!option) throw new Error(`browse-demo option missing from ${options.join(" | ")}`);
					if (options.length > 50) throw new Error(`Expected capped plugin options, got ${options.length}`);
					return option;
				}
				if (title === "Install browse-demo@fixture-marketplace?") return action;
				throw new Error(`Unexpected select title: ${title}`);
			},
			async confirm() { return true; },
			notify(message) { messages.push(String(message)); },
		},
		_choices: choices,
	};
}

const cancelMessages = [];
const cancelCtx = createCtx("Cancel", cancelMessages);
await handleCommand(createMockPi(cancelMessages), "browse fixture-marketplace", cancelCtx);
if (cancelMessages.some((message) => message.includes("Installed browse-demo"))) {
	throw new Error("Cancel path installed browse-demo");
}

const installMessages = [];
const installCtx = createCtx("Install for user", installMessages);
const result = await handleCommand(createMockPi(installMessages), "browse fixture-marketplace", installCtx);
if (!result?.reloadRecommended) throw new Error("Install path did not recommend reload");
if (!installMessages.some((message) => message.includes("Installed browse-demo@fixture-marketplace"))) {
	throw new Error(`Install message missing. Messages: ${installMessages.join("\n")}`);
}
if (!installCtx._choices.some((choice) => choice.title === "Browse fixture-marketplace")) {
	throw new Error("Plugin selection was not shown");
}

console.log("mock ui browse ok");
