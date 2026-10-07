import { InjectionToken } from '@angular/core';

/**
 * Reads the address the page was opened at, for the choices made in it such as `samples=0`.
 *
 * Read through a token rather than from `location`, so that what an address asks for can be tried
 * without navigating, and without depending on whatever another test left in the global.
 */
export const PAGE_ADDRESS = new InjectionToken<() => string>('PAGE_ADDRESS', {
  providedIn: 'root',
  factory: () => () => location.href,
});
