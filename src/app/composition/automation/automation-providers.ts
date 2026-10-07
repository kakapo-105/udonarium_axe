import { inject, Injector, Provider } from '@angular/core';
import { MAP_GENERATOR, MapGenerator } from '@axe/application/automation/map-generator';

/**
 * What automation is handed from the layers above it: the map generator panel's way of building a
 * map. It draws with the map editor, so it is loaded the first time a map is asked for rather than
 * with the app.
 */
export const AUTOMATION_PROVIDERS: Provider[] = [
  {
    provide: MAP_GENERATOR,
    useFactory: (): MapGenerator => {
      const injector = inject(Injector);
      return async (request) => {
        const { MapGenerationService } =
          await import('@axe/features/tabletop/dungeon-generator/map-generation.service');
        return injector.get(MapGenerationService).generate(request);
      };
    },
  },
];
