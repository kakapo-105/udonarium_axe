import { paletteCommandGroups, paletteHeadingTree, paletteRowsOf } from '@axe/domain/chat/palette-rows';

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
      { heading: '戦闘', lines: ['2d6+3 攻撃'] },
      { heading: '回復', lines: [':HP+5'] },
    ]);
  });

  it('keeps the lines written before any heading together', () => {
    expect(paletteCommandGroups(['1d100', '◆戦闘', '2d6'])).toEqual([
      { heading: '', lines: ['1d100'] },
      { heading: '戦闘', lines: ['2d6'] },
    ]);
  });

  it('names a group under a ■ heading together with the top-level heading above it', () => {
    expect(paletteCommandGroups(['◆戦闘', '■攻撃', '2d6', '■防御', '1d6'])).toEqual([
      { heading: '戦闘 / 攻撃', lines: ['2d6'] },
      { heading: '戦闘 / 防御', lines: ['1d6'] },
    ]);
  });

  it('drops a heading with nothing to send under it', () => {
    expect(paletteCommandGroups(['◆空', '', '//威力=7'])).toEqual([]);
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
