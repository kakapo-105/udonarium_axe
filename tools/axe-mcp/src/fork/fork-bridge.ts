import path from 'node:path';

import type { AgentToolDefinition } from '@axe/core/agent/agent-tools';
import { FORK_BRIDGE_TOOL_NAME } from '@axe/core/agent/fork-agent-tools';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { type FacadeResult, failure } from './facade-result';
import { FORK_BRIDGE_TOOLS, type ForkBridgeToolDefinition } from './fork-bridge-tools';
import { checkForkInput } from './fork-schema';
import {
  fetchBoardTemplate,
  type FetchBytes,
  fetchBytes as fetchBytesOverHttp,
  fetchPieceImages,
  fetchPieceSheets,
  type FetchText,
  fetchText as fetchTextOverHttp,
  pieceSourceOrigins,
} from './piece-source';
import { type ChatLine, readPreparedLines } from './prepared-lines';
import {
  AudioLibrary,
  audioNotes,
  ImageLibrary,
  listTemplates,
  loadTemplate,
  sameName,
  type TemplateFolders,
} from './template-source';

/** What the tab answers a call: its value, or why it refused. */
export type TabOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Hands the tab a tool call, giving it up after the time given. */
export type TabCall = (tool: string, args: Readonly<Record<string, unknown>>, timeoutMs: number) => Promise<TabOutcome>;

export interface ForkBridgeOptions {
  /** Origins character_create and table_create may fetch sheets and boards from. None, and only inline ones. */
  readonly pieceSources?: readonly string[];
  readonly fetchText?: FetchText;
  readonly fetchBytes?: FetchBytes;
  /** Waits between the lines of one chat_send; replaced in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Where room templates, sounds, pictures and scenario lines are kept on this machine. */
  readonly templates?: TemplateFolders;
}

/** How long the tab is given for a command, beyond which the facade gives up first. */
const DEFAULT_TIMEOUT_MS = 25_000;
/** A large generated map stands thousands of blocks; the facade gives it two minutes. */
const TABLE_CREATE_TIMEOUT_MS = 135_000;
/** A template brings its pictures and sounds, which the facade checks for a minute at most. */
const ROOM_TEMPLATE_TIMEOUT_MS = 75_000;
const AUDIO_TIMEOUT_MS = 75_000;
/** At most this many lines go in one chat_send. */
const MAX_CHAT_LINES = 20;
/** A scene or place heading stays alone on the screen this long more, so the change of scene lands. */
const HEADING_PAUSE_MS = 2000;
/** A line that only changes resources of the speaking piece, as chat_send takes them. */
const RESOURCE_LINE = /^:\S+(?:\s+:\S+)*$/u;
const RESOURCE_GAP_MS = 300;

/**
 * How long a line is given before the next follows: novel mode shows only the newest line, so one
 * that arrives while the last is still being typed out hides it. The wait covers typing at the slow
 * speed (60 ms a character) and a moment to read, within bounds.
 */
export function lineGapMs(text: string, style?: string): number {
  if (RESOURCE_LINE.test(text.trim())) return RESOURCE_GAP_MS;
  const gap = Math.min(15000, Math.max(1500, [...text].length * 60 + 1200));
  return style === 'scene' || style === 'location' ? gap + HEADING_PAUSE_MS : gap;
}

