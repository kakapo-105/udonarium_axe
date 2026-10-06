import { TestBed } from '@angular/core/testing';
import { AutomationCommand, AutomationResult } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { LocalModePreferenceService } from '@axe/application/ui/local-mode-preference.service';
import { Network } from '@axe/core/network/network';
import { localDispatch } from '@axe/core/network/network-messaging';
import { calcSHA256Async } from '@axe/core/storage/file-reader-util';
import { ImageStorage } from '@axe/core/storage/image-storage';
import { ObjectContext } from '@axe/core/sync/game-object';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ObjectSynchronizer } from '@axe/core/sync/object-synchronizer';
import { waitZeroTimeout } from '@axe/core/util/zero-timeout';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatMessage } from '@axe/domain/chat/chat-message';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { ChatTabList } from '@axe/domain/chat/chat-tab-list';
import { DataElement } from '@axe/domain/data/data-element';
import { DiceBot } from '@axe/domain/dice/dice-bot';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { Terrain } from '@axe/domain/tabletop/terrain';
import { TextNote } from '@axe/domain/tabletop/text-note';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('AutomationFacadeService', () => {
  let facade: AutomationFacadeService;
  let policy: AutomationPolicyService;
  let piece: GameCharacter;
  let tab: ChatTab;
  let table: GameTable;
  const store = ObjectStore.instance;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...TEST_PROVIDERS] });
    TestBed.inject(LocalModePreferenceService).enabled.set(true);
    Config.instance.initialize();
    table = new GameTable();
    table.width = 20;
    table.height = 20;
    table.gridSize = 50;
    table.initialize();
    PeerCursor.createMyCursor();
    PeerCursor.myCursor.userId = 'operator';
    PeerCursor.myCursor.role = 'pl';
    piece = GameCharacter.create('Piece', 1, '');
    piece.owner = 'operator';
    piece.location = { name: 'table', x: 50, y: 50 };
    tab = new ChatTab();
    tab.name = 'Public';
    tab.initialize();
    ChatTabList.instance.addChatTab(tab);
    if (!store.get('DiceBot')) new DiceBot('DiceBot').initialize();
    facade = TestBed.inject(AutomationFacadeService);
    policy = TestBed.inject(AutomationPolicyService);
    facade.health();
    policy.enable();
    policy.setScope('move_piece', true);
    policy.setScope('send_chat', true);
    vi.spyOn(DiceBot, 'loadGameSystemAsync').mockResolvedValue(null as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    ObjectSynchronizer.instance.destroy();
    for (const obj of store.getObjects()) store.remove(obj);
    store.clearDeleteHistory();
  });
  function call(
    command: AutomationCommand,
    args: Record<string, unknown> = {},
    requestId: string = crypto.randomUUID()
  ) {
    return facade.invoke({ sessionId: policy.sessionId(), requestId, command, arguments: args });
  }
  function move(args: Record<string, unknown> = {}, id?: string) {
    return call('piece_move', { identifier: piece.identifier, x: 3, y: 2, ...args }, id);
  }
  function error(result: AutomationResult, code: string) {
    expect(result).toMatchObject({ ok: false, error: { code } });
  }

  it('moves once through sync updates and accepts an identical retry', async () => {
    const version = piece.version;
    const first = await move({ expectedVersion: version }, 'retry');
    expect(first.ok).toBe(true);
    expect(piece.location).toMatchObject({ x: 150, y: 100 });
    const movedVersion = piece.version;
    expect(await move({ expectedVersion: version }, 'retry')).toEqual(first);
    expect(piece.version).toBe(movedVersion);
    error(await move({ x: 4 }, 'retry'), 'CONFLICT');
  });
  it('checks a dry run without changing the piece or consuming a later request', async () => {
    const version = piece.version;
    expect((await move({ dryRun: true })).ok).toBe(true);
    expect(piece.version).toBe(version);
    expect((await move()).ok).toBe(true);
  });

  it('does not expose mutable scope grants through the browser result', async () => {
    policy.setScope('move_piece', false);
    const result = await call('session_get');
    const data = (result as { data: { scopes: string[] } }).data;
    data.scopes.push('move_piece');
    error(await move(), 'FORBIDDEN');
  });
  it.each([NaN, Infinity, -1, 9999999, '3', null])('rejects invalid coordinates %s', async (x) => {
    error(await move({ x }), 'INVALID_ARGUMENT');
    expect(piece.location.x).toBe(50);
  });
  it('rejects an oversized footprint, unknown options and wall placements', async () => {
    piece.size = 3;
    error(await move({ x: 19 }), 'INVALID_ARGUMENT');
    error(await move({ arbitrary: true }), 'INVALID_ARGUMENT');
    piece.location = { ...piece.location, surface: 'north-wall' };
    error(await move(), 'FORBIDDEN');
  });
  it('rejects locked pieces, guests, missing scopes and stale versions', async () => {
    piece.isLock = true;
    error(await move(), 'LOCKED');
    piece.isLock = false;
    error(await move({ expectedVersion: 0 }), 'CONFLICT');
    policy.setScope('move_piece', false);
    error(await move(), 'FORBIDDEN');
    PeerCursor.myCursor.role = 'guest';
    facade.health();
    policy.enable();
    policy.setScope('move_piece', true);
    error(await move(), 'FORBIDDEN');
  });
  it('uses the shared ownership rule even for a GM and defaults to owned pieces', async () => {
    piece.owner = 'another';
    error(await move(), 'FORBIDDEN');
    Config.instance.automationOwnedOnly = false;
    expect((await move()).ok).toBe(true);
  });
  it('hides undisclosed and fog-hidden pieces, including from name searches', async () => {
    piece.owner = '';
    piece.disclosureMode = 'gm';
    expect(await call('scene_list')).toMatchObject({ ok: true, data: { objects: [] } });
    error(await call('object_get', { identifier: piece.identifier }), 'NOT_FOUND');
    piece.disclosureMode = 'all';
    vi.spyOn(TestBed.inject(VisionService), 'isTokenVisible').mockReturnValue(false);
    expect(await call('scene_list', { name: 'Piece' })).toMatchObject({ ok: true, data: { objects: [] } });
  });
  it('does not disclose hidden names or reuse old read results after visibility changes', async () => {
    piece.hideName = true;
    expect(await call('object_get', { identifier: piece.identifier }, 'read')).toMatchObject({
      ok: true,
      data: { name: '' },
    });
    piece.owner = '';
    piece.disclosureMode = 'gm';
    error(await call('object_get', { identifier: piece.identifier }, 'read'), 'NOT_FOUND');
  });
  it('pages duplicate names using identifiers', async () => {
    const second = GameCharacter.create('Piece', 1, '');
    const result = await call('scene_list', { limit: 1 });
    expect(result.ok).toBe(true);
    const data = (result as { data: { objects: { identifier: string }[]; next: string } }).data;
    expect(data.objects).toHaveLength(1);
    const next = await call('scene_list', { after: data.next, limit: 1 });
    expect(next.ok).toBe(true);
    expect(JSON.stringify(next)).toContain(
      data.objects[0].identifier === piece.identifier ? second.identifier : piece.identifier
    );
  });
  it('excludes secret and direct messages, and refuses unreadable tabs', async () => {
    tab.addMessage({ name: 'Public', text: 'hello' });
    tab.addMessage({ name: 'Secret', text: 'secret value', tag: 'secret' });
    tab.addMessage({ name: 'Whisper', text: 'whisper value', to: 'operator', from: 'operator' });
    const read = await call('chat_read_recent', { tabId: tab.identifier });
    expect(JSON.stringify(read)).toContain('hello');
    expect(JSON.stringify(read)).not.toContain('secret value');
    expect(JSON.stringify(read)).not.toContain('whisper value');
    tab.plCanView = false;
    error(await call('chat_read_recent', { tabId: tab.identifier }), 'NOT_FOUND');
    error(await call('chat_send', { tabId: tab.identifier, text: 'hello' }), 'NOT_FOUND');
  });
  it('respects tab speaking permissions and prevents command scope escalation', async () => {
    tab.plCanSpeak = false;
    error(await call('chat_send', { tabId: tab.identifier, text: 'hello' }), 'FORBIDDEN');
    tab.plCanSpeak = true;
    for (const text of [':HP-5', 't:HP-5', 'ｓｔ：HP-5', '{秘密}', '《damage》', '&buff+1']) {
      error(await call('chat_send', { tabId: tab.identifier, characterId: piece.identifier, text }), 'FORBIDDEN');
    }
    policy.setScope('edit_resource', true);
    expect((await call('chat_send', { tabId: tab.identifier, characterId: piece.identifier, text: ':HP-5' })).ok).toBe(
      true
    );
  });
  it('lets a resource amount roll dice and branch with if() and $n, but never reach a reference', async () => {
    policy.setScope('edit_resource', true);
    const send = (text: string) => call('chat_send', { tabId: tab.identifier, characterId: piece.identifier, text });
    for (const text of [':HP-2d6', ':HP-[k10]+3', ':HP-if([2d6]>=10,5,0)', ':MP-if([2d6]>=12,10,if($1>=7,5,0))L']) {
      expect((await send(text)).ok, text).toBe(true);
    }
    for (const text of [':HP-if({HP}<=5,3,0)', ':HP-[{秘密}]', ':HP-5 :MP-1', ':HP-if(1, 2, 3)', ':HP=5']) {
      error(await send(text), 'FORBIDDEN');
    }
  });
  it('cancels a delayed chat when its grant is withdrawn before sending', async () => {
    let release!: () => void;
    vi.mocked(DiceBot.loadGameSystemAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null as never);
        })
    );
    const send = vi.spyOn(TestBed.inject(ChatMessageService), 'sendMessage');
    const pending = call('chat_send', { tabId: tab.identifier, text: 'hello' });
    policy.setScope('send_chat', false);
    release();
    error(await pending, 'FORBIDDEN');
    expect(send).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent chat sends and refuses overlapping writes', async () => {
    let release!: () => void;
    vi.mocked(DiceBot.loadGameSystemAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null as never);
        })
    );
    const args = { tabId: tab.identifier, text: 'hello' };
    const first = call('chat_send', args, 'send');
    const again = call('chat_send', args, 'send');
    error(await move(), 'CONFLICT');
    release();
    expect(await first).toEqual(await again);
    expect(tab.chatMessages.filter((m) => m.text === 'hello')).toHaveLength(1);
  });
  it('expires pending work without permitting late writes or automatic retries', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    vi.mocked(DiceBot.loadGameSystemAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null as never);
        })
    );
    const send = vi.spyOn(TestBed.inject(ChatMessageService), 'sendMessage');
    const args = { tabId: tab.identifier, text: 'late' };
    const pending = call('chat_send', args, 'timeout');
    await vi.advanceTimersByTimeAsync(15001);
    error(await pending, 'TIMEOUT');
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    error(await call('chat_send', args, 'timeout'), 'TIMEOUT');
  });
  it('invalidates old requests on stop and on a role change', async () => {
    const sessionId = policy.sessionId();
    policy.stop();
    policy.enable();
    error(await facade.invoke({ sessionId, requestId: 'old', command: 'session_get', arguments: {} }), 'NOT_READY');
    PeerCursor.myCursor.role = 'gm';
    expect(facade.health().ready).toBe(false);
    expect(policy.enabled()).toBe(false);
  });
  it('refuses use before joining unless explicitly offline', async () => {
    TestBed.inject(LocalModePreferenceService).enabled.set(false);
    facade.health();
    policy.enable();
    error(await call('session_get'), 'NOT_READY');
  });
  it('walks around walls under strict rules and never teleports through an unreachable wall', async () => {
    Config.instance.moveStrict = true;
    DataElement.findElementByReference(piece.rootDataElement!, '移動')!.value = 5;
    // Taller than one cell, so the piece cannot simply step up onto it and walk across the top.
    const wall = Terrain.create('Wall', 1, 20, 3, '', '');
    wall.location = { name: 'table', x: 100, y: 0 };
    table.appendChild(wall);
    error(await move(), 'FORBIDDEN');
    expect(piece.location.x).toBe(50);
    wall.destroy();
    expect((await move()).ok).toBe(true);
    expect(piece.location).toMatchObject({ x: 150, y: 100 });
  });
  it('moves a piece standing up on terrain only by a strict walk, which works out the ground', async () => {
    // A block one cell high to stand on; with nothing under it, gravity would drop the piece to the floor.
    const block = Terrain.create('Block', 1, 1, 1, '', '');
    block.location = { name: 'table', x: 50, y: 50 };
    table.appendChild(block);
    piece.posZ = 50;
    // Config outlives each test, so a strict rule left on by another one is switched off here.
    Config.instance.moveStrict = false;
    error(await move(), 'FORBIDDEN');
    expect(piece.location.x).toBe(50);
    Config.instance.moveStrict = true;
    DataElement.findElementByReference(piece.rootDataElement!, '移動')!.value = 5;
    expect((await move()).ok).toBe(true);
    expect(piece.location).toMatchObject({ x: 150, y: 100 });
  });
  it('stops a strict walk after permission revocation, keeping the last reached cell', async () => {
    Config.instance.moveStrict = true;
    DataElement.findElementByReference(piece.rootDataElement!, '移動')!.value = 10;
    const pending = move({ x: 6, y: 1 });
    policy.stop();
    error(await pending, 'NOT_READY');
    expect(piece.location.x).toBeLessThan(300);
  });

  it('spike: replays emitted movement and chat through the receiving sync engine', async () => {
    const packets: { eventName: string; data: ObjectContext }[] = [];
    await waitZeroTimeout();
    const send = vi.spyOn(Network.instance, 'send').mockImplementation((packet) => {
      // Network queues the context by reference until the current turn finishes, allowing
      // ObjectStore to coalesce a newly created message with its subsequent parent link.
      packets.push(packet as { eventName: string; data: ObjectContext });
    });
    const originals = store.getObjects().map((o) => JSON.parse(JSON.stringify(o.toContext())) as ObjectContext);
    expect((await move()).ok).toBe(true);
    expect((await call('chat_send', { tabId: tab.identifier, text: 'sync spike' })).ok).toBe(true);
    await waitZeroTimeout();
    const delivered = JSON.parse(JSON.stringify(packets)) as typeof packets;
    expect(packets.some((p) => p.eventName === 'UPDATE_GAME_OBJECT' && p.data.identifier === piece.identifier)).toBe(
      true
    );
    const pieceId = piece.identifier;
    const tabId = tab.identifier;
    send.mockImplementation(() => {});
    for (const object of store.getObjects()) store.remove(object);
    ObjectSynchronizer.instance.initialize();
    for (const context of originals) localDispatch('UPDATE_GAME_OBJECT', context, 'sender-peer');
    for (const packet of delivered) localDispatch(packet.eventName, packet.data, 'sender-peer');
    expect(store.get<GameCharacter>(pieceId)?.location).toMatchObject({ x: 150, y: 100 });
    expect(store.get<ChatTab>(tabId)?.chatMessages.some((m) => m.text === 'sync spike')).toBe(true);
    expect(store.getObjects<ChatMessage>(ChatMessage).filter((m) => m.text === 'sync spike')).toHaveLength(1);
  });
  describe('the palette', () => {
    let enemy: GameCharacter;
    beforeEach(() => {
      DataElement.findElementByReference(piece.rootDataElement!, '移動')!.value = 5;
      piece.chatPalette!.setPalette('◆攻撃\n2d6+{移動} 攻撃\n//威力=3\nt:HP-{威力}');
      enemy = GameCharacter.create('Enemy', 1, '');
      enemy.location = { name: 'table', x: 300, y: 300 };
    });
    function say(args: Record<string, unknown>) {
      return call('palette_send', { characterId: piece.identifier, tabId: tab.identifier, ...args });
    }
    function said(): string[] {
      return tab.chatMessages.map((m) => m.text);
    }

    it('reads every line with its index and kind, headings and variables included', async () => {
      const result = await call('palette_get', { identifier: piece.identifier });

      expect(result).toMatchObject({
        ok: true,
        data: {
          lines: [
            { lineIndex: 0, kind: 'heading', heading: '攻撃', level: 1 },
            { lineIndex: 1, kind: 'command', text: '2d6+{移動} 攻撃' },
            { lineIndex: 2, kind: 'variable', text: '//威力=3' },
            { lineIndex: 3, kind: 'command', text: 't:HP-{威力}' },
          ],
          untrustedContent: true,
        },
      });
    });

    it('needs its own grant before a line is said', async () => {
      error(await say({ lineIndex: 1 }), 'FORBIDDEN');
      expect(said()).toEqual([]);
    });

    it('says a line as the piece with its references filled in, as clicking it would', async () => {
      policy.setScope('use_palette', true);

      const result = await say({ lineIndex: 1 });

      expect(result).toMatchObject({ ok: true, data: { text: '2d6+5 攻撃' } });
      expect(said()).toEqual(['2d6+5 攻撃']);
      expect(tab.chatMessages[0].name).toBe('Piece');
    });

    it('aims a t: line at the targets named', async () => {
      policy.setScope('use_palette', true);

      expect((await say({ lineIndex: 3, targetIds: [enemy.identifier] })).ok).toBe(true);

      expect(said()).toEqual(['t:HP-3 [Enemy]']);
    });

    it('says only command lines, and refuses a line edited since it was read', async () => {
      policy.setScope('use_palette', true);

      error(await say({ lineIndex: 0 }), 'NOT_FOUND');
      error(await say({ lineIndex: 2 }), 'NOT_FOUND');
      error(await say({ lineIndex: 99 }), 'NOT_FOUND');
      error(await say({ lineIndex: 1, expectedText: '2d6 攻撃' }), 'CONFLICT');
      expect(said()).toEqual([]);
    });

    it('checks a line without saying it on a dry run', async () => {
      policy.setScope('use_palette', true);

      expect(await say({ lineIndex: 1, dryRun: true })).toMatchObject({ ok: true, data: { dryRun: true } });
      expect(said()).toEqual([]);
    });

    it('speaks only for a piece the operator may control', async () => {
      policy.setScope('use_palette', true);
      // Config outlives each test, so the room's limit is set here rather than taken as left.
      Config.instance.automationOwnedOnly = true;
      piece.owner = 'someone-else';

      error(await say({ lineIndex: 1 }), 'FORBIDDEN');
    });
  });

  it('reads a sheet field by field, resources with what is left', async () => {
    const hp = DataElement.findElementByReference(piece.rootDataElement!, 'HP')!;
    hp.value = 20;
    hp.currentValue = 12;

    const result = await call('character_sheet_get', { identifier: piece.identifier });

    expect(result.ok).toBe(true);
    const fields = (result as { data: { fields: { path: string; value: string; current?: string }[] } }).data.fields;
    expect(fields.find((f) => f.path.endsWith('/HP'))).toMatchObject({ value: '20', current: '12' });
  });

  describe('buffs', () => {
    function run(commands: unknown, extra: Record<string, unknown> = {}) {
      return call('buff_send', { characterId: piece.identifier, tabId: tab.identifier, commands, ...extra });
    }

    it('reads the buffs on one piece as plain data', async () => {
      piece.buffs.addRound('猛攻撃', '攻撃+2', 3);

      const result = await call('buff_list', { identifier: piece.identifier });

      expect(result).toMatchObject({
        ok: true,
        data: { identifier: piece.identifier, buffs: [{ name: '猛攻撃', value: 3, info: '攻撃+2' }] },
      });
    });

    it('lists every visible piece carrying a buff when no piece is named', async () => {
      const bare = GameCharacter.create('Bare', 1, '');
      bare.location = { name: 'table', x: 300, y: 300 };
      piece.buffs.addRound('毒', '', 2);

      const result = await call('buff_list');

      expect(result).toMatchObject({ ok: true, data: { pieces: [{ identifier: piece.identifier }] } });
      expect((result as { data: { pieces: unknown[] } }).data.pieces).toHaveLength(1);
    });

    it('needs its own grant before a buff command is run', async () => {
      error(await run(['&猛攻撃']), 'FORBIDDEN');
      expect(tab.chatMessages).toHaveLength(0);
    });

    it('says the buff commands as the piece and carries them out, as typing them into chat would', async () => {
      policy.setScope('edit_buff', true);

      expect(await run(['&猛攻撃/攻撃+2/3'])).toMatchObject({ ok: true, data: { text: '&猛攻撃/攻撃+2/3' } });

      expect(tab.chatMessages[0]).toMatchObject({ name: 'Piece', text: '&猛攻撃/攻撃+2/3' });
      await vi.waitFor(() => expect(piece.buffs.snapshot()).toMatchObject([{ name: '猛攻撃', value: 3 }]));
    });

    it('aims a t& command at the targets named', async () => {
      policy.setScope('edit_buff', true);
      const enemy = GameCharacter.create('Enemy', 1, '');
      enemy.location = { name: 'table', x: 300, y: 300 };

      expect((await run(['t&毒/継続2/3'], { targetIds: [enemy.identifier] })).ok).toBe(true);

      expect(tab.chatMessages[0].text).toBe('t&毒/継続2/3 [Enemy]');
      await vi.waitFor(() => expect(enemy.buffs.snapshot()).toMatchObject([{ name: '毒', value: 3 }]));
      expect(piece.buffs.snapshot()).toEqual([]);
    });

    it('refuses anything that is not a buff command, so nothing else reaches the room', async () => {
      policy.setScope('edit_buff', true);

      for (const commands of [['hello'], [':HP-5'], ['&猛攻撃 hello'], [], 'not a list']) {
        error(await run(commands), 'INVALID_ARGUMENT');
      }
      expect(tab.chatMessages).toHaveLength(0);
    });
  });

  describe('buffs across the table', () => {
    let other: GameCharacter;
    beforeEach(() => {
      // Config outlives each test, so the room's limit is set here rather than taken as left.
      Config.instance.automationOwnedOnly = true;
      other = GameCharacter.create('Other', 1, '');
      other.owner = 'someone-else';
      other.location = { name: 'table', x: 300, y: 300 };
      other.buffs.addRound('毒', '継続2', 3);
    });
    function buffId(piece: GameCharacter, index = 0): string {
      return (piece.buffDataElement!.children[0].children[index] as DataElement).identifier;
    }
    function edit(args: Record<string, unknown>) {
      return call('buff_edit', { identifier: buffId(other), ...args });
    }
    /** A change of role withdraws every grant by design, so the operator enables them again. */
    function becomeRole(role: PeerRole) {
      PeerCursor.myCursor.role = role;
      facade.health();
      policy.enable();
      policy.setScope('edit_buff', true);
    }

    it('gives each buff the identifier an edit takes it by', async () => {
      const result = await call('buff_list', { identifier: other.identifier });

      expect(result).toMatchObject({
        ok: true,
        data: { buffs: [{ identifier: buffId(other), name: '毒', value: 3 }] },
      });
    });

    it('edits a buff on a piece somebody else owns, as the buff manager lets anyone do', async () => {
      policy.setScope('edit_buff', true);

      const result = await edit({ name: ' 猛毒 ', info: '継続3', rounds: 1.6, timing: 'turnStart', trigger: 'Other' });

      expect(result).toMatchObject({ ok: true, data: { name: '猛毒', info: '継続3', value: 2 } });
      expect(other.buffs.snapshot()[0].appearance).toMatchObject({ timing: 'turnStart', trigger: 'Other' });
    });

    it('drops the trigger when the buff goes back to counting down at the end of the round', async () => {
      policy.setScope('edit_buff', true);
      await edit({ timing: 'turnStart', trigger: 'Other' });

      await edit({ timing: 'roundEnd' });

      expect(other.buffs.snapshot()[0].appearance.trigger).toBeFalsy();
    });

    it('takes a buff off', async () => {
      policy.setScope('edit_buff', true);

      expect(await edit({ remove: true })).toMatchObject({ ok: true, data: { removed: true } });
      expect(other.buffs.snapshot()).toEqual([]);
    });

    it('needs its grant, refuses guests, and finds nothing that is not a buff', async () => {
      error(await edit({ rounds: 1 }), 'FORBIDDEN');
      policy.setScope('edit_buff', true);
      error(await call('buff_edit', { identifier: other.identifier, rounds: 1 }), 'NOT_FOUND');
      error(await edit({}), 'INVALID_ARGUMENT');
      error(await edit({ timing: 'sometime' }), 'INVALID_ARGUMENT');
      becomeRole(PeerRole.Guest);
      error(await edit({ rounds: 1 }), 'FORBIDDEN');
      expect(other.buffs.snapshot()[0].value).toBe(3);
    });

    it('sweeps the table only for the game master, counting first on a dry run', async () => {
      policy.setScope('edit_buff', true);
      piece.buffs.addRound('毒', '', 2);
      error(await call('buff_sweep', { kind: 'name', name: '毒' }), 'FORBIDDEN');

      becomeRole(PeerRole.GameMaster);
      expect(await call('buff_sweep', { kind: 'name', name: '毒', dryRun: true })).toMatchObject({
        ok: true,
        data: { characters: 2, buffs: 2, dryRun: true },
      });
      expect(other.buffs.snapshot()).toHaveLength(1);

      expect(await call('buff_sweep', { kind: 'name', name: '毒' })).toMatchObject({
        ok: true,
        data: { characters: 2, buffs: 2 },
      });
      expect([...piece.buffs.snapshot(), ...other.buffs.snapshot()]).toEqual([]);
      expect(tab.chatMessages.at(-1)?.text).toContain('（2体・2件）');
    });
  });

  it('reads only the sheet fields asked for, whole sections included', async () => {
    const read = async (paths: string[]) =>
      (
        (await call('character_sheet_get', { identifier: piece.identifier, paths })) as {
          data: { fields: { path: string }[] };
        }
      ).data.fields.map((f) => f.path);

    expect(await read(['リソース/基本/HP'])).toEqual(['リソース/基本/HP']);
    expect(await read(['リソース'])).toEqual(expect.arrayContaining(['リソース/基本/HP', 'リソース/基本/MP']));
    expect(await read(['リソース/基'])).toEqual([]);
    error(await call('character_sheet_get', { identifier: piece.identifier, paths: [] }), 'INVALID_ARGUMENT');
  });

  describe('waiting for chat', () => {
    let at = 1000;
    function say(text: string, from = 'player') {
      return tab.addMessage({ name: 'Player', text, from, timestamp: at++ });
    }
    async function wait(args: Record<string, unknown> = {}) {
      const pending = call('chat_wait', { waitSeconds: 2, ...args });
      await vi.advanceTimersByTimeAsync(2500);
      return (await pending) as { ok: true; data: { messages: { text: string }[]; timedOut: boolean; more: boolean } };
    }
    beforeEach(() => vi.useFakeTimers());

    it('hands over what arrives after the first wait began, each message once', async () => {
      say('before');
      expect((await wait()).data).toMatchObject({ messages: [], timedOut: true });

      const pending = call('chat_wait', { waitSeconds: 10 });
      await vi.advanceTimersByTimeAsync(1000);
      say('first');
      say('second');
      await vi.advanceTimersByTimeAsync(1000);

      expect((await pending) as unknown).toMatchObject({
        ok: true,
        data: { messages: [{ text: 'first' }, { text: 'second' }], timedOut: false },
      });
      expect((await wait()).data.timedOut).toBe(true);
    });

    it('hands over at most the limit, keeping the rest for the next wait', async () => {
      await wait();
      say('one');
      say('two');
      expect((await wait({ limit: 1 })).data).toMatchObject({ messages: [{ text: 'one' }], more: true });
      expect((await wait()).data.messages).toMatchObject([{ text: 'two' }]);
    });

    it('leaves out secret rolls and what automation said, but not a person at the same browser', async () => {
      await wait();
      tab.addMessage({ name: 'Secret', text: 'secret value', tag: 'secret', timestamp: at++ });
      const sent = call('chat_send', { tabId: tab.identifier, text: 'said by automation' });
      await vi.advanceTimersByTimeAsync(100);
      expect((await sent).ok).toBe(true);
      expect((await wait()).data.messages).toEqual([]);

      say('typed by hand', Network.peerContext.userId);
      expect((await wait()).data.messages).toMatchObject([{ text: 'typed by hand' }]);
    });

    it('waits only on the tabs named, and refuses tabs it cannot read', async () => {
      const other = new ChatTab();
      other.name = 'Chatter';
      other.initialize();
      ChatTabList.instance.addChatTab(other);
      await wait();
      other.addMessage({ name: 'Player', text: 'off topic', from: 'player', timestamp: at++ });
      expect((await wait({ tabIds: [tab.identifier] })).data.timedOut).toBe(true);
      other.plCanView = false;
      error(await call('chat_wait', { tabIds: [other.identifier] }), 'NOT_FOUND');
    });

    it('bounds the wait and forgets what it handed over when the session starts again', async () => {
      error(await call('chat_wait', { waitSeconds: 301 }), 'INVALID_ARGUMENT');
      error(await call('chat_wait', { waitSeconds: 0.5 }), 'INVALID_ARGUMENT');
      await wait();
      say('during the old session');
      policy.enable();
      expect((await wait()).data.timedOut).toBe(true);
    });

    it('ends the wait when automation is stopped', async () => {
      const pending = call('chat_wait', { waitSeconds: 10 });
      await vi.advanceTimersByTimeAsync(500);
      policy.stop();
      await vi.advanceTimersByTimeAsync(1000);
      error(await pending, 'NOT_READY');
    });
  });

  describe('pieces made by automation', () => {
    const goblin = (name = 'ゴブリン') => ({
      kind: 'character',
      data: {
        name,
        status: [{ label: 'HP', value: '16', max: '16' }],
        params: [{ label: 'LV', value: '1' }],
        commands: '2d+3【命中力／武器】',
      },
    });
    function grant() {
      policy.setScope('create_piece', true);
    }
    function created(result: AutomationResult) {
      expect(result).toMatchObject({ ok: true });
      return (result as { data: { pieces: { identifier: string; name: string; x: number; y: number }[] } }).data.pieces;
    }

    it('puts pieces from sheets in a row from the cell asked for, owned by the operator', async () => {
      grant();
      const pieces = created(
        await call('character_create', { pieces: [goblin('ゴブリンA'), goblin('ゴブリンB')], x: 2, y: 3 })
      );

      expect(pieces).toMatchObject([
        { name: 'ゴブリンA', x: 100, y: 150 },
        { name: 'ゴブリンB', x: 150, y: 150 },
      ]);
      const made = store.get<GameCharacter>(pieces[0].identifier)!;
      expect(made.owner).toBe('operator');
      expect(made.location.name).toBe('table');
      expect(made.disclosureMode).toBe('all');
    });

    describe('from this tool’s own XML', () => {
      // happy-dom cannot read dotted attribute names such as location.name, which browsers read; the
      // end-to-end test reads a piece with them.
      const xml = (name: string, image = '') => `<character disclosureMode="all" owner="someone">
  <data name="character">
    <data name="image"><data type="image" name="imageIdentifier">${image}</data></data>
    <data name="common"><data name="name">${name}</data><data name="size">2</data><data name="altitude">0</data></data>
    <data name="detail">
      <data role="section" name="パラメータ"><data role="group" name="基本">
        <data fieldType="number" role="field" name="命中力修正">1</data>
        <data fieldType="calc" role="field" name="命中力固定値" formula="10+命中力修正">10</data>
      </data></data>
    </data>
  </data>
  <chat-palette dicebot="SwordWorld2.5">2d6+3 【命中力判定】</chat-palette>
</character>`;

      it('builds a piece as a dropped file would, owned by the operator and placed as asked', async () => {
        grant();
        const [made] = created(
          await call('character_create', { pieces: [xml('トロール')], x: 2, y: 3, disclosure: 'gm', concealed: false })
        );

        const piece = store.get<GameCharacter>(made.identifier)!;
        expect(made).toMatchObject({ name: 'トロール', x: 100, y: 150, size: 2 });
        expect(piece.owner).toBe('operator');
        expect(piece.disclosureMode).toBe('gm');
        expect(piece.chatPalette?.dicebot).toBe('SwordWorld2.5');
        const sheet = await call('character_sheet_get', { identifier: made.identifier, paths: ['パラメータ'] });
        expect(JSON.stringify(sheet)).toContain('"path":"パラメータ/基本/命中力固定値","type":"calc","value":"11"');
      });

      it('takes only a piece, never room data or a chat tab', async () => {
        grant();
        const before = store.getObjects(GameCharacter).length;
        for (const sheet of ['<chat-tab name="x"></chat-tab>', '<room></room>', 'not xml at all']) {
          error(await call('character_create', { pieces: [xml('ゴブリン'), sheet], x: 0, y: 0 }), 'INVALID_ARGUMENT');
        }
        expect(store.getObjects(GameCharacter)).toHaveLength(before);
      });

      it('adds the picture a piece wears under the identifier it names, after checking the bytes', async () => {
        grant();
        const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
        const identifier = await calcSHA256Async(bytes.buffer);
        const data = btoa(String.fromCharCode(...bytes));
        // A test DOM cannot decode a picture to make its thumbnail, so the storage itself is left out.
        const added = vi.spyOn(ImageStorage.instance, 'addAsync').mockResolvedValue(null as never);

        error(
          await call('character_create', {
            pieces: [xml('ゴブリン', identifier)],
            x: 0,
            y: 0,
            images: [{ identifier: 'f'.repeat(64), type: 'image/webp', data }],
          }),
          'INVALID_ARGUMENT'
        );
        expect(added).not.toHaveBeenCalled();

        const [made] = created(
          await call('character_create', {
            pieces: [xml('ゴブリン', identifier)],
            x: 0,
            y: 0,
            images: [{ identifier, type: 'image/webp', data }],
          })
        );
        expect(added).toHaveBeenCalledTimes(1);
        expect((added.mock.calls[0][0] as File).name).toBe(`${identifier}.webp`);
        const worn = store
          .get<GameCharacter>(made.identifier)!
          .imageDataElement?.getFirstElementByName('imageIdentifier');
        expect(worn?.value).toBe(identifier);
      });
    });

    it('gives the pieces the dice bot asked for, which a sheet from another tool does not name', async () => {
      grant();
      const [made] = created(
        await call('character_create', { pieces: [goblin()], x: 0, y: 0, dicebot: 'SwordWorld2.5' })
      );
      expect(store.get<GameCharacter>(made.identifier)!.chatPalette?.dicebot).toBe('SwordWorld2.5');
    });

    it('keeps what a piece says about itself to the game master by default when run by one', async () => {
      PeerCursor.myCursor.role = PeerRole.GameMaster;
      facade.health();
      policy.enable();
      grant();
      const [piece] = created(await call('character_create', { pieces: [goblin()], x: 0, y: 0 }));
      expect(store.get<GameCharacter>(piece.identifier)!.disclosureMode).toBe('gm');

      expect(await call('piece_disclose', { identifier: piece.identifier, disclosure: 'all' })).toMatchObject({
        ok: true,
        data: { disclosure: 'all' },
      });
      expect(store.get<GameCharacter>(piece.identifier)!.disclosureMode).toBe('all');
    });

    it('builds nothing when a sheet cannot be read, the row runs off the table, or on a dry run', async () => {
      grant();
      const before = store.getObjects(GameCharacter).length;
      error(await call('character_create', { pieces: [goblin(), { nonsense: true }], x: 0, y: 0 }), 'INVALID_ARGUMENT');
      error(await call('character_create', { pieces: [goblin(), goblin()], x: 19, y: 0 }), 'INVALID_ARGUMENT');
      expect(await call('character_create', { pieces: [goblin()], x: 0, y: 0, dryRun: true })).toMatchObject({
        ok: true,
        data: { pieces: [{ name: 'ゴブリン', x: 0, y: 0 }], dryRun: true },
      });
      expect(store.getObjects(GameCharacter)).toHaveLength(before);
    });

    it('needs its own grant and refuses guests', async () => {
      error(await call('character_create', { pieces: [goblin()], x: 0, y: 0 }), 'FORBIDDEN');
      PeerCursor.myCursor.role = 'guest';
      facade.health();
      policy.enable();
      grant();
      error(await call('character_create', { pieces: [goblin()], x: 0, y: 0 }), 'FORBIDDEN');
    });

    describe('out of sight', () => {
      function beGameMaster() {
        PeerCursor.myCursor.role = PeerRole.GameMaster;
        facade.health();
        policy.enable();
        grant();
      }
      async function hide(name = 'ドレイク') {
        const [made] = created(await call('character_create', { pieces: [goblin(name)], x: 4, y: 5, concealed: true }));
        return made;
      }
      const names = async (args: Record<string, unknown>) =>
        ((await call('scene_list', args)) as { data: { objects: { name: string }[] } }).data.objects.map(
          (object) => object.name
        );

      it('keeps a piece put out early off every table, where it stood, yet readable to the master', async () => {
        beGameMaster();
        const made = await hide();

        const piece = store.get<GameCharacter>(made.identifier)!;
        expect(piece.location).toMatchObject({ name: 'concealed', x: 200, y: 250 });
        expect(await names({})).not.toContain('ドレイク');
        expect(await names({ place: 'concealed' })).toEqual(['ドレイク']);
        expect(await call('object_get', { identifier: made.identifier })).toMatchObject({
          ok: true,
          data: { place: 'concealed' },
        });
        expect((await call('character_sheet_get', { identifier: made.identifier, paths: ['リソース'] })).ok).toBe(true);
        expect((await call('palette_get', { identifier: made.identifier })).ok).toBe(true);
      });

      it('brings it back where it stood, and puts it out of sight again', async () => {
        beGameMaster();
        const made = await hide();

        expect(await call('piece_reveal', { identifiers: [made.identifier] })).toMatchObject({
          ok: true,
          data: { revealed: [{ identifier: made.identifier, x: 200, y: 250 }] },
        });
        expect(store.get<GameCharacter>(made.identifier)!.location.name).toBe('table');
        error(await call('piece_reveal', { identifiers: [made.identifier] }), 'NOT_FOUND');

        expect((await call('piece_conceal', { identifiers: [made.identifier] })).ok).toBe(true);
        expect(store.get<GameCharacter>(made.identifier)!.location).toMatchObject({ name: 'concealed', x: 200 });
      });

      it('leaves putting out of sight to the master, and never touches a player’s piece', async () => {
        grant();
        error(await call('character_create', { pieces: [goblin()], x: 0, y: 0, concealed: true }), 'FORBIDDEN');
        error(await call('piece_conceal', { identifiers: [piece.identifier] }), 'FORBIDDEN');

        beGameMaster();
        const players = GameCharacter.create('PC', 1, '');
        players.owner = 'player';
        players.location = { name: 'table', x: 100, y: 100 };
        error(await call('piece_conceal', { identifiers: [players.identifier] }), 'NOT_FOUND');
        expect(players.location.name).toBe('table');
      });

      it('lets an owner who is not the master read what is theirs out of sight, but nobody else’s', async () => {
        beGameMaster();
        const made = await hide();
        const others = GameCharacter.create('Other', 1, '');
        others.owner = 'someone';
        others.location = { name: 'concealed', x: 0, y: 0 };

        PeerCursor.myCursor.role = 'pl';
        facade.health();
        policy.enable();
        expect(await names({ place: 'concealed' })).toEqual(['ドレイク']);
        error(await call('character_sheet_get', { identifier: others.identifier }), 'NOT_FOUND');
        expect((await call('character_sheet_get', { identifier: made.identifier })).ok).toBe(true);
      });
    });

    it('clears away its own pieces to the graveyard, and never a player’s', async () => {
      grant();
      const [made] = created(await call('character_create', { pieces: [goblin()], x: 0, y: 0 }));
      const players = GameCharacter.create('PC', 1, '');
      players.owner = 'player';
      players.location = { name: 'table', x: 100, y: 100 };

      error(await call('piece_remove', { identifiers: [made.identifier, players.identifier] }), 'NOT_FOUND');
      error(await call('piece_disclose', { identifier: players.identifier, disclosure: 'gm' }), 'NOT_FOUND');
      expect(store.get<GameCharacter>(made.identifier)!.location.name).toBe('table');

      expect(await call('piece_remove', { identifiers: [made.identifier] })).toMatchObject({
        ok: true,
        data: { removed: [made.identifier] },
      });
      expect(store.get<GameCharacter>(made.identifier)!.location.name).toBe('graveyard');
      expect(players.location.name).toBe('table');
    });
  });

  describe('preparing the room', () => {
    function beGameMaster() {
      PeerCursor.myCursor.role = PeerRole.GameMaster;
      facade.health();
      policy.enable();
      policy.setScope('prepare_room', true);
      policy.setScope('create_piece', true);
    }

    it('lists every table with the one in view', async () => {
      const other = new GameTable();
      other.name = 'Town';
      other.initialize();

      const result = await call('table_list');

      expect(result).toMatchObject({ ok: true });
      const tables = (result as { data: { tables: { identifier: string; viewing: boolean }[] } }).data.tables;
      expect(tables.find((t) => t.identifier === table.identifier)?.viewing).toBe(true);
      expect(tables.find((t) => t.identifier === other.identifier)?.viewing).toBe(false);
    });

    it('leaves setting the room up to the game master with its own grant', async () => {
      policy.setScope('prepare_room', true);
      error(await call('chat_tab_create', { name: 'メイン' }), 'FORBIDDEN');

      PeerCursor.myCursor.role = PeerRole.GameMaster;
      facade.health();
      policy.enable();
      error(await call('chat_tab_create', { name: 'メイン' }), 'FORBIDDEN');
    });

    it('puts another table in view for the room', async () => {
      beGameMaster();
      const town = new GameTable();
      town.name = 'Town';
      town.initialize();

      expect(await call('table_select', { identifier: town.identifier })).toMatchObject({
        ok: true,
        data: { identifier: town.identifier },
      });
      expect(TestBed.inject(TableSelecter).viewTableIdentifier).toBe(town.identifier);
      error(await call('table_select', { identifier: piece.identifier }), 'NOT_FOUND');
    });

    it('opens a chat tab the players cannot read, for the master’s own notes', async () => {
      beGameMaster();

      const result = await call('chat_tab_create', { name: 'GM', playersRead: false, guestsRead: false });

      expect(result).toMatchObject({ ok: true, data: { plCanView: false, plCanSpeak: false, guestCanView: false } });
      const made = store.get<ChatTab>((result as { data: { identifier: string } }).data.identifier)!;
      expect(made.name).toBe('GM');
      expect(ChatTabList.instance.chatTabs).toContain(made);
    });

    it('puts a note on the table, or keeps it out of sight until it is revealed', async () => {
      beGameMaster();

      const shown = await call('note_create', { title: '依頼書', text: 'ゴブリン退治', x: 1, y: 2 });
      expect(shown).toMatchObject({ ok: true, data: { x: 50, y: 100, concealed: false } });
      const note = store.get<TextNote>((shown as { data: { identifier: string } }).data.identifier)!;
      expect(note.text).toBe('ゴブリン退治');
      expect(note.owner).toBe('operator');

      const hidden = await call('note_create', { title: '地図', text: '', x: 0, y: 0, concealed: true });
      const id = (hidden as { data: { identifier: string } }).data.identifier;
      expect(store.get<TextNote>(id)!.location.name).toBe('concealed');
      expect((await call('piece_reveal', { identifiers: [id] })).ok).toBe(true);
      expect(store.get<TextNote>(id)!.location.name).toBe('table');

      error(await call('note_create', { title: '大きすぎる', text: '', x: 18, y: 0, width: 5 }), 'INVALID_ARGUMENT');
    });

    it('says plainly when this build cannot generate maps', async () => {
      beGameMaster();
      error(await call('table_create', { kind: 'dungeon', atmosphere: 'crypt' }), 'NOT_READY');
      error(await call('table_create', { kind: 'cave', atmosphere: 'crypt' }), 'INVALID_ARGUMENT');
      error(await call('table_create', { kind: 'dungeon', atmosphere: 'crypt', roomCount: 99 }), 'INVALID_ARGUMENT');
    });
  });
});
