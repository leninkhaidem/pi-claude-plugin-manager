import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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
};

type TuiTheme = {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

type ManageSkillsTuiOptions = {
	cwd: string;
	skills: SkillInfo[];
	sources: SkillSourceInfo[];
	state: State;
	saveState: (state: State) => Promise<void>;
	done: (result: ManageSkillsTuiResult) => void;
	tui?: TuiHost;
	theme?: TuiTheme;
	onSaved?: () => void;
};

type ViewMode = "dashboard" | "advanced" | "description";

type DetailAction = {
	label: string;
	run: () => void;
};

type ShortcutHint = {
	key: string;
	label: string;
};

type StatusKind = "info" | "success" | "warning" | "error";

const TABLE_ROW_LIMIT = 8;
const NARROW_TABLE_ROW_LIMIT = 5;
const DETAIL_DESCRIPTION_WIDTH_FALLBACK = 40;
const DESCRIPTION_VIEWPORT_LINES = 13;
const WIDE_SPLIT_MIN_WIDTH = 68;

export class ManageSkillsTui implements Component {
	private cwd: string;
	private skills: SkillInfo[];
	private sources: SkillSourceInfo[];
	private state: State;
	private saveState: (state: State) => Promise<void>;
	private done: (result: ManageSkillsTuiResult) => void;
	private tui?: TuiHost;
	private theme?: TuiTheme;
	private onSaved?: () => void;
	private mode: ViewMode = "dashboard";
	private selected = 0;
	private scrollTop = 0;
	private search = "";
	private editingSearch = false;
	private detailActionIndex = 0;
	private descriptionScrollTop = 0;
	private descriptionWrapWidth = DETAIL_DESCRIPTION_WIDTH_FALLBACK;
	private rowLimit = TABLE_ROW_LIMIT;
	private status = "Space toggles this folder. Enter opens details. a opens advanced policy controls.";
	private statusKind: StatusKind = "info";
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
		this.theme = options.theme;
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
		if (this.mode === "advanced") {
			this.handleActionInput(data);
			return;
		}
		if (this.mode === "description") {
			this.handleDescriptionInput(data);
			return;
		}
		this.handleDashboardInput(data);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.max(1, safeWidth - 4);
		const lines = this.mode === "advanced" ? this.renderAdvancedDrawer(contentWidth) : this.mode === "description" ? this.renderDescriptionDrawer(contentWidth) : this.renderDashboard(contentWidth);
		this.cachedWidth = width;
		this.cachedLines = frameLines(lines, safeWidth, this.style("borderAccent", "─"));
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
			this.setStatus("Search applied across all skills.");
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.editingSearch = false;
			this.setStatus("Search closed.");
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, "backspace")) {
			this.search = this.search.slice(0, -1);
			this.selected = 0;
			this.scrollTop = 0;
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.search = "";
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

	private handleDashboardInput(data: string): void {
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
		if (matchesKey(data, Key.enter) || matchesKey(data, "d")) {
			if (rows.length === 0) return;
			this.mode = "description";
			this.descriptionScrollTop = 0;
			this.setStatus("Details view. Scroll with ↑↓; Escape returns.");
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.space)) {
			const skill = rows[this.selected];
			if (!skill) return;
			this.toggleSkillForFolder(skill);
			return;
		}
		if (matchesKey(data, "r")) {
			const skill = rows[this.selected];
			if (!skill) return;
			this.resetSkillFolderOverride(skill);
			return;
		}
		if (matchesKey(data, "a")) {
			if (rows.length === 0) return;
			this.mode = "advanced";
			this.detailActionIndex = 0;
			this.setStatus("Advanced policy controls. Enter saves immediately; Escape returns.");
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, "/")) {
			this.editingSearch = true;
			this.setStatus("Search is global: name, description, source, path, and policy state.");
			this.invalidateAndRender();
		}
	}

	private handleActionInput(data: string): void {
		const actions = this.detailActions(this.selectedSkill());
		if (matchesKey(data, Key.escape) || matchesKey(data, "b") || matchesKey(data, Key.left)) {
			if (this.preventExitWhenUnsaved()) return;
			this.mode = "dashboard";
			this.setStatus("Returned to skill dashboard.");
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

	private handleDescriptionInput(data: string): void {
		const skill = this.selectedSkill();
		const description = skill?.description.trim() || "(no description)";
		const wrapped = wrapTextWithAnsi(description, this.descriptionWrapWidth);
		const maxTop = Math.max(0, wrapped.length - DESCRIPTION_VIEWPORT_LINES);
		if (matchesKey(data, Key.escape) || matchesKey(data, "b") || matchesKey(data, Key.left)) {
			this.mode = "dashboard";
			this.setStatus("Returned to skill dashboard.");
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.descriptionScrollTop = Math.max(0, this.descriptionScrollTop - 1);
			this.invalidateAndRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.descriptionScrollTop = Math.min(maxTop, this.descriptionScrollTop + 1);
			this.invalidateAndRender();
		}
	}

	private moveSelection(delta: number, rowCount: number): void {
		if (rowCount === 0) return;
		this.selected = Math.min(rowCount - 1, Math.max(0, this.selected + delta));
		if (this.selected < this.scrollTop) this.scrollTop = this.selected;
		if (this.selected >= this.scrollTop + this.rowLimit) this.scrollTop = this.selected - this.rowLimit + 1;
		this.descriptionScrollTop = 0;
		this.invalidateAndRender();
	}

	private filteredSkills(): SkillInfo[] {
		const query = this.search.trim().toLowerCase();
		if (!query) return this.skills;
		const tokens = query.split(/\s+/).filter(Boolean);
		return this.skills.filter((skill) => {
			const haystack = [
				skill.name,
				skill.description,
				skill.sourceLabel,
				skill.sourceRoot,
				skill.path,
				skill.globalState,
				skill.folderState,
				skill.effectiveState,
				skill.winningScope,
				skill.winningTarget,
				skill.identityKind,
				skill.identityKey,
			].join(" ").toLowerCase();
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

	private toggleSkillForFolder(skill: SkillInfo): void {
		this.setSkillFolder(skill, skill.effectiveState === "enabled" ? "disabled" : "enabled");
	}

	private resetSkillFolderOverride(skill: SkillInfo): void {
		if (skill.folderState === "inherit") {
			this.setStatus(`No this-folder override for ${skill.name}; already using ${ruleDetails(skill)}.`);
			this.invalidateAndRender();
			return;
		}
		this.setSkillFolder(skill, "inherit");
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
		this.setStatus("Saving policy…", "warning");
		this.invalidateAndRender();
		this.pendingSave = this.saveState(cloneState(this.state))
			.then(() => {
				this.saving = false;
				this.hasUnsavedPolicy = false;
				this.changed = true;
				this.setStatus(successMessage, "success");
				this.onSaved?.();
			})
			.catch((error) => {
				this.saving = false;
				this.saveError = `Save failed: ${(error as Error).message}`;
				this.setStatus("Change is not durable. Press r to retry; Esc stays in this view.", "error");
			})
			.finally(() => this.invalidateAndRender());
	}

	private preventExitWhenUnsaved(): boolean {
		if (!this.hasUnsavedPolicy) return false;
		this.setStatus("Cannot leave yet: the latest policy change was not saved.", "error");
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
				winningTarget: effective.winningTarget,
			};
		});
		const rowCount = this.filteredSkills().length;
		this.selected = rowCount === 0 ? 0 : Math.min(this.selected, rowCount - 1);
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, rowCount - this.rowLimit));
	}

	private sourceFor(skill: SkillInfo | undefined): SkillSourceInfo | undefined {
		if (!skill) return undefined;
		return this.sources.find((source) => source.path === skill.sourceRoot);
	}

	private detailActions(skill: SkillInfo | undefined): DetailAction[] {
		if (!skill) return [];
		return [
			{ label: "Reset this-folder override (inherit)", run: () => this.setSkillFolder(skill, "inherit") },
			{ label: "Enable this skill in this folder", run: () => this.setSkillFolder(skill, "enabled") },
			{ label: "Disable this skill in this folder", run: () => this.setSkillFolder(skill, "disabled") },
			{ label: "Set global default: enabled", run: () => this.setSkillGlobal(skill, "enabled") },
			{ label: "Set global default: disabled", run: () => this.setSkillGlobal(skill, "disabled") },
			{ label: "Set source globally: enabled", run: () => this.setSourceGlobal(skill, "enabled") },
			{ label: "Set source globally: disabled", run: () => this.setSourceGlobal(skill, "disabled") },
			{ label: "Reset source for this folder (inherit)", run: () => this.setSourceFolder(skill, "inherit") },
			{ label: "Enable source in this folder", run: () => this.setSourceFolder(skill, "enabled") },
			{ label: "Disable source in this folder", run: () => this.setSourceFolder(skill, "disabled") },
		];
	}

	private renderDashboard(width: number): string[] {
		const rows = this.filteredSkills();
		const selectedSkill = this.selectedSkill();
		this.rowLimit = rowLimitForWidth(width);
		const header = [
			centerTitle(this.title("Skill Manager"), width),
			fit(`Folder: ${this.cwd}`, width),
			fit(`Search all ${this.skills.length} skills: ${this.search}${this.editingSearch ? "_" : ""}   ${rows.length}/${this.skills.length} matching`, width),
		];
		if (width < WIDE_SPLIT_MIN_WIDTH) {
			return [
				...header,
				repeatToWidth("─", width),
				...this.renderSkillPane(width, rows, this.rowLimit, false),
				repeatToWidth("─", width),
				...this.renderCompactSelectedSkillPane(width, selectedSkill),
				repeatToWidth("─", width),
				...this.renderFooter(width),
			];
		}

		const leftWidth = Math.max(34, Math.min(44, Math.floor(width * 0.47)));
		const rightWidth = Math.max(1, width - leftWidth - 1);
		const left = this.renderSkillPane(leftWidth, rows, this.rowLimit);
		const right = this.renderSelectedSkillPane(rightWidth, selectedSkill);
		const body: string[] = [];
		const count = Math.max(left.length, right.length);
		for (let i = 0; i < count; i++) {
			body.push(`${fit(left[i] ?? "", leftWidth)}│${fit(right[i] ?? "", rightWidth)}`);
		}
		return [
			...header,
			repeatToWidth("─", leftWidth) + "┬" + repeatToWidth("─", rightWidth),
			...body,
			repeatToWidth("─", leftWidth) + "┴" + repeatToWidth("─", rightWidth),
			...this.renderFooter(width),
		];
	}

	private renderSkillPane(width: number, rows: SkillInfo[], rowLimit: number, showTitle = true): string[] {
		const visibleRows = rows.slice(this.scrollTop, this.scrollTop + rowLimit);
		const lines = [
			...(showTitle ? [this.titleLine("Skills", width)] : []),
			this.skillTableHeader(width),
			repeatToWidth("─", width),
		];
		if (visibleRows.length === 0) {
			lines.push(fit("No skills match this global search.", width));
		} else {
			for (let i = 0; i < visibleRows.length; i++) {
				lines.push(this.skillTableRow(visibleRows[i]!, this.scrollTop + i === this.selected, width));
			}
		}
		lines.push(this.scrollInfo(rows.length, width));
		return lines.map((line) => fit(line, width));
	}

	private skillTableHeader(width: number): string {
		const cols = skillTableWidths(width);
		return this.dim(joinColumns([
			fit("Skill", cols.name),
			fit("Current", cols.current),
			fit("Rule", cols.rule),
			fit("Source", cols.source),
		]));
	}

	private skillTableRow(skill: SkillInfo, selected: boolean, width: number): string {
		const cols = skillTableWidths(width);
		const duplicateHint = skill.duplicateName ? ` · ${skill.sourceLabel}` : "";
		const name = `${selected ? "❯" : " "} ${skill.name}${duplicateHint}`;
		const row = joinColumns([
			fit(name, cols.name),
			fit(currentLabel(skill), cols.current),
			fit(ruleLabel(skill), cols.rule),
			fit(sourceBadge(skill), cols.source),
		]);
		return selected ? this.selectedRow(fit(row, width)) : fit(row, width);
	}

	private renderSelectedSkillPane(width: number, skill: SkillInfo | undefined): string[] {
		if (!skill) return [this.titleLine("Selected skill", width), "No selected skill.", "", "Try a broader search."].map((line) => fit(line, width));
		const description = skill.description.trim() || "(no description)";
		const descriptionWidth = Math.max(10, Math.min(width - 2, DETAIL_DESCRIPTION_WIDTH_FALLBACK));
		const descriptionLines = wrapTextWithAnsi(description, descriptionWidth).slice(0, 2).map((line) => `  ${line}`);
		const lines = [
			this.titleLine(skill.name, width),
			this.dim(fit(skill.sourceLabel, width)),
			"Description",
			...descriptionLines,
			`Current: ${stateText(skill.effectiveState)}`,
			`Rule: ${ruleDetails(skill)}`,
			`This folder override: ${folderStateText(skill.folderState)}`,
			`Path: ${skill.path}`,
			`Enforcement: ${enforcementMode(skill)}`,
		];
		return lines.map((line) => fit(line, width));
	}

	private renderCompactSelectedSkillPane(width: number, skill: SkillInfo | undefined): string[] {
		if (!skill) return [this.titleLine("Selected", width), "No selected skill."].map((line) => fit(line, width));
		const description = skill.description.trim() || "(no description)";
		return [
			this.titleLine(`Selected: ${skill.name}`, width),
			`Desc: ${description}`,
			`Current: ${stateText(skill.effectiveState)} • Rule: ${ruleDetails(skill)}`,
		].map((line) => fit(line, width));
	}

	private renderFooter(width: number): string[] {
		const shortcuts = this.editingSearch ? [
			{ key: "Esc", label: "close search" },
			{ key: "Type", label: "filter all skills" },
			{ key: "Backspace", label: "delete" },
			{ key: "Ctrl-U", label: "clear" },
			{ key: "Enter", label: "apply" },
		] : [
			{ key: "Esc", label: "close" },
			{ key: "Space", label: "toggle this folder" },
			{ key: "Enter", label: "details" },
			{ key: "/", label: "search" },
			{ key: "a", label: "advanced" },
			{ key: "r", label: "reset" },
		];
		return [
			this.shortcutLegend(width, shortcuts),
			this.statusLine(width),
		];
	}

	private renderAdvancedDrawer(width: number): string[] {
		const skill = this.selectedSkill();
		if (!skill) return [centerTitle(this.title("Advanced policy"), width), "No selected skill.", this.shortcutLegend(width, [{ key: "Esc", label: "back" }])].map((line) => fit(line, width));
		const source = this.sourceFor(skill);
		const actions = this.detailActions(skill);
		const lines = [
			centerTitle(this.title(`Advanced policy: ${skill.name}`), width),
			fit(`Current: ${stateText(skill.effectiveState)} • Rule: ${ruleDetails(skill)}`, width),
			fit(`This folder override: ${folderStateText(skill.folderState)} • Source: ${source?.label ?? skill.sourceLabel}`, width),
			fit(`Source rule: ${sourceRuleDetails(source)} • Global default: ${stateText(skill.globalState)}`, width),
			repeatToWidth("─", width),
		];
		for (let i = 0; i < actions.length; i++) {
			const prefix = i === this.detailActionIndex ? "❯" : " ";
			const line = fit(`${prefix} ${actions[i]!.label}`, width);
			lines.push(i === this.detailActionIndex ? this.selectedRow(line) : line);
		}
		lines.push(repeatToWidth("─", width));
		lines.push(this.statusLine(width));
		lines.push(this.shortcutLegend(width, [
			{ key: "Esc", label: "back" },
			{ key: "↑↓", label: "choose" },
			{ key: "Enter", label: "save immediately" },
		]));
		return lines.map((line) => fit(line, width));
	}

	private renderDescriptionDrawer(width: number): string[] {
		const skill = this.selectedSkill();
		if (!skill) return [centerTitle(this.title("Details"), width), "No selected skill.", this.shortcutLegend(width, [{ key: "Esc", label: "back" }])].map((line) => fit(line, width));
		const description = skill.description.trim() || "(no description)";
		this.descriptionWrapWidth = Math.max(10, width - 2);
		const wrapped = wrapTextWithAnsi(description, this.descriptionWrapWidth);
		const maxTop = Math.max(0, wrapped.length - DESCRIPTION_VIEWPORT_LINES);
		this.descriptionScrollTop = Math.min(this.descriptionScrollTop, maxTop);
		const visible = wrapped.slice(this.descriptionScrollTop, this.descriptionScrollTop + DESCRIPTION_VIEWPORT_LINES);
		while (visible.length < DESCRIPTION_VIEWPORT_LINES) visible.push("");
		const start = wrapped.length === 0 ? 0 : this.descriptionScrollTop + 1;
		const end = Math.min(wrapped.length, this.descriptionScrollTop + DESCRIPTION_VIEWPORT_LINES);
		return [
			centerTitle(this.title(`Details: ${skill.name}`), width),
			this.dim(fit(skill.sourceLabel, width)),
			fit(`Current: ${stateText(skill.effectiveState)} • Rule: ${ruleDetails(skill)}`, width),
			fit(`Path: ${skill.path}`, width),
			repeatToWidth("─", width),
			...visible.map((line) => fit(line, width)),
			this.shortcutLegend(width, [
				{ key: "Esc", label: "back" },
				{ key: "↑↓", label: "scroll" },
			], `${start}-${end} of ${wrapped.length} description lines`),
		].map((line) => fit(line, width));
	}

	private scrollInfo(total: number, width: number): string {
		if (total === 0) return fit(`0 of ${this.skills.length} skills`, width);
		const start = Math.min(total, this.scrollTop + 1);
		const end = Math.min(total, this.scrollTop + this.rowLimit);
		const moreBefore = this.scrollTop > 0 ? "↑" : " ";
		const moreAfter = end < total ? "↓" : " ";
		return fit(`${moreBefore}${moreAfter} ${start}-${end} of ${total} matching skills`, width);
	}

	private statusLine(width: number): string {
		const parts = [this.status];
		if (this.saveError) parts.push(this.saveError);
		if (this.hasUnsavedPolicy) parts.push("unsaved policy change");
		const text = parts.join("  ");
		const color = this.statusKind === "success" ? "success" : this.statusKind === "error" ? "error" : this.statusKind === "warning" ? "warning" : "dim";
		return this.style(color, fit(text, width));
	}

	private setStatus(status: string, kind: StatusKind = "info"): void {
		this.status = status;
		this.statusKind = kind;
	}

	private title(value: string): string {
		const bold = this.theme?.bold?.(value) ?? value;
		return this.style("accent", bold);
	}

	private titleLine(value: string, width: number): string {
		return fit(this.title(value), width);
	}

	private dim(value: string): string {
		return this.style("dim", value);
	}

	private shortcutLegend(width: number, shortcuts: ShortcutHint[], prefix?: string): string {
		const separator = this.dim(" • ");
		const parts = [
			...(prefix ? [this.dim(prefix)] : []),
			...shortcuts.map((shortcut) => `${this.shortcutKey(shortcut.key)} ${this.dim(shortcut.label)}`),
		];
		return fit(parts.join(separator), width);
	}

	private shortcutKey(value: string): string {
		const bold = this.theme?.bold?.(value) ?? value;
		return this.style("accent", bold);
	}

	private selectedRow(value: string): string {
		return this.theme?.bg?.("selectedBg", value) ?? this.style("accent", value);
	}

	private style(color: string, value: string): string {
		return this.theme?.fg?.(color, value) ?? value;
	}

	private invalidateAndRender(): void {
		this.invalidate();
		this.tui?.requestRender?.(true);
	}
}

