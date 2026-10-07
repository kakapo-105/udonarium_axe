import { inject, Injectable } from '@angular/core';
import { fail, onlyKeys, record, textArgument } from '@axe/application/automation/automation-contract';
import { calcSHA256Async } from '@axe/core/storage/file-reader-util';
import { ImageState } from '@axe/core/storage/image-file';
import { ImageStorage } from '@axe/core/storage/image-storage';

export const MAX_AUTOMATION_IMAGES = 20;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** A picture of up to 2 MB, as base64 grows it. */
const MAX_IMAGE_BASE64 = 3_000_000;
const IMAGE_IDENTIFIER = /^[0-9a-f]{64}$/;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

/** A picture automation brings, as its bytes in base64 with the SHA-256 that identifies it. */
export interface AutomationImage {
  identifier: string;
  type: string;
  data: string;
}

/** The pictures an automation request brings, each with its identifier, type and base64 bytes as strings. */
export function automationImagesOf(value: unknown): AutomationImage[] {
  if (!Array.isArray(value) || value.length > MAX_AUTOMATION_IMAGES)
    fail('INVALID_ARGUMENT', `images must list at most ${MAX_AUTOMATION_IMAGES} pictures.`);
  return value.map((image) => {
    const picture = record(image);
    onlyKeys(picture, ['identifier', 'type', 'data']);
    return {
      identifier: textArgument(picture['identifier'], 64),
      type: textArgument(picture['type'], 64),
      data: textArgument(picture['data'], MAX_IMAGE_BASE64),
    };
  });
}

/**
 * Takes in the pictures automation brings for the pieces and tables it makes, as save data's
 * pictures are taken in: each kept under the SHA-256 that identifies it, after checking the bytes
 * are that picture, so the room shares it with everyone and a saved room keeps it.
 */
@Injectable({ providedIn: 'root' })
export class AutomationImageService {
  private readonly imageStorage = inject(ImageStorage);

  /**
   * Checks every picture before any is added, answering the files to add; one the room has already
   * is left out. Fails when any is not what its identifier names.
   */
  async check(images: readonly AutomationImage[]): Promise<File[]> {
    const files = await Promise.all(images.map((image) => this.checkOne(image)));
    return files.filter((file): file is File => file !== null);
  }

  /** Adds pictures already checked. */
  async add(files: readonly File[]): Promise<void> {
    for (const file of files) await this.imageStorage.addAsync(file);
  }

  private async checkOne(image: AutomationImage): Promise<File | null> {
    if (!IMAGE_IDENTIFIER.test(image.identifier)) fail('INVALID_ARGUMENT', 'An image identifier is not a SHA-256.');
    const extension = IMAGE_EXTENSIONS[image.type];
    if (!extension) fail('INVALID_ARGUMENT', `Images of type ${image.type} are not taken.`);
    const held = this.imageStorage.get(image.identifier);
    if (held && held.state >= ImageState.COMPLETE) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    } catch {
      return fail('INVALID_ARGUMENT', 'An image is not base64.');
    }
    if (bytes.length > MAX_IMAGE_BYTES) fail('INVALID_ARGUMENT', 'An image is too large.');
    if ((await calcSHA256Async(bytes.buffer)) !== image.identifier)
      fail('INVALID_ARGUMENT', 'An image is not the picture its identifier names.');
    // Named as save data names its pictures, so the identifier is kept rather than worked out again.
    return new File([bytes], `${image.identifier}.${extension}`, { type: image.type });
  }
}
