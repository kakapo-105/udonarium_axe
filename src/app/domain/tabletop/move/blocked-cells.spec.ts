import { CellBits } from '@axe/domain/tabletop/fog/cell-bits';
import { cellCount, cellGridOf, cellIndexOf } from '@axe/domain/tabletop/fog/cell-grid';
import { GridType } from '@axe/domain/tabletop/grid-type';
import { nearestOpenCell, terrainBlocksMovement } from '@axe/domain/tabletop/move/blocked-cells';
import { DoorStyle, Terrain, TerrainViewState } from '@axe/domain/tabletop/terrain';

function block(): Terrain {
  return Terrain.create('block', 1, 1, 1, '', '');
}

describe('terrainBlocksMovement', () => {
  it('stops a piece at a wall', () => {
    const wall = block();
    wall.mode = TerrainViewState.ALL;

    expect(terrainBlocksMovement(wall)).toBe(true);
  });

  it('lets a piece over a floor laid flat', () => {
    const floor = block();
    floor.mode = TerrainViewState.FLOOR;

    expect(terrainBlocksMovement(floor)).toBe(false);
  });

  it('stops a piece at a flat block too sheer to get up', () => {
    const cliff = block();
    cliff.mode = TerrainViewState.FLOOR;
    cliff.blocksClimb = true;

    expect(terrainBlocksMovement(cliff)).toBe(true);
  });

  it('lets a piece through a door standing open, sheer or not', () => {
    const door = block();
    door.mode = TerrainViewState.ALL;
    door.blocksClimb = true;
    door.doorStyle = DoorStyle.SWING;
    door.isDoorOpen = true;

    expect(terrainBlocksMovement(door)).toBe(false);
  });

  it('lets a piece past anything hung on a wall of the table', () => {
    const shelf = block();
    shelf.blocksClimb = true;
    shelf.location.surface = 'north-wall';

    expect(terrainBlocksMovement(shelf)).toBe(false);
  });
});

describe('nearestOpenCell', () => {
  const grid = cellGridOf(5, 5, 50, GridType.SQUARE);

  function walled(...cells: [number, number][]): CellBits {
    const bits = new CellBits(cellCount(grid));
    for (const [col, row] of cells) bits.set(cellIndexOf(grid, col, row));
    return bits;
  }

  it('keeps a cell nothing stands on', () => {
    expect(nearestOpenCell(grid, walled([0, 0]), cellIndexOf(grid, 2, 2))).toBe(cellIndexOf(grid, 2, 2));
  });

  it('stands a piece put inside a building on the nearest open cell beside it', () => {
    const building: [number, number][] = [];
    for (let col = 1; col <= 3; col++) for (let row = 1; row <= 3; row++) building.push([col, row]);

    const open = nearestOpenCell(grid, walled(...building), cellIndexOf(grid, 2, 2));

    expect(open).toBe(cellIndexOf(grid, 0, 0));
  });

  it('answers -1 when nowhere is open', () => {
    const all: [number, number][] = [];
    for (let col = 0; col < 5; col++) for (let row = 0; row < 5; row++) all.push([col, row]);

    expect(nearestOpenCell(grid, walled(...all), cellIndexOf(grid, 2, 2))).toBe(-1);
  });
});
