import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { AMBIENCE_BRIGHTNESS } from '@axe/domain/effect/ambience/ambience-brightness';
import {
  AmbienceKind,
  DEFAULT_AMBIENCE_DENSITY,
  GROUND_AMBIENCE_KINDS,
  SKY_AMBIENCE_KINDS,
} from '@axe/domain/effect/ambience/ambience-kind';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { SHOWN_TO } from '@axe/domain/tabletop/shown-to';
import { TableAmbience } from '@axe/domain/tabletop/table-ambience';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

export const GROUND_KIND_NAMES: readonly string[] = GROUND_AMBIENCE_KINDS;
export const WEATHER_KIND_NAMES: readonly string[] = SKY_AMBIENCE_KINDS;

/** How thick it is: thin, normal or thick, the steps the context menu offers. */
export const DENSITY_NAMES = { thin: 0.3, normal: 0.6, thick: 1 } as const;
export type DensityName = keyof typeof DENSITY_NAMES;

const MAX_AREA = 100;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** What the master may set on an area. Anything left out is left alone (or the default, on a new area). */
export interface AmbienceAreaRequest {
  kind?: string;
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  density?: string;
  color?: string;
  shownTo?: string;
  blocksSight?: boolean;
  brightness?: string;
  /** Water only, 0 to 1 unless noted. */
  surfaceHeight?: number;
  turbidity?: number;
  dirtiness?: number;
  floatingLeaves?: number;
  flowSpeed?: number;
  flowDirection?: number;
}

/**
 * Lets the master lay an area of ground effect, such as a poisoned marsh, a bank of fog or a pond,
 * on the table in view, and set the weather over a whole table.
 */
@Injectable({ providedIn: 'root' })
export class AmbienceCommandService {
  private readonly tables = inject(TableSelecter);

  private view(): GameTable {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    return table;
  }

  list() {
    const table = this.view();
    const grid = table.gridSize;
    return {
      unit: 'grid',
      weather: table.weatherKind
        ? { kind: table.weatherKind, density: table.weatherDensity, color: table.weatherColor || null }
        : null,
      areas: table.ambiences.map((area) => ({
        identifier: area.identifier,
        name: area.name.slice(0, 256),
        kind: area.ambienceKind,
        x: area.location.x / grid,
        y: area.location.y / grid,
        w: area.width,
        h: area.height,
        density: area.ambienceDensity,
        shownTo: area.shows,
        blocksSight: area.blocksSight,
        brightness: area.brightness || 'none',
        ...(area.ambienceKind === 'water'
          ? {
              surfaceHeight: area.surface,
              turbidity: area.murk,
              dirtiness: area.dirt,
              floatingLeaves: area.floatingLeaves,
              flowSpeed: area.flowSpeed,
              flowDirection: area.flowDirection,
            }
          : {}),
      })),
    };
  }

  area(identifier: string): TableAmbience {
    const area = this.view().ambiences.find((one) => one.identifier === identifier);
    if (!area) fail('NOT_FOUND', 'No area effect on the table in view has that identifier.');
    return area;
  }

  /** Lays a new area on the table in view, a cell at x, y being its top-left. */
  place(request: AmbienceAreaRequest) {
    const table = this.view();
    const kind = request.kind;
    if (!kind || !GROUND_KIND_NAMES.includes(kind))
      fail('INVALID_ARGUMENT', `kind must be one of ${GROUND_AMBIENCE_KINDS.join(', ')}.`);
    if (request.x === undefined || request.y === undefined) fail('INVALID_ARGUMENT', 'Give x and y.');
    const w = this.size(request.w ?? 4, 'w');
    const h = this.size(request.h ?? 4, 'h');
    if (request.x < 0 || request.y < 0 || request.x + w > table.width || request.y + h > table.height)
      fail('INVALID_ARGUMENT', 'The area is not on the table in view.');
    const area = TableAmbience.create(request.name?.trim() || kind, kind as AmbienceKind, w, h);
    area.location.x = Math.round(request.x * table.gridSize);
    area.location.y = Math.round(request.y * table.gridSize);
    area.posZ = 0;
    this.apply(area, { ...request, kind: undefined });
    table.appendChild(area);
    return this.describe(area, table.gridSize);
  }

