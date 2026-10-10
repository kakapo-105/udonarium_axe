import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { ConcealmentService } from '@axe/application/tabletop/concealment.service';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { cellGridOf, cellIndexOf } from '@axe/domain/tabletop/fog/cell-grid';
import { ensureFogMemoryOn, fogMemoryOn } from '@axe/domain/tabletop/fog/fog-memory';
import { fogRules } from '@axe/domain/tabletop/fog/fog-mode';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { LightSource } from '@axe/domain/tabletop/light-source';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { Terrain } from '@axe/domain/tabletop/terrain';
import { applyLightPreset, LightPreset } from '@axe/domain/tabletop/vision-types';

/** A rectangle of the table in view, in cells from its top-left corner. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LIGHT_KINDS = [
  LightPreset.TORCH,
  LightPreset.LANTERN,
  LightPreset.CANDLE,
  LightPreset.CAMPFIRE,
  LightPreset.BRAZIER,
  LightPreset.DAYLIGHT,
] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

const MAX_TERRAINS = 200;

/**
 * Lets the master run exploration on the board: the ground a party has come to know, the doors in
 * its way and the lights it finds or brings, on the table in view.
 *
 * The fog clears by itself wherever the players' pieces can see; this is for what sight does not
 * reach, such as a room the party has been told of or has walked through in the dark.
 */
@Injectable({ providedIn: 'root' })
export class ExplorationCommandService {
  private readonly tables = inject(TableSelecter);
  private readonly concealment = inject(ConcealmentService);

  private table(): GameTable {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    return table;
  }

  /** The rectangle, checked against the table, as whole cells. */
  private cells(table: GameTable, rect: CellRect): CellRect {
    const x = Math.floor(rect.x);
    const y = Math.floor(rect.y);
    const w = Math.ceil(rect.w);
    const h = Math.ceil(rect.h);
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > table.width || y + h > table.height)
      fail('INVALID_ARGUMENT', 'The rectangle is not on the table in view.');
    return { x, y, w, h };
  }

  /**
   * Marks a rectangle as explored, so the fog lifts from it for everyone as if the party had seen it.
   * Only a table whose fog remembers the ground keeps it.
   */
  revealFog(rect: CellRect) {
    const table = this.table();
    const cells = this.cells(table, rect);
    if (!table.fogEnabled) return { revealed: 0, fog: false };
    if (!fogRules(table.fogMode).remembersGround)
      fail('INVALID_ARGUMENT', 'This table’s fog forgets the ground at once, so nothing can be marked explored.');
    const grid = cellGridOf(table.width, table.height, table.gridSize, table.gridType);
    const memory = fogMemoryOn(table) ?? ensureFogMemoryOn(table);
    const bits = memory.read(grid);
    let revealed = 0;
    for (let row = cells.y; row < cells.y + cells.h; row++)
      for (let col = cells.x; col < cells.x + cells.w; col++) {
        const index = cellIndexOf(grid, col, row);
        if (index < 0 || bits.get(index)) continue;
        bits.set(index);
        revealed++;
      }
    if (revealed > 0) memory.write(grid, bits);
    return { revealed, fog: true };
  }

  /**
   * The doors, walls, props and lights inside a rectangle of the table in view, or all of them, with
   * whether each is out of sight. Walls are left out unless asked for, since a dungeon stands thousands.
   */
  listTerrain(rect: CellRect | null, walls: boolean) {
    const table = this.table();
    const area = rect ? this.cells(table, rect) : null;
    const grid = table.gridSize;
    const inside = (x: number, y: number) =>
      !area || (x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h);
    const stashed = this.concealment.concealed();
    const terrains = [...table.terrains, ...stashed.filter((object): object is Terrain => object instanceof Terrain)]
      .filter((terrain) => walls || terrain.isDoor || !terrain.blocksSight)
      .map((terrain) => ({
        identifier: terrain.identifier,
        name: terrain.name.slice(0, 256),
        kind: terrain.isDoor ? 'door' : terrain.blocksSight ? 'wall' : 'prop',
        x: terrain.location.x / grid,
        y: terrain.location.y / grid,
        open: terrain.isDoor ? terrain.isDoorOpen : undefined,
        concealed: this.concealment.isConcealed(terrain),
      }))
      .filter((terrain) => inside(terrain.x, terrain.y));
    const lights = table.children
      .filter((child): child is LightSource => child instanceof LightSource)
      .map((light) => ({
        identifier: light.identifier,
        name: light.name.slice(0, 256),
        kind: 'light',
        x: light.location.x / grid,
        y: light.location.y / grid,
        on: light.lightEnabled,
      }))
      .filter((light) => inside(light.x, light.y));
    const all = [...terrains, ...lights];
    return { unit: 'grid', items: all.slice(0, MAX_TERRAINS), more: all.length > MAX_TERRAINS };
  }

  /** A door on the table in view, or put out of sight there. */
  door(identifier: string): Terrain {
    const table = this.table();
    const terrain = [...table.terrains, ...this.concealment.concealed()].find(
      (object) => object.identifier === identifier
    );
    if (!(terrain instanceof Terrain) || !terrain.isDoor)
      fail('NOT_FOUND', 'No door on the table in view has that identifier.');
    return terrain;
  }

  /**
   * Opens or shuts a door, and brings one that was put out of sight back first, as when a hidden
   * door is found. A hidden door the generator made looks like the wall it stands in until opened.
   */
  setDoor(terrain: Terrain, open: boolean | undefined) {
    const found = this.concealment.isConcealed(terrain) ? this.concealment.reveal(terrain) : false;
    if (open !== undefined) terrain.isDoorOpen = open;
    return { identifier: terrain.identifier, open: terrain.isDoorOpen, found };
  }

  /** Stands a light on the table in view, centred on a cell, shown to everyone whether or not a piece sees it. */
  placeLight(x: number, y: number, kind: LightKind, name: string) {
    const table = this.table();
    const cell = this.cells(table, { x, y, w: 1, h: 1 });
    const light = LightSource.create(name);
    applyLightPreset(light, kind);
    light.lightEnabled = true;
    light.lightRevealToAll = true;
    light.owner = PeerCursor.myCursor?.userId ?? '';
    light.location = { name: 'table', x: cell.x * table.gridSize, y: cell.y * table.gridSize };
    light.posZ = 0;
    // A light belongs to its table, so clearing the table takes its lights with it.
    table.appendChild(light);
    light.update();
    return { identifier: light.identifier, name: light.name, x: cell.x, y: cell.y, unit: 'grid', kind };
  }
}
