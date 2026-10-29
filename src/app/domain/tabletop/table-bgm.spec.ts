import { GameTable } from '@axe/domain/tabletop/game-table';
import { adoptLegacyTableBgm, setTableBgmSetting, tableBgmSettingOf } from '@axe/domain/tabletop/table-bgm';

describe('a table’s music as one setting', () => {
  function table(): GameTable {
    const made = new GameTable();
    made.initialize();
    return made;
  }

  it('reads empty for a table that leaves the music alone', () => {
    expect(tableBgmSettingOf(table())).toBe('');
  });

  it('writes a track as one to put on, and reads it back', () => {
    const made = table();
    setTableBgmSetting(made, 'battle');

    expect([made.tableBgm, made.tableBgmIdentifier]).toEqual(['play', 'battle']);
    expect(tableBgmSettingOf(made)).toBe('battle');
  });

  it('writes stop as silence, forgetting the track it named', () => {
    const made = table();
    setTableBgmSetting(made, 'battle');
    setTableBgmSetting(made, 'stop');

    expect([made.tableBgm, made.tableBgmIdentifier]).toEqual(['stop', '']);
    expect(tableBgmSettingOf(made)).toBe('stop');
  });

  it('writes empty as leaving the music alone', () => {
    const made = table();
    setTableBgmSetting(made, 'battle');
    setTableBgmSetting(made, '');

    expect([made.tableBgm, made.tableBgmIdentifier]).toEqual(['', '']);
  });

  describe('a table saved by an older version of the fork', () => {
    it('takes the track named in its bgm attribute, and forgets the attribute', () => {
      const made = table();
      made.setAttribute('bgm', 'battle');

      adoptLegacyTableBgm(made);

      expect(tableBgmSettingOf(made)).toBe('battle');
      expect(made.getAttribute('bgm')).toBe('');
    });

    it('takes the old mark for silence as stop', () => {
      const made = table();
      made.setAttribute('bgm', '__stop__');

      adoptLegacyTableBgm(made);

      expect(tableBgmSettingOf(made)).toBe('stop');
    });

    it('keeps music already named the newer way', () => {
      const made = table();
      setTableBgmSetting(made, 'explore');
      made.setAttribute('bgm', 'battle');

      adoptLegacyTableBgm(made);

      expect(tableBgmSettingOf(made)).toBe('explore');
    });

    it('does nothing to a table with no bgm attribute', () => {
      const made = table();

      adoptLegacyTableBgm(made);

      expect(tableBgmSettingOf(made)).toBe('');
    });
  });
});
