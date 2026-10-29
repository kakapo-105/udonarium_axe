export type PaletteLineKind = 'command' | 'heading' | 'variable' | 'empty' | 'tab';

export interface PaletteRow {
  text: string;
  kind: PaletteLineKind;
  lineIndex: number;
  headingName?: string;
  /** 1 for a `◆` or `//---` heading, 2 for a `■` one beneath it. */
  headingLevel?: 1 | 2;
  /** For a `■` heading, the name of the top-level heading it sits under, if any. */
  headingParent?: string;
  tabName?: string;
}

const DASH_HEADING = /^\/\/--[-]+(.*)$/;
const MARK_HEADING = /^◆(.*)$/;
const SUB_HEADING = /^■(.*)$/;
/**
 * A line opening a tab: two diamonds and its name. A version before tabs reads it as a heading, as it
 * does anything starting with a diamond; three or more stay a heading here too, as written to set
 * one off.
 */
const TAB_MARK = /^◆◆(?!◆)(.*)$/;

/** Whether a palette line opens a tab rather than saying anything. */
export function isPaletteTabLine(line: string): boolean {
  return TAB_MARK.test(line);
}
const VARIABLE = /^\s*[/／]{2}([^=＝{}｛｝\s]+)\s*[=＝]\s*(.+)/;

/**
 * What each line of a palette is: something to say, a heading over the rest, a variable, or nothing.
 *
 * `◆` and `//---` start a top-level heading and `■` one beneath the top-level heading above it.
 */
export function paletteRowsOf(lines: readonly string[]): PaletteRow[] {
  let parent: string | undefined;
  return lines.map((text, lineIndex): PaletteRow => {
    if (/^\s*$/.test(text)) return { text, kind: 'empty', lineIndex };

    const tab = text.match(TAB_MARK);
    if (tab) {
      parent = undefined;
      return { text, kind: 'tab', lineIndex, tabName: tab[1].trim() };
    }

    const dashed = text.match(DASH_HEADING);
    if (dashed) {
      parent = dashed[1].replace(/-+$/, '');
      return { text, kind: 'heading', lineIndex, headingName: parent, headingLevel: 1 };
    }

    const marked = text.match(MARK_HEADING);
    if (marked) {
      parent = marked[1];
      return { text, kind: 'heading', lineIndex, headingName: parent, headingLevel: 1 };
    }

    const sub = text.match(SUB_HEADING);
    if (sub) {
      const row: PaletteRow = { text, kind: 'heading', lineIndex, headingName: sub[1], headingLevel: 2 };
      if (parent !== undefined) row.headingParent = parent;
      return row;
    }

    if (VARIABLE.test(text)) return { text, kind: 'variable', lineIndex };
    return { text, kind: 'command', lineIndex };
  });
}

/**
 * A heading's name as it reads away from the palette, where the heading above it cannot be seen:
 * a `■` heading is named together with the top-level heading it sits under.
 */
export function paletteHeadingLabel(row: PaletteRow): string {
  const name = (row.headingName ?? '').trim();
  const parent = row.headingParent?.trim();
  return parent ? `${parent} / ${name}` : name;
}

/** A heading in the headings menu, with the `■` headings beneath it. */
export interface PaletteHeadingNode {
  name: string;
  lineIndex: number;
  children: PaletteHeadingNode[];
}

/**
 * The palette's headings as the headings menu lists them.
 *
 * A `■` heading goes under the top-level heading above it; one written before any top-level
 * heading stands at the top level itself.
 */
export function paletteHeadingTree(rows: readonly PaletteRow[]): PaletteHeadingNode[] {
  const tree: PaletteHeadingNode[] = [];
  let parent: PaletteHeadingNode | null = null;
  for (const row of rows) {
    if (row.kind !== 'heading') continue;
    const node: PaletteHeadingNode = { name: row.headingName ?? '', lineIndex: row.lineIndex, children: [] };
    if (row.headingLevel === 2 && parent) {
      parent.children.push(node);
      continue;
    }
    tree.push(node);
    if (row.headingLevel !== 2) parent = node;
  }
  return tree;
}

export interface PaletteCommandGroup {
  /** The tab these lines sit in, empty for a palette with no tabs or the lines before the first. */
  tab: string;
  /** The heading these lines sit under, empty for the ones written before any heading. */
  heading: string;
  lines: string[];
}

/** The lines worth sending, kept under the headings they were written beneath. */
export function paletteCommandGroups(lines: readonly string[]): PaletteCommandGroup[] {
  const groups: PaletteCommandGroup[] = [];
  let current: PaletteCommandGroup | null = null;
  let tab = '';

  for (const row of paletteRowsOf(lines)) {
    if (row.kind === 'tab') {
      tab = row.tabName ?? '';
      current = null;
      continue;
    }
    if (row.kind === 'heading') {
      current = { tab, heading: paletteHeadingLabel(row), lines: [] };
      groups.push(current);
      continue;
    }
    if (row.kind !== 'command') continue;

    if (!current) {
      current = { tab, heading: '', lines: [] };
      groups.push(current);
    }
    current.lines.push(row.text.trim());
  }

  return groups.filter((group) => group.lines.length > 0);
}

/**
 * A palette line as it is said: each `\n` written in it becomes a real line break, so a line
 * that casts a spell can carry its damage and its cost as commands of their own lines.
 */
export function paletteLineAsChat(line: string): string {
  return line.replace(/\\n/g, '\n');
}

/** One tab of a palette: its name, empty for the lines before the first tab, and the rows in it. */
export interface PaletteTab {
  name: string;
  rows: PaletteRow[];
}

/**
 * The tabs a palette is parted into by its `◆◆name` lines, the lines before the first making a tab
 * of their own where they hold anything. None for a palette with no such line, which shows as it
 * always did.
 */
export function paletteTabsOf(rows: readonly PaletteRow[]): PaletteTab[] {
  if (!rows.some((row) => row.kind === 'tab')) return [];
  const tabs: PaletteTab[] = [];
  let current: PaletteTab = { name: '', rows: [] };
  const close = () => {
    if (tabs.length > 0 || current.rows.some((row) => row.kind !== 'empty')) tabs.push(current);
  };
  for (const row of rows) {
    if (row.kind !== 'tab') {
      current.rows.push(row);
      continue;
    }
    close();
    current = { name: row.tabName ?? '', rows: [] };
  }
  close();
  return tabs;
}
