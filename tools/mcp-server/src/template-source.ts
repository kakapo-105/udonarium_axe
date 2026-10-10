import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { type FacadeResult, failure } from '#mcp/facade-client.js';

/** As many pictures and sounds as the browser takes in one request. */
const MAX_IMAGES = 20;
const MAX_AUDIOS = 10;
/** The browser refuses larger ones, so they are named rather than sent. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ROOM_BYTES = 4_000_000;
const MAX_PART_BYTES = 200_000;
const MAX_NOTES_BYTES = 50_000;
/** The master's notes kept beside a saved room: what it is for and how each of its tables is used. */
const NOTES_FILE = 'template.json';
const IMAGE_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};
const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  flac: 'audio/flac',
};
const SAVED_PICTURE = /^([0-9a-f]{64})\.([a-z0-9]+)$/;
/** Where a saved room names a sound: a table's music, a cut-in's sound and the sounds of its scene. */
const HEARD = [
  /\bbgm="([0-9a-f]{64})"/g,
  /\baudioIdentifier="([0-9a-f]{64})"/g,
  /&quot;a&quot;:&quot;([0-9a-f]{64})&quot;/g,
];

export interface TemplateImage {
  identifier: string;
  type: string;
  data: string;
}
export interface TemplateAudio extends TemplateImage {
  name: string;
}

/** A sound in a folder the master keeps, known by the SHA-256 of its bytes as the room knows it. */
export interface AudioEntry {
  identifier: string;
  file: string;
  name: string;
  type: string;
  size: number;
}

/** Where the master keeps room templates and sounds on this machine. */
export interface TemplateFolders {
  /** A folder holding one folder per template, each an unzipped room save. */
  templates?: string;
  /** Folders of sounds; a template's own folder is searched as well. */
  audio?: readonly string[];
  /** The folder of pictures: backgrounds, portraits and textures, with an index.json saying what each is. */
  images?: string;
}

export interface LoadedTemplate {
  room: string;
  config?: string;
  audioTags?: string;
  images: TemplateImage[];
  audios: TemplateAudio[];
  /** What `template.json` says, for the model to read: how each table is laid out and used. */
  notes?: Record<string, unknown>;
  warnings: string[];
}

/** One template's folder under the templates folder, refusing any name that would lead out of it. */
function templateFolder(root: string, name: string): string {
  const base = path.resolve(root);
  const folder = path.resolve(base, name);
  if (path.dirname(folder) !== base || path.basename(folder) !== name) throw new RangeError('Bad template name.');
  return folder;
}

async function readOptional(file: string, max: number): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > max) throw new RangeError(`${path.basename(file)} is too large.`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The names of the tables a saved room holds, in its own order. */
export function tableNamesOf(room: string): string[] {
  return [...room.matchAll(/<game-table\b[^>]*?\sname="([^"]*)"/g)].map((match) => unescapeXml(match[1]));
}

async function readNotes(folder: string): Promise<Record<string, unknown> | undefined> {
  const text = await readOptional(path.join(folder, NOTES_FILE), MAX_NOTES_BYTES);
  if (text === undefined) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Not an object.');
  return parsed as Record<string, unknown>;
}

/** The templates kept in the templates folder, each with the tables it holds and what its notes say it is for. */
export async function listTemplates(
  folders: TemplateFolders
): Promise<{ name: string; tables: string[]; description?: unknown }[]> {
  if (!folders.templates) return [];
  const entries = await readdir(folders.templates, { withFileTypes: true }).catch(() => []);
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const room = await readOptional(path.join(folders.templates, entry.name, 'data.xml'), MAX_ROOM_BYTES).catch(
      () => undefined
    );
    if (room === undefined) continue;
    const notes = await readNotes(path.join(folders.templates, entry.name)).catch(() => undefined);
    templates.push({
      name: entry.name,
      tables: tableNamesOf(room),
      ...(notes?.['description'] !== undefined ? { description: notes['description'] } : {}),
    });
  }
  return templates;
}

/**
 * The sounds in the given folders, each known by the SHA-256 of its bytes. Hashes are kept while a
 * file keeps its size and time, so a large library is read once.
 */
export class AudioLibrary {
  private readonly hashes = new Map<string, { size: number; mtime: number; identifier: string }>();

  async entries(folders: readonly string[]): Promise<AudioEntry[]> {
    const found: AudioEntry[] = [];
    for (const folder of folders) {
      const files = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        const type = AUDIO_TYPES[path.extname(file.name).slice(1).toLowerCase()];
        if (!file.isFile() || !type) continue;
        const full = path.join(folder, file.name);
        const info = await stat(full);
        if (info.size > MAX_AUDIO_BYTES) continue;
        let known = this.hashes.get(full);
        if (!known || known.size !== info.size || known.mtime !== info.mtimeMs) {
          const identifier = createHash('sha256')
            .update(await readFile(full))
            .digest('hex');
          known = { size: info.size, mtime: info.mtimeMs, identifier };
          this.hashes.set(full, known);
        }
        found.push({ identifier: known.identifier, file: full, name: file.name, type, size: info.size });
      }
    }
    return found;
  }

  /** A sound's bytes in base64, to hand to the browser. */
  async read(entry: AudioEntry): Promise<TemplateAudio> {
    return {
      identifier: entry.identifier,
      type: entry.type,
      name: entry.name,
      data: (await readFile(entry.file)).toString('base64'),
    };
  }
}

/**
 * Reads a template from the templates folder: the room, its settings and sound tags, the pictures
 * kept with it, and the sounds it names from the template's folder or the sound folders. What is
 * missing or too many is said in the warnings, and the room is built without it.
 */
