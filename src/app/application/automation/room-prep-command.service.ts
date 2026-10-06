import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { MAP_GENERATOR, MapRequest } from '@axe/application/automation/map-generator';
import { CutInService } from '@axe/application/media/cut-in.service';
import { TableBgmService } from '@axe/application/media/table-bgm.service';
import { emitSelectGameTable } from '@axe/core/event/domain-events';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { ChatTabList } from '@axe/domain/chat/chat-tab-list';
import { ChatTabPermission } from '@axe/domain/chat/chat-tab-permission';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { CONCEALED_LOCATION } from '@axe/domain/tabletop/board-switch/concealment';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TextNote } from '@axe/domain/tabletop/text-note';

export interface NoteRequest {
  title: string;
  text: string;
  /** Top-left corner, in cells or pixels of the table in view. */
  x: number;
  y: number;
  unit: 'grid' | 'px';
  /** Size in cells. */
  width: number;
  height: number;
  disclosure: DisclosureMode;
  concealed: boolean;
}

/**
 * Sets a room up before a session, as the master would by hand: tables built from generated maps,
 * the table in view, chat tabs and shared notes.
 *
 * What is made is owned by you. Every table is the room's, so choosing one changes it for everyone,
 * with its music and its cut-ins, as choosing it from the table settings does.
 */
@Injectable({ providedIn: 'root' })
export class RoomPrepCommandService {
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);
  private readonly chatTabs = inject(ChatTabList);
  private readonly generator = inject(MAP_GENERATOR);
  private readonly tableBgm = inject(TableBgmService);
  private readonly cutIns = inject(CutInService);

  /** Every table in the room, with which one is in view. */
  list() {
    const viewing = this.tables.viewTable?.identifier;
    return {
      tables: this.store.getObjects<GameTable>(GameTable).map((table) => ({
        identifier: table.identifier,
        name: table.name.slice(0, 256),
        width: table.width,
        height: table.height,
        gridSize: table.gridSize,
        viewing: table.identifier === viewing,
      })),
    };
  }

  /**
   * Builds a table from a generated map and answers what the master needs to run it: the notes the
   * generator panel shows, where the way in is and where each room lies, in cells.
   */
  async create(request: MapRequest, guard: () => void) {
    if (!this.generator) fail('NOT_READY', 'Map generation is not available in this build.');
    let built;
    try {
      built = await this.generator(request);
    } catch (error) {
      if (error instanceof RangeError) fail('INVALID_ARGUMENT', error.message);
      throw error;
    }
    guard();
    return {
      identifier: built.table.identifier,
      name: built.table.name.slice(0, 256),
      width: built.width,
      height: built.height,
      unit: 'grid',
      entrance: built.entrance,
      rooms: built.rooms,
      traps: built.traps,
      summary: built.summary.slice(0, 4000),
      seed: request.seed,
    };
  }

  table(identifier: string): GameTable {
    const table = this.store.get(identifier);
    if (!(table instanceof GameTable)) fail('NOT_FOUND', 'No table has that identifier.');
    return table;
  }

  /** Puts a table in view for the whole room, playing its music and cut-ins as the table settings do. */
  select(table: GameTable) {
    const was = this.tables.viewTableIdentifier;
    emitSelectGameTable({ identifier: table.identifier });
    if (was !== table.identifier) {
      this.tableBgm.applyFor(table);
      this.cutIns.launchForTable(table);
    }
    return { identifier: table.identifier, name: table.name.slice(0, 256) };
  }

  /** Opens a chat tab with who may read and speak in it; the game master always may. */
  createTab(name: string, permission: Omit<ChatTabPermission, 'isSystemTab'>) {
    const tab: ChatTab = this.chatTabs.addChatTab(name);
    tab.plCanView = permission.plCanView;
    tab.plCanSpeak = permission.plCanView && permission.plCanSpeak;
    tab.guestCanView = permission.guestCanView;
    tab.guestCanSpeak = permission.guestCanView && permission.guestCanSpeak;
    return {
      identifier: tab.identifier,
      name: tab.name,
      plCanView: tab.plCanView,
      plCanSpeak: tab.plCanSpeak,
      guestCanView: tab.guestCanView,
      guestCanSpeak: tab.guestCanSpeak,
    };
  }

  /**
   * Puts a shared note on the table, owned by you, or keeps it out of sight there until it is
   * revealed. Notes are shared by every table, as pieces are.
   */
  createNote(request: NoteRequest) {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    const scale = request.unit === 'grid' ? table.gridSize : 1;
    const x = request.x * scale;
    const y = request.y * scale;
    if (
      x < 0 ||
      y < 0 ||
      x + request.width * table.gridSize > table.width * table.gridSize ||
      y + request.height * table.gridSize > table.height * table.gridSize
    )
      fail('INVALID_ARGUMENT', 'The note would not fit on the table there.');
    const note = TextNote.create(request.title, request.text, 14, request.width, request.height);
    note.location = { ...note.location, name: request.concealed ? CONCEALED_LOCATION : 'table', x, y };
    note.owner = PeerCursor.myCursor?.userId ?? '';
    note.disclosureMode = request.disclosure;
    note.update();
    return {
      identifier: note.identifier,
      title: note.title,
      x,
      y,
      unit: 'px',
      concealed: request.concealed,
    };
  }
}
