import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import {
	evaluateSkillPolicy,
	evaluateSourcePolicy,
	setFolderSkillPolicy,
	setFolderSourcePolicy,
	setGlobalSkillPolicy,
	setGlobalSourcePolicy,
} from "./skill-policy.js";
import type { SkillInfo, SkillSourceInfo } from "./skills.js";
import type { FolderSkillPolicyValue, SkillPolicyValue, State } from "./types.js";

export type ManageSkillsTuiResult = {
	changed: boolean;
};

type TuiHost = {
	requestRender?: (force?: boolean) => void;
	setFocus?: (component: Component | null) => void;
};

type ManageSkillsTuiOptions = {
	cwd: string;
	skills: SkillInfo[];
	sources: SkillSourceInfo[];
	state: State;
	saveState: (state: State) => Promise<void>;
	done: (result: ManageSkillsTuiResult) => void;
	tui?: TuiHost;
	onSaved?: () => void;
};

type ViewMode = "table" | "detail";
type TableColumn = "global" | "folder";

type DetailAction = {
	label: string;
	run: () => void;
};

const TABLE_ROW_LIMIT = 10;
const DETAIL_DESCRIPTION_WIDTH_FALLBACK = 72;

export class ManageSkillsTui implements Component {
	private cwd: string;
	private skills: SkillInfo[];
	private sources: SkillSourceInfo[];
	private state: State;
	private saveState: (state: State) => Promise<void>;
	private done: (result: ManageSkillsTuiResult) => void;
	private tui?: TuiHost;
	private onSaved?: () => void;
	private mode: ViewMode = "table";
	private selected = 0;
	private scrollTop = 0;
	private activeColumn: TableColumn = "folder";
	private search = "";
	private editingSearch = false;
	private detailActionIndex = 0;
	private status = "Space cycles this-folder override. Tab switches column.";
	private saveError: string | undefined;
	private hasUnsavedPolicy = false;
	private saving = false;
	private changed = false;
	private pendingSave: Promise<void> | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(options: ManageSkillsTuiOptions) {
		this.cwd = options.cwd;
		this.skills = options.skills.map((skill) => ({ ...skill }));
		this.sources = options.sources.map((source) => ({ ...source }));
		this.state = cloneState(options.state);
		this.saveState = options.saveState;
		this.done = options.done;
		this.tui = options.tui;
		this.onSaved = options.onSaved;
		this.recomputePolicyViews();
	}

	handleInput(data: string): void {
		if (this.saving) return;
		if (this.hasUnsavedPolicy && matchesKey(data, "r")) {
			this.retrySave();
			return;
		}
		if (this.editingSearch) {
			this.handleSearchInput(data);
			return;
		}
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleTableInput(data);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.max(1, safeWidth - 4);
		const lines = this.mode === "detail" ? this.renderDetail(contentWidth) : this.renderTable(contentWidth);
		this.cachedWidth = width;
		this.cachedLines = frameLines(lines, safeWidth);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	async waitForIdle(): Promise<void> {
		await this.pendingSave;
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.editingSearch = false;
			this.status = "Search applied over all skills.";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.editingSearch = false;
			this.status = "Search closed.";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.search = this.search.slice(0, -1);
			this.selected = 0;
			this.scrollTop = 0;
			this.invalidateAndRender();
			return;
		}
		if (isPrintable(data)) {
			this.search += data;
			this.selected = 0;
			this.scrollTop = 0;
			this.invalidateAndRender();
		}
	}

