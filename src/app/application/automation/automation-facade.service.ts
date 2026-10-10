import { inject, Injectable } from '@angular/core';
import { automationAudiosOf } from '@axe/application/automation/automation-audio.service';
import { AutomationAuditService } from '@axe/application/automation/automation-audit.service';
import {
  AUTOMATION_COMMANDS,
  AUTOMATION_WRITES,
  AutomationCommand,
  AutomationError,
  AutomationRequest,
  AutomationResult,
  fail,
  numberArgument,
  onlyKeys,
  pageSize,
  record,
  textArgument,
} from '@axe/application/automation/automation-contract';
import { automationImagesOf } from '@axe/application/automation/automation-image.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { BuffChanges, BuffCommandService } from '@axe/application/automation/buff-command.service';
import { characterSheetView } from '@axe/application/automation/character-sheet-view';
import { ChatWaitService, isPublicMessage } from '@axe/application/automation/chat-wait.service';
import {
  ExplorationCommandService,
  LIGHT_KINDS,
  LightKind,
} from '@axe/application/automation/exploration-command.service';
import { MapRequest } from '@axe/application/automation/map-generator';
import { MAX_CREATED_PIECES, PieceCommandService } from '@axe/application/automation/piece-command.service';
import { RangeCommandService, RangePlace } from '@axe/application/automation/range-command.service';
import { RoomPrepCommandService } from '@axe/application/automation/room-prep-command.service';
import { RoomTemplateCommandService } from '@axe/application/automation/room-template-command.service';
import { SessionCommandService } from '@axe/application/automation/session-command.service';
import { VnStageCommandService } from '@axe/application/automation/vn-stage-command.service';
import { SharedFocusService } from '@axe/application/tabletop/shared-focus.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { BuffRemovalRule } from '@axe/domain/character/buff-bulk-removal';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { canRoleSpeakTab, canRoleViewTab } from '@axe/domain/chat/chat-tab-permission';
import { PaletteRow, paletteRowsOf } from '@axe/domain/chat/palette-rows';
import { DisclosureMode } from '@axe/domain/disclosure/disclosure';
import { isTextureId, isWallTextureId } from '@axe/domain/media/texture-catalog';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { CONCEALED_LOCATION } from '@axe/domain/tabletop/board-switch/concealment';
import { MapMaterial } from '@axe/domain/tabletop/map-blocks';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TabletopObject } from '@axe/domain/tabletop/tabletop-object';
import { VN_MESSAGE_KINDS, VnMessageKind } from '@axe/domain/visual-novel/vn-emote';
import { VN_STAGE_TRANSITIONS, VnStageTransition } from '@axe/domain/visual-novel/vn-stage';

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
/** Time a wait is given beyond the wait itself, to look one last time and answer. */
const WAIT_MARGIN_MS = 5000;
const MAX_WAIT_TABS = 20;
const MAX_SHEET_PATHS = 50;
/** Building a large generated map stands thousands of blocks, which takes a while. */
const TABLE_CREATE_TIMEOUT_MS = 120000;
const MAX_NOTE_TEXT = 10000;
/** A template or a piece of music brings its pictures and up to ten sounds, which take a while to check and take in. */
const ROOM_TEMPLATE_TIMEOUT_MS = 60000;
/** A saved room's data.xml, effect library and all. */
const MAX_TEMPLATE_XML = 4_000_000;
const MAX_TEMPLATE_PART_XML = 200_000;
const MAX_TEMPLATE_TABLES = 20;
/** The commands that set the room up, which only the game master runs. */
const ROOM_PREP_WRITES: readonly AutomationCommand[] = [
  'table_create',
  'table_select',
  'chat_tab_create',
  'note_create',
  'room_template_load',
  'bgm_play',
  'audio_restore',
  'table_view',
  'view_focus',
  'fog_reveal',
  'door_set',
  'light_place',
  'vn_stage',
  'range_set',
];
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/**
 * One resource change on the speaking piece. Besides a plain number the amount may roll dice, hold a
 * bracketed roll, branch with `if()` and read a roll again through `$n`, as a resource edit typed into
 * chat can; none of these reach any data but the dice. Spaces are not allowed, so it stays one command.
 */
const RESOURCE_COMMAND =
  /^:[^\s:：&＆+=-]+[+-](?:\d+(?:\.\d+)?|[dD]|\[[^[\]\s{}｛｝]+\]|\$\d+|if\(|[-+*/()<>=!,])+[LZlz]{0,2}$/u;
const MAX_PALETTE_LINES = 500;
const MAX_TARGETS = 50;
const MAX_BUFF_PIECES = 100;
const MAX_BUFF_COMMANDS = 20;
/** One buff command as chat takes it: `&`, `t&`, `s&` or `st&` and the rest with no space in it. */
const BUFF_COMMAND = /^[sSｓＳ]?[tTｔＴ]?[&＆]\S+$/u;

/** The changes a buff_edit asks for, each checked for its type; values are checked by the buff service. */
function buffChangesOf(a: Record<string, unknown>): BuffChanges {
  const changes: BuffChanges = {};
  if (a['name'] !== undefined) changes.name = textArgument(a['name']);
  if (a['info'] !== undefined) {
    if (typeof a['info'] !== 'string' || a['info'].length > 500) fail('INVALID_ARGUMENT', 'Invalid info.');
    changes.info = a['info'];
  }
  if (a['rounds'] !== undefined) changes.rounds = numberArgument(a['rounds']);
  if (a['timing'] !== undefined) changes.timing = textArgument(a['timing']) as BuffChanges['timing'];
  if (a['trigger'] !== undefined) {
    if (typeof a['trigger'] !== 'string' || a['trigger'].length > 256) fail('INVALID_ARGUMENT', 'Invalid trigger.');
    changes.trigger = a['trigger'];
  }
  for (const key of ['remove', 'dryRun'] as const) {
    if (a[key] !== undefined && typeof a[key] !== 'boolean') fail('INVALID_ARGUMENT', `${key} must be boolean.`);
  }
  if (a['remove'] === true) changes.remove = true;
  return changes;
}

/** Which buffs a sweep takes: those held until cleared, those with so many rounds left, or one name. */
function sweepRuleOf(a: Record<string, unknown>): BuffRemovalRule {
  switch (a['kind']) {
    case 'held':
      return { kind: 'held' };
    case 'rounds': {
      const rounds = numberArgument(a['rounds']);
      if (!Number.isInteger(rounds)) fail('INVALID_ARGUMENT', 'rounds must be a whole number.');
      return { kind: 'rounds', rounds };
    }
    case 'name':
      return { kind: 'name', name: textArgument(a['name']) };
    default:
      return fail('INVALID_ARGUMENT', 'kind must be held, rounds or name.');
  }
}

/** The buff commands asked for, each checked to be one; anything else would be said to the room as it is. */
function buffCommandsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BUFF_COMMANDS)
    fail('INVALID_ARGUMENT', `commands must list 1 to ${MAX_BUFF_COMMANDS} buff commands.`);
  return value.map((command) => {
    const text = textArgument(command, 500);
    if (!BUFF_COMMAND.test(text)) fail('INVALID_ARGUMENT', `Not a buff command: ${text.slice(0, 50)}`);
    return text;
  });
}

