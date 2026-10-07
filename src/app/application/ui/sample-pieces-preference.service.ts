import { Injectable, signal } from '@angular/core';

export const SAMPLE_PIECES_STORAGE_KEY = 'ui-sample-pieces';

/**
 * Whether this browser sets out the sample pieces, their party and the display items they are read
 * by, as the app comes up.
 *
 * They show a newcomer what a table can do, and stand in the way of a table that is being set up
 * for a session. Like the choice to run offline, it is a way of starting: read once on load, kept in
 * this browser, and taking effect on the next load. `samples=0` in the address turns them off for
 * that load alone, for a browser that is opened afresh each time, such as the one AI control drives.
 */
@Injectable({ providedIn: 'root' })
export class SamplePiecesPreferenceService {
  readonly enabled = signal<boolean>(stored() && !refusedByAddress());

  /** Turns the sample pieces on or off in this browser. It takes effect on the next load, not now. */
  set(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      if (enabled) localStorage.removeItem(SAMPLE_PIECES_STORAGE_KEY);
      else localStorage.setItem(SAMPLE_PIECES_STORAGE_KEY, '0');
    } catch {
      // Private browsing refuses the write; the choice still holds for this session.
    }
  }
}

function stored(): boolean {
  try {
    return localStorage.getItem(SAMPLE_PIECES_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function refusedByAddress(): boolean {
  try {
    return new URL(location.href).searchParams.get('samples') === '0';
  } catch {
    return false;
  }
}