	private handleTableInput(data: string): void {
		const rows = this.filteredSkills();
		if (matchesKey(data, Key.escape)) {
			if (this.preventExitWhenUnsaved()) return;
			this.done({ changed: this.changed });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1, rows.length);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1, rows.length);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.activeColumn = this.activeColumn === "folder" ? "global" : "folder";
			this.status = `Editing ${this.activeColumn === "folder" ? "this-folder override" : "global default"}.`;
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (rows.length === 0) return;
			this.mode = "detail";
			this.detailActionIndex = 0;
			this.status = "Enter applies the selected action. Escape returns to the table.";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.space)) {
			const skill = rows[this.selected];
			if (!skill) return;
			if (this.activeColumn === "global") this.setSkillGlobal(skill, cycleGlobal(skill.globalState));
			else this.setSkillFolder(skill, cycleFolder(skill.folderState));
			return;
		}
		if (matchesKey(data, "/")) {
			this.search = "";
			this.selected = 0;
			this.scrollTop = 0;
			this.editingSearch = true;
			this.status = "Type to search names, sources, and paths. Enter keeps results; Escape leaves search.";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, "g")) {
			this.activeColumn = "global";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, "f")) {
			this.activeColumn = "folder";
			this.invalidateAndRender();
		}
	}

	private handleDetailInput(data: string): void {
		const actions = this.detailActions(this.selectedSkill());
		if (matchesKey(data, Key.escape) || matchesKey(data, "b") || matchesKey(data, Key.left)) {
			if (this.preventExitWhenUnsaved()) return;
			this.mode = "table";
			this.status = "Returned to skill table.";
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.detailActionIndex = Math.max(0, this.detailActionIndex - 1);
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.detailActionIndex = Math.min(Math.max(0, actions.length - 1), this.detailActionIndex + 1);
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			actions[this.detailActionIndex]?.run();
		}
	}

	private moveSelection(delta: number, rowCount: number): void {
		if (rowCount === 0) return;
		this.selected = Math.min(rowCount - 1, Math.max(0, this.selected + delta));
		if (this.selected < this.scrollTop) this.scrollTop = this.selected;
		if (this.selected >= this.scrollTop + TABLE_ROW_LIMIT) this.scrollTop = this.selected - TABLE_ROW_LIMIT + 1;
		this.invalidateAndRender();
	}

	private filteredSkills(): SkillInfo[] {
		const query = this.search.trim().toLowerCase();
		if (!query) return this.skills;
		const tokens = query.split(/\s+/).filter(Boolean);
		return this.skills.filter((skill) => {
			const haystack = [skill.name, skill.sourceLabel, skill.path, skill.globalState, skill.folderState, skill.effectiveState, skill.winningScope, skill.winningTarget].join(" ").toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	private selectedSkill(): SkillInfo | undefined {
		return this.filteredSkills()[this.selected];
	}

	private setSkillGlobal(skill: SkillInfo, value: SkillPolicyValue): void {
		this.applyPolicyChange(`Saved global default: ${skill.name} → ${value}.`, (state) => {
			setGlobalSkillPolicy(state.skillPolicy, skillSubject(skill), value);
		});
	}

	private setSkillFolder(skill: SkillInfo, value: FolderSkillPolicyValue): void {
		this.applyPolicyChange(`Saved this-folder override: ${skill.name} → ${value}.`, (state) => {
			setFolderSkillPolicy(state.skillPolicy, this.cwd, skillSubject(skill), value);
		});
	}

	private setSourceGlobal(skill: SkillInfo, value: SkillPolicyValue): void {
		this.applyPolicyChange(`Saved source global default: ${skill.sourceLabel} → ${value}.`, (state) => {
			setGlobalSourcePolicy(state.skillPolicy, skill.sourceRoot, value);
		});
	}

	private setSourceFolder(skill: SkillInfo, value: FolderSkillPolicyValue): void {
		this.applyPolicyChange(`Saved source this-folder override: ${skill.sourceLabel} → ${value}.`, (state) => {
			setFolderSourcePolicy(state.skillPolicy, this.cwd, skill.sourceRoot, value);
		});
	}

	private applyPolicyChange(successMessage: string, mutate: (state: State) => void): void {
		const nextState = cloneState(this.state);
		mutate(nextState);
		this.state = nextState;
		this.recomputePolicyViews();
		this.persistCurrentState(successMessage);
	}

	private retrySave(): void {
		this.persistCurrentState("Saved policy after retry.");
	}

	private persistCurrentState(successMessage: string): void {
		this.saving = true;
		this.hasUnsavedPolicy = true;
		this.saveError = undefined;
		this.status = "Saving policy…";
		this.invalidateAndRender();
		this.pendingSave = this.saveState(cloneState(this.state))
			.then(() => {
				this.saving = false;
				this.hasUnsavedPolicy = false;
				this.changed = true;
				this.status = successMessage;
				this.onSaved?.();
			})
			.catch((error) => {
				this.saving = false;
				this.saveError = `Save failed: ${(error as Error).message}`;
				this.status = "Policy change is not saved. Press r to retry before leaving this view.";
			})
			.finally(() => this.invalidateAndRender());
	}

	private preventExitWhenUnsaved(): boolean {
		if (!this.hasUnsavedPolicy) return false;
		this.status = "Cannot leave yet: the latest policy change was not saved.";
		this.invalidateAndRender();
		return true;
	}

	private recomputePolicyViews(): void {
		this.skills = this.skills.map((skill) => {
			const effective = evaluateSkillPolicy(this.state.skillPolicy, skillSubject(skill), this.cwd);
			return {
				...skill,
				enabled: effective.enabled,
				globalState: effective.globalState,
				folderState: effective.folderState,
				effectiveState: effective.effectiveState,
				winningScope: effective.winningScope,
				winningTarget: effective.winningTarget,
				identityKind: effective.identity.kind,
				identityKey: effective.identity.key,
			};
		});
		this.sources = this.sources.map((source) => {
			const effective = evaluateSourcePolicy(this.state.skillPolicy, source.path, this.cwd);
			return {
				...source,
				enabled: effective.enabled,
				globalState: effective.globalState,
				folderState: effective.folderState,
				effectiveState: effective.effectiveState,
				winningScope: effective.winningScope,
			};
		});
		const rowCount = this.filteredSkills().length;
		this.selected = rowCount === 0 ? 0 : Math.min(this.selected, rowCount - 1);
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, rowCount - TABLE_ROW_LIMIT));
	}

	private sourceFor(skill: SkillInfo | undefined): SkillSourceInfo | undefined {
		if (!skill) return undefined;
		return this.sources.find((source) => source.path === skill.sourceRoot);
	}

	private detailActions(skill: SkillInfo | undefined): DetailAction[] {
		if (!skill) return [];
		return [
			{ label: "Set this-folder override: inherit", run: () => this.setSkillFolder(skill, "inherit") },
			{ label: "Set this-folder override: enabled", run: () => this.setSkillFolder(skill, "enabled") },
			{ label: "Set this-folder override: disabled", run: () => this.setSkillFolder(skill, "disabled") },
			{ label: "Enable skill globally", run: () => this.setSkillGlobal(skill, "enabled") },
			{ label: "Disable skill globally", run: () => this.setSkillGlobal(skill, "disabled") },
			{ label: "Enable this source globally", run: () => this.setSourceGlobal(skill, "enabled") },
			{ label: "Disable this source globally", run: () => this.setSourceGlobal(skill, "disabled") },
			{ label: "Set this source for this folder: inherit", run: () => this.setSourceFolder(skill, "inherit") },
			{ label: "Set this source for this folder: enabled", run: () => this.setSourceFolder(skill, "enabled") },
			{ label: "Set this source for this folder: disabled", run: () => this.setSourceFolder(skill, "disabled") },
		];
	}

	private renderTable(width: number): string[] {
		const rows = this.filteredSkills();
		const visibleRows = rows.slice(this.scrollTop, this.scrollTop + TABLE_ROW_LIMIT);
		const lines = [
			centerTitle("Manage Skills", width),
			`Scope: Global defaults + this folder override`,
			`Folder: ${this.cwd}`,
			`Search: ${this.search}${this.editingSearch ? "_" : ""}`,
			`Editing: ${this.activeColumn === "folder" ? "This folder" : "Global"}`,
			"",
			this.tableHeader(width),
			repeatToWidth("─", width),
		];
		if (visibleRows.length === 0) {
			lines.push("No skills match the current search.");
		} else {
			for (let i = 0; i < visibleRows.length; i++) {
				lines.push(this.tableRow(visibleRows[i]!, this.scrollTop + i === this.selected, width));
			}
		}
		lines.push("");
		lines.push(this.scrollInfo(rows.length));
		lines.push(this.statusLine());
		lines.push("↑↓ select • tab column • space cycle • enter details • / search • esc exit");
		return lines.map((line) => fit(line, width));
	}

	private tableHeader(width: number): string {
		const cols = tableWidths(width);
		return joinColumns([
			fit("Skill", cols.name),
			fit(this.activeColumn === "global" ? "Global*" : "Global", cols.global),
			fit(this.activeColumn === "folder" ? "This folder*" : "This folder", cols.folder),
			fit("Effective", cols.effective),
			fit("Scope", cols.scope),
			fit("Enforce", cols.enforcement),
		], cols);
	}

	private tableRow(skill: SkillInfo, selected: boolean, width: number): string {
		const cols = tableWidths(width);
		const duplicateHint = skill.duplicateName ? ` · ${skill.sourceLabel}` : "";
		const name = `${selected ? "❯" : " "} ${skill.name}${duplicateHint}`;
		return joinColumns([
			fit(name, cols.name),
			fit(skill.globalState, cols.global),
			fit(skill.folderState, cols.folder),
			fit(skill.effectiveState, cols.effective),
			fit(`${skill.winningScope}/${skill.winningTarget}`, cols.scope),
			fit(enforcementMode(skill), cols.enforcement),
		], cols);
	}

	private renderDetail(width: number): string[] {
		const skill = this.selectedSkill();
		if (!skill) return [centerTitle("Skill", width), "No selected skill.", "esc back"].map((line) => fit(line, width));
		const source = this.sourceFor(skill);
		const actions = this.detailActions(skill);
		const description = skill.description.trim() || "(no description)";
		const descriptionWidth = Math.max(10, Math.min(width - 4, DETAIL_DESCRIPTION_WIDTH_FALLBACK));
		const lines = [
			centerTitle(`Skill: ${skill.name}`, width),
			`Source: ${skill.sourceLabel}`,
			`Path: ${skill.path}`,
			`Identity: ${skill.identityKind}:${skill.identityKey}${skill.duplicateName ? ` (${skill.sameNameCount} skills share this name)` : ""}`,
			"",
			"Description",
			...wrapTextWithAnsi(description, descriptionWidth).map((line) => `  ${line}`),
			"",
			`Global default      ${skill.globalState}`,
			`This folder         ${skill.folderState}`,
			`Effective state     ${skill.effectiveState} by ${skill.winningScope}/${skill.winningTarget}`,
			`Enforcement         ${enforcementMode(skill)}`,
			`Source global       ${source?.globalState ?? "enabled"}`,
			`Source this folder  ${source?.folderState ?? "inherit"}`,
			"",
			"Actions",
		];
		for (let i = 0; i < actions.length; i++) {
			lines.push(`${i === this.detailActionIndex ? "❯" : " "} ${actions[i]!.label}`);
		}
		lines.push("");
		lines.push(this.statusLine());
		lines.push("↑↓ action • enter select • esc back");
		return lines.map((line) => fit(line, width));
	}

	private scrollInfo(total: number): string {
		if (total === 0) return `0 of ${this.skills.length} skills`;
		const start = Math.min(total, this.scrollTop + 1);
		const end = Math.min(total, this.scrollTop + TABLE_ROW_LIMIT);
		const moreBefore = this.scrollTop > 0 ? "↑" : " ";
		const moreAfter = end < total ? "↓" : " ";
		return `${moreBefore}${moreAfter} showing ${start}-${end} of ${total} matching skills (${this.skills.length} total)`;
	}

	private statusLine(): string {
		const parts = [this.status];
		if (this.saveError) parts.push(this.saveError);
		if (this.hasUnsavedPolicy) parts.push("unsaved policy change");
		return parts.join("  ");
	}

	private invalidateAndRender(): void {
		this.invalidate();
		this.tui?.requestRender?.(true);
	}
}

