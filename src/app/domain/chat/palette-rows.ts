export type PaletteLineKind = 'command' | 'heading' | 'variable' | 'empty';

export interface PaletteRow {
  text: string;
  kind: PaletteLineKind;
  lineIndex: number;
  headingName?: string;
  /** 1 for a `◆` or `//---` heading, 2 for a `■` one beneath it. */
  headingLevel?: 1 | 2;
  /** For a `■` heading, the name of the top-level heading it sits under, if any. */
  headingParent?: string;
}

const DASH_HEADING = /^\/\/--[-]+(.*)$/;
const MARK_HEADING = /^◆(.*)$/;
const SUB_HEADING = /^■(.*)$/;
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
  /** The heading these lines sit under, empty for the ones written before any heading. */
  heading: string;
  lines: string[];
}

/** The lines worth sending, kept under the headings they were written beneath. */
export function paletteCommandGroups(lines: readonly string[]): PaletteCommandGroup[] {
  const groups: PaletteCommandGroup[] = [];
  let current: PaletteCommandGroup | null = null;

  for (const row of paletteRowsOf(lines)) {
    if (row.kind === 'heading') {
      current = { heading: paletteHeadingLabel(row), lines: [] };
      groups.push(current);
      continue;
    }
    if (row.kind !== 'command') continue;

    if (!current) {
      current = { heading: '', lines: [] };
      groups.push(current);
    }
    current.lines.push(row.text.trim());
  }

  return groups.filter((group) => group.lines.length > 0);
}
