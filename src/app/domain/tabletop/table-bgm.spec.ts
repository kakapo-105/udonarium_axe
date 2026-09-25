import { TABLE_BGM_STOP, tableBgmAction } from '@axe/domain/tabletop/table-bgm';

describe('what choosing a table does to the music', () => {
  const silent = { audioIdentifier: '', isPlaying: false };
  const playing = (identifier: string) => ({ audioIdentifier: identifier, isPlaying: true });
  const held = (identifier: string) => identifier === 'battle' || identifier === 'explore';

  it('leaves the music alone for a table with no setting', () => {
    expect(tableBgmAction('', playing('explore'), held)).toEqual({ kind: 'keep' });
  });

  it('plays the track the table names', () => {
    expect(tableBgmAction('battle', playing('explore'), held)).toEqual({ kind: 'play', identifier: 'battle' });
    expect(tableBgmAction('battle', silent, held)).toEqual({ kind: 'play', identifier: 'battle' });
  });

  it('leaves the same track playing rather than starting it over', () => {
    expect(tableBgmAction('battle', playing('battle'), held)).toEqual({ kind: 'keep' });
  });

  it('starts the named track again when it is set but stopped', () => {
    expect(tableBgmAction('battle', { audioIdentifier: 'battle', isPlaying: false }, held)).toEqual({
      kind: 'play',
      identifier: 'battle',
    });
  });

  it('stops the music for a table that asks for silence, and does nothing when it is already silent', () => {
    expect(tableBgmAction(TABLE_BGM_STOP, playing('explore'), held)).toEqual({ kind: 'stop' });
    expect(tableBgmAction(TABLE_BGM_STOP, silent, held)).toEqual({ kind: 'keep' });
  });

  it('leaves the music alone when the room no longer holds the track', () => {
    expect(tableBgmAction('deleted', playing('explore'), held)).toEqual({ kind: 'keep' });
  });
});
