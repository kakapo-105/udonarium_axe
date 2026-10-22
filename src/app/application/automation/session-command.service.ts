import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { AutomationImage, AutomationImageService } from '@axe/application/automation/automation-image.service';
import { ChatWaitService } from '@axe/application/automation/chat-wait.service';
import { CharacterMacroService } from '@axe/application/chat/character-macro.service';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { MovePlanService } from '@axe/application/tabletop/move-plan.service';
import { MoveRangeService } from '@axe/application/tabletop/move-range.service';
import { TriggerFireService } from '@axe/application/tabletop/trigger-fire.service';
import { LocalModePreferenceService } from '@axe/application/ui/local-mode-preference.service';
import { Network } from '@axe/core/network/network';
import { GameObject } from '@axe/core/sync/game-object';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { DiceBot } from '@axe/domain/dice/dice-bot';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { cellCenterOf, cellGridOf } from '@axe/domain/tabletop/fog/cell-grid';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { blockedByTerrain, nearestOpenCell, terrainBlocksMovement } from '@axe/domain/tabletop/move/blocked-cells';
import { cheapestPath } from '@axe/domain/tabletop/move/cheapest-path';
import { pieceCellOf, pieceCornerOn } from '@axe/domain/tabletop/move/piece-on-grid';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { Terrain } from '@axe/domain/tabletop/terrain';
import { encodeVnEmote, VN_EMOTE_DEFAULT, VnMessageKind } from '@axe/domain/visual-novel/vn-emote';

/**
 * What a piece cannot be stood inside: a wall or a building on the ground. A canopy or a roof
 * hangs over the ground under it, which is somewhere to stand.
 */
function standsInTheWay(terrain: Terrain): boolean {
  return terrainBlocksMovement(terrain) && !(terrain.altitude > 0);
}

export interface PieceDestination {
  x: number;
  y: number;
  unit: 'grid' | 'px';
}