/** How long a chat_wait may wait, in seconds: a whole number from 1 to the cap, a minute when left out. */
function waitSecondsOf(value: unknown): number {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = numberArgument(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS)
    fail('INVALID_ARGUMENT', `waitSeconds must be a whole number from 1 to ${MAX_WAIT_SECONDS}.`);
  return seconds;
}

/** How long a request may run before it is given up: a wait for chat gets its own wait and a margin. */
function timeoutFor(request: AutomationRequest): number {
  if (request.command === 'table_create') return TABLE_CREATE_TIMEOUT_MS;
  if (['room_template_load', 'bgm_play', 'audio_restore'].includes(request.command)) return ROOM_TEMPLATE_TIMEOUT_MS;
  if (request.command !== 'chat_wait') return REQUEST_TIMEOUT_MS;
  return waitSecondsOf(request.arguments['waitSeconds']) * 1000 + WAIT_MARGIN_MS;
}

/** A whole number argument from `min` to `max`, or the fallback when left out. */
function wholeOf(value: unknown, key: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = numberArgument(value);
  if (!Number.isInteger(number) || number < min || number > max)
    fail('INVALID_ARGUMENT', `${key} must be a whole number from ${min} to ${max}.`);
  return number;
}

/** The generated map a table_create asks for, each value checked; the generator clamps the rest. */
function mapRequestOf(a: Record<string, unknown>): MapRequest {
  const kind = a['kind'];
  if (kind !== 'dungeon' && kind !== 'field') fail('INVALID_ARGUMENT', 'kind must be dungeon or field.');
  return {
    kind,
    atmosphere: textArgument(a['atmosphere'], 64),
    seed: wholeOf(a['seed'], 'seed', 0, 2 ** 31 - 1, Math.floor(Math.random() * 2 ** 31)),
    name: a['name'] === undefined ? '' : textArgument(a['name']).trim(),
    roomCount: a['roomCount'] === undefined ? undefined : wholeOf(a['roomCount'], 'roomCount', 3, 20, 8),
    trapCount: a['trapCount'] === undefined ? undefined : wholeOf(a['trapCount'], 'trapCount', 0, 30, 0),
    size: a['size'] === undefined ? undefined : wholeOf(a['size'], 'size', 1, 200, 40),
    density: a['density'] === undefined ? undefined : wholeOf(a['density'], 'density', 0, 100, 50),
    fog: booleanOf(a['fog'], 'fog'),
    flat: a['flat'] === undefined ? undefined : booleanOf(a['flat'], 'flat'),
    floor: a['floor'] === undefined ? undefined : materialOf(a['floor'], 'floor', isTextureId),
    wall: a['wall'] === undefined ? undefined : materialOf(a['wall'], 'wall', isWallTextureId),
    wallHeight: a['wallHeight'] === undefined ? undefined : wallHeightOf(a['wallHeight']),
  };
}

/** A rectangle in cells: x, y, w and h, each a finite number. */
function cellRectOf(a: Record<string, unknown>) {
  return { x: numberArgument(a['x']), y: numberArgument(a['y']), w: numberArgument(a['w']), h: numberArgument(a['h']) };
}

/** A bundled texture by its name, or a picture the room holds (or is brought along) by its SHA-256. */
function materialOf(value: unknown, key: string, bundled: (id: string) => boolean): MapMaterial {
  const id = textArgument(value, 64);
  if (/^[0-9a-f]{64}$/.test(id)) return { kind: 'library', identifier: id };
  if (!bundled(id)) fail('INVALID_ARGUMENT', `${key} is neither a bundled texture nor a picture's SHA-256.`);
  return { kind: 'texture', id };
}

function wallHeightOf(value: unknown): number {
  const height = numberArgument(value);
  if (height <= 0 || height > 10) fail('INVALID_ARGUMENT', 'wallHeight must be above 0 and at most 10 cells.');
  return height;
}

/** Who may read and speak in a new tab: by default the players both read and speak, guests only read. */
function tabPermissionOf(a: Record<string, unknown>) {
  const flag = (key: string, fallback: boolean) => (a[key] === undefined ? fallback : booleanOf(a[key], key));
  return {
    plCanView: flag('playersRead', true),
    plCanSpeak: flag('playersSpeak', true),
    guestCanView: flag('guestsRead', true),
    guestCanSpeak: flag('guestsSpeak', false),
  };
}

