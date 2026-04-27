import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

export type CheckboxItem = {
	label: string;
	checked: boolean;
	key: string;
};

export type CheckboxResult = {
	applied: boolean;
	items: CheckboxItem[];
};

/**
 * Interactive checkbox selector for TUI.
 * Use space to toggle items, enter to apply, escape to cancel.
 */
export class CheckboxSelector {
	private items: CheckboxItem[];
	private originalStates: boolean[];
	private selected = 0;
	private title: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onDone?: (result: CheckboxResult) => void;

	constructor(title: string, items: CheckboxItem[]) {
		this.title = title;
		this.items = items.map((item) => ({ ...item }));
		this.originalStates = items.map((item) => item.checked);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) && this.selected > 0) {
			this.selected--;
			this.invalidate();
		} else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
			this.selected++;
			this.invalidate();
		} else if (matchesKey(data, Key.space)) {
			this.items[this.selected]!.checked = !this.items[this.selected]!.checked;
			this.invalidate();
		} else if (matchesKey(data, Key.enter)) {
			this.onDone?.({ applied: true, items: this.items });
		} else if (matchesKey(data, Key.escape)) {
			this.onDone?.({ applied: false, items: this.items });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		lines.push(truncateToWidth(this.title, width));
		lines.push(truncateToWidth("  ↑/↓ navigate  space toggle  enter apply  esc cancel", width));
		lines.push("");

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const pointer = i === this.selected ? "→ " : "  ";
			const checkbox = item.checked ? "✓" : "○";
			const changed = item.checked !== this.originalStates[i] ? " *" : "";
			lines.push(truncateToWidth(`${pointer}${checkbox} ${item.label}${changed}`, width));
		}

		const changeCount = this.getChangeCount();
		if (changeCount > 0) {
			lines.push("");
			lines.push(truncateToWidth(`  ${changeCount} change${changeCount === 1 ? "" : "s"} pending — press enter to apply`, width));
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getChangeCount(): number {
		return this.items.filter((item, i) => item.checked !== this.originalStates[i]).length;
	}
}
