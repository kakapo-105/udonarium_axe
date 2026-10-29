import { CellBits } from '@axe/domain/tabletop/fog/cell-bits';
import { cellCount, CellGrid, forEachCellInBox, forEachNeighbourCell } from '@axe/domain/tabletop/fog/cell-grid';
import { isSquareGrid, squaresClosedBy } from '@axe/domain/tabletop/move/move-grid';
import { surfaceOf } from '@axe/domain/tabletop/tabletop-object';
import { Terrain } from '@axe/domain/tabletop/terrain';
import { terrainBoxOf } from '@axe/domain/tabletop/terrain-box';

/**
 * Whether a terrain piece stands in the way of a piece walking: a block on the floor with walls or a face too
 * sheer to climb.
 *
 * An open door lets pieces through, and terrain that is not on the floor never blocks.
 */
export function terrainBlocksMovement(terrain: Terrain): boolean {
  if (surfaceOf(terrain) !== 'floor') return false;
  if (!terrain.hasWall && !terrain.blocksClimb) return false;
  return !(terrain.isDoor && terrain.isDoorOpen);
}

/**
 * What still stands in the way of a piece that means to jump.
 *
 * Height is no answer to a piece that can leave the ground, so a block it could get on top of
 * is somewhere to land rather than something to walk around. A face too sheer to climb is the
 * one thing a jump does not answer.
 */
export function terrainBlocksJump(terrain: Terrain): boolean {
  if (surfaceOf(terrain) !== 'floor') return false;
  if (!terrain.blocksClimb) return false;
  return !(terrain.isDoor && terrain.isDoorOpen);
}

/**
 * The cells covered by terrain that stops a piece, judged by `stops`: walking by default, or
 * {@link terrainBlocksJump} for a piece that jumps.
 *
 * Empty for a grid with no cell size. On a grid of squares, the cells are worked out first and a
 * square is closed where they run right across it, as {@link squaresClosedBy} has it.
 */
export function blockedByTerrain(
  grid: CellGrid,
  terrains: readonly Terrain[],
  stops: (terrain: Terrain) => boolean = terrainBlocksMovement
): CellBits {
  if (isSquareGrid(grid)) return squaresClosedBy(grid, blockedByTerrain(grid.fine, terrains, stops));
  const bits = new CellBits(cellCount(grid));
  if (grid.sizePx <= 0) return bits;
  for (const terrain of terrains) {
    if (!stops(terrain)) continue;
    const box = terrainBoxOf(terrain, grid.sizePx);
    forEachCellInBox(grid, box.minX, box.minY, box.maxX, box.maxY, (cell) => bits.set(cell));
  }
  return bits;
}

/**
 * The open cell nearest `from`, counting steps to the cells around: `from` itself when nothing
 * stands on it, or -1 when every cell is taken or `from` is off the grid.
 *
 * It is how a piece set down inside a building or a wall is stood beside it instead.
 */
export function nearestOpenCell(grid: CellGrid, blocked: CellBits, from: number): number {
  const count = cellCount(grid);
  if (from < 0 || from >= count) return -1;
  if (!blocked.get(from)) return from;
  const seen = new CellBits(count);
  seen.set(from);
  let ring = [from];
  while (ring.length > 0) {
    const next: number[] = [];
    for (const cell of ring) {
      forEachNeighbourCell(grid, cell, (neighbour) => {
        if (seen.get(neighbour)) return;
        seen.set(neighbour);
        next.push(neighbour);
      });
    }
    // The lowest index of a ring wins, so the same board always gives the same cell.
    const open = next.filter((cell) => !blocked.get(cell));
    if (open.length > 0) return Math.min(...open);
    ring = next;
  }
  return -1;
}
