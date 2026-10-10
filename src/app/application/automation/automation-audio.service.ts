import { inject, Injectable } from '@angular/core';
import { fail, onlyKeys, record, textArgument } from '@axe/application/automation/automation-contract';
import { AudioState } from '@axe/core/storage/audio-file';
import { AudioStorage } from '@axe/core/storage/audio-storage';
import { calcSHA256Async } from '@axe/core/storage/file-reader-util';

export const MAX_AUTOMATION_AUDIOS = 10;
/** As large a sound as a dropped file may be. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** A sound of up to 10 MB, as base64 grows it. */
const MAX_AUDIO_BASE64 = 14_000_000;
const AUDIO_IDENTIFIER = /^[0-9a-f]{64}$/;
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'audio/flac',
]);

/** A sound automation brings, as its bytes in base64 with the SHA-256 that identifies it and a name to list it by. */
export interface AutomationAudio {
  identifier: string;
  type: string;
  name: string;
  data: string;
}

/** The sounds an automation request brings, each with its identifier, type, name and base64 bytes as strings. */
export function automationAudiosOf(value: unknown): AutomationAudio[] {
  if (!Array.isArray(value) || value.length > MAX_AUTOMATION_AUDIOS)
    fail('INVALID_ARGUMENT', `audios must list at most ${MAX_AUTOMATION_AUDIOS} sounds.`);
  return value.map((audio) => {
    const sound = record(audio);
    onlyKeys(sound, ['identifier', 'type', 'name', 'data']);
    return {
      identifier: textArgument(sound['identifier'], 64),
      type: textArgument(sound['type'], 64),
      name: textArgument(sound['name'], 256),
      data: textArgument(sound['data'], MAX_AUDIO_BASE64),
    };
  });
}

/**
 * Takes in the sounds automation brings for table music and cut-ins, as a dropped sound is taken in:
 * each kept under the SHA-256 of its bytes, which is what a table's music and a cut-in's sounds name,
 * so a room that points at a sound it was saved without finds it again.
 */
@Injectable({ providedIn: 'root' })
export class AutomationAudioService {
  private readonly audioStorage = inject(AudioStorage);

  /**
   * Checks every sound before any is added, answering the files to add; one the room has already is
   * left out. Fails when any is not what its identifier names.
   */
  async check(audios: readonly AutomationAudio[]): Promise<File[]> {
    const files = await Promise.all(audios.map((audio) => this.checkOne(audio)));
    return files.filter((file): file is File => file !== null);
  }

  /** Adds sounds already checked. */
  async add(files: readonly File[]): Promise<void> {
    for (const file of files) await this.audioStorage.addAsync(file);
  }

  /** Whether the room holds the whole of a sound, ready to play. */
  has(identifier: string): boolean {
    const audio = this.audioStorage.get(identifier);
    return audio != null && audio.state >= AudioState.COMPLETE;
  }

  private async checkOne(audio: AutomationAudio): Promise<File | null> {
    if (!AUDIO_IDENTIFIER.test(audio.identifier)) fail('INVALID_ARGUMENT', 'An audio identifier is not a SHA-256.');
    if (!AUDIO_TYPES.has(audio.type)) fail('INVALID_ARGUMENT', `Sounds of type ${audio.type} are not taken.`);
    if (this.has(audio.identifier)) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0));
    } catch {
      return fail('INVALID_ARGUMENT', 'A sound is not base64.');
    }
    if (bytes.length > MAX_AUDIO_BYTES) fail('INVALID_ARGUMENT', 'A sound is too large.');
    if ((await calcSHA256Async(bytes.buffer)) !== audio.identifier)
      fail('INVALID_ARGUMENT', 'A sound is not the one its identifier names.');
    return new File([bytes], audio.name, { type: audio.type });
  }
}
