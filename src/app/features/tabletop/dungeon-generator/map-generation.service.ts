import { inject, Injectable } from '@angular/core';
import { MapBuilt, MapRequest } from '@axe/application/automation/map-generator';
import { TRANSLATE_FN } from '@axe/application/i18n/translate.token';
import {
  DUNGEON_GRID_SIZE,
  DungeonBuildService,
  DungeonMaterial,
} from '@axe/application/tabletop/dungeon-build.service';
import { ImageStorage } from '@axe/core/storage/image-storage';
import { clampDoubleDoorPercent, doorWidthsFor } from '@axe/domain/tabletop/dungeon/door-hanging';
import {
  atmosphereById,
  clampWallHeight,
  DUNGEON_ATMOSPHERE_IDS,
  DungeonAtmosphereId,
} from '@axe/domain/tabletop/dungeon/dungeon-atmosphere';
import { corridorWidthsFor, planDungeon } from '@axe/domain/tabletop/dungeon/dungeon-generator';
import {
  clampFieldDensity,
  clampFieldSize,
  FIELD_ATMOSPHERE_IDS,
  fieldAtmosphereById,
  FieldAtmosphereId,
} from '@axe/domain/tabletop/field/field-atmosphere';
import { FieldPlan, planField } from '@axe/domain/tabletop/field/field-generator';
import { GridType } from '@axe/domain/tabletop/game-table';
import { MAP_MAX_TERRAINS, MapBlocks, MapSize } from '@axe/domain/tabletop/map-blocks';
import { exportSceneToBlob } from '@axe/features/map-editor/render/export-image';
import { describeDungeon } from '@axe/features/tabletop/dungeon-generator/dungeon-notes';
import { withFieldMaterials } from '@axe/features/tabletop/dungeon-generator/field-materials';
import { describeField } from '@axe/features/tabletop/dungeon-generator/field-notes';
import { buildGroundScene } from '@axe/features/tabletop/dungeon-generator/ground-scene';

type DungeonPlan = ReturnType<typeof planDungeon>;
export type ExportScene = typeof exportSceneToBlob;

/** A field stands on the walls of the default dungeon, as the generator panel lets it. */
const FIELD_WALL_HEIGHT_FROM: DungeonAtmosphereId = 'stoneDungeon';

/**
 * Generates a map and builds a table from it: the work the map generator panel does when the
 * master presses the button, done here so that it can also be asked for without the panel.
 *
 * A map asked for here is built as the panel builds one left at its defaults: the atmosphere picks
 * the materials, the passages, the doors and the way in.
 */
@Injectable({ providedIn: 'root' })
export class MapGenerationService {
  private readonly dungeonBuild = inject(DungeonBuildService);
  private readonly imageStorage = inject(ImageStorage);
  private readonly t = inject(TRANSLATE_FN);

  /**
   * Paints the ground and hands back the picture the table wears, already in storage.
   *
   * Nothing is left of the map if the canvas will not draw, so a failure costs the floor rather than
   * the table, and answers an empty identifier.
   */
  async paintFloor(
    plan: { layout: MapSize; blocks: MapBlocks; atmosphere: unknown },
    floor: DungeonMaterial,
    gridType: GridType,
    exportScene: ExportScene = exportSceneToBlob
  ): Promise<string> {
    const hazardId = (plan.atmosphere as { cave?: { hazardFloor?: string } }).cave?.hazardFloor ?? '';
    const scene = buildGroundScene(
      plan.layout,
      plan.blocks.paint,
      { floor, hazard: hazardId ? { kind: 'texture', id: hazardId } : floor },
      DUNGEON_GRID_SIZE,
      gridType
    );
    try {
      const blob = await exportScene(scene, [], {
        drawGrid: false,
        resolveImageUrl: (id) => this.imageStorage.get(id)?.url ?? null,
      });
      return (await this.imageStorage.addAsync(blob)).identifier;
    } catch {
      return '';
    }
  }

  /**
   * Builds the table for the map asked for, with the master's notes on it and, for a dungeon, where
   * each room is. Fails for an atmosphere there is none of, or a map with more on it than a table
   * can hold.
   */
  async generate(request: MapRequest): Promise<MapBuilt> {
    return request.kind === 'dungeon' ? this.dungeon(request) : this.field(request);
  }

