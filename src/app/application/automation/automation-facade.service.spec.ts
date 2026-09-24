import { TestBed } from '@angular/core/testing';
import { AutomationCommand, AutomationResult } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { LocalModePreferenceService } from '@axe/application/ui/local-mode-preference.service';
import { Network } from '@axe/core/network/network';
import { localDispatch } from '@axe/core/network/network-messaging';
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
import { GameTable } from '@axe/domain/tabletop/game-table';
import { Terrain } from '@axe/domain/tabletop/terrain';
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
});
