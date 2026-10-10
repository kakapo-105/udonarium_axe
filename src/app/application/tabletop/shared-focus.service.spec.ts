import { TestBed } from '@angular/core/testing';
import {
  SHARED_FOCUS_EVENT_NAME,
  sharedFocusOf,
  SharedFocusService,
} from '@axe/application/tabletop/shared-focus.service';
import { FollowFocusPreferenceService } from '@axe/application/ui/follow-focus-preference.service';
import { SelectionSignalService } from '@axe/application/ui/selection-signal.service';
import { localDispatch } from '@axe/core/network/network-messaging';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ObjectSynchronizer } from '@axe/core/sync/object-synchronizer';
import { GameCharacter } from '@axe/domain/character/game-character';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('SharedFocusService', () => {
  const store = ObjectStore.instance;
  let table: GameTable;
  let selection: SelectionSignalService;

  function peer(role: PeerRole): PeerCursor {
    const cursor = new PeerCursor();
    cursor.initialize();
    cursor.peerId = `peer-${role}`;
    cursor.role = role;
    return cursor;
  }

  beforeEach(() => {
    for (const object of store.getObjects()) store.remove(object);
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [...TEST_PROVIDERS] });
    table = new GameTable();
    table.width = 20;
    table.height = 20;
    table.gridSize = 50;
    table.initialize();
    TestBed.inject(TableSelecter).viewTableIdentifier = table.identifier;
    PeerCursor.createMyCursor();
    PeerCursor.myCursor.role = PeerRole.Player;
    selection = TestBed.inject(SelectionSignalService);
    TestBed.inject(SharedFocusService);
  });

  afterEach(() => {
    ObjectSynchronizer.instance.destroy();
    for (const object of store.getObjects()) store.remove(object);
    localStorage.clear();
  });

  it('glides to where the game master points, and flashes the piece pointed at', () => {
    const gm = peer(PeerRole.GameMaster);
    const piece = GameCharacter.create('Guide', 1, '');
    piece.location = { name: 'table', x: 300, y: 200 };

    localDispatch(
      SHARED_FOCUS_EVENT_NAME,
      { table: table.identifier, x: 300, y: 200, identifier: piece.identifier },
      gm.peerId
    );

    expect(selection.focusCoordinate()).toMatchObject({ x: 300, y: 200 });
    expect(selection.highlightedObject()).toMatchObject({ identifier: piece.identifier });
  });

  it('leaves the view alone for a player pointing, another table, or a reader who does not follow', () => {
    const before = selection.focusCoordinate();
    const gm = peer(PeerRole.GameMaster);
    const player = peer(PeerRole.Player);

    localDispatch(SHARED_FOCUS_EVENT_NAME, { table: table.identifier, x: 10, y: 10 }, player.peerId);
    localDispatch(SHARED_FOCUS_EVENT_NAME, { table: 'another table', x: 10, y: 10 }, gm.peerId);
    TestBed.inject(FollowFocusPreferenceService).set(false);
    localDispatch(SHARED_FOCUS_EVENT_NAME, { table: table.identifier, x: 10, y: 10 }, gm.peerId);

    expect(selection.focusCoordinate()).toBe(before);
  });

  it('reads only a focus with a table and a finite point', () => {
    expect(sharedFocusOf({ table: 't', x: 1, y: 2 })).toEqual({ table: 't', x: 1, y: 2 });
    expect(sharedFocusOf({ table: 't', x: Infinity, y: 2 })).toBeNull();
    expect(sharedFocusOf({ x: 1, y: 2 })).toBeNull();
    expect(sharedFocusOf('look')).toBeNull();
  });
});
