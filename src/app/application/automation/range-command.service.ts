import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { RangeArea } from '@axe/domain/tabletop/range';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

/** Where a range can be: out on the table, or put away in the shared inventory. */
export type RangePlace = 'table' | 'common';

export interface RangeChange {
  /** Where the range's centre goes, in cells (a cell is pointed at by its middle) or pixels. */
  point?: { x: number; y: number; unit: 'grid' | 'px' };
  /** A piece the range follows from now on; empty stops it following. */
  follow?: string;
  place?: RangePlace;
}

/**
 * Lets the master set out, move and put away the ranges on the table, as a melee area or the reach
 * of a spell: a range kept in the shared inventory is brought out where it is wanted, follows a piece
 * if asked, and goes back to the inventory when it is done with.
 */
@Injectable({ providedIn: 'root' })
export class RangeCommandService {
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);

  private grid(): number {
    const grid = this.tables.viewTable?.gridSize;
    return grid && Number.isFinite(grid) && grid > 0 ? grid : 50;
  }

  /** Every range out on the table or in the shared inventory, with where its centre is in cells. */
  list() {
    const grid = this.grid();
    return {
      unit: 'grid',
      ranges: this.store
        .getObjects<RangeArea>(RangeArea)
        .filter((range) => range.location.name === 'table' || range.location.name === 'common')
        .map((range) => ({
          identifier: range.identifier,
          name: range.name.slice(0, 256),
          place: range.location.name,
          type: range.type,
          length: range.length,
          width: range.width,
          x: range.location.x / grid - 0.5,
          y: range.location.y / grid - 0.5,
          following: range.followingCharacterIdentifier || null,
        })),
    };
  }

  range(identifier: string): RangeArea {
    const range = this.store.get(identifier);
    if (!(range instanceof RangeArea)) fail('NOT_FOUND', 'No range has that identifier.');
    return range;
  }

  /** Moves a range, sets it following a piece or not, and brings it out onto the table or puts it away. */
  set(range: RangeArea, change: RangeChange) {
    const table = this.tables.viewTable;
    const grid = this.grid();
    if (change.follow) {
      const piece = this.store.get(change.follow);
      if (!(piece instanceof GameCharacter) || piece.location.name !== 'table')
        fail('NOT_FOUND', 'No piece on the table has that identifier to follow.');
    }
    if (change.point) {
      const scale = change.point.unit === 'grid' ? grid : 1;
      const offset = change.point.unit === 'grid' ? grid / 2 : 0;
      const x = change.point.x * scale + offset;
      const y = change.point.y * scale + offset;
      if (table && (x < 0 || y < 0 || x > table.width * grid || y > table.height * grid))
        fail('INVALID_ARGUMENT', 'The point is not on the table in view.');
      range.location = { ...range.location, x, y };
    }
    if (change.place !== undefined) range.location = { ...range.location, name: change.place };
    if (change.follow !== undefined) {
      range.followingCharacterIdentifier = change.follow;
      range.gridSize = grid;
      if (change.follow) range.following();
    }
    range.update();
    return {
      identifier: range.identifier,
      name: range.name.slice(0, 256),
      place: range.location.name,
      x: range.location.x / grid - 0.5,
      y: range.location.y / grid - 0.5,
      unit: 'grid',
      following: range.followingCharacterIdentifier || null,
    };
  }
}
