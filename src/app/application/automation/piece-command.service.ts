import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { CharacterImportService } from '@axe/application/character/character-import.service';
import { ConcealmentService } from '@axe/application/tabletop/concealment.service';
import { GameObject } from '@axe/core/sync/game-object';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ImportedCharacter } from '@axe/domain/character/import/imported-character';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { CONCEALED_LOCATION } from '@axe/domain/tabletop/board-switch/concealment';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TextNote } from '@axe/domain/tabletop/text-note';

export const MAX_CREATED_PIECES = 20;

/** What automation puts out and clears away: pieces, and the shared notes handed to the players. */
export type OwnedThing = GameCharacter | TextNote;

export interface PieceAnchor {
  x: number;
  y: number;
  unit: 'grid' | 'px';
}

/**
 * Puts pieces on the table from sheet JSON, puts them out of sight and back, changes who may read
 * them and takes them off again, for automation acting as the one running the table.
 *
 * Only pieces you own are touched, so the pieces of the players never are. A piece out of sight keeps
 * where it stood, and comes back there.
 */
@Injectable({ providedIn: 'root' })
export class PieceCommandService {
  private readonly importer = inject(CharacterImportService);
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);
  private readonly concealment = inject(ConcealmentService);

  /**
   * Where each of `sizes` would stand: in a row from the anchor, one after another, each as wide as
   * it is. Fails when the row would run off the table.
   */
  placesFor(sizes: readonly number[], anchor: PieceAnchor): { x: number; y: number }[] {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    const scale = anchor.unit === 'grid' ? table.gridSize : 1;
    let x = anchor.x * scale;
    const y = anchor.y * scale;
    return sizes.map((size) => {
      const width = Math.max(1, size) * table.gridSize;
      if (x < 0 || y < 0 || x + width > table.width * table.gridSize || y + width > table.height * table.gridSize)
        fail('INVALID_ARGUMENT', 'The pieces would not fit on the table from there.');
      const place = { x, y };
      x += width;
      return place;
    });
  }

  /**
   * Builds a piece from each of `sheets` and stands them in a row from the anchor, owned by you and
   * disclosed as asked, or keeps them out of sight there until they are revealed. Every sheet is read
   * and the row is checked before anything is built, so a sheet that cannot be read or a row that
   * will not fit leaves the table as it was.
   */
  async create(
    sheets: readonly unknown[],
    anchor: PieceAnchor,
    options: { disclosure: DisclosureMode; concealed: boolean; dicebot?: string },
    dryRun: boolean,
    guard: () => void
  ) {
    const imported: ImportedCharacter[] = [];
    for (const sheet of sheets) {
      const read = await this.importer.readSheet(sheet);
      // A sheet from another tool names no dice bot, and a palette line on the power table needs the system's own.
      if (read && options.dicebot) read.dicebot = options.dicebot;
      if (!read) fail('INVALID_ARGUMENT', `Piece ${imported.length + 1} is not a sheet that can be read.`);
      imported.push(read);
    }
    const places = this.placesFor(
      imported.map((sheet) => (sheet.size >= 1 ? sheet.size : 1)),
      anchor
    );
    // Reading label maps yields to the UI; permissions may have been withdrawn in the meantime.
    guard();
    if (dryRun) {
      return {
        pieces: imported.map((sheet, index) => ({ name: sheet.name, ...places[index] })),
        unit: 'px',
        concealed: options.concealed,
        dryRun: true,
      };
    }
    // Built and placed in one batch, so the room first hears of each piece where it stands, or that
    // it is out of sight.
    const place = options.concealed ? CONCEALED_LOCATION : 'table';
    const built = GameObject.batch(() =>
      imported.map((sheet, index) => {
        const character = this.importer.ownedCharacterOf(sheet, sheet.iconImageIdentifier);
        character.disclosureMode = options.disclosure;
        character.location = { ...character.location, name: place, ...places[index], surface: 'floor' };
        character.update();
        return character;
      })
    );
    return {
      pieces: built.map((character) => ({
        identifier: character.identifier,
        name: character.name,
        x: character.location.x,
        y: character.location.y,
        size: character.size,
      })),
      unit: 'px',
      concealed: options.concealed,
    };
  }

  /**
   * One of your own pieces or shared notes on the table, or out of sight when `places` says so, or a
   * failure that does not say whether it exists.
   */
  own(identifier: string, places: readonly string[] = ['table', CONCEALED_LOCATION]): OwnedThing {
    const piece = this.store.get(identifier);
    const me = PeerCursor.myCursor?.userId;
    const owned = piece instanceof GameCharacter || piece instanceof TextNote;
    if (!owned || !places.includes(piece.location.name) || !me || piece.owner !== me)
      fail('NOT_FOUND', 'None of your own pieces there has that identifier.');
    return piece;
  }

  /** Puts the pieces out of sight where they stand, as the master's context menu does. */
  conceal(pieces: readonly OwnedThing[]) {
    GameObject.batch(() => pieces.forEach((piece) => this.concealment.conceal(piece)));
    return { concealed: pieces.map((piece) => piece.identifier) };
  }

  /** Brings the pieces back to where they were put out of sight, for everyone to see. */
  reveal(pieces: readonly OwnedThing[]) {
    GameObject.batch(() => pieces.forEach((piece) => this.concealment.reveal(piece)));
    return {
      revealed: pieces.map((piece) => ({ identifier: piece.identifier, x: piece.location.x, y: piece.location.y })),
      unit: 'px',
    };
  }

  disclose(piece: OwnedThing, mode: DisclosureMode) {
    piece.disclosureMode = mode;
    piece.update();
    return { identifier: piece.identifier, disclosure: mode };
  }

  /** Sends the pieces to the graveyard, as the context menu does, so they can still be brought back. */
  remove(pieces: readonly OwnedThing[]) {
    GameObject.batch(() => pieces.forEach((piece) => piece.setLocation('graveyard')));
    return { removed: pieces.map((piece) => piece.identifier) };
  }
}