  private async dungeon(request: MapRequest): Promise<MapBuilt> {
    if (!(DUNGEON_ATMOSPHERE_IDS as readonly string[]).includes(request.atmosphere))
      throw new RangeError(
        `No dungeon atmosphere ${request.atmosphere}; use one of ${DUNGEON_ATMOSPHERE_IDS.join(', ')}.`
      );
    const atmosphere = atmosphereById(request.atmosphere);
    const plan: DungeonPlan = planDungeon(
      {
        atmosphere: atmosphere.id,
        roomCount: request.roomCount ?? 8,
        seed: request.seed,
        entrance: atmosphere.entrance,
        corridorWidth: corridorWidthsFor(atmosphere),
        doorWidth: doorWidthsFor(),
        doubleDoorPercent: clampDoubleDoorPercent(undefined),
        trapCount: request.trapCount ?? 0,
        gridType: GridType.SQUARE,
      },
      { placeDoors: true, placeStairs: true, sheerWalls: false }
    );
    const name = request.name || this.t(`feature.tabletop.dungeonGenerator.atmosphere.${atmosphere.id}`);
    const roles = atmosphere.roleNames
      ? `feature.tabletop.dungeonGenerator.roleIn.${atmosphere.roleNames}`
      : 'feature.tabletop.dungeonGenerator.role';
    const built = await this.build(plan, name, {
      wall: { kind: 'texture', id: atmosphere.defaultWall },
      floor: { kind: 'texture', id: atmosphere.defaultFloor },
      wallHeight: clampWallHeight(atmosphere.wallHeight),
      summary: describeDungeon(plan.layout, plan.blocks, name, this.t, atmosphere.roleNames),
      fog: request.fog,
    });
    return {
      ...built,
      entrance: { ...plan.layout.entrance },
      rooms: plan.layout.rooms.map((room) => ({
        number: room.index + 1,
        role: this.t(`${roles}.${room.role}`),
        x: room.x,
        y: room.y,
        w: room.w,
        h: room.h,
      })),
      traps: (plan.layout.traps ?? []).map((trap) => ({
        x: trap.x,
        y: trap.y,
        kind: this.t(`feature.tabletop.dungeonGenerator.trap.${trap.kind}`),
      })),
    };
  }

  private async field(request: MapRequest): Promise<MapBuilt> {
    if (!(FIELD_ATMOSPHERE_IDS as readonly string[]).includes(request.atmosphere))
      throw new RangeError(`No field atmosphere ${request.atmosphere}; use one of ${FIELD_ATMOSPHERE_IDS.join(', ')}.`);
    const atmosphere = fieldAtmosphereById(request.atmosphere as FieldAtmosphereId);
    const floor: DungeonMaterial = { kind: 'texture', id: atmosphere.defaultGround };
    const shape = planField({
      atmosphere: atmosphere.id,
      size: clampFieldSize(request.size ?? 40),
      density: clampFieldDensity(request.density ?? 50),
      seed: request.seed,
      gridType: GridType.SQUARE,
    });
    const plan: FieldPlan = { ...shape, blocks: withFieldMaterials(shape.blocks, shape.atmosphere, floor, null) };
    const name = request.name || this.t(`feature.tabletop.dungeonGenerator.field.${atmosphere.id}`);
    const built = await this.build(plan, name, {
      wall: { kind: 'texture', id: atmosphere.defaultProp },
      floor,
      wallHeight: clampWallHeight(atmosphereById(FIELD_WALL_HEIGHT_FROM).wallHeight),
      summary: describeField(plan, name, request.seed, this.t),
      fog: request.fog,
    });
    return { ...built, entrance: null, rooms: [], traps: [] };
  }

  private async build(
    plan: DungeonPlan | FieldPlan,
    name: string,
    look: { wall: DungeonMaterial; floor: DungeonMaterial; wallHeight: number; summary: string; fog: boolean }
  ) {
    if (plan.blocks.blocks.length > MAP_MAX_TERRAINS)
      throw new RangeError(`The map would stand ${plan.blocks.blocks.length} blocks, more than a table holds.`);
    const result = await this.dungeonBuild.build(plan.layout, plan.atmosphere, plan.blocks, {
      name,
      wall: look.wall,
      wallHeight: look.wallHeight,
      floorImage: await this.paintFloor(plan, look.floor, GridType.SQUARE),
      summary: look.summary,
      gridType: GridType.SQUARE,
      fogEnabled: look.fog,
    });
    return { table: result.table, summary: result.summary, width: plan.layout.width, height: plan.layout.height };
  }
}
