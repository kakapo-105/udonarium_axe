import { TestBed } from '@angular/core/testing';
import { MapRequest } from '@axe/application/automation/map-generator';
import { ImageStorage } from '@axe/core/storage/image-storage';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { MapGenerationService } from '@axe/features/tabletop/dungeon-generator/map-generation.service';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('MapGenerationService', () => {
  let service: MapGenerationService;

  function wipe(): void {
    // The picture store outlives the object store, so a picture made in one test would linger in the next.
    for (const image of ImageStorage.instance.images) ImageStorage.instance.delete(image.identifier);
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...TEST_PROVIDERS] });
    wipe();
    service = TestBed.inject(MapGenerationService);
  });

  afterEach(() => {
    for (const table of ObjectStore.instance.getObjects<GameTable>(GameTable)) table.destroy();
    wipe();
  });

  const request = (overrides: Partial<MapRequest> = {}): MapRequest => ({
    kind: 'dungeon',
    atmosphere: 'stoneDungeon',
    seed: 7,
    name: '',
    roomCount: 5,
    fog: false,
    ...overrides,
  });

  it('builds a dungeon table and says where its way in and each of its rooms lie', async () => {
    const built = await service.generate(request({ name: 'ゴブリンの洞窟', trapCount: 2 }));

    expect(ObjectStore.instance.get(built.table.identifier)).toBe(built.table);
    expect(built.table.name).toBe('ゴブリンの洞窟');
    expect(built.rooms.length).toBeGreaterThanOrEqual(3);
    for (const room of built.rooms) {
      expect(room.x + room.w).toBeLessThanOrEqual(built.width);
      expect(room.y + room.h).toBeLessThanOrEqual(built.height);
      expect(room.role.length).toBeGreaterThan(0);
    }
    expect(built.rooms.map((room) => room.number)).toEqual(built.rooms.map((_, index) => index + 1));
    expect(built.entrance).not.toBeNull();
    expect(built.traps).toHaveLength(2);
    expect(built.summary).toContain('ゴブリンの洞窟');
  });

  it('rolls the same dungeon again from the same seed', async () => {
    const first = await service.generate(request());
    const second = await service.generate(request());

    expect(second.rooms).toEqual(first.rooms);
  });

  it('builds a field with no rooms to speak of, named after its atmosphere when given no name', async () => {
    const built = await service.generate(request({ kind: 'field', atmosphere: 'woodland', size: 30 }));

    expect(built.rooms).toEqual([]);
    expect(built.entrance).toBeNull();
    expect(built.width).toBe(30);
    expect(built.table.name.length).toBeGreaterThan(0);
  });

  it('refuses an atmosphere there is none of, building nothing', async () => {
    await expect(service.generate(request({ atmosphere: 'moon' }))).rejects.toThrow(RangeError);
    await expect(service.generate(request({ kind: 'field', atmosphere: 'crypt' }))).rejects.toThrow(RangeError);
    expect(ObjectStore.instance.getObjects(GameTable)).toHaveLength(0);
  });
});
