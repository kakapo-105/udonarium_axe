import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
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
import { cellCenterOf } from '@axe/domain/tabletop/fog/cell-grid';
import { cheapestPath } from '@axe/domain/tabletop/move/cheapest-path';
import { pieceCellOf, pieceCornerOn } from '@axe/domain/tabletop/move/piece-on-grid';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

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
    // A plain move only sets x and y, which would leave such a piece floating at its old height.
    if (!strict && piece.posZ !== 0)
      fail('FORBIDDEN', 'Without strict movement only pieces at ground level can be moved.');
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
      return { x, y, planned: false, tableId: table.identifier };
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
    return { x, y, planned: true, tableId: table.identifier, centre: cellCenterOf(terms.grid, cell) };
  }

  async move(piece: GameCharacter, destination: PieceDestination, dryRun: boolean, guard: () => void) {
    guard();
    const next = this.destination(piece, destination);
    if (dryRun) return { identifier: piece.identifier, x: next.x, y: next.y, unit: 'px', dryRun: true };
    if (piece.location.x === next.x && piece.location.y === next.y)
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
      });
      this.triggers.putDown(piece);
    }
    return {
      identifier: piece.identifier,
      version: piece.version,
      x: piece.location.x,
      y: piece.location.y,
      unit: 'px',
    };
  }

  async send(tab: ChatTab, text: string, character: GameCharacter | null, guard: () => void) {
    const gameSystem = await DiceBot.loadGameSystemAsync(character?.chatPalette?.dicebot ?? this.chat.gameType);
    // Loading dice code yields to the UI; permissions may have been withdrawn in the meantime.
    guard();
    if (this.store.get(tab.identifier) !== tab || (character && this.store.get(character.identifier) !== character)) {
      fail('CONFLICT', 'The speaker or chat tab was replaced while preparing the message.');
    }
    const message = character
      ? this.macro.send(character, text, { tab, gameSystem, targets: [] })
      : this.chat.sendMessage(tab, text, gameSystem, PeerCursor.myCursor.identifier);
    if (!message) fail('NOT_READY', 'Chat is not ready.');
    return { identifier: message.identifier, tabId: tab.identifier };
  }
}
