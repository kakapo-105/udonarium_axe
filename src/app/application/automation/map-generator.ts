import { InjectionToken } from '@angular/core';
import { GameTable } from '@axe/domain/tabletop/game-table';

/** A generated map asked for: a dungeon or a field, in one of its atmospheres, rolled from a seed. */
export interface MapRequest {
  kind: 'dungeon' | 'field';
  atmosphere: string;
  seed: number;
  /** The table's name; left empty, the atmosphere's own. */
  name: string;
  /** A dungeon's rooms. */
  roomCount?: number;
  /** A dungeon's traps. */
  trapCount?: number;
  /** A field's width in cells. */
  size?: number;
  /** How thickly a field is set with what stands on it, as a percentage. */
  density?: number;
  /** Whether the table starts under the fog of war. */
  fog: boolean;
}

/** One room of a generated dungeon, in cells from the table's top-left corner. */
export interface MapRoom {
  number: number;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapBuilt {
  table: GameTable;
  /** The master's notes on the place, as the generator panel shows them. */
  summary: string;
  width: number;
  height: number;
  /** Where the party comes in, in cells; none for a field. */
  entrance: { x: number; y: number } | null;
  rooms: MapRoom[];
  traps: { x: number; y: number; kind: string }[];
}

export type MapGenerator = (request: MapRequest) => Promise<MapBuilt>;

/**
 * Builds a table from a generated map, as the map generator panel does.
 *
 * The generator draws its ground with the map editor, which sits above this layer, so the
 * composition root hands it in. Left unprovided, there is nothing to generate with.
 */
export const MAP_GENERATOR = new InjectionToken<MapGenerator | null>('MAP_GENERATOR', {
  providedIn: 'root',
  factory: () => null,
});
