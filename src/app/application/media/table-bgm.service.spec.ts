import { TestBed } from '@angular/core/testing';
import { TableBgmService } from '@axe/application/media/table-bgm.service';
import { AudioFile } from '@axe/core/storage/audio-file';
import { AudioStorage } from '@axe/core/storage/audio-storage';
import { ObjectStore } from '@axe/core/sync/object-store';
import { Jukebox } from '@axe/domain/media/jukebox';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TABLE_BGM_STOP } from '@axe/domain/tabletop/table-bgm';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('TableBgmService', () => {
  let service: TableBgmService;
  let jukebox: Jukebox;
  let table: GameTable;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...TEST_PROVIDERS] });
    jukebox = ObjectStore.instance.get<Jukebox>('Jukebox') ?? new Jukebox('Jukebox');
    if (!ObjectStore.instance.get('Jukebox')) jukebox.initialize();
    AudioStorage.instance.add(AudioFile.createEmpty('battle-theme'));
    table = new GameTable();
    table.initialize();
    service = TestBed.inject(TableBgmService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    table.destroy();
  });

  it("plays the table's track on the room's jukebox", () => {
    const play = vi.spyOn(jukebox, 'play').mockImplementation(() => undefined);
    table.bgm = 'battle-theme';

    expect(service.applyFor(table)).toEqual({ kind: 'play', identifier: 'battle-theme' });
    expect(play).toHaveBeenCalledWith('battle-theme', true);
  });

  it('stops the music for a table that asks for silence', () => {
    jukebox.audioIdentifier = 'battle-theme';
    jukebox.isPlaying = true;
    const stop = vi.spyOn(jukebox, 'stop').mockImplementation(() => undefined);
    table.bgm = TABLE_BGM_STOP;

    expect(service.applyFor(table)).toEqual({ kind: 'stop' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('touches nothing for a table left to keep the music', () => {
    const play = vi.spyOn(jukebox, 'play');
    const stop = vi.spyOn(jukebox, 'stop');

    expect(service.applyFor(table)).toEqual({ kind: 'keep' });
    expect(play).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
