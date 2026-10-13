import { TestBed } from '@angular/core/testing';
import { VOICE_STORAGE_KEY, VoicePreferenceService } from '@axe/application/voice/voice-preference.service';

describe('VoicePreferenceService', () => {
  afterEach(() => localStorage.removeItem(VOICE_STORAGE_KEY));

  it('is off until turned on, and remembers being turned on in this browser', () => {
    expect(TestBed.inject(VoicePreferenceService).enabled()).toBe(false);

    TestBed.inject(VoicePreferenceService).set(true);
    expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBe('1');

    TestBed.resetTestingModule();
    const again = TestBed.inject(VoicePreferenceService);
    expect(again.enabled()).toBe(true);
    again.set(false);
    expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBeNull();
  });
});
