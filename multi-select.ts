/**
 * Multi-select TUI: Space toggles, ↑/↓ moves, Enter confirms, Esc cancels, type to filter.
 * Selection is tracked by item value (stable across filters).
 *
 * Visual states (cursor vs checked are independent):
 *   focused (+/- checked) → accent bar + full selectedBg row (bold label)
 *   checked only          → green [x], normal label
 *   idle                  → dim [ ], normal label
 */
import { matchesKey, type Component } from "@earendil-works/pi-tui";

export interface MultiSelectItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * Theme hooks from the host.
 * Prefer scoped resets (fg→39 / bg→49 / bold→22) so styles compose.
 * `row` paints the full focused line (theme.bg("selectedBg", ...)).
 */
export interface MultiSelectTheme {
  title: (text: string) => string;
  accent: (text: string) => string;
  success: (text: string) => string;
  dim: (text: string) => string;
  muted: (text: string) => string;
  warning: (text: string) => string;
  bold: (text: string) => string;
  /** Full-line highlight for the focused row. */
  row: (text: string) => string;
  /** Primary text on a focused row. */
  rowText: (text: string) => string;
}

/** Scoped ANSI so nested styles (esp. row inverse/bg) don't get wiped by 0m. */
export const DEFAULT_THEME: MultiSelectTheme = {
  title: (t) => `\x1b[1m\x1b[36m${t}\x1b[39m\x1b[22m`,
  accent: (t) => `\x1b[36m${t}\x1b[39m`,
  success: (t) => `\x1b[32m${t}\x1b[39m`,
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  muted: (t) => `\x1b[2m${t}\x1b[22m`,
  warning: (t) => `\x1b[33m${t}\x1b[39m`,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  row: (t) => `\x1b[7m${t}\x1b[27m`,
  rowText: (t) => t,
};

const UP = ["\u001b[A", "\u001bOA"];
const DOWN = ["\u001b[B", "\u001bOB"];
const PAGE_UP = ["\u001b[5~"];
const PAGE_DOWN = ["\u001b[6~"];
const HOME = ["\u001b[H", "\u001b[1~", "\u001bOH"];
const END = ["\u001b[F", "\u001b[4~", "\u001bOF"];
const ENTER = ["\r", "\n"];
const ESC = ["\u001b", "\u001bc"];
const SPACE = " ";
const CTRL_A = "\u0001";
const CTRL_D = "\u0004";
const CTRL_C = "\u0003";

/** Rough terminal column width (CJK = 2). */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else if (cp >= 0x20 || cp === 0x09) {
      w += 1;
    }
  }
  return w;
}

export interface MultiSelectOptions {
  items: MultiSelectItem[];
  done: (val: string[] | null) => void;
  onDirty?: () => void;
  title?: string;
  maxVisible?: number;
  theme?: MultiSelectTheme;
  initialSelected?: string[];
  /** pi keybindings manager from ctx.ui.custom(..., keybindings, ...). */
  keybindings?: { matches(data: string, keybinding: string): boolean };
}

export class MultiSelect implements Component {
  private items: MultiSelectItem[];
  private filtered: MultiSelectItem[];
  private cursor = 0;
  private selected = new Set<string>();
  private filter = "";
  private maxVisible: number;
  private topOffset = 0;
  private done: (val: string[] | null) => void;
  private onDirty: () => void;
  private title: string;
  private theme: MultiSelectTheme;
  private keybindings?: { matches(data: string, keybinding: string): boolean };

  constructor(opts: MultiSelectOptions) {
    this.items = opts.items;
    this.filtered = opts.items;
    this.maxVisible = Math.max(1, opts.maxVisible ?? 12);
    this.done = opts.done;
    this.onDirty = opts.onDirty ?? (() => {});
    this.title = opts.title?.trim() || "Select models";
    this.theme = opts.theme ?? DEFAULT_THEME;
    this.keybindings = opts.keybindings;
    if (opts.initialSelected) {
      for (const v of opts.initialSelected) this.selected.add(v);
    }
  }

