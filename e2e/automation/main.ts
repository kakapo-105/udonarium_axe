/** Test-only composition root. Never imported by src/main.ts or a release build. */
import '../../src/main';

import { Network } from '@axe/core/network/network';
import { EventContext } from '@axe/core/network/network-messaging';
import { PeerContext } from '@axe/core/network/peer-context';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { ChatTabList } from '@axe/domain/chat/chat-tab-list';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

const seat = new URL(location.href).searchParams.get('seat') ?? 'a';
const peer = PeerContext.parse(`automation-${seat}`);
peer.userId = `automation-${seat}`;
peer.roomId = 'fixture';
peer.roomName = 'Automation test';
peer.isOpen = true;
Object.defineProperty(Network, 'peerId', { get: () => peer.peerId });
Object.defineProperty(Network, 'peerContext', { get: () => peer });
Object.defineProperty(Network, 'isOpen', { get: () => true });
const channel = new BroadcastChannel('automation-e2e-sync');
let connected = false;
const queued: EventContext[] = [];
let scheduled = false;
Network.instance.send = (data: unknown) => {
  if (!connected) return;
  queued.push(data as EventContext);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    channel.postMessage({ from: seat, data: queued.splice(0) });
  }, 0);
};
channel.onmessage = (event) => {
  if (connected && event.data.from !== seat) Network.instance.callback.onData(peer, event.data.data);
};
localStorage.setItem('ui-local-mode', '1');

window.__automationTest = {
  prepare(role: PeerRole) {
    PeerCursor.myCursor.userId = peer.userId;
    PeerCursor.myCursor.peerId = peer.peerId;
    PeerCursor.myCursor.role = role;
    Config.instance.automationOwnedOnly = true;
    connected = true;
  },
  seed() {
    const table = new GameTable();
    table.width = 20;
    table.height = 20;
    table.gridSize = 50;
    table.name = 'Test table';
    table.initialize();
    TableSelecter.instance.viewTableIdentifier = table.identifier;
    const piece = GameCharacter.create('Shared piece', 1, '');
    piece.owner = peer.userId;
    piece.location = { name: 'table', x: 50, y: 50 };
    const hidden = GameCharacter.create('Private GM piece', 1, '');
    hidden.disclosureMode = 'gm';
    const tab = new ChatTab();
    tab.name = 'Test chat';
    tab.initialize();
    ChatTabList.instance.addChatTab(tab);
    tab.addMessage({ name: 'GM', text: 'private roll result', tag: 'secret' });
    tab.addMessage({ name: 'GM', text: 'private whisper', to: peer.userId, from: peer.userId });
    return { pieceId: piece.identifier, hiddenId: hidden.identifier, tabId: tab.identifier };
  },
  snapshot() {
    channel.postMessage({
      from: seat,
      data: ObjectStore.instance
        .getObjects()
        .map((object) => ({ eventName: 'UPDATE_GAME_OBJECT', data: object.toContext(), sendFrom: peer.peerId })),
    });
  },
  position(id: string) {
    return ObjectStore.instance.get<GameCharacter>(id)?.location;
  },
  messages(id: string) {
    return ObjectStore.instance.get<ChatTab>(id)?.chatMessages.map((m) => m.text) ?? [];
  },
};
declare global {
  interface Window {
    __automationTest: {
      prepare(role: PeerRole): void;
      seed(): { pieceId: string; hiddenId: string; tabId: string };
      snapshot(): void;
      position(id: string): unknown;
      messages(id: string): string[];
    };
  }
}