function timeoutFor(command: string, args: Readonly<Record<string, unknown>>): number {
  if (command === 'table_create') return TABLE_CREATE_TIMEOUT_MS;
  if (command === 'room_template_load') return ROOM_TEMPLATE_TIMEOUT_MS;
  if (command === 'bgm_play' || command === 'audio_restore' || command === 'table_set') return AUDIO_TIMEOUT_MS;
  if (command === 'vn_stage' && args['audios'] !== undefined) return AUDIO_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

function answer(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}

function refusal(result: FacadeResult): CallToolResult {
  const error = result.ok ? { code: 'failed', message: 'No error.' } : result.error;
  return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
}

function reply(result: FacadeResult): CallToolResult {
  return result.ok ? answer(result.data) : refusal(result);
}

const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The bridge's settings read from the environment, as tools/mcp-server read them. */
export function forkBridgeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ForkBridgeOptions {
  let pieceSources: string[] = [];
  try {
    pieceSources = pieceSourceOrigins(env['UDONARIUM_PIECE_SOURCES']);
  } catch (error) {
    console.error('UDONARIUM_PIECE_SOURCES:', error instanceof Error ? error.message : error);
  }
  return {
    pieceSources,
    templates: {
      templates: env['UDONARIUM_TEMPLATE_DIR'] || undefined,
      audio: (env['UDONARIUM_AUDIO_DIR'] ?? '').split(path.delimiter).filter((folder) => folder.trim().length > 0),
      images: env['UDONARIUM_IMAGE_DIR'] || undefined,
      scenarios: env['UDONARIUM_SCENARIO_DIR'] || undefined,
    },
  };
}

/**
 * The fork's tools that read this machine's files before the tab can act: the bridge reads the
 * pictures, sounds, room templates, scenario lines and sheets they name, and hands the tab the
 * facade command with what it read, through the one tool the tab keeps for it.
 */
export class ForkBridge {
  private readonly folders: TemplateFolders;
  private readonly library = new AudioLibrary();
  private readonly images: ImageLibrary;
  private readonly sleep: (ms: number) => Promise<void>;
  /** When the last line said has been read, so the next is not put over it in novel mode. */
  private readByAt = 0;

  constructor(private readonly options: ForkBridgeOptions = {}) {
    this.folders = options.templates ?? {};
    this.images = new ImageLibrary(this.folders.images);
    this.sleep = options.sleep ?? sleepFor;
  }

  has(name: string): boolean {
    return FORK_BRIDGE_TOOLS.some((tool) => tool.name === name);
  }

  /** Runs one of the tools for the AI, handing the tab what it needs through `tab`. */
  async call(name: string, input: Readonly<Record<string, unknown>>, tab: TabCall): Promise<CallToolResult> {
    const tool = FORK_BRIDGE_TOOLS.find((each) => each.name === name);
    if (!tool) return refusal(failure('unknown_tool', `There is no tool named ${name}.`));
    const problems = checkForkInput(tool.inputSchema, input);
    if (problems.length > 0) return refusal(failure('invalid_input', problems.join('; ')));
    return this.run(name, { ...input }, tab);
  }

  private invoke(command: string, args: Record<string, unknown>, tab: TabCall): Promise<FacadeResult> {
    return tab(FORK_BRIDGE_TOOL_NAME, { command, payload: JSON.stringify(args) }, timeoutFor(command, args)).then(
      (outcome) => (outcome.ok ? { ok: true, data: outcome.value } : { ok: false, error: { ...outcome.error } })
    );
  }

  private async waitForReading(): Promise<void> {
    const left = this.readByAt - Date.now();
    if (left > 0) await this.sleep(left);
  }

  private async run(name: string, given: Record<string, unknown>, tab: TabCall): Promise<CallToolResult> {
    const { folders, library, images, options } = this;
    let args = given;
    let warnings: string[] = [];
    let notes: Record<string, unknown> = {};

    if (name === 'room_template_list') {
      const sounds = await library.entries(folders.audio ?? []);
      const said = await audioNotes(folders.audio ?? []);
      return answer({
        templates: await listTemplates(folders),
        sounds: sounds.map((sound) => ({
          file: sound.name,
          identifier: sound.identifier,
          size: sound.size,
          ...(said[sound.name.normalize('NFC')] ?? {}),
        })),
        images: (await images.entries()).map(({ full: _full, ...image }) => image),
      });
    }

    if (name === 'room_template_load') {
      const { template, config, ...rest } = given;
      const loaded = await loadTemplate(folders, library, String(template));
      if (!('room' in loaded)) return reply(loaded);
      warnings = loaded.warnings;
      if (loaded.notes) notes = { templateNotes: loaded.notes };
      args = {
        ...rest,
        room: loaded.room,
        ...(config !== false && loaded.config !== undefined ? { config: loaded.config } : {}),
        ...(loaded.audioTags !== undefined ? { audioTags: loaded.audioTags } : {}),
        images: loaded.images,
        audios: loaded.audios,
      };
    }

    if (name === 'vn_stage') {
      const { backgroundFile, clear, bgmFile, stopBgm, ...rest } = given;
      if (backgroundFile !== undefined && clear === true)
        return reply(failure('INVALID_ARGUMENT', 'Give backgroundFile or clear, not both.'));
      if (bgmFile !== undefined && stopBgm === true)
        return reply(failure('INVALID_ARGUMENT', 'Give bgmFile or stopBgm, not both.'));
      if (stopBgm === true) rest['bgm'] = 'stop';
      if (bgmFile !== undefined) {
        const entry = (await library.entries(folders.audio ?? [])).find((sound) =>
          sameName(sound.name, String(bgmFile))
        );
        if (!entry) return reply(failure('NOT_FOUND', `No sound file ${String(bgmFile)} in the sound folders.`));
        rest['bgm'] = entry.identifier;
        rest['audios'] = [await library.read(entry)];
      }
      if (clear === true) rest['background'] = '';
      if (backgroundFile !== undefined) {
        const picture = await images.read(String(backgroundFile));
        if (!('identifier' in picture)) return reply(picture);
        rest['background'] = picture.identifier;
        rest['images'] = [picture];
      }
      args = rest;
    }

    if (name === 'chat_send') return this.say(given, tab);

    if (name === 'self_set') {
      const { imageFile, ...rest } = given;
      if (imageFile !== undefined) {
        if (rest['image'] !== undefined)
          return reply(failure('INVALID_ARGUMENT', 'Give image or imageFile, not both.'));
        const picture = await images.read(String(imageFile));
        if (!('identifier' in picture)) return reply(picture);
        rest['image'] = picture.identifier;
        rest['images'] = [picture];
      }
      args = rest;
    }

    if (name === 'table_set') {
      const { surfaceFile, backgroundFile, bgmFile, ...rest } = given;
      const pictures: { identifier: string }[] = [];
      for (const [file, key] of [
        [surfaceFile, 'surface'],
        [backgroundFile, 'background'],
      ] as const) {
        if (file === undefined) continue;
        if (rest[key] !== undefined) return reply(failure('INVALID_ARGUMENT', `Give ${key} or ${key}File, not both.`));
        const picture = await images.read(String(file));
        if (!('identifier' in picture)) return reply(picture);
        rest[key] = picture.identifier;
        if (!pictures.some((held) => held.identifier === picture.identifier)) pictures.push(picture);
      }
      if (pictures.length > 0) rest['images'] = pictures;
      if (bgmFile !== undefined) {
        if (rest['bgm'] !== undefined) return reply(failure('INVALID_ARGUMENT', 'Give bgm or bgmFile, not both.'));
        const entry = (await library.entries(folders.audio ?? [])).find((sound) =>
          sameName(sound.name, String(bgmFile))
        );
        if (!entry) return reply(failure('NOT_FOUND', `No sound file ${String(bgmFile)} in the sound folders.`));
        rest['bgm'] = entry.identifier;
        rest['audios'] = [await library.read(entry)];
      }
      args = rest;
    }

    if (name === 'room_audio_restore') {
      const probe = await this.invoke('audio_restore', {}, tab);
      if (!probe.ok) return reply(probe);
      const missing = (probe.data as { missingAudio?: unknown } | null)?.missingAudio;
      const wanted = new Set(Array.isArray(missing) ? missing.map(String) : []);
      if (wanted.size === 0) return reply(probe);
      const found = (await library.entries(folders.audio ?? [])).filter((sound) => wanted.has(sound.identifier));
      const unique = [...new Map(found.map((sound) => [sound.identifier, sound])).values()].slice(0, 10);
      if (unique.length === 0) return reply(probe);
      return reply(
        await this.invoke(
          'audio_restore',
          { audios: await Promise.all(unique.map((sound) => library.read(sound))) },
          tab
        )
      );
    }

    if (name === 'bgm_play') {
      const { file, thenFile, ...rest } = given;
      if (file !== undefined && rest['identifier'] !== undefined)
        return reply(failure('INVALID_ARGUMENT', 'Give file or identifier, not both.'));
      if (thenFile !== undefined && rest['then'] !== undefined)
        return reply(failure('INVALID_ARGUMENT', 'Give thenFile or then, not both.'));
      const audios: unknown[] = [];
      if (rest['stop'] !== true || file !== undefined || rest['identifier'] !== undefined) {
        const sounds = await library.entries(folders.audio ?? []);
        const entry =
          file !== undefined
            ? sounds.find((sound) => sameName(sound.name, String(file)))
            : sounds.find((sound) => sound.identifier === rest['identifier']);
        if (file !== undefined && !entry)
          return reply(failure('NOT_FOUND', `No sound file ${String(file)} in the sound folders.`));
        if (entry) {
          rest['identifier'] = entry.identifier;
          audios.push(await library.read(entry));
        }
        if (thenFile !== undefined) {
          const after = sounds.find((sound) => sameName(sound.name, String(thenFile)));
          if (!after) return reply(failure('NOT_FOUND', `No sound file ${String(thenFile)} in the sound folders.`));
          rest['then'] = after.identifier;
          if (after.identifier !== entry?.identifier) audios.push(await library.read(after));
        }
      }
      if (audios.length > 0) rest['audios'] = audios;
      args = rest;
    }

    if (name === 'table_create') {
      const built = await this.tableArgs(given);
      if ('refused' in built) return reply(built.refused);
      args = built.args;
      warnings = built.warnings;
      notes = built.notes;
    }

    if (name === 'character_create') {
      const { sourceUrl, imageFile, ...rest } = given;
      if ((sourceUrl === undefined) === (rest['pieces'] === undefined))
        return reply(failure('INVALID_ARGUMENT', 'Give either pieces or sourceUrl.'));
      if (typeof sourceUrl === 'string') {
        const fetched = await fetchPieceSheets(
          sourceUrl,
          options.pieceSources ?? [],
          options.fetchText ?? fetchTextOverHttp
        );
        if (!('pieces' in fetched)) return reply(fetched);
        const pictures = await fetchPieceImages(fetched.images, options.fetchBytes ?? fetchBytesOverHttp);
        warnings = [...fetched.warnings, ...pictures.warnings];
        rest['pieces'] = fetched.pieces;
        if (pictures.images.length > 0) rest['images'] = pictures.images;
      }
      if (imageFile !== undefined) {
        const picture = await images.read(String(imageFile));
        if (!('identifier' in picture)) return reply(picture);
        rest['image'] = picture.identifier;
        rest['images'] = [...((rest['images'] as unknown[] | undefined) ?? []), picture];
      }
      args = rest;
    }

    const result = await this.invoke(name, args, tab);
    if (
      result.ok &&
      result.data &&
      typeof result.data === 'object' &&
      (warnings.length > 0 || Object.keys(notes).length > 0)
    ) {
      return answer({ ...result.data, ...notes, ...(warnings.length > 0 ? { sourceWarnings: warnings } : {}) });
    }
    return reply(result);
  }

  /** What table_create hands the tab: a board from a picture or the rulebook server, or a map to generate. */
  private async tableArgs(
    given: Record<string, unknown>
  ): Promise<
    { refused: FacadeResult } | { args: Record<string, unknown>; warnings: string[]; notes: Record<string, unknown> }
  > {
    const { images, options } = this;
    const refused = (code: string, message: string) => ({ refused: failure(code, message) });
    if (given['kind'] === 'board' && given['backgroundFile'] !== undefined) {
      const { backgroundFile, name, width, height, grid, flat } = given;
      if (given['templateUrl'] !== undefined)
        return refused('INVALID_ARGUMENT', 'Give templateUrl or backgroundFile, not both.');
      if (typeof name !== 'string') return refused('INVALID_ARGUMENT', 'A board from a picture needs a name.');
      const picture = await images.read(String(backgroundFile));
      if (!('identifier' in picture)) return { refused: picture };
      return {
        args: {
          kind: 'board',
          name,
          width: width ?? 32,
          height: height ?? 18,
          background: picture.identifier,
          grid: grid ?? false,
          flat: flat ?? true,
          images: [picture],
        },
        warnings: [],
        notes: {},
      };
    }
    if (given['kind'] === 'board') {
      const { templateUrl, ...rest } = given;
      if (typeof templateUrl !== 'string')
        return refused('INVALID_ARGUMENT', 'A board needs a templateUrl or a backgroundFile.');
      const template = await fetchBoardTemplate(
        templateUrl,
        options.pieceSources ?? [],
        options.fetchText ?? fetchTextOverHttp
      );
      if (!('table' in template)) return { refused: template };
      const pictures = await fetchPieceImages(template.images, options.fetchBytes ?? fetchBytesOverHttp);
      return {
        args: {
          kind: 'board',
          name: rest['name'] ?? template.table.name,
          width: rest['width'] ?? template.table.width,
          height: rest['height'] ?? template.table.height,
          background: template.table.background,
          grid: template.table.grid,
          flat: template.table.flat,
          images: pictures.images,
        },
        warnings: [...template.warnings, ...pictures.warnings],
        notes: template.notes,
      };
    }
    if (given['templateUrl'] !== undefined) return refused('INVALID_ARGUMENT', 'templateUrl is for kind board.');
    // A floor or wall from the image folder goes to the tab as a picture, and is named by it.
    const { floorFile, wallFile, backgroundFile, grid, ...rest } = given;
    if (backgroundFile !== undefined || grid !== undefined)
      return refused('INVALID_ARGUMENT', 'backgroundFile and grid are for kind board.');
    const pictures = [];
    for (const [file, key] of [
      [floorFile, 'floor'],
      [wallFile, 'wall'],
    ] as const) {
      if (file === undefined) continue;
      if (rest[key] !== undefined) return refused('INVALID_ARGUMENT', `Give ${key} or ${key}File, not both.`);
      const picture = await images.read(String(file));
      if (!('identifier' in picture)) return { refused: picture };
      rest[key] = picture.identifier;
      pictures.push(picture);
    }
    return { args: pictures.length > 0 ? { ...rest, images: pictures } : rest, warnings: [], notes: {} };
  }

  /** chat_send: one line, or several said one after another at a pace a person can read them. */
  private async say(given: Record<string, unknown>, tab: TabCall): Promise<CallToolResult> {
    const fromFile = given['linesFile'] !== undefined;
    if (given['lines'] === undefined && !fromFile) {
      if (given['text'] === undefined) return reply(failure('INVALID_ARGUMENT', 'Give text or lines.'));
      if (given['dryRun'] !== true) await this.waitForReading();
      return reply(await this.invoke('chat_send', given, tab));
    }
    const { lines, linesFile, linesKey, tabId, dryRun, ...rest } = given;
    if (Object.keys(rest).length > 0 || (fromFile && lines !== undefined))
      return reply(
        failure('INVALID_ARGUMENT', 'Give lines, linesFile, or text with characterId and style: one of them.')
      );
    let list = lines as ChatLine[];
    if (fromFile) {
      if (typeof linesKey !== 'string') return reply(failure('INVALID_ARGUMENT', 'Give linesKey with linesFile.'));
      const read = await readPreparedLines(this.folders.scenarios, String(linesFile), linesKey, MAX_CHAT_LINES);
      if (!('lines' in read)) return reply(read);
      list = read.lines;
    }
    const told = fromFile ? { lines: list } : {};
    const sent: unknown[] = [];
    if (dryRun !== true) await this.waitForReading();
    for (const [index, line] of list.entries()) {
      if (index > 0 && dryRun !== true) await this.sleep(lineGapMs(list[index - 1].text, list[index - 1].style));
      const result = await this.invoke('chat_send', { tabId, ...line, ...(dryRun === true ? { dryRun } : {}) }, tab);
      if (!result.ok) return answer({ sent, failed: { index, error: result.error }, ...told });
      sent.push(result.data);
    }
    if (dryRun !== true && list.length > 0) {
      const last = list[list.length - 1];
      this.readByAt = Date.now() + lineGapMs(last.text, last.style);
    }
    return answer({ sent, ...told });
  }
}

/** One bridge for the process, with its settings read from the environment, made when first asked for. */
let shared: ForkBridge | undefined;
export function forkBridge(): ForkBridge {
  shared ??= new ForkBridge(forkBridgeOptionsFromEnv());
  return shared;
}

/** The tools the bridge offers the AI: the app's, less the one the tab keeps for the bridge, and the fork's own. */
export function withForkBridgeTools(tools: readonly AgentToolDefinition[]): readonly AgentToolDefinition[] {
  // In the place of the tab's own tool, so that they come with the table's tools and before the desk's.
  return tools.flatMap((tool) => (tool.name === FORK_BRIDGE_TOOL_NAME ? FORK_BRIDGE_TOOLS.map(asAgentTool) : [tool]));
}

/** A fork bridge tool in the shape the MCP server lists tools in; its schema is listed as it is. */
function asAgentTool(tool: ForkBridgeToolDefinition): AgentToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    access: tool.readOnly ? 'read' : 'write',
    input: tool.inputSchema as unknown as AgentToolDefinition['input'],
  };
}