export function createManageSkillsTui(options: ManageSkillsTuiOptions): ManageSkillsTui {
	return new ManageSkillsTui(options);
}

function skillSubject(skill: SkillInfo): { name: string; path?: string; sourceRoot?: string } {
	return { name: skill.name, path: skill.path, sourceRoot: skill.sourceRoot };
}

function cloneState(state: State): State {
	return JSON.parse(JSON.stringify(state)) as State;
}

function stateText(value: SkillPolicyValue): string {
	return value === "enabled" ? "enabled" : "disabled";
}

function folderStateText(value: FolderSkillPolicyValue): string {
	return value === "inherit" ? "inherit" : stateText(value);
}

function currentLabel(skill: SkillInfo): string {
	return skill.effectiveState === "enabled" ? "on" : "off";
}

function ruleLabel(skill: SkillInfo): string {
	if (skill.winningScope === "folder") return "folder";
	if (skill.winningTarget === "default") return "default";
	return skill.winningTarget;
}

function ruleDetails(skill: SkillInfo): string {
	const target = skill.winningTarget === "default" ? "default" : `${skill.winningTarget} rule`;
	return skill.winningScope === "folder" ? `this folder ${target}` : `global ${target}`;
}

function sourceRuleDetails(source: SkillSourceInfo | undefined): string {
	if (!source) return "enabled by default";
	const target = source.winningTarget === "default" ? "default" : `${source.winningScope} source rule`;
	return `${stateText(source.effectiveState)} by ${target}`;
}