export function createManageSkillsTui(options: ManageSkillsTuiOptions): ManageSkillsTui {
	const component = new ManageSkillsTui(options);
	options.tui?.setFocus?.(component);
	return component;
}

function skillSubject(skill: SkillInfo): { name: string; path?: string; sourceRoot?: string } {
	return { name: skill.name, path: skill.path, sourceRoot: skill.sourceRoot };
}

function cloneState(state: State): State {
	return JSON.parse(JSON.stringify(state)) as State;
}

function cycleGlobal(value: SkillPolicyValue): SkillPolicyValue {
	return value === "enabled" ? "disabled" : "enabled";
}

function cycleFolder(value: FolderSkillPolicyValue): FolderSkillPolicyValue {
	if (value === "inherit") return "disabled";
	if (value === "disabled") return "enabled";
	return "inherit";
}

function enforcementMode(skill: SkillInfo): string {
	if (skill.enabled) return "active";
	if (skill.source === "plugin" || skill.source === "custom-source") return "hidden after reload + blocked";
	return "prompt-filtered + blocked";
}

function tableWidths(width: number): { name: number; global: number; folder: number; effective: number; scope: number; enforcement: number; gaps: number } {
	const gaps = 5;
	if (width < 64) {
		const enforcement = Math.max(7, width - 46);
		return { name: 14, global: 8, folder: 8, effective: 8, scope: 8, enforcement, gaps };
	}
	const fixed = 10 + 13 + 10 + 14 + gaps;
	const enforcement = width >= 92 ? 24 : 14;
	const name = Math.max(16, width - fixed - enforcement);
	return { name, global: 10, folder: 13, effective: 10, scope: 14, enforcement, gaps };
}

function joinColumns(values: string[], _cols: { gaps: number }): string {
	return values.join(" ");
}

function centerTitle(title: string, width: number): string {
	const label = ` ${title} `;
	const remaining = Math.max(0, width - visibleWidth(label));
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return `${repeatToWidth("─", left)}${label}${repeatToWidth("─", right)}`;
}

function frameLines(content: string[], width: number): string[] {
	if (width < 4) return content.map((line) => fit(line, width));
	const inner = width - 2;
	const top = `╭${repeatToWidth("─", inner)}╮`;
	const bottom = `╰${repeatToWidth("─", inner)}╯`;
	return [top, ...content.map((line) => `│${fit(line, inner)}│`), bottom];
}

function fit(value: string, width: number): string {
	const truncated = truncateToWidth(value, Math.max(0, width), "…", false);
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function repeatToWidth(char: string, width: number): string {
	if (width <= 0) return "";
	return char.repeat(width);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}
