import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { CharacterImportService } from '@axe/application/character/character-import.service';
import { ConcealmentService } from '@axe/application/tabletop/concealment.service';
import { calcSHA256Async } from '@axe/core/storage/file-reader-util';
import { ImageState } from '@axe/core/storage/image-file';
import { ImageStorage } from '@axe/core/storage/image-storage';
import { GameObject } from '@axe/core/sync/game-object';
import { ObjectSerializer } from '@axe/core/sync/object-serializer';
import { xml2element } from '@axe/core/util/xml-util';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ImportedCharacter } from '@axe/domain/character/import/imported-character';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { CONCEALED_LOCATION } from '@axe/domain/tabletop/board-switch/concealment';
import { claimBroughtInPiece } from '@axe/domain/tabletop/ownership';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TextNote } from '@axe/domain/tabletop/text-note';

export const MAX_CREATED_PIECES = 20;
export const MAX_PIECE_IMAGES = 20;
const MAX_SHEET_XML = 200_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_IDENTIFIER = /^[0-9a-f]{64}$/;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

/** A picture a piece wears, as its bytes in base64 with the SHA-256 that identifies it. */
export interface PieceImage {
  identifier: string;
  type: string;
  data: string;
}

type Sheet =
  | { kind: 'xml'; element: Element; name: string; size: number }
  | { kind: 'imported'; imported: ImportedCharacter; name: string; size: number };

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
  private readonly serializer = inject(ObjectSerializer);
  private readonly imageStorage = inject(ImageStorage);
  private readonly policy = inject(AutomationPolicyService);

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
   * disclosed as asked, or keeps them out of sight there until they are revealed.
   *
   * A sheet is either a piece of this tool's own, as the `<character>` XML its save data holds, or
   * JSON from another tool. The pictures the pieces wear come in `images`, each checked against its
   * identifier before it joins the room's pictures. Every sheet and picture is read and the row is
   * checked before anything is built, so a sheet that cannot be read, a picture that is not what it
   * claims or a row that will not fit leaves the table as it was.
   */
  async create(
    sheets: readonly unknown[],
    anchor: PieceAnchor,
    options: { disclosure: DisclosureMode; concealed: boolean; dicebot?: string; images?: readonly PieceImage[] },
    dryRun: boolean,
    guard: () => void
  ) {
    const read: Sheet[] = [];
    for (const sheet of sheets) read.push(await this.readSheet(sheet, read.length + 1, options.dicebot));
    const places = this.placesFor(
      read.map((sheet) => sheet.size),
      anchor
    );
    const pictures = await Promise.all((options.images ?? []).map((image) => this.checkImage(image)));
    // Reading label maps and pictures yields to the UI; permissions may have been withdrawn in the meantime.
    guard();
    if (dryRun) {
      return {
        pieces: read.map((sheet, index) => ({ name: sheet.name, ...places[index] })),
        unit: 'px',
        concealed: options.concealed,
        dryRun: true,
      };
    }
    for (const picture of pictures) if (picture) await this.imageStorage.addAsync(picture);
    guard();
    // Built and placed in one batch, so the room first hears of each piece where it stands, or that
    // it is out of sight.
    const place = options.concealed ? CONCEALED_LOCATION : 'table';
    const built = GameObject.batch(() =>
      read.map((sheet, index) => {
        const character = this.build(sheet, options.dicebot);
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

  /** Reads one sheet without building anything: this tool's own XML, or JSON from another tool. */
  private async readSheet(sheet: unknown, number: number, dicebot: string | undefined): Promise<Sheet> {
    if (typeof sheet === 'string') {
      if (sheet.length > MAX_SHEET_XML) fail('INVALID_ARGUMENT', `Piece ${number} is too long.`);
      const element = xml2element(sheet);
      // Only a piece is taken: room data or a chat tab would reach well past the table.
      if (!element || element.tagName !== 'character')
        fail('INVALID_ARGUMENT', `Piece ${number} is not a <character> element.`);
      const common = (name: string) =>
        element.querySelector(`data[name="character"] > data[name="common"] > data[name="${name}"]`)?.textContent ?? '';
      const size = Number(common('size'));
      return { kind: 'xml', element, name: common('name').trim(), size: size >= 1 ? size : 1 };
    }
    const imported = await this.importer.readSheet(sheet);
    if (!imported) fail('INVALID_ARGUMENT', `Piece ${number} is not a sheet that can be read.`);
    // A sheet from another tool names no dice bot, and a palette line on the power table needs the system's own.
    if (dicebot) imported.dicebot = dicebot;
    return { kind: 'imported', imported, name: imported.name, size: imported.size >= 1 ? imported.size : 1 };
  }

  /** Builds a piece from a sheet already read, owned by you, as a dropped file or an import would be. */
  private build(sheet: Sheet, dicebot: string | undefined): GameCharacter {
    if (sheet.kind === 'imported')
      return this.importer.ownedCharacterOf(sheet.imported, sheet.imported.iconImageIdentifier);
    const character = this.serializer.parseXml(sheet.element);
    if (!(character instanceof GameCharacter)) return fail('INVALID_ARGUMENT', 'The piece could not be built.');
    claimBroughtInPiece(character, PeerCursor.myCursor?.userId ?? '');
    character.partyIdentifier = '';
    character.addExtendData();
    if (dicebot && character.chatPalette) character.chatPalette.dicebot = dicebot;
    return character;
  }

  /**
   * The picture to add for one the pieces wear, named by its identifier as save data names it so that
   * the identifier is kept; nothing when the room has it already. Fails when the bytes are not the
   * picture the identifier names.
   */
  private async checkImage(image: PieceImage): Promise<File | null> {
    if (!IMAGE_IDENTIFIER.test(image.identifier)) fail('INVALID_ARGUMENT', 'An image identifier is not a SHA-256.');
    const extension = IMAGE_EXTENSIONS[image.type];
    if (!extension) fail('INVALID_ARGUMENT', `Images of type ${image.type} are not taken.`);
    const held = this.imageStorage.get(image.identifier);
    if (held && held.state >= ImageState.COMPLETE) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    } catch {
      return fail('INVALID_ARGUMENT', 'An image is not base64.');
    }
    if (bytes.length > MAX_IMAGE_BYTES) fail('INVALID_ARGUMENT', 'An image is too large.');
    if ((await calcSHA256Async(bytes.buffer)) !== image.identifier)
      fail('INVALID_ARGUMENT', 'An image is not the picture its identifier names.');
    return new File([bytes], `${image.identifier}.${extension}`, { type: image.type });
  }

  /**
   * One of your own pieces or shared notes on the table, or out of sight when `places` says so, or a
   * failure that does not say whether it exists.
   */
  own(identifier: string, places: readonly string[] = ['table', CONCEALED_LOCATION]): OwnedThing {
    const piece = this.store.get(identifier);
    const owned = piece instanceof GameCharacter || piece instanceof TextNote;
    if (!owned || !places.includes(piece.location.name) || !this.policy.isMine(piece.owner))
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
