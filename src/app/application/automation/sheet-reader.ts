import { Injectable } from '@angular/core';
import { GameCharacter } from '@axe/domain/character/game-character';
import { parseImportedCharacterJson } from '@axe/domain/character/import/character-import-format';
import { ImportedCharacter } from '@axe/domain/character/import/imported-character';
import { ImportedCharacterFactory } from '@axe/domain/character/import/imported-character-factory';
import { loadLabelMaps } from '@axe/domain/character/import/system-profiles/label-maps';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';

/**
 * Makes pieces from character sheets another tool wrote, for automation, as the character import
 * panel does with sheets it has fetched.
 */
@Injectable({ providedIn: 'root' })
export class SheetReader {
  /** Reads sheet JSON already in hand, fetching nothing; null when it is in no known format. */
  async readSheet(json: unknown): Promise<ImportedCharacter | null> {
    await loadLabelMaps();
    return parseImportedCharacterJson(json);
  }

  /**
   * The piece built from a sheet read, owned by you and kept to game masters when you are one. It
   * is not placed anywhere; a portrait shows only when `imageIdentifier` is already in storage.
   */
  ownedCharacterOf(imported: ImportedCharacter, imageIdentifier: string): GameCharacter {
    const character = ImportedCharacterFactory.create(imported, imageIdentifier);
    character.owner = PeerCursor.myCursor?.userId ?? '';
    if (PeerCursor.isMyselfGameMaster) character.disclosureMode = DisclosureMode.GameMaster;
    character.update();
    return character;
  }
}
