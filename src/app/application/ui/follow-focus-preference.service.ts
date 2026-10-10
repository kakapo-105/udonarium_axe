import { Injectable, signal } from '@angular/core';

export const FOLLOW_FOCUS_STORAGE_KEY = 'ui-follow-gm-focus';

/**
 * Whether this reader's view glides to where the game master points everyone.
 *
 * On unless turned off, and kept in this browser: it is a way of looking, as the view mode is, and
 * one player who would rather look about for themselves does not stop the others following.
 */
@Injectable({ providedIn: 'root' })
export class FollowFocusPreferenceService {
  readonly enabled = signal<boolean>(stored());

  /** Turns following the game master's pointing on or off in this browser. */
  set(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      if (enabled) localStorage.removeItem(FOLLOW_FOCUS_STORAGE_KEY);
      else localStorage.setItem(FOLLOW_FOCUS_STORAGE_KEY, '0');
    } catch {
      // Private browsing refuses the write; the choice still holds for this session.
    }
  }
}

function stored(): boolean {
  try {
    return localStorage.getItem(FOLLOW_FOCUS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
