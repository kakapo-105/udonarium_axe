import { TestBed } from '@angular/core/testing';
import { parseVoiceSay, VoiceTranscriptService } from '@axe/application/voice/voice-transcript.service';
import { diceTableMessage$, sendMessage$ } from '@axe/core/event/domain-events';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ObjectSynchronizer } from '@axe/core/sync/object-synchronizer';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { ChatTabList } from '@axe/domain/chat/chat-tab-list';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('parseVoiceSay()', () => {
  it('takes a line shaped as one', () => {
    expect(parseVoiceSay({ type: 'say', id: 'a1', name: ' アリス ', text: ' 「行くぞ」 ', tab: 'メイン' })).toEqual({
      type: 'say',
      id: 'a1',
      name: 'アリス',
      text: '「行くぞ」',
      tab: 'メイン',
    });
  });

  it('refuses anything else rather than guess', () => {
    expect(typeof parseVoiceSay(null)).toBe('string');
    expect(typeof parseVoiceSay([])).toBe('string');
    expect(typeof parseVoiceSay({ type: 'hello', id: 'a', name: 'n', text: 't' })).toBe('string');
    expect(typeof parseVoiceSay({ type: 'say', id: 'a', name: 'n', text: '   ' })).toBe('string');
    expect(typeof parseVoiceSay({ type: 'say', id: 'a', name: 'n', text: 'x'.repeat(2001) })).toBe('string');
    expect(typeof parseVoiceSay({ type: 'say', id: 'a', name: '', text: 't' })).toBe('string');
    expect(parseVoiceSay({ type: 'say', id: 'a', name: 'n', text: 't', to: 'gm' })).toBe('unknown key: to');
  });
});

describe('VoiceTranscriptService', () => {
  const store = ObjectStore.instance;
  let service: VoiceTranscriptService;
  let main: ChatTab;
  let pl: ChatTab;

  const makeTab = (name: string) => {
    const tab = new ChatTab();
    tab.name = name;
    tab.initialize();
    ChatTabList.instance.addChatTab(tab);
    return tab;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...TEST_PROVIDERS] });
    PeerCursor.createMyCursor();
    PeerCursor.myCursor.lastControlCharacterName = '主催者';
    main = makeTab('メイン');
    pl = makeTab('PL');
    service = TestBed.inject(VoiceTranscriptService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ObjectSynchronizer.instance.destroy();
    for (const obj of store.getObjects()) store.remove(obj);
    store.clearDeleteHistory();
  });

  it('posts into the tab named, under the name given, and leaves who the reader last spoke as alone', () => {
    expect(service.post({ type: 'say', id: '1', name: 'たろう', text: '(トイレ行ってきます)', tab: 'PL' })).toEqual({
      ok: true,
      warnings: [],
    });

    const [line] = pl.chatMessages;
    expect(line.name).toBe('たろう');
    expect(line.text).toBe('(トイレ行ってきます)');
    expect(main.chatMessages).toHaveLength(0);
    expect(PeerCursor.myCursor.lastControlCharacterName).toBe('主催者');
  });

  it('rolls nothing for speech that mentions dice', () => {
    const heard: unknown[] = [];
    const stopSend = sendMessage$.subscribe((e) => heard.push(e));
    const stopTable = diceTableMessage$.subscribe((e) => heard.push(e));

    service.post({ type: 'say', id: '1', name: 'たろう', text: '(2D6振りますね)', tab: 'PL' });

    stopSend();
    stopTable();
    expect(heard).toEqual([]);
    expect(pl.chatMessages[0].tag).toBe('');
  });

  it('dresses a line in the character it names, the one on the table before one put away', () => {
    const away = GameCharacter.create('アリス', 1, '');
    away.location = { name: 'common', x: 0, y: 0 };
    const standing = GameCharacter.create('アリス', 1, '');
    standing.location = { name: 'table', x: 0, y: 0 };
    standing.chatColorCode = ['#aa0000', '#000000', '#000000'];

    service.post({ type: 'say', id: '1', name: 'アリス', text: '「行くぞ」', tab: 'メイン', character: 'アリス' });

    const [line] = main.chatMessages;
    expect(line.sendFrom).toBe(standing.identifier);
    expect(line.messColor).toBe('#aa0000');
  });

  it('falls back to the first tab and the bare name, and says so', () => {
    const result = service.post({
      type: 'say',
      id: '1',
      name: 'ボブ',
      text: '「よし」',
      tab: 'ない',
      character: 'ボブ',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings).toHaveLength(2);
    expect(main.chatMessages[0].name).toBe('ボブ');
    expect(main.chatMessages[0].sendFrom).toBe('');
  });
});
