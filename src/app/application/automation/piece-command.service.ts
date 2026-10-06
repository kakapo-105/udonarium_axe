import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { CharacterImportService } from '@axe/application/character/character-import.service';
import { GameObject } from '@axe/core/sync/game-object';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ImportedCharacter } from '@axe/domain/character/import/imported-character';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

export const MAX_CREATED_PIECES = 20;

export interface PieceAnchor {
  x: number;
  y: number;
  unit: 'grid' | 'px';
}

/**
 * Puts pieces on the table from sheet JSON, changes who may read them and takes them off again,
 * for automation acting as the one running the table.
 *
 * Only pieces you own can be disclosed or removed, so the pieces of the players are never touched.
 */
@Injectable({ providedIn: 'root' })
export class PieceCommandService {
  private readonly importer = inject(CharacterImportService);
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);

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
   * disclosed as asked. Every sheet is read and the row is checked before anything is built, so a
   * sheet that cannot be read or a row that will not fit leaves the table as it was.
   */
  async create(
    sheets: readonly unknown[],
    anchor: PieceAnchor,
    disclosure: DisclosureMode,
    dryRun: boolean,
    guard: () => void
  ) {
    const imported: ImportedCharacter[] = [];
    for (const sheet of sheets) {
      const read = await this.importer.readSheet(sheet);
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
        dryRun: true,
      };
    }
    // Built and placed in one batch, so the room first hears of each piece where it stands.
    const built = GameObject.batch(() =>
      imported.map((sheet, index) => {
        const character = this.importer.ownedCharacterOf(sheet, sheet.iconImageIdentifier);
        character.disclosureMode = disclosure;
        character.location = { ...character.location, name: 'table', ...places[index], surface: 'floor' };
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
    };
  }

  /** One of your own pieces on the table, or a failure that does not say whether it exists. */
  own(identifier: string): GameCharacter {
    const piece = this.store.get(identifier);
    const me = PeerCursor.myCursor?.userId;
    if (!(piece instanceof GameCharacter) || piece.location.name !== 'table' || !me || piece.owner !== me)
      fail('NOT_FOUND', 'None of your own pieces on the table has that identifier.');
    return piece;
  }

  disclose(piece: GameCharacter, mode: DisclosureMode) {
    piece.disclosureMode = mode;
    piece.update();
    return { identifier: piece.identifier, disclosure: mode };
  }

  /** Sends the pieces to the graveyard, as the context menu does, so they can still be brought back. */
  remove(pieces: readonly GameCharacter[]) {
    GameObject.batch(() => pieces.forEach((piece) => piece.setLocation('graveyard')));
    return { removed: pieces.map((piece) => piece.identifier) };
  }
}
