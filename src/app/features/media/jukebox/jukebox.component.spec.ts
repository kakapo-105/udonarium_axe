import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TRANSLATE_FN } from '@axe/application/i18n/translate.token';
import { PointerDeviceService } from '@axe/application/input/pointer-device.service';
import { ConfirmService } from '@axe/application/ui/confirm.service';
import { ContextMenuAction, ContextMenuService } from '@axe/application/ui/context-menu.service';
import { AudioFile } from '@axe/core/storage/audio-file';
import { AudioPlayer } from '@axe/core/storage/audio-player';
import { AudioStorage } from '@axe/core/storage/audio-storage';
import { ObjectStore } from '@axe/core/sync/object-store';
import { AudioTag } from '@axe/domain/media/audio-tag';
import { CutInLauncher } from '@axe/domain/media/cut-in-launcher';
import { Jukebox } from '@axe/domain/media/jukebox';
import { Playlist } from '@axe/domain/media/playlist';
import { JukeboxComponent } from '@axe/features/media/jukebox/jukebox.component';
import { JukeboxPlaybackService } from '@axe/features/media/jukebox-playback.service';
import { expectPanelDragRecovery, PanelDragTestHostComponent } from '@axe/testing/panel-drag-recovery';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

function makeReadyAudio(identifier: string, name?: string): AudioFile {
  const audio = AudioFile.createEmpty(identifier);
  const ctx = (audio as unknown as { context: Record<string, unknown> }).context;
  ctx['blob'] = new Blob(['x']);
  ctx['url'] = 'blob:x';
  ctx['name'] = name ?? identifier;
  return audio;
}

function ensureJukeboxAndLauncher() {
  if (!ObjectStore.instance.get<Jukebox>('Jukebox')) {
    const jukebox = new Jukebox('Jukebox');
    jukebox.initialize();
  }
  if (!ObjectStore.instance.get<CutInLauncher>('CutInLauncher')) {
    const cutInLauncher = new CutInLauncher('CutInLauncher');
    cutInLauncher.initialize();
  }
}