  static create(
    items: MultiSelectItem[],
    done: (val: string[] | null) => void,
    onDirty: () => void = () => {},
    maxVisible = 12,
    title = "Select models",
    theme?: MultiSelectTheme,
  ): MultiSelect {
    return new MultiSelect({ items, done, onDirty, maxVisible, title, theme });
  }

  invalidate() { /* no cached state */ }

  private dirty() {
    this.onDirty();
  }

  /**
   * One list row. Matches pi selectors: style parts → pad to width → wrap focused
   * line in selectedBg so the cursor band is unmistakable.
   */
  private renderRow(it: MultiSelectItem, isCur: boolean, isSel: boolean, width: number): string {
    const th = this.theme;

    // Plain skeleton for width calc (no ANSI)
    const gutterPlain = isCur ? "▌ " : "  ";
    const boxPlain = isSel ? "[x]" : "[ ]";
    const labelPlain = it.label;
    const descPlain = it.description ? `  ${it.description}` : "";
    const plainCore = `${gutterPlain}${boxPlain} ${labelPlain}${descPlain}`;
    const pad = " ".repeat(Math.max(0, width - visualWidth(plainCore)));

    if (isCur) {
      // Focused: accent bar + checkbox + bold label, then full-row bg
      const gutter = th.accent("▌ ");
      const box = isSel ? th.success("[x]") : th.dim("[ ]");
      const label = th.bold(th.rowText(labelPlain));
      const desc = descPlain ? th.muted(descPlain) : "";
      // Official pattern: build styled line, THEN apply bg to the whole thing
      return th.row(`${gutter}${box} ${label}${desc}${pad}`);
    }

    // Unfocused checked: only the box is green — keeps focus row dominant
    if (isSel) {
      const box = th.success("[x]");
      const desc = descPlain ? th.muted(descPlain) : "";
      return `  ${box} ${labelPlain}${desc}`;
    }

    // Idle
    const box = th.dim("[ ]");
    const desc = descPlain ? th.muted(descPlain) : "";
    return `  ${box} ${labelPlain}${desc}`;
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const total = this.filtered.length;
    const selCount = this.selected.size;
    const rowWidth = Math.max(24, width > 0 ? width : 80);

    lines.push(th.title(` ${this.title}`));

    // Status line
    const countPart = selCount > 0
      ? th.success(` ${selCount} selected`)
      : th.dim(" 0 selected");
    const totalPart = this.filter
      ? th.dim(` · ${total}/${this.items.length} shown`)
      : th.dim(` · ${this.items.length} total`);
    const filterPart = this.filter ? th.accent(`  “${this.filter}”`) : "";
    lines.push(`${countPart}${totalPart}${filterPart}`);
    lines.push("");

    if (total === 0) {
      lines.push(th.warning("  (no matches)"));
      lines.push("");
      lines.push(th.dim("  Backspace clears filter · Esc cancels"));
      return lines;
    }

    if (this.cursor < this.topOffset) this.topOffset = this.cursor;
    if (this.cursor >= this.topOffset + this.maxVisible) {
      this.topOffset = this.cursor - this.maxVisible + 1;
    }
    const end = Math.min(total, this.topOffset + this.maxVisible);

    for (let i = this.topOffset; i < end; i++) {
      const it = this.filtered[i];
      lines.push(
        this.renderRow(it, i === this.cursor, this.selected.has(it.value), rowWidth),
      );
    }

    if (total > this.maxVisible) {
      const pct = Math.round(((this.cursor + 1) / total) * 100);
      lines.push("");
      lines.push(th.dim(`  ${this.topOffset + 1}–${end} of ${total}  ·  ${pct}%`));
    }

    lines.push("");
    lines.push(
      th.dim("  Space toggle · Enter confirm · Esc cancel · type filter · Ctrl+A all · Ctrl+D none"),
    );
    return lines;
  }

