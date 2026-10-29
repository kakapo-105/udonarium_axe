import { tableBgmModeOf } from '@axe/domain/media/table-bgm';

/**
 * A table's music as automation reads and writes it, in one string: an audio file's identifier to
 * put on, `'stop'` for silence, or empty to leave the music as it is. The table itself keeps this as
 * `tableBgm` and `tableBgmIdentifier`.
 */
export type TableBgmSetting = string;

/** The setting that asks for silence when the table is switched to. */
export const TABLE_BGM_STOP_SETTING = 'stop';

/** What a table holding its music in `tableBgm` and `tableBgmIdentifier` asks for, as one setting. */
interface TableBgmFields {
  tableBgm: string;
  tableBgmIdentifier: string;
}

/** A table's music as one setting: its track, `'stop'`, or empty. */
export function tableBgmSettingOf(table: TableBgmFields): TableBgmSetting {
  switch (tableBgmModeOf(table)) {
    case 'play':
      return table.tableBgmIdentifier;
    case 'stop':
      return TABLE_BGM_STOP_SETTING;
    case '':
      return '';
  }
}

/** Writes one setting into a table's music: a track to put on, `'stop'`, or empty to leave it. */
export function setTableBgmSetting(table: TableBgmFields, setting: TableBgmSetting): void {
  if (setting === '' || setting === TABLE_BGM_STOP_SETTING) {
    table.tableBgm = setting;
    table.tableBgmIdentifier = '';
    return;
  }
  table.tableBgm = 'play';
  table.tableBgmIdentifier = setting;
}

/** What an older version of this fork kept in a table's `bgm` attribute to ask for silence. */
const LEGACY_STOP = '__stop__';

/**
 * Moves the music a table saved by an older version of this fork names in its `bgm` attribute into
 * `tableBgm` and `tableBgmIdentifier`, and forgets the attribute. A table that already names its
 * music the newer way keeps that.
 */
export function adoptLegacyTableBgm(
  table: TableBgmFields & { getAttribute(name: string): string; removeAttribute(name: string): void }
): void {
  const legacy = String(table.getAttribute('bgm') ?? '');
  if (legacy === '') return;
  table.removeAttribute('bgm');
  if (tableBgmModeOf(table) !== '') return;
  setTableBgmSetting(table, legacy === LEGACY_STOP ? TABLE_BGM_STOP_SETTING : legacy);
}