  /** Changes an area already on the table. */
  change(area: TableAmbience, request: AmbienceAreaRequest) {
    const table = this.view();
    if (request.kind !== undefined) {
      if (!GROUND_KIND_NAMES.includes(request.kind))
        fail('INVALID_ARGUMENT', `kind must be one of ${GROUND_AMBIENCE_KINDS.join(', ')}.`);
      area.ambienceKind = request.kind;
    }
    if (request.x !== undefined || request.y !== undefined) {
      area.location.x = Math.round((request.x ?? area.location.x / table.gridSize) * table.gridSize);
      area.location.y = Math.round((request.y ?? area.location.y / table.gridSize) * table.gridSize);
    }
    if (request.w !== undefined) area.width = this.size(request.w, 'w');
    if (request.h !== undefined) area.height = this.size(request.h, 'h');
    this.apply(area, { ...request, kind: undefined });
    return this.describe(area, table.gridSize);
  }

  /** Takes an area away. */
  remove(area: TableAmbience) {
    const identifier = area.identifier;
    area.destroy();
    return { identifier, removed: true };
  }

  /** Sets the weather over a whole table: a kind that falls from the sky, or none to clear it. */
  weather(table: GameTable, kind: string, density: string | undefined, color: string | undefined) {
    if (kind === 'none') {
      table.weatherKind = '';
    } else {
      if (!WEATHER_KIND_NAMES.includes(kind))
        fail('INVALID_ARGUMENT', `weather must be none or one of ${SKY_AMBIENCE_KINDS.join(', ')}.`);
      table.weatherKind = kind;
      table.weatherDensity = density === undefined ? DEFAULT_AMBIENCE_DENSITY : this.density(density);
    }
    if (color !== undefined) table.weatherColor = this.color(color);
    return {
      identifier: table.identifier,
      weather: table.weatherKind || 'none',
      density: table.weatherDensity,
    };
  }

  private apply(area: TableAmbience, request: AmbienceAreaRequest) {
    if (request.name !== undefined && request.name.trim()) area.name = request.name.trim();
    if (request.density !== undefined) area.ambienceDensity = this.density(request.density);
    if (request.color !== undefined) area.ambienceColor = this.color(request.color);
    if (request.shownTo !== undefined) {
      if (!(SHOWN_TO as readonly string[]).includes(request.shownTo))
        fail('INVALID_ARGUMENT', `shownTo must be one of ${SHOWN_TO.join(', ')}.`);
      area.shownTo = request.shownTo;
    }
    if (request.blocksSight !== undefined) area.blocksSight = request.blocksSight;
    if (request.brightness !== undefined) {
      if (!(AMBIENCE_BRIGHTNESS as readonly string[]).includes(request.brightness))
        fail('INVALID_ARGUMENT', `brightness must be one of ${AMBIENCE_BRIGHTNESS.join(', ')}.`);
      area.brightness = request.brightness === 'none' ? '' : request.brightness;
    }
    if (request.surfaceHeight !== undefined)
      area.surfaceHeight = this.range(request.surfaceHeight, 'surfaceHeight', 10);
    if (request.turbidity !== undefined) area.turbidity = this.range(request.turbidity, 'turbidity', 1);
    if (request.dirtiness !== undefined) area.dirtiness = this.range(request.dirtiness, 'dirtiness', 1);
    if (request.floatingLeaves !== undefined)
      area.floatingLeaves = this.range(request.floatingLeaves, 'floatingLeaves', 1);
    if (request.flowSpeed !== undefined) area.flowSpeed = this.range(request.flowSpeed, 'flowSpeed', 1);
    if (request.flowDirection !== undefined)
      area.flowDirection = this.range(request.flowDirection, 'flowDirection', 359);
  }

  private describe(area: TableAmbience, grid: number) {
    return {
      identifier: area.identifier,
      name: area.name.slice(0, 256),
      kind: area.ambienceKind,
      x: area.location.x / grid,
      y: area.location.y / grid,
      w: area.width,
      h: area.height,
      unit: 'grid',
    };
  }

  private size(value: number, key: string): number {
    if (!Number.isFinite(value) || value < 1 || value > MAX_AREA)
      fail('INVALID_ARGUMENT', `${key} must be 1 to ${MAX_AREA} cells.`);
    return Math.round(value);
  }

  private range(value: number, key: string, max: number): number {
    if (!Number.isFinite(value) || value < 0 || value > max) fail('INVALID_ARGUMENT', `${key} must be 0 to ${max}.`);
    return value;
  }

  private density(value: string): number {
    if (!(value in DENSITY_NAMES)) fail('INVALID_ARGUMENT', 'density must be thin, normal or thick.');
    return DENSITY_NAMES[value as DensityName];
  }

  private color(value: string): string {
    if (value !== '' && !COLOR.test(value))
      fail('INVALID_ARGUMENT', 'color must be like #5ec4e8, or empty for the default.');
    return value;
  }
}