/** The disclosure asked for: everyone, or the game master only. */
function disclosureOf(value: unknown): DisclosureMode {
  if (value === 'all') return DisclosureMode.All;
  if (value === 'gm') return DisclosureMode.GameMaster;
  return fail('INVALID_ARGUMENT', 'disclosure must be all or gm.');
}

function booleanOf(value: unknown, key: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${key} must be boolean.`);
  return value;
}

/** A list of strings, one to `max` of them, each checked as an argument. */
function textsOf(value: unknown, key: string, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    fail('INVALID_ARGUMENT', `${key} must list 1 to ${max} entries.`);
  return value.map((entry) => textArgument(entry));
}

/** One palette line as automation reads it: where it is, what kind of line it is and what it says. */
function paletteLineView(row: PaletteRow) {
  if (row.kind === 'heading') {
    return { lineIndex: row.lineIndex, kind: row.kind, heading: row.headingName ?? '', level: row.headingLevel ?? 1 };
  }
  return { lineIndex: row.lineIndex, kind: row.kind, text: row.text.slice(0, 2000) };
}

type Remembered = { fingerprint: string; expires: number; result: Promise<AutomationResult> };

@Injectable({ providedIn: 'root' })
export class AutomationFacadeService {
  private readonly policy = inject(AutomationPolicyService);
  private readonly session = inject(SessionCommandService);
  private readonly buffCommands = inject(BuffCommandService);
  private readonly pieceCommands = inject(PieceCommandService);
  private readonly chatWait = inject(ChatWaitService);
  private readonly roomPrep = inject(RoomPrepCommandService);
  private readonly roomTemplates = inject(RoomTemplateCommandService);
  private readonly sharedFocus = inject(SharedFocusService);
  private readonly exploration = inject(ExplorationCommandService);
  private readonly vnStage = inject(VnStageCommandService);
  private readonly ranges = inject(RangeCommandService);
  private readonly audit = inject(AutomationAuditService);
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);
  private readonly remembered = new Map<string, Remembered>();
  private identity = '';
  private epoch = '';
  private writing = false;
  private calls: number[] = [];

  health() {
    this.refreshSession();
    return {
      ready: this.policy.enabled() && this.session.ready,
      sessionId: this.policy.sessionId(),
      apiVersion: '1' as const,
    };
  }

  private refreshSession(): void {
    const identity = this.session.identity;
    if (this.identity && identity !== this.identity) this.policy.stop();
    this.identity = identity;
    if (this.epoch !== this.policy.sessionId()) {
      this.epoch = this.policy.sessionId();
      this.remembered.clear();
      this.calls = [];
      this.chatWait.reset();
    }
  }

  async invoke(input: unknown): Promise<AutomationResult> {
    let request: AutomationRequest | undefined;
    try {
      this.refreshSession();
      const raw = record(input);
      onlyKeys(raw, ['sessionId', 'requestId', 'command', 'arguments']);
      const command = textArgument(raw['command']);
      if (!(AUTOMATION_COMMANDS as readonly string[]).includes(command)) fail('INVALID_ARGUMENT', 'Unknown command.');
      request = {
        sessionId: textArgument(raw['sessionId']),
        requestId: textArgument(raw['requestId'], 128),
        command: command as AutomationRequest['command'],
        arguments: { ...record(raw['arguments']) },
      };
      this.authorize(request);
      const now = Date.now();
      this.calls = this.calls.filter((at) => at > now - 60000);
      if (this.calls.length >= 120) fail('FORBIDDEN', 'Rate limit reached; wait one minute.');
      this.calls.push(now);
      for (const [id, entry] of this.remembered) if (entry.expires < now) this.remembered.delete(id);
      const fingerprint = JSON.stringify([
        request.command,
        Object.entries(request.arguments).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      const previous = this.remembered.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail('CONFLICT', 'Request ID was already used for different arguments.');
        return previous.result;
      }
      const writes = AUTOMATION_WRITES.includes(request.command);
      if (writes && this.writing) fail('CONFLICT', 'Another automation write is in progress.');
      // Refuse new writes instead of evicting still-retryable IDs and permitting double execution.
      if (writes && this.remembered.size >= 256) fail('CONFLICT', 'Replay cache is full; retry later.');
      const pending = this.execute(request, writes);
      if (writes)
        this.remembered.set(request.requestId, { fingerprint, expires: now + REPLAY_WINDOW_MS, result: pending });
      return await pending;
    } catch (error) {
      const result = this.errorResult(error);
      this.log(request, result);
      return result;
    }
  }

  private async execute(request: AutomationRequest, writes: boolean): Promise<AutomationResult> {
    if (writes) this.writing = true;
    const timeout = timeoutFor(request);
    const deadline = Date.now() + timeout;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = () => {
      if (expired || Date.now() >= deadline) fail('TIMEOUT', 'Request timed out.');
      this.refreshSession();
      this.authorize(request);
    };
    try {
      const work = this.dispatch(request, guard);
      const data = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new AutomationError('TIMEOUT', 'Request timed out.'));
          }, timeout);
        }),
      ]);
      const result: AutomationResult = { ok: true, data };
      this.log(request, result);
      return result;
    } catch (error) {
      const result = this.errorResult(error);
      this.log(request, result);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (writes) this.writing = false;
    }
  }

  private authorize(request: AutomationRequest): void {
    if (!this.session.ready || request.sessionId !== this.policy.sessionId())
      fail('NOT_READY', 'Start a new automation session.');
    this.policy.require('read_visible');
    const args = request.arguments;
    if (request.command === 'piece_move') {
      this.policy.require('move_piece');
      this.policy.canControl(this.piece(textArgument(args['identifier'])));
    }
    if (request.command === 'chat_send') {
      this.policy.require('send_chat');
      this.tab(textArgument(args['tabId']), true);
      if (args['characterId'] !== undefined) this.policy.canControl(this.piece(textArgument(args['characterId'])));
      this.validateChat(textArgument(args['text'], 2000), args['characterId'] !== undefined);
    }
    if (request.command === 'palette_send') {
      // A palette line is said in full, references, targets and all, as a player clicking it would.
      this.policy.require('use_palette');
      this.tab(textArgument(args['tabId']), true);
      this.policy.canControl(this.piece(textArgument(args['characterId'])));
    }
    if (request.command === 'buff_send') {
      this.policy.require('edit_buff');
      this.tab(textArgument(args['tabId']), true);
      this.policy.canControl(this.piece(textArgument(args['characterId'])));
      buffCommandsOf(args['commands']);
    }
    if (request.command === 'buff_edit') {
      // Any visible piece's buff, as the buff manager allows anyone at the table.
      this.policy.require('edit_buff');
      this.policy.canManage(this.buffCommands.find(textArgument(args['identifier'])).owner);
    }
    if (request.command === 'buff_sweep') this.policy.require('edit_buff');
    if (request.command === 'character_create') {
      this.policy.require('create_piece');
      this.policy.canCreatePieces();
      if (args['concealed'] === true) this.policy.requireGameMaster();
    }
    // The ground plan, hidden doors and all, is the master's to read.
    if (request.command === 'terrain_list' || request.command === 'range_list') this.policy.requireGameMaster();
    if (ROOM_PREP_WRITES.includes(request.command)) {
      this.policy.require('prepare_room');
      this.policy.requireGameMaster();
    }
    if (request.command === 'piece_reveal' || request.command === 'piece_conceal') {
      this.policy.require('create_piece');
      this.policy.requireGameMaster();
      const from = request.command === 'piece_reveal' ? CONCEALED_LOCATION : 'table';
      for (const identifier of textsOf(args['identifiers'], 'identifiers', MAX_CREATED_PIECES))
        this.pieceCommands.own(identifier, [from]);
    }
    if (request.command === 'piece_disclose') {
      this.policy.require('create_piece');
      this.policy.canCreatePieces();
      this.pieceCommands.own(textArgument(args['identifier']));
    }
    if (request.command === 'piece_remove') {
      this.policy.require('create_piece');
      this.policy.canCreatePieces();
      for (const identifier of textsOf(args['identifiers'], 'identifiers', MAX_CREATED_PIECES))
        this.pieceCommands.own(identifier);
    }
  }

  private validateChat(text: string, asCharacter: boolean): void {
    // References can expand to private data or more commands. Targeting/effect/portrait
    // macros have side effects outside the MVP's explicitly named speaker.
    if (/[{}｛｝《》]/u.test(text) || /(?:^|\s)[sSｓＳ]?[tTｔＴ][:&：＆]/u.test(text) || /[@＠]/u.test(text)) {
      fail('FORBIDDEN', 'References, targets, portraits and effect macros are not supported.');
    }
    if (/(?:^|\s)[sSｓＳ]?[:：&＆]/u.test(text)) {
      this.policy.require('edit_resource');
      if (!asCharacter || !RESOURCE_COMMAND.test(text)) {
        fail(
          'FORBIDDEN',
          'Resource chat supports only a single :name+amount or :name-amount command; the amount may use numbers, dice, [rolls], if() and $n.'
        );
      }
    }
  }

  private async dispatch(request: AutomationRequest, guard: () => void): Promise<unknown> {
    const a = request.arguments;
    switch (request.command) {
      case 'session_get':
        onlyKeys(a, []);
        return {
          ...this.session.session(),
          apiVersion: '1',
          sessionId: this.policy.sessionId(),
          scopes: [...this.policy.scopes()],
          tabs: this.store
            .getObjects<ChatTab>(ChatTab)
            .filter((tab) => canRoleViewTab(tab, PeerCursor.myRole))
            .map((tab) => ({
              identifier: tab.identifier,
              name: tab.name.slice(0, 256),
              canSpeak: canRoleSpeakTab(tab, PeerCursor.myRole),
            })),
        };
      case 'scene_list': {
        onlyKeys(a, ['limit', 'after', 'name', 'place']);
        const limit = pageSize(a['limit']);
        const after = a['after'] === undefined ? '' : textArgument(a['after']);
        const name = a['name'] === undefined ? '' : textArgument(a['name']);
        const place = a['place'] ?? 'table';
        if (place !== 'table' && place !== 'concealed') fail('INVALID_ARGUMENT', 'place must be table or concealed.');
        const pieces = this.store
          .getObjects<GameCharacter>(GameCharacter)
          .filter((p) => (place === 'table' ? this.policy.canSee(p) : this.policy.canSeeConcealed(p)))
          .map((p) => this.describe(p))
          .filter((p) => p.identifier > after && (!name || p.name.includes(name)))
          .sort((l, r) => (l.identifier < r.identifier ? -1 : l.identifier > r.identifier ? 1 : 0));
        return { objects: pieces.slice(0, limit), next: pieces.length > limit ? pieces[limit - 1].identifier : null };
      }
      case 'object_get':
        onlyKeys(a, ['identifier']);
        return this.describe(this.readable(textArgument(a['identifier'])));
      case 'piece_move': {
        onlyKeys(a, ['identifier', 'x', 'y', 'unit', 'expectedVersion', 'dryRun']);
        const piece = this.piece(textArgument(a['identifier']));
        const unit = a['unit'] ?? 'grid';
        if (unit !== 'grid' && unit !== 'px') fail('INVALID_ARGUMENT', 'Unit must be grid or px.');
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        if (a['expectedVersion'] !== undefined && numberArgument(a['expectedVersion']) !== piece.version) {
          fail('CONFLICT', 'Piece changed since it was read.');
        }
        const moved = await this.session.move(
          piece,
          { x: numberArgument(a['x']), y: numberArgument(a['y']), unit },
          a['dryRun'] === true,
          guard
        );
        // Moved by automation itself, so a wait does not hand it back as a player's move.
        if (a['dryRun'] !== true) this.chatWait.settle(piece);
        return moved;
      }
      case 'chat_send': {
        onlyKeys(a, ['tabId', 'text', 'characterId', 'style', 'dryRun']);
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        const style = a['style'] ?? 'normal';
        if (!VN_MESSAGE_KINDS.includes(style as VnMessageKind))
          fail('INVALID_ARGUMENT', `style must be one of ${VN_MESSAGE_KINDS.join(', ')}.`);
        const tab = this.tab(textArgument(a['tabId']), true);
        const piece = a['characterId'] === undefined ? null : this.piece(textArgument(a['characterId']));
        if (a['dryRun'] === true) return { tabId: tab.identifier, dryRun: true };
        return this.session.send(tab, textArgument(a['text'], 2000), piece, guard, style as VnMessageKind);
      }
      case 'chat_read_recent': {
        onlyKeys(a, ['tabId', 'limit']);
        const tab = this.tab(textArgument(a['tabId']));
        const limit = pageSize(a['limit'], 20);
        return {
          messages: tab.chatMessages
            .filter(isPublicMessage)
            .slice(-limit)
            .map((m) => ({
              identifier: m.identifier,
              name: m.name.slice(0, 256),
              text: m.text.slice(0, 2000),
              timestamp: m.timestamp,
            })),
          untrustedContent: true,
        };
      }
      case 'chat_wait': {
        onlyKeys(a, ['tabIds', 'waitSeconds', 'limit', 'pieces']);
        const visible = this.store.getObjects<ChatTab>(ChatTab).filter((tab) => canRoleViewTab(tab, PeerCursor.myRole));
        const tabs =
          a['tabIds'] === undefined
            ? visible
            : textsOf(a['tabIds'], 'tabIds', MAX_WAIT_TABS).map((identifier) => this.tab(identifier));
        // The players' pieces: those in view on the table that are not automation's own.
        const pieces = booleanOf(a['pieces'], 'pieces')
          ? () =>
              this.store
                .getObjects<GameCharacter>(GameCharacter)
                .filter(
                  (piece) =>
                    piece.location.name === 'table' && this.policy.canSee(piece) && !this.policy.isMine(piece.owner)
                )
          : undefined;
        const waited = await this.chatWait.wait(
          tabs,
          visible,
          {
            waitMs: waitSecondsOf(a['waitSeconds']) * 1000,
            limit: pageSize(a['limit'], 50),
            pieces,
          },
          guard
        );
        const grid = this.tables.viewTable?.gridSize || 50;
        return {
          ...waited,
          moves: waited.moves.map((move) => ({
            identifier: move.piece.identifier,
            name: this.describe(move.piece).name,
            fromX: move.fromX / grid,
            fromY: move.fromY / grid,
            x: move.x / grid,
            y: move.y / grid,
            unit: 'grid',
          })),
        };
      }
      case 'character_sheet_get': {
        onlyKeys(a, ['identifier', 'paths']);
        const piece = this.readable(textArgument(a['identifier']));
        const paths = a['paths'] === undefined ? undefined : textsOf(a['paths'], 'paths', MAX_SHEET_PATHS);
        return { identifier: piece.identifier, name: this.describe(piece).name, ...characterSheetView(piece, paths) };
      }
      case 'palette_get': {
        onlyKeys(a, ['identifier']);
        const piece = this.readable(textArgument(a['identifier']));
        const palette = piece.chatPalette;
        const rows = palette ? paletteRowsOf(palette.getPalette()) : [];
        return {
          identifier: piece.identifier,
          dicebot: palette?.dicebot ?? '',
          lines: rows
            .filter((row) => row.kind !== 'empty')
            .slice(0, MAX_PALETTE_LINES)
            .map((row) => paletteLineView(row)),
          truncated: rows.filter((row) => row.kind !== 'empty').length > MAX_PALETTE_LINES,
          untrustedContent: true,
        };
      }
      case 'palette_send': {
        onlyKeys(a, ['characterId', 'tabId', 'lineIndex', 'expectedText', 'targetIds', 'dryRun']);
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        const tab = this.tab(textArgument(a['tabId']), true);
        const piece = this.piece(textArgument(a['characterId']));
        const lineIndex = numberArgument(a['lineIndex']);
        const row = piece.chatPalette ? paletteRowsOf(piece.chatPalette.getPalette())[lineIndex] : undefined;
        if (!Number.isInteger(lineIndex) || !row || row.kind !== 'command')
          fail('NOT_FOUND', 'No palette line to say at that index.');
        if (a['expectedText'] !== undefined && textArgument(a['expectedText'], 2000) !== row.text)
          fail('CONFLICT', 'The palette line changed since it was read.');
        const targets = this.targets(a['targetIds']);
        if (a['dryRun'] === true) return { tabId: tab.identifier, text: row.text, dryRun: true };
        return this.session.speakAs(tab, piece, row.text, targets, guard);
      }
      case 'buff_list': {
        onlyKeys(a, ['identifier']);
        if (a['identifier'] !== undefined) return this.buffsOf(this.readable(textArgument(a['identifier'])));
        const pieces = this.store
          .getObjects<GameCharacter>(GameCharacter)
          .filter((piece) => this.policy.canSee(piece))
          .map((piece) => this.buffsOf(piece))
          .filter((entry) => entry.buffs.length > 0);
        return { pieces: pieces.slice(0, MAX_BUFF_PIECES), truncated: pieces.length > MAX_BUFF_PIECES };
      }
      case 'buff_send': {
        onlyKeys(a, ['characterId', 'tabId', 'commands', 'targetIds', 'dryRun']);
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        const tab = this.tab(textArgument(a['tabId']), true);
        const piece = this.piece(textArgument(a['characterId']));
        const line = buffCommandsOf(a['commands']).join(' ');
        const targets = this.targets(a['targetIds']);
        if (a['dryRun'] === true) return { tabId: tab.identifier, text: line, dryRun: true };
        return this.session.speakAs(tab, piece, line, targets, guard);
      }
      case 'buff_edit': {
        onlyKeys(a, ['identifier', 'name', 'info', 'rounds', 'timing', 'trigger', 'remove', 'dryRun']);
        const { buff, owner } = this.buffCommands.find(textArgument(a['identifier']));
        const changes = buffChangesOf(a);
        if (Object.keys(changes).length < 1) fail('INVALID_ARGUMENT', 'Nothing to change.');
        this.buffCommands.validate(changes);
        if (a['dryRun'] === true) return { identifier: buff.identifier, owner: owner.identifier, dryRun: true };
        return this.buffCommands.edit(buff, owner, changes);
      }
      case 'buff_sweep': {
        onlyKeys(a, ['kind', 'rounds', 'name', 'dryRun']);
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        return this.buffCommands.sweep(sweepRuleOf(a), a['dryRun'] === true);
      }
      case 'character_create': {
        onlyKeys(a, ['pieces', 'x', 'y', 'unit', 'disclosure', 'concealed', 'dicebot', 'images', 'image', 'dryRun']);
        const image = a['image'] === undefined ? undefined : textArgument(a['image'], 64);
        if (image !== undefined && !/^[0-9a-f]{64}$/.test(image))
          fail('INVALID_ARGUMENT', 'image must be a picture’s SHA-256.');
        const pieces = a['pieces'];
        if (!Array.isArray(pieces) || pieces.length < 1 || pieces.length > MAX_CREATED_PIECES)
          fail('INVALID_ARGUMENT', `pieces must list 1 to ${MAX_CREATED_PIECES} sheets.`);
        const unit = a['unit'] ?? 'grid';
        if (unit !== 'grid' && unit !== 'px') fail('INVALID_ARGUMENT', 'Unit must be grid or px.');
        const disclosure =
          a['disclosure'] === undefined
            ? PeerCursor.isMyselfGameMaster
              ? DisclosureMode.GameMaster
              : DisclosureMode.All
            : disclosureOf(a['disclosure']);
        return this.pieceCommands.create(
          pieces,
          { x: numberArgument(a['x']), y: numberArgument(a['y']), unit },
          {
            disclosure,
            concealed: booleanOf(a['concealed'], 'concealed'),
            dicebot: a['dicebot'] === undefined ? undefined : textArgument(a['dicebot'], 64).trim(),
            images: a['images'] === undefined ? undefined : automationImagesOf(a['images']),
            image,
          },
          booleanOf(a['dryRun'], 'dryRun'),
          guard
        );
      }
      case 'piece_disclose': {
        onlyKeys(a, ['identifier', 'disclosure', 'dryRun']);
        const piece = this.pieceCommands.own(textArgument(a['identifier']));
        const disclosure = disclosureOf(a['disclosure']);
        if (booleanOf(a['dryRun'], 'dryRun')) return { identifier: piece.identifier, disclosure, dryRun: true };
        return this.pieceCommands.disclose(piece, disclosure);
      }
      case 'piece_remove': {
        onlyKeys(a, ['identifiers', 'dryRun']);
        const pieces = textsOf(a['identifiers'], 'identifiers', MAX_CREATED_PIECES).map((identifier) =>
          this.pieceCommands.own(identifier)
        );
        if (booleanOf(a['dryRun'], 'dryRun')) return { removed: pieces.map((piece) => piece.identifier), dryRun: true };
        return this.pieceCommands.remove(pieces);
      }
      case 'piece_reveal':
      case 'piece_conceal': {
        onlyKeys(a, ['identifiers', 'dryRun']);
        const revealing = request.command === 'piece_reveal';
        const pieces = textsOf(a['identifiers'], 'identifiers', MAX_CREATED_PIECES).map((identifier) =>
          this.pieceCommands.own(identifier, [revealing ? CONCEALED_LOCATION : 'table'])
        );
        if (booleanOf(a['dryRun'], 'dryRun'))
          return { [revealing ? 'revealed' : 'concealed']: pieces.map((piece) => piece.identifier), dryRun: true };
        return revealing ? this.pieceCommands.reveal(pieces) : this.pieceCommands.conceal(pieces);
      }
      case 'table_list':
        onlyKeys(a, []);
        return this.roomPrep.list();
      case 'table_create':
        if (a['kind'] === 'board') {
          onlyKeys(a, ['kind', 'name', 'width', 'height', 'background', 'grid', 'flat', 'images']);
          return this.roomPrep.createBoard(
            {
              name: textArgument(a['name']).trim(),
              width: wholeOf(a['width'], 'width', 1, 200, 30),
              height: wholeOf(a['height'], 'height', 1, 200, 20),
              background: a['background'] === undefined ? '' : textArgument(a['background'], 64),
              images: a['images'] === undefined ? [] : automationImagesOf(a['images']),
              grid: booleanOf(a['grid'], 'grid'),
              flat: booleanOf(a['flat'], 'flat'),
            },
            guard
          );
        }
        onlyKeys(a, [
          'kind',
          'atmosphere',
          'seed',
          'name',
          'roomCount',
          'trapCount',
          'size',
          'density',
          'fog',
          'flat',
          'floor',
          'wall',
          'wallHeight',
          'images',
        ]);
        return this.roomPrep.create(
          mapRequestOf(a),
          a['images'] === undefined ? [] : automationImagesOf(a['images']),
          guard
        );
      case 'fog_reveal':
        onlyKeys(a, ['x', 'y', 'w', 'h']);
        return this.exploration.revealFog(cellRectOf(a));
      case 'terrain_list':
        onlyKeys(a, ['x', 'y', 'w', 'h', 'walls']);
        return this.exploration.listTerrain(
          a['x'] === undefined ? null : cellRectOf(a),
          booleanOf(a['walls'], 'walls')
        );
      case 'door_set': {
        onlyKeys(a, ['identifier', 'open', 'dryRun']);
        const door = this.exploration.door(textArgument(a['identifier']));
        const open = a['open'] === undefined ? undefined : booleanOf(a['open'], 'open');
        if (booleanOf(a['dryRun'], 'dryRun')) return { identifier: door.identifier, dryRun: true };
        return this.exploration.setDoor(door, open);
      }
      case 'light_place': {
        onlyKeys(a, ['x', 'y', 'kind', 'name']);
        const kind = a['kind'] ?? 'torch';
        if (!(LIGHT_KINDS as readonly unknown[]).includes(kind))
          fail('INVALID_ARGUMENT', `kind must be one of ${LIGHT_KINDS.join(', ')}.`);
        return this.exploration.placeLight(
          numberArgument(a['x']),
          numberArgument(a['y']),
          kind as LightKind,
          a['name'] === undefined ? String(kind) : textArgument(a['name']).trim()
        );
      }
      case 'range_list':
        onlyKeys(a, []);
        return this.ranges.list();
      case 'range_set': {
        onlyKeys(a, ['identifier', 'x', 'y', 'unit', 'follow', 'place', 'dryRun']);
        const range = this.ranges.range(textArgument(a['identifier']));
        const unit = a['unit'] ?? 'grid';
        if (unit !== 'grid' && unit !== 'px') fail('INVALID_ARGUMENT', 'Unit must be grid or px.');
        if ((a['x'] === undefined) !== (a['y'] === undefined)) fail('INVALID_ARGUMENT', 'Give both x and y.');
        const place = a['place'];
        if (place !== undefined && place !== 'table' && place !== 'common')
          fail('INVALID_ARGUMENT', 'place must be table or common.');
        const follow = a['follow'];
        if (follow !== undefined && (typeof follow !== 'string' || follow.length > 256))
          fail('INVALID_ARGUMENT', 'follow must be a piece identifier, or empty to stop following.');
        const change = {
          point:
            a['x'] === undefined
              ? undefined
              : { x: numberArgument(a['x']), y: numberArgument(a['y']), unit: unit as 'grid' | 'px' },
          follow: follow as string | undefined,
          place: place as RangePlace | undefined,
        } as const;
        if (booleanOf(a['dryRun'], 'dryRun')) return { identifier: range.identifier, dryRun: true };
        return this.ranges.set(range, change);
      }
      case 'vn_stage': {
        onlyKeys(a, ['open', 'background', 'transition', 'images']);
        const transition = a['transition'];
        if (transition !== undefined && !VN_STAGE_TRANSITIONS.includes(transition as VnStageTransition))
          fail('INVALID_ARGUMENT', `transition must be one of ${VN_STAGE_TRANSITIONS.join(', ')}.`);
        const background = a['background'];
        if (background !== undefined && (typeof background !== 'string' || !/^([0-9a-f]{64})?$/.test(background)))
          fail('INVALID_ARGUMENT', 'background must be a picture’s SHA-256, or empty to clear it.');
        return this.vnStage.set(
          {
            open: a['open'] === undefined ? undefined : booleanOf(a['open'], 'open'),
            background: background as string | undefined,
            transition: transition as VnStageTransition | undefined,
            images: a['images'] === undefined ? [] : automationImagesOf(a['images']),
          },
          guard
        );
      }
      case 'view_focus': {
        onlyKeys(a, ['identifier', 'x', 'y', 'unit']);
        if (a['identifier'] !== undefined) {
          if (a['x'] !== undefined || a['y'] !== undefined)
            fail('INVALID_ARGUMENT', 'Give a piece or a point, not both.');
          const target = this.store.get(textArgument(a['identifier']));
          if (!(target instanceof TabletopObject) || target.location.name !== 'table')
            fail('NOT_FOUND', 'No piece on the table has that identifier.');
          return { focus: this.sharedFocus.showPiece(target) ?? fail('NOT_READY', 'No table is in view.') };
        }
        const table = this.tables.viewTable;
        if (!table) fail('NOT_READY', 'No table is in view.');
        const unit = a['unit'] ?? 'grid';
        if (unit !== 'grid' && unit !== 'px') fail('INVALID_ARGUMENT', 'Unit must be grid or px.');
        const x = numberArgument(a['x']);
        const y = numberArgument(a['y']);
        if (x < 0 || y < 0 || (unit === 'grid' && (x > table.width || y > table.height)))
          fail('INVALID_ARGUMENT', 'The point is not on the table in view.');
        // A cell is pointed at by its middle.
        const px = unit === 'grid' ? (x + 0.5) * table.gridSize : x;
        const py = unit === 'grid' ? (y + 0.5) * table.gridSize : y;
        return { focus: this.sharedFocus.showPoint(px, py) };
      }
      case 'table_view': {
        onlyKeys(a, ['identifier', 'flat']);
        const table = this.roomPrep.table(textArgument(a['identifier']));
        if (typeof a['flat'] !== 'boolean') fail('INVALID_ARGUMENT', 'flat must be boolean.');
        return this.roomPrep.view(table, a['flat']);
      }
      case 'table_select': {
        onlyKeys(a, ['identifier', 'dryRun']);
        const table = this.roomPrep.table(textArgument(a['identifier']));
        if (booleanOf(a['dryRun'], 'dryRun')) return { identifier: table.identifier, dryRun: true };
        return this.roomPrep.select(table);
      }
      case 'chat_tab_create': {
        onlyKeys(a, ['name', 'playersRead', 'playersSpeak', 'guestsRead', 'guestsSpeak', 'dryRun']);
        const name = textArgument(a['name'], 64).trim();
        const permission = tabPermissionOf(a);
        if (booleanOf(a['dryRun'], 'dryRun')) return { name, ...permission, dryRun: true };
        return this.roomPrep.createTab(name, permission);
      }
      case 'note_create': {
        onlyKeys(a, ['title', 'text', 'x', 'y', 'unit', 'width', 'height', 'disclosure', 'concealed', 'dryRun']);
        const unit = a['unit'] ?? 'grid';
        if (unit !== 'grid' && unit !== 'px') fail('INVALID_ARGUMENT', 'Unit must be grid or px.');
        if (typeof a['text'] !== 'string' || a['text'].length > MAX_NOTE_TEXT)
          fail('INVALID_ARGUMENT', `text must be a string of at most ${MAX_NOTE_TEXT} characters.`);
        const request = {
          title: textArgument(a['title']),
          text: a['text'],
          x: numberArgument(a['x']),
          y: numberArgument(a['y']),
          unit,
          width: wholeOf(a['width'], 'width', 1, 40, 5),
          height: wholeOf(a['height'], 'height', 1, 40, 4),
          disclosure: a['disclosure'] === undefined ? DisclosureMode.All : disclosureOf(a['disclosure']),
          concealed: booleanOf(a['concealed'], 'concealed'),
        } as const;
        if (booleanOf(a['dryRun'], 'dryRun')) return { title: request.title, dryRun: true };
        return this.roomPrep.createNote(request);
      }
      case 'room_template_load': {
        onlyKeys(a, ['room', 'tables', 'presets', 'config', 'audioTags', 'images', 'audios']);
        return this.roomTemplates.load(
          {
            room: textArgument(a['room'], MAX_TEMPLATE_XML),
            tables: a['tables'] === undefined ? null : textsOf(a['tables'], 'tables', MAX_TEMPLATE_TABLES),
            presets: booleanOf(a['presets'], 'presets'),
            config: a['config'] === undefined ? null : textArgument(a['config'], MAX_TEMPLATE_PART_XML),
            audioTags: a['audioTags'] === undefined ? null : textArgument(a['audioTags'], MAX_TEMPLATE_PART_XML),
            images: a['images'] === undefined ? [] : automationImagesOf(a['images']),
            audios: a['audios'] === undefined ? [] : automationAudiosOf(a['audios']),
          },
          guard
        );
      }
      case 'audio_restore':
        onlyKeys(a, ['audios']);
        return this.roomTemplates.restoreAudio(a['audios'] === undefined ? [] : automationAudiosOf(a['audios']), guard);
      case 'bgm_play': {
        onlyKeys(a, ['identifier', 'loop', 'audios', 'stop']);
        const stop = booleanOf(a['stop'], 'stop');
        if (stop === (a['identifier'] !== undefined))
          fail('INVALID_ARGUMENT', 'Give either the identifier of a sound to play or stop: true.');
        return this.roomTemplates.play(
          stop ? null : textArgument(a['identifier'], 64),
          a['loop'] === undefined ? true : booleanOf(a['loop'], 'loop'),
          a['audios'] === undefined ? [] : automationAudiosOf(a['audios']),
          guard
        );
      }
    }
  }

  /** The buffs on one visible piece, as plain data, each with the identifier buff_edit takes. */
  private buffsOf(piece: GameCharacter) {
    return { identifier: piece.identifier, name: this.describe(piece).name, buffs: this.buffCommands.buffsOf(piece) };
  }

  /** The pieces a palette line is aimed at, each one that can be seen; none given leaves the marked pieces. */
  private targets(value: unknown): GameCharacter[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_TARGETS)
      fail('INVALID_ARGUMENT', `targetIds must be a list of at most ${MAX_TARGETS} identifiers.`);
    return value.map((identifier) => this.piece(textArgument(identifier)));
  }

  private piece(identifier: string): GameCharacter {
    const piece = this.store.get(identifier);
    if (!(piece instanceof GameCharacter) || !this.policy.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
    return piece;
  }
  /** A piece to read: one in view on the table, or one out of sight this reader may look at. */
  private readable(identifier: string): GameCharacter {
    const piece = this.store.get(identifier);
    if (piece instanceof GameCharacter && this.policy.canSeeConcealed(piece)) return piece;
    return this.piece(identifier);
  }
  private tab(identifier: string, speak = false): ChatTab {
    const tab = this.store.get(identifier);
    if (!(tab instanceof ChatTab) || !canRoleViewTab(tab, PeerCursor.myRole))
      fail('NOT_FOUND', 'Visible tab not found.');
    if (speak && !canRoleSpeakTab(tab, PeerCursor.myRole)) fail('FORBIDDEN', 'You cannot speak in this tab.');
    return tab;
  }
  private describe(piece: GameCharacter) {
    const gridSize = this.tables.viewTable!.gridSize;
    return {
      identifier: piece.identifier,
      kind: 'character',
      name: piece.hideName && !PeerCursor.isMyselfGameMaster ? '' : piece.name.slice(0, 256),
      x: piece.location.x,
      y: piece.location.y,
      unit: 'px',
      gridX: piece.location.x / gridSize,
      gridY: piece.location.y / gridSize,
      place: piece.location.name === CONCEALED_LOCATION ? 'concealed' : 'table',
      surface: piece.location.surface ?? 'floor',
      posZ: piece.posZ,
      size: piece.size,
      locked: piece.isLock,
      version: piece.version,
    };
  }
  private errorResult(error: unknown): AutomationResult {
    return {
      ok: false,
      error:
        error instanceof AutomationError
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL_ERROR', message: 'Operation failed.' },
    };
  }
  private log(request: AutomationRequest | undefined, result: AutomationResult): void {
    this.audit.add({
      requestId: request?.requestId ?? '',
      command: request?.command ?? 'invalid',
      at: new Date().toISOString(),
      outcome: result.ok ? 'OK' : result.error.code,
    });
  }
}
