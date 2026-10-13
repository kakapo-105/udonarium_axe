import { Injectable, signal } from '@angular/core';

export const VOICE_STORAGE_KEY = 'voice-transcriber';

/**
 * Whether this browser takes spoken lines from the voice transcriber on this machine.
 *
 * Kept in this browser rather than the room, since the transcriber runs beside one seat: the one
 * who turns it on is the one whose machine hears the call. Turned on, a page joined from an
 * ordinary invite link connects as one opened with `voice=1` would.
 */
@Injectable({ providedIn: 'root' })
export class VoicePreferenceService {
  readonly enabled = signal<boolean>(stored());

  set(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      if (enabled) localStorage.setItem(VOICE_STORAGE_KEY, '1');
      else localStorage.removeItem(VOICE_STORAGE_KEY);
    } catch {
      // Private browsing refuses the write; the choice still holds for this session.
    }
  }
}

function stored(): boolean {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