describe('JukeboxComponent', () => {
  let component: JukeboxComponent;
  let fixture: ComponentFixture<JukeboxComponent>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [JukeboxComponent, PanelDragTestHostComponent],
      providers: [...TEST_PROVIDERS],
    }).compileComponents();
  });

  beforeEach(() => {
    ensureJukeboxAndLauncher();
    fixture = TestBed.createComponent(JukeboxComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    AudioStorage.instance.audios.forEach((a) => AudioStorage.instance.delete(a.identifier));
    const allTags = ObjectStore.instance.getObjects(AudioTag);
    allTags.forEach((t) => ObjectStore.instance.delete(t, false));
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(component).toBeTruthy();
  });

  it('lets the panel take the pointer again once the drag ends', async () => {
    await expectPanelDragRecovery(JukeboxComponent, {
      beforeOpen: () => {
        ensureJukeboxAndLauncher();
      },
    });
  });

  describe('dragging the seek bar', () => {
    function seekBarAt(value: number): Event {
      const input = document.createElement('input');
      input.type = 'range';
      input.value = String(value);
      return { target: input } as unknown as Event;
    }

    it('holds the bar where it is dragged to while the track plays on, and seeks there once it is let go', () => {
      const playback = TestBed.inject(JukeboxPlaybackService);
      vi.spyOn(playback, 'duration').mockReturnValue(200);
      const position = vi.spyOn(playback, 'position').mockReturnValue(20);
      const seek = vi.spyOn(playback, 'seek').mockImplementation(() => undefined);

      component.onSeekInput(seekBarAt(75));
      position.mockReturnValue(40);
      expect(component.displayProgress()).toBe(0.75);

      component.onSeekCommit(seekBarAt(75));

      expect(seek).toHaveBeenCalledWith(150);
      expect(component.isSeeking()).toBe(false);
    });
  });

  describe('getTagOf / setTagOf', () => {
    it('calls an untagged track music', () => {
      const audio = makeReadyAudio('tag-test-01');
      AudioStorage.instance.add(audio);

      expect(component.getTagOf(audio)).toBe('BGM');
    });

    it('returns the tag a track carries', () => {
      const audio = makeReadyAudio('tag-test-02');
      AudioStorage.instance.add(audio);
      const tag = AudioTag.create('tag-test-02');
      tag.tag = 'SE';

      expect(component.getTagOf(audio)).toBe('SE');
    });

    it('sets a tag on a track that has none', () => {
      const audio = makeReadyAudio('tag-test-03');
      AudioStorage.instance.add(audio);

      component.setTagOf(audio, '環境音');

      const tag = AudioTag.get('tag-test-03');
      expect(tag).toBeTruthy();
      expect(tag!.tag).toBe('環境音');
    });

    it('changes the tag a track carries', () => {
      const audio = makeReadyAudio('tag-test-04');
      AudioStorage.instance.add(audio);
      AudioTag.create('tag-test-04');

      component.setTagOf(audio, 'SE');
      expect(AudioTag.get('tag-test-04')!.tag).toBe('SE');
    });
  });

  describe('playBGM / stopBGM', () => {
    it('stops the untagged cut-ins and plays the music', () => {
      const audio = makeReadyAudio('play-bgm-01');
      AudioStorage.instance.add(audio);

      const stopBlankSpy = vi
        .spyOn(ObjectStore.instance.get<CutInLauncher>('CutInLauncher')!, 'stopBlankTagCutIn')
        .mockImplementation(() => {});
      const playSpy = vi.spyOn(component.jukebox, 'play').mockImplementation(() => {});

      component.playBGM(audio);

      expect(stopBlankSpy).toHaveBeenCalledOnce();
      expect(playSpy).toHaveBeenCalledWith('play-bgm-01', true); // BGM → loop=true
    });

    it('plays a sound effect once rather than looping it', () => {
      const audio = makeReadyAudio('play-se-01');
      AudioStorage.instance.add(audio);
      const tag = AudioTag.create('play-se-01');
      tag.tag = 'SE';

      vi.spyOn(ObjectStore.instance.get<CutInLauncher>('CutInLauncher')!, 'stopBlankTagCutIn').mockImplementation(
        () => {}
      );
      const playSpy = vi.spyOn(component.jukebox, 'play').mockImplementation(() => {});

      component.playBGM(audio);

      expect(playSpy).toHaveBeenCalledWith('play-se-01', false); // SE → loop=false
    });

    it('stops the music only when it is the track that is playing', () => {
      const audio = makeReadyAudio('stop-bgm-01');
      AudioStorage.instance.add(audio);

      vi.spyOn(AudioPlayer.prototype, 'play').mockImplementation(() => {});
      vi.spyOn(AudioPlayer.prototype, 'stop').mockImplementation(() => {});

      // when the jukebox is playing that track
      component.jukebox.audioIdentifier = 'stop-bgm-01';
      const stopSpy = vi.spyOn(component.jukebox, 'stop').mockImplementation(() => {});

      component.stopBGM(audio);
      expect(stopSpy).toHaveBeenCalledOnce();
    });

    it('leaves another track playing alone', () => {
      const audio = makeReadyAudio('stop-bgm-02');
      AudioStorage.instance.add(audio);

      component.jukebox.audioIdentifier = 'other-audio'; // 異なる identifier
      const otherAudio = makeReadyAudio('other-audio');
      AudioStorage.instance.add(otherAudio);

      const stopSpy = vi.spyOn(component.jukebox, 'stop').mockImplementation(() => {});

      component.stopBGM(audio);
      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  describe('moving a track of the playlist from its menu', () => {
    let playlist: Playlist;

    beforeEach(() => {
      playlist = ObjectStore.instance.get<Playlist>('Playlist') ?? new Playlist('Playlist');
      if (!ObjectStore.instance.get<Playlist>('Playlist')) playlist.initialize();
    });

    afterEach(() => {
      playlist.entries = [];
    });

    it('moves a track beside the one shown next to it, past a hidden one in between', () => {
      const t = TestBed.inject(TRANSLATE_FN);
      for (const id of ['pl-a', 'pl-hidden', 'pl-b', 'pl-c']) AudioStorage.instance.add(makeReadyAudio(id));
      AudioStorage.instance.get('pl-hidden')!.isHidden = true;
      playlist.entries = ['pl-a', 'pl-hidden', 'pl-b', 'pl-c'];
      vi.spyOn(TestBed.inject(PointerDeviceService), 'isAllowedToOpenContextMenu', 'get').mockReturnValue(true);
      const open = vi.spyOn(TestBed.inject(ContextMenuService), 'open').mockImplementation(() => undefined);

      const event = new MouseEvent('contextmenu', { cancelable: true });
      component.onPlaylistContextMenu(event, AudioStorage.instance.get('pl-c')!);
      const actions = open.mock.calls[0][1] as ContextMenuAction[];
      actions.find((action) => action.name === t('common.reorder.up'))?.action?.();

      expect(event.defaultPrevented).toBe(true);
      expect(playlist.entries).toEqual(['pl-a', 'pl-hidden', 'pl-c', 'pl-b']);
    });
  });

  describe('stopSE / isSePlaying', () => {
    it('stops a sound effect by identifier', () => {
      const audio = makeReadyAudio('se-stop-01');
      const stopSpy = vi.spyOn(component.jukebox, 'stopSE').mockImplementation(() => {});

      component.stopSE(audio);

      expect(stopSpy).toHaveBeenCalledWith('se-stop-01');
    });

    it('reports whether an effect is playing', () => {
      const audio = makeReadyAudio('se-playing-01');
      vi.spyOn(component.jukebox, 'isSePlaying').mockReturnValue(true);

      expect(component.isSePlaying(audio)).toBe(true);
    });
  });

  describe('keeping several playlists', () => {
    let first: Playlist;

    beforeEach(() => {
      first = new Playlist(Playlist.DEFAULT_IDENTIFIER);
      first.initialize();
    });

    function openMenuOf(open: (event: MouseEvent) => void): ContextMenuAction[] {
      vi.spyOn(TestBed.inject(PointerDeviceService), 'isAllowedToOpenContextMenu', 'get').mockReturnValue(true);
      const menu = vi.spyOn(TestBed.inject(ContextMenuService), 'open').mockImplementation(() => undefined);
      open(new MouseEvent('contextmenu', { cancelable: true }));
      return (menu.mock.calls[0]?.[1] ?? []) as ContextMenuAction[];
    }

    it('makes a new playlist and shows it, so the library adds to that one', async () => {
      const t = TestBed.inject(TRANSLATE_FN);
      AudioStorage.instance.add(makeReadyAudio('lib-a'));

      component.createPlaylist();
      await fixture.whenStable();
      component.addToPlaylist(AudioStorage.instance.get('lib-a')!);

      const made = Playlist.all()[1];
      expect(component.viewedPlaylist()?.identifier).toBe(made.identifier);
      expect(made.name).toBe(t('feature.media.jukebox.playlistNewName', { number: 2 }));
      expect(made.entries).toEqual(['lib-a']);
      expect(first.entries).toEqual([]);
    });

    it('shows the playlist the room plays through until another is picked', async () => {
      const battle = Playlist.create('Battle');
      component.jukebox.playlistIdentifier = battle.identifier;
      await fixture.whenStable();
      expect(component.viewedPlaylist()?.identifier).toBe(battle.identifier);

      component.choosePlaylist(first.identifier);

      expect(component.viewedPlaylist()?.identifier).toBe(first.identifier);
    });

    it('renames the playlist shown, and an emptied name gives back its stand-in', async () => {
      const t = TestBed.inject(TRANSLATE_FN);

      component.renamePlaylist('  Town  ');
      await fixture.whenStable();
      expect(first.name).toBe('Town');
      expect(component.viewedPlaylist()?.label).toBe('Town');

      component.renamePlaylist('');
      await fixture.whenStable();
      expect(component.viewedPlaylist()?.label).toBe(t('feature.media.jukebox.playlistDefaultName'));
    });

    it('deletes the playlist shown once that is confirmed, and the room goes on through its first', async () => {
      const battle = Playlist.create('Battle');
      component.jukebox.playlistIdentifier = battle.identifier;
      component.choosePlaylist(battle.identifier);
      await fixture.whenStable();
      vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);

      await component.deletePlaylist();
      await fixture.whenStable();

      expect(Playlist.all()).toEqual([first]);
      expect(component.jukebox.playlist).toBe(first);
      expect(component.viewedPlaylist()?.identifier).toBe(first.identifier);
    });

    it('keeps the playlist when the deletion is not confirmed', async () => {
      const battle = Playlist.create('Battle');
      component.choosePlaylist(battle.identifier);
      await fixture.whenStable();
      vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(false);

      await component.deletePlaylist();

      expect(Playlist.all()).toContain(battle);
    });

    it('never deletes the room’s first playlist', async () => {
      const ask = vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);

      await component.deletePlaylist();

      expect(ask).not.toHaveBeenCalled();
      expect(Playlist.all()).toEqual([first]);
    });

    it('keeps the tag of a track on any playlist, not only the one shown', async () => {
      AudioStorage.instance.add(makeReadyAudio('held'));
      const battle = Playlist.create('Battle');
      battle.addEntry('held');
      await fixture.whenStable();

      expect(component.viewedPlaylist()?.identifier).toBe(first.identifier);
      expect(component.isOnAnyPlaylist(AudioStorage.instance.get('held')!)).toBe(true);
    });

    it('moves a track to another playlist from its menu', async () => {
      const t = TestBed.inject(TRANSLATE_FN);
      AudioStorage.instance.add(makeReadyAudio('song'));
      first.entries = ['song'];
      const battle = Playlist.create('Battle');
      await fixture.whenStable();

      const actions = openMenuOf((event) => component.onPlaylistContextMenu(event, AudioStorage.instance.get('song')!));
      const move = actions.find((action) => action.name === t('feature.media.jukebox.moveToPlaylist'));
      move?.subActions?.find((target) => target.name === 'Battle')?.action?.();

      expect(first.entries).toEqual([]);
      expect(battle.entries).toEqual(['song']);
    });

    it('copies a track to another playlist from its menu', async () => {
      const t = TestBed.inject(TRANSLATE_FN);
      AudioStorage.instance.add(makeReadyAudio('song'));
      first.entries = ['song'];
      const battle = Playlist.create('Battle');
      await fixture.whenStable();

      const actions = openMenuOf((event) => component.onPlaylistContextMenu(event, AudioStorage.instance.get('song')!));
      const copy = actions.find((action) => action.name === t('feature.media.jukebox.copyToPlaylist'));
      copy?.subActions?.find((target) => target.name === 'Battle')?.action?.();

      expect(first.entries).toEqual(['song']);
      expect(battle.entries).toEqual(['song']);
    });

    it('puts a library track on a playlist from its menu, and takes it off again', async () => {
      AudioStorage.instance.add(makeReadyAudio('song'));
      const battle = Playlist.create('Battle');
      await fixture.whenStable();
      const pick = () =>
        openMenuOf((event) =>
          component.onLibraryContextMenu(event, AudioStorage.instance.get('song')!)
        )[0]?.subActions?.find((target) => target.name.endsWith('Battle'));

      pick()?.action?.();
      expect(battle.entries).toEqual(['song']);

      vi.restoreAllMocks();
      expect(pick()?.name).toBe('☑Battle');
      pick()?.action?.();
      expect(battle.entries).toEqual([]);
    });

    it('offers no playlist for a sound effect', () => {
      AudioStorage.instance.add(makeReadyAudio('se'));
      AudioTag.create('se').tag = 'SE';

      const actions = openMenuOf((event) => component.onLibraryContextMenu(event, AudioStorage.instance.get('se')!));

      expect(actions).toEqual([]);
    });

    it('plays a track of the playlist shown and goes on through that playlist', async () => {
      AudioStorage.instance.add(makeReadyAudio('song'));
      const battle = Playlist.create('Battle');
      battle.addEntry('song');
      component.choosePlaylist(battle.identifier);
      await fixture.whenStable();
      vi.spyOn(AudioPlayer.prototype, 'play').mockImplementation(() => {});

      component.playFromPlaylist(AudioStorage.instance.get('song')!);

      expect(component.jukebox.playlistIdentifier).toBe(battle.identifier);
      expect(component.jukebox.audioIdentifier).toBe('song');
    });
  });
});