  private applyFilter() {
    if (!this.filter) {
      this.filtered = this.items;
    } else {
      const f = this.filter.toLowerCase();
      this.filtered = this.items.filter(
        (it) =>
          it.value.toLowerCase().includes(f) ||
          it.label.toLowerCase().includes(f) ||
          (it.description?.toLowerCase().includes(f) ?? false),
      );
    }
    if (this.cursor >= this.filtered.length) {
      this.cursor = Math.max(0, this.filtered.length - 1);
    }
    this.topOffset = 0;
    this.dirty();
  }

  private selectedValues(): string[] {
    const out: string[] = [];
    for (const it of this.items) {
      if (this.selected.has(it.value)) out.push(it.value);
    }
    return out;
  }

  private currentValue(): string | undefined {
    return this.filtered[this.cursor]?.value;
  }

  private toggleCurrent() {
    const v = this.currentValue();
    if (!v) return;
    if (this.selected.has(v)) this.selected.delete(v);
    else this.selected.add(v);
    this.dirty();
  }

  private selectAllVisible() {
    for (const it of this.filtered) this.selected.add(it.value);
    this.dirty();
  }

  private deselectAll() {
    this.selected.clear();
    this.dirty();
  }

  private move(delta: number) {
    if (this.filtered.length === 0) return;
    let next = this.cursor + delta;
    if (next < 0) next = this.filtered.length - 1;
    else if (next >= this.filtered.length) next = 0;
    if (next !== this.cursor) {
      this.cursor = next;
      this.dirty();
    }
  }

  handleInput(data: string): void {
    const kb = this.keybindings;

    // Prefer pi's official select keybindings. This fixes terminals that do not
    // send a bare "\u001b" for Esc (kitty keyboard protocol, custom bindings, etc.).
    if (
      kb?.matches(data, "tui.select.cancel") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "\u001b" ||
      data === "\u0003"
    ) {
      this.done(null);
      return;
    }
    if (kb?.matches(data, "tui.select.confirm")) {
      this.done(this.selectedValues());
      return;
    }
    if (kb?.matches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (kb?.matches(data, "tui.select.down")) {
      this.move(1);
      return;
    }
    if (kb?.matches(data, "tui.select.pageUp")) {
      this.move(-this.maxVisible);
      return;
    }
    if (kb?.matches(data, "tui.select.pageDown")) {
      this.move(this.maxVisible);
      return;
    }

    if (data === SPACE) {
      this.toggleCurrent();
      return;
    }
    if (UP.includes(data)) {
      this.move(-1);
      return;
    }
    if (DOWN.includes(data)) {
      this.move(1);
      return;
    }
    if (PAGE_UP.includes(data)) {
      this.move(-this.maxVisible);
      return;
    }
    if (PAGE_DOWN.includes(data)) {
      this.move(this.maxVisible);
      return;
    }
    if (HOME.includes(data)) {
      if (this.cursor !== 0) {
        this.cursor = 0;
        this.dirty();
      }
      return;
    }
    if (END.includes(data)) {
      const last = Math.max(0, this.filtered.length - 1);
      if (this.cursor !== last) {
        this.cursor = last;
        this.dirty();
      }
      return;
    }
    if (ENTER.includes(data)) {
      this.done(this.selectedValues());
      return;
    }
    if (ESC.includes(data) || data === CTRL_C) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "ctrl+a") || data === CTRL_A) {
      this.selectAllVisible();
      return;
    }
    if (matchesKey(data, "ctrl+d") || data === CTRL_D) {
      this.deselectAll();
      return;
    }
    if (data === "\u007f" || data === "\u0008") {
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
      }
      return;
    }
    if (!data || data.startsWith("\u001b")) return;
    if ([...data].every((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x20 && cp !== 0x7f;
    })) {
      this.filter += data;
      this.applyFilter();
    }
  }
}