function sourceBadge(skill: SkillInfo): string {
	if (skill.source === "plugin") return "plugin";
	if (skill.source === "custom-source") return "custom";
	if (skill.source === "pi-native") return "pi";
	if (skill.sourceLabel.startsWith("package:")) return "pkg";
	return "readonly";
}

function enforcementMode(skill: SkillInfo): string {
	if (skill.enabled) return "active";
	if (skill.source === "plugin" || skill.source === "custom-source") return "hidden after reload + blocked";
	return "prompt-filtered + blocked";
}

function rowLimitForWidth(width: number): number {
	return width < WIDE_SPLIT_MIN_WIDTH ? NARROW_TABLE_ROW_LIMIT : TABLE_ROW_LIMIT;
}

function skillTableWidths(width: number): { name: number; current: number; rule: number; source: number } {
	const current = width >= 42 ? 8 : 7;
	const rule = width >= 42 ? 12 : 8;
	const source = width >= 44 ? 8 : 6;
	const spaces = 3;
	const name = Math.max(6, width - current - rule - source - spaces);
	return { name, current, rule, source };
}

function joinColumns(values: string[]): string {
	return values.join(" ");
}

function centerTitle(title: string, width: number): string {
	const label = ` ${title} `;
	const remaining = Math.max(0, width - visibleWidth(label));
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return `${repeatToWidth("─", left)}${label}${repeatToWidth("─", right)}`;
}

function frameLines(content: string[], width: number, borderChar = "─"): string[] {
	if (width < 4) return content.map((line) => fit(line, width));
	const inner = width - 2;
	const top = `╭${repeatToWidth(borderChar, inner)}╮`;
	const bottom = `╰${repeatToWidth(borderChar, inner)}╯`;
	return [top, ...content.map((line) => `│${fit(line, inner)}│`), bottom];
}

function fit(value: string, width: number): string {
	const truncated = truncateToWidth(value, Math.max(0, width), "…", false);
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function repeatToWidth(char: string, width: number): string {
	if (width <= 0) return "";
	let result = "";
	while (visibleWidth(result) < width) result += char;
	return truncateToWidth(result, width, "", false);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}