/** Application operations, also usable by UI callers without a browser transport. */
@Injectable({ providedIn: 'root' })
export class SessionCommandService {
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);
  private readonly localMode = inject(LocalModePreferenceService);
  private readonly range = inject(MoveRangeService);
  private readonly plan = inject(MovePlanService);
  private readonly triggers = inject(TriggerFireService);
  private readonly chat = inject(ChatMessageService);
  private readonly macro = inject(CharacterMacroService);
  private readonly chatWait = inject(ChatWaitService);
  private readonly images = inject(AutomationImageService);

  get ready(): boolean {
    return (
      !!PeerCursor.myCursor &&
      !!this.tables.viewTable &&
      (this.localMode.enabled() || (Network.isOpen && Network.peerContext.isRoom))
    );
  }
  get identity(): string {
    return JSON.stringify([
      PeerCursor.myCursor?.identifier,
      PeerCursor.myCursor?.userId,
      PeerCursor.myRole,
      this.localMode.enabled(),
      Network.isOpen,
      Network.peerContext.peerId,
      Network.peerContext.roomId,
    ]);
  }
  session() {
    const table = this.tables.viewTable;
    return {
      connected: Network.isOpen,
      offline: this.localMode.enabled(),
      roomName: Network.peerContext.roomName.slice(0, 256),
      role: PeerCursor.myRole,
      table: table
        ? {
            identifier: table.identifier,
            name: table.name.slice(0, 256),
            width: table.width,
            height: table.height,
            gridSize: table.gridSize,
            gridType: table.gridType,
          }
        : null,
    };
  }

  /** Validates without opening a UI plan or changing even the piece's stacking order. */
  destination(piece: GameCharacter, destination: PieceDestination) {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    if ((piece.location.surface && piece.location.surface !== 'floor') || piece.altitude !== 0) {
      fail('FORBIDDEN', 'Only pieces standing on the floor side can be moved.');
    }
    const strict = !!this.store.get<Config>('Config')?.moveStrict;
    // A strict walk works out the ground under each step, so a piece up on terrain can walk from there.
    // A plain move sets the piece down on the ground, so one dropped on a roof comes down off it.
    const scale = destination.unit === 'grid' ? table.gridSize : 1;
    const x = destination.x * scale;
    const y = destination.y * scale;
    const size = Math.max(1, piece.size) * table.gridSize;
    if (
      ![x, y, size].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      x + size > table.width * table.gridSize ||
      y + size > table.height * table.gridSize
    ) {
      fail('INVALID_ARGUMENT', 'Destination is outside the table.');
    }
    if (this.plan.isPlanning() || this.plan.isWalking) fail('CONFLICT', 'Another move is in progress.');
    if (!strict || (x === piece.location.x && y === piece.location.y)) {
      // A plain move goes wherever it is put, so a piece put on a wall or a building is stood
      // beside it instead of inside it.
      const open = this.openGroundFor(table, piece, x, y);
      return { ...open, planned: false, tableId: table.identifier };
    }
    const terms = this.range.termsOf(piece);
    if (!terms) fail('FORBIDDEN', 'This piece has no legal movement range.');
    const cell = pieceCellOf(terms.grid, piece, table.gridSize, { x, y });
    if (cell < 0 || !terms.cells.get(cell)) fail('FORBIDDEN', 'Destination cannot be reached.');
    const corner = pieceCornerOn(terms.grid, piece, table.gridSize, cell);
    if (Math.abs(corner.x - x) > 0.001 || Math.abs(corner.y - y) > 0.001) {
      fail('INVALID_ARGUMENT', 'Strict movement requires a cell-aligned destination.');
    }
    const way = cheapestPath(terms.grid, terms.start, cell, terms.walk, (i) => terms.blocked.get(i), terms.options);
    if (!way || way.length > 100) fail('FORBIDDEN', 'No path within the 100-step limit.');
    return { x, y, planned: true, adjusted: false, tableId: table.identifier, centre: cellCenterOf(terms.grid, cell) };
  }

  /** Whether a piece on the table in view stands inside a wall or a building, where nobody can stand. */
  standsInside(piece: GameCharacter): boolean {
    const table = this.tables.viewTable;
    if (!table || !(table.gridSize > 0)) return false;
    const grid = cellGridOf(table.width, table.height, table.gridSize, table.gridType);
    const cell = pieceCellOf(grid, piece, table.gridSize);
    return cell >= 0 && blockedByTerrain(grid, table.terrains, standsInTheWay).get(cell);
  }

  /** Where a piece put at x, y in pixels stands: there, or the open cell nearest it when that is walled. */
  private openGroundFor(table: GameTable, piece: GameCharacter, x: number, y: number) {
    const grid = cellGridOf(table.width, table.height, table.gridSize, table.gridType);
    const cell = pieceCellOf(grid, piece, table.gridSize, { x, y });
    if (cell < 0) return { x, y, adjusted: false };
    const open = nearestOpenCell(grid, blockedByTerrain(grid, table.terrains, standsInTheWay), cell);
    if (open < 0 || open === cell) return { x, y, adjusted: false };
    const corner = pieceCornerOn(grid, piece, table.gridSize, open);
    return { x: corner.x, y: corner.y, adjusted: true };
  }

  /**
   * Sets the name and picture automation speaks under when it speaks as itself, as the connection
   * panel's name and icon do: a game master's narration then carries the master's own face rather
   * than the default icon. The picture is taken in first when it is brought along.
   */
  async setSelf(change: { name?: string; image?: string; images: readonly AutomationImage[] }, guard: () => void) {
    const me = PeerCursor.myCursor;
    if (!me) fail('NOT_READY', 'There is no seat to set.');
    const pictures = await this.images.check(change.images);
    guard();
    await this.images.add(pictures);
    guard();
    if (change.name !== undefined) me.name = change.name;
    if (change.image !== undefined) me.imageIdentifier = change.image;
    return { name: me.name, image: me.imageIdentifier };
  }

  async move(piece: GameCharacter, destination: PieceDestination, dryRun: boolean, guard: () => void) {
    guard();
    const next = this.destination(piece, destination);
    const adjusted = next.adjusted ? { adjusted: true } : {};
    if (dryRun) return { identifier: piece.identifier, x: next.x, y: next.y, unit: 'px', ...adjusted, dryRun: true };
    if (piece.location.x === next.x && piece.location.y === next.y && piece.posZ === 0)
      return { identifier: piece.identifier, version: piece.version };
    if (next.planned && next.centre) {
      if (!this.plan.begin(piece)) fail('CONFLICT', 'Could not open a move.');
      this.plan.lookAt(next.centre.x, next.centre.y);
      if (
        !(await this.plan.run(() => {
          guard();
          if (this.tables.viewTable?.identifier !== next.tableId)
            fail('CONFLICT', 'The table changed during movement.');
        }))
      )
        fail('CONFLICT', 'Movement was interrupted.');
    } else {
      this.triggers.pickedUp(piece);
      GameObject.batch(() => {
        piece.location = { ...piece.location, x: next.x, y: next.y, surface: 'floor' };
        piece.posZ = 0;
      });
      this.triggers.putDown(piece);
    }
    return {
      identifier: piece.identifier,
      version: piece.version,
      x: piece.location.x,
      y: piece.location.y,
      unit: 'px',
      ...adjusted,
    };
  }

  /**
   * Says a line in a tab, as yourself or a piece. `style` stages it as narration, a place heading or a
   * scene heading, as picking that kind in the chat input does, so it stands out in the log and in
   * novel mode.
   */
  async send(
    tab: ChatTab,
    text: string,
    character: GameCharacter | null,
    guard: () => void,
    style: VnMessageKind = 'normal'
  ) {
    // Rolled under the system a person's line would be: the piece's, else the room's default.
    const gameSystem = await DiceBot.loadGameSystemAsync(
      character ? this.macro.gameTypeFor(character) : this.macro.gameTypeForSelf()
    );
    // Loading dice code yields to the UI; permissions may have been withdrawn in the meantime.
    guard();
    if (this.store.get(tab.identifier) !== tab || (character && this.store.get(character.identifier) !== character)) {
      fail('CONFLICT', 'The speaker or chat tab was replaced while preparing the message.');
    }
    const before = this.chatWait.linesOf(tab);
    const message = this.chatWait.said(() => {
      const said = character
        ? this.macro.send(character, text, { tab, gameSystem, targets: [] })
        : this.chat.sendMessage(tab, text, gameSystem, PeerCursor.myCursor.identifier);
      if (said && style !== 'normal') said.vnEmote = encodeVnEmote({ ...VN_EMOTE_DEFAULT, kind: style });
      return said;
    });
    if (!message) fail('NOT_READY', 'Chat is not ready.');
    const rolls = await this.chatWait.rollsSince(tab, before, message.text, guard, gameSystem?.COMMAND_PATTERN);
    return { identifier: message.identifier, tabId: tab.identifier, ...(rolls.length > 0 ? { rolls } : {}) };
  }

  /**
   * Says a line as the piece, exactly as a player's palette or buff command would be said.
   *
   * References are filled in, a line aimed at targets is spoken once for each of `targets`, and
   * resource, buff and effect commands in it are carried out. With no targets given, the pieces
   * marked on the table stand in, as they do for a player.
   */
  async speakAs(
    tab: ChatTab,
    character: GameCharacter,
    line: string,
    targets: readonly GameCharacter[] | undefined,
    guard: () => void
  ) {
    const gameSystem = await DiceBot.loadGameSystemAsync(this.macro.gameTypeFor(character));
    // Loading dice code yields to the UI; permissions may have been withdrawn in the meantime.
    guard();
    if (this.store.get(tab.identifier) !== tab || this.store.get(character.identifier) !== character) {
      fail('CONFLICT', 'The speaker or chat tab was replaced while preparing the message.');
    }
    const before = this.chatWait.linesOf(tab);
    const message = this.chatWait.said(() => this.macro.send(character, line, { tab, gameSystem, targets }));
    if (!message) fail('NOT_READY', 'Chat is not ready.');
    const rolls = await this.chatWait.rollsSince(tab, before, message.text, guard, gameSystem?.COMMAND_PATTERN);
    return {
      identifier: message.identifier,
      tabId: tab.identifier,
      text: message.text.slice(0, 2000),
      ...(rolls.length > 0 ? { rolls } : {}),
    };
  }
}
