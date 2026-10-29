import {
  isPaletteTabLine,
  paletteCommandGroups,
  paletteHeadingTree,
  paletteRowsOf,
  paletteTabsOf,
} from '@axe/domain/chat/palette-rows';

describe('reading a palette line for what it is', () => {
  it('tells a heading from what follows it', () => {
    const rows = paletteRowsOf(['//----戦闘----', '◆移動', '2d6+3 攻撃']);

    expect(rows.map((row) => row.kind)).toEqual(['heading', 'heading', 'command']);
    expect(rows[0].headingName).toBe('戦闘');
    expect(rows[1].headingName).toBe('移動');
  });

  it('reads a ■ line as a heading beneath the top-level heading above it', () => {
    const rows = paletteRowsOf(['◆戦闘', '■攻撃', '2d6 攻撃']);

    expect(rows.map((row) => row.kind)).toEqual(['heading', 'heading', 'command']);
    expect(rows.map((row) => row.headingLevel)).toEqual([1, 2, undefined]);
    expect(rows[1].headingName).toBe('攻撃');
    expect(rows[1].headingParent).toBe('戦闘');
  });

  it('gives a ■ heading written before any top-level heading no parent', () => {
    const [row] = paletteRowsOf(['■準備']);

    expect(row.headingLevel).toBe(2);
    expect(row.headingParent).toBeUndefined();
  });

  it('tells a variable from a line to say', () => {
    const rows = paletteRowsOf(['//威力=7', '//全角＝も', '2d6+{威力}']);

    expect(rows.map((row) => row.kind)).toEqual(['variable', 'variable', 'command']);
  });

  it('calls a line with nothing on it empty', () => {
    expect(paletteRowsOf(['', '   ']).map((row) => row.kind)).toEqual(['empty', 'empty']);
  });

  it('keeps the place of each line', () => {
    expect(paletteRowsOf(['a', 'b', 'c']).map((row) => row.lineIndex)).toEqual([0, 1, 2]);
  });

  it('gathers only what is worth sending, under the heading it sits below', () => {
    const lines = ['//----戦闘----', '  2d6+3 攻撃  ', '//威力=7', '', '◆回復', ':HP+5'];

    expect(paletteCommandGroups(lines)).toEqual([
      { tab: '', heading: '戦闘', lines: ['2d6+3 攻撃'] },
      { tab: '', heading: '回復', lines: [':HP+5'] },
    ]);
  });

  it('keeps the lines written before any heading together', () => {
    expect(paletteCommandGroups(['1d100', '◆戦闘', '2d6'])).toEqual([
      { tab: '', heading: '', lines: ['1d100'] },
      { tab: '', heading: '戦闘', lines: ['2d6'] },
    ]);
  });

  it('names a group under a ■ heading together with the top-level heading above it', () => {
    expect(paletteCommandGroups(['◆戦闘', '■攻撃', '2d6', '■防御', '1d6'])).toEqual([
      { tab: '', heading: '戦闘 / 攻撃', lines: ['2d6'] },
      { tab: '', heading: '戦闘 / 防御', lines: ['1d6'] },
    ]);
  });

  it('drops a heading with nothing to send under it', () => {
    expect(paletteCommandGroups(['◆空', '', '//威力=7'])).toEqual([]);
  });

  it('drops a heading with nothing to send under it', () => {
    expect(paletteCommandGroups(['◆空', '', '//威力=7'])).toEqual([]);
  });
});

describe('parting a palette into tabs', () => {
  const lines = ['//威力=7', '1d100 目星', '◆◆戦闘', '◆攻撃', '2d6+{威力}', '◆◆◆飾り', '◆◆ 探索 ', 'CC<=50'];

  it('reads two diamonds as a tab, and one or three or more as a heading as before', () => {
    const rows = paletteRowsOf(lines);

    expect(rows.map((row) => row.kind)).toEqual([
      'variable',
      'command',
      'tab',
      'heading',
      'command',
      'heading',
      'tab',
      'command',
    ]);
    expect(rows[2].tabName).toBe('戦闘');
    expect(rows[6].tabName).toBe('探索');
    expect(isPaletteTabLine('◆◆戦闘')).toBe(true);
    expect(isPaletteTabLine('◆◆◆戦闘')).toBe(false);
  });

  it('puts the lines before the first tab in a tab of their own, and the rest under the tab they follow', () => {
    const tabs = paletteTabsOf(paletteRowsOf(lines));

    expect(tabs.map((tab) => [tab.name, tab.rows.map((row) => row.text)])).toEqual([
      ['', ['//威力=7', '1d100 目星']],
      ['戦闘', ['◆攻撃', '2d6+{威力}', '◆◆◆飾り']],
      ['探索', ['CC<=50']],
    ]);
  });

  it('makes no tab of nothing written before the first, nor any tab at all of a palette with none', () => {
    expect(paletteTabsOf(paletteRowsOf(['', '◆◆戦闘', '2d6'])).map((tab) => tab.name)).toEqual(['戦闘']);
    expect(paletteTabsOf(paletteRowsOf(['◆攻撃', '2d6']))).toEqual([]);
  });

  it('gathers what is worth sending under its tab as well as its heading', () => {
    expect(paletteCommandGroups(lines)).toEqual([
      { tab: '', heading: '', lines: ['1d100 目星'] },
      { tab: '戦闘', heading: '攻撃', lines: ['2d6+{威力}'] },
      { tab: '探索', heading: '', lines: ['CC<=50'] },
    ]);
  });
});

describe('nesting the headings for the headings menu', () => {
  function tree(lines: string[]) {
    return paletteHeadingTree(paletteRowsOf(lines)).map((node) => ({
      name: node.name,
      line: node.lineIndex,
      children: node.children.map((child) => `${child.lineIndex}:${child.name}`),
    }));
  }

  it('puts each ■ heading under the top-level heading above it', () => {
    expect(tree(['◆戦闘', '■攻撃', '2d6', '■防御', '◆技能', '1d100'])).toEqual([
      { name: '戦闘', line: 0, children: ['1:攻撃', '3:防御'] },
      { name: '技能', line: 4, children: [] },
    ]);
  });

  it('keeps a ■ heading written before any top-level heading at the top level', () => {
    expect(tree(['■準備', '1d6', '//----戦闘----', '■攻撃'])).toEqual([
      { name: '準備', line: 0, children: [] },
      { name: '戦闘', line: 2, children: ['3:攻撃'] },
    ]);
  });
});
