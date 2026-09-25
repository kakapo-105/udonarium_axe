/** A table's music setting that asks for silence when the table is chosen. */
export const TABLE_BGM_STOP = '__stop__';

/** What choosing a table does to the room's music. */
export type TableBgmAction = { kind: 'keep' } | { kind: 'stop' } | { kind: 'play'; identifier: string };

/**
 * What the room's music should do when a table with this music setting is chosen.
 *
 * An empty setting leaves the music as it is, and so does a track the room no longer holds. A
 * track already playing is left playing rather than started again from the top, and asking for
 * silence when nothing is playing does nothing.
 */
export function tableBgmAction(
  setting: string,
  playing: { audioIdentifier: string; isPlaying: boolean },
  hasTrack: (identifier: string) => boolean
): TableBgmAction {
  if (setting === '') return { kind: 'keep' };
  if (setting === TABLE_BGM_STOP) return playing.isPlaying ? { kind: 'stop' } : { kind: 'keep' };
  if (!hasTrack(setting)) return { kind: 'keep' };
  if (playing.isPlaying && playing.audioIdentifier === setting) return { kind: 'keep' };
  return { kind: 'play', identifier: setting };
}