export async function loadTemplate(
  folders: TemplateFolders,
  library: AudioLibrary,
  name: string
): Promise<LoadedTemplate | FacadeResult> {
  if (!folders.templates)
    return failure('NOT_READY', 'No templates folder is set. Start the MCP server with UDONARIUM_TEMPLATE_DIR.');
  let folder: string;
  try {
    folder = templateFolder(folders.templates, name);
  } catch {
    return failure('INVALID_ARGUMENT', 'A template is named by its folder alone.');
  }
  let room: string | undefined;
  let config: string | undefined;
  let audioTags: string | undefined;
  try {
    room = await readOptional(path.join(folder, 'data.xml'), MAX_ROOM_BYTES);
    config = await readOptional(path.join(folder, 'config.xml'), MAX_PART_BYTES);
    audioTags = await readOptional(path.join(folder, 'audiotag.xml'), MAX_PART_BYTES);
  } catch (error) {
    return failure('INVALID_ARGUMENT', error instanceof RangeError ? error.message : 'The template cannot be read.');
  }
  if (room === undefined) {
    const known = (await listTemplates(folders)).map((template) => template.name);
    return failure('NOT_FOUND', `No template ${name}. Templates: ${known.join(', ') || 'none'}.`);
  }
  const warnings: string[] = [];
  let notes: Record<string, unknown> | undefined;
  try {
    notes = await readNotes(folder);
  } catch {
    warnings.push(`${NOTES_FILE} is not a JSON object and was left out.`);
  }

  const images: TemplateImage[] = [];
  for (const file of await readdir(folder)) {
    const match = SAVED_PICTURE.exec(file);
    const type = match && IMAGE_TYPES[match[2]];
    if (!match || !type || !room.includes(match[1])) continue;
    const bytes = await readFile(path.join(folder, file));
    if (bytes.length > MAX_IMAGE_BYTES) warnings.push(`Picture ${file} is over 2 MB and was left out.`);
    else if (images.length >= MAX_IMAGES) warnings.push(`Picture ${file} was left out: at most ${MAX_IMAGES}.`);
    else images.push({ identifier: match[1], type, data: bytes.toString('base64') });
  }

  const heard = new Set(HEARD.flatMap((pattern) => [...room.matchAll(pattern)].map((match) => match[1])));
  const sounds = await library.entries([folder, ...(folders.audio ?? [])]);
  const audios: TemplateAudio[] = [];
  for (const identifier of heard) {
    const entry = sounds.find((sound) => sound.identifier === identifier);
    if (!entry) warnings.push(`No sound file for ${identifier}; put the original file in the sound folder.`);
    else if (audios.length >= MAX_AUDIOS) warnings.push(`Sound ${entry.name} was left out: at most ${MAX_AUDIOS}.`);
    else audios.push(await library.read(entry));
  }
  return { room, config, audioTags, images, audios, notes, warnings };
}

/** A picture in the master's image folder, by its path inside it, with what the folder's index says of it. */
export interface ImageEntry {
  file: string;
  full: string;
  type: string;
  size: number;
  kind?: string;
  tags?: string[];
  note?: string;
}

const IMAGE_INDEX = 'index.json';
const MAX_IMAGE_DEPTH = 3;

/**
 * The pictures in the master's image folder: backgrounds, NPC portraits and textures for floors and
 * walls. `index.json` in the folder says what each is ({"<path>": {"kind", "tags", "note"}}), so the
 * model can choose one without looking at it.
 */
export class ImageLibrary {
  constructor(private readonly folder: string | undefined) {}

  async entries(): Promise<ImageEntry[]> {
    if (!this.folder) return [];
    const index = await this.index();
    const found: ImageEntry[] = [];
    const walk = async (folder: string, prefix: string, depth: number) => {
      const files = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        const full = path.join(folder, file.name);
        const relative = prefix ? `${prefix}/${file.name}` : file.name;
        if (file.isDirectory()) {
          if (depth < MAX_IMAGE_DEPTH) await walk(full, relative, depth + 1);
          continue;
        }
        const type = IMAGE_TYPES[path.extname(file.name).slice(1).toLowerCase()];
        if (!file.isFile() || !type) continue;
        const size = (await stat(full)).size;
        const said = index[relative] ?? {};
        found.push({
          file: relative,
          full,
          type,
          size,
          ...(typeof said['kind'] === 'string' ? { kind: said['kind'] } : {}),
          ...(Array.isArray(said['tags']) ? { tags: said['tags'].map(String) } : {}),
          ...(typeof said['note'] === 'string' ? { note: said['note'] } : {}),
        });
      }
    };
    await walk(this.folder, '', 0);
    return found;
  }

  /** One picture by its path in the folder, read for the browser with its SHA-256; an error to show if it cannot be. */
  async read(file: string): Promise<TemplateImage | FacadeResult> {
    if (!this.folder)
      return failure('NOT_READY', 'No image folder is set. Start the MCP server with UDONARIUM_IMAGE_DIR.');
    const entry = (await this.entries()).find((image) => image.file === file);
    if (!entry) return failure('NOT_FOUND', `No picture ${file} in the image folder.`);
    if (entry.size > MAX_IMAGE_BYTES) return failure('INVALID_ARGUMENT', `Picture ${file} is over 2 MB.`);
    const bytes = await readFile(entry.full);
    return {
      identifier: createHash('sha256').update(bytes).digest('hex'),
      type: entry.type,
      data: bytes.toString('base64'),
    };
  }

  private async index(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.folder!, IMAGE_INDEX), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, Record<string, unknown>>)
        : {};
    } catch {
      return {};
    }
  }
}
