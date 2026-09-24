import { inject, Injectable } from '@angular/core';
import { AutomationAuditService } from '@axe/application/automation/automation-audit.service';
import {
  AUTOMATION_COMMANDS,
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
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { SessionCommandService } from '@axe/application/automation/session-command.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { canRoleSpeakTab, canRoleViewTab } from '@axe/domain/chat/chat-tab-permission';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';

const REQUEST_TIMEOUT_MS = 15000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/**
 * One resource change on the speaking piece. Besides a plain number the amount may roll dice, hold a
 * bracketed roll, branch with `if()` and read a roll again through `$n`, as a resource edit typed into
 * chat can; none of these reach any data but the dice. Spaces are not allowed, so it stays one command.
 */
const RESOURCE_COMMAND =
  /^:[^\s:：&＆+=-]+[+-](?:\d+(?:\.\d+)?|[dD]|\[[^[\]\s{}｛｝]+\]|\$\d+|if\(|[-+*/()<>=!,])+[LZlz]{0,2}$/u;
type Remembered = { fingerprint: string; expires: number; result: Promise<AutomationResult> };

@Injectable({ providedIn: 'root' })
export class AutomationFacadeService {
  private readonly policy = inject(AutomationPolicyService);
  private readonly session = inject(SessionCommandService);
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
      const writes = request.command === 'piece_move' || request.command === 'chat_send';
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
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
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
          }, REQUEST_TIMEOUT_MS);
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
        onlyKeys(a, ['limit', 'after', 'name']);
        const limit = pageSize(a['limit']);
        const after = a['after'] === undefined ? '' : textArgument(a['after']);
        const name = a['name'] === undefined ? '' : textArgument(a['name']);
        const pieces = this.store
          .getObjects<GameCharacter>(GameCharacter)
          .filter((p) => this.policy.canSee(p))
          .map((p) => this.describe(p))
          .filter((p) => p.identifier > after && (!name || p.name.includes(name)))
          .sort((l, r) => (l.identifier < r.identifier ? -1 : l.identifier > r.identifier ? 1 : 0));
        return { objects: pieces.slice(0, limit), next: pieces.length > limit ? pieces[limit - 1].identifier : null };
      }
      case 'object_get':
        onlyKeys(a, ['identifier']);
        return this.describe(this.piece(textArgument(a['identifier'])));
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
        return this.session.move(
          piece,
          { x: numberArgument(a['x']), y: numberArgument(a['y']), unit },
          a['dryRun'] === true,
          guard
        );
      }
      case 'chat_send': {
        onlyKeys(a, ['tabId', 'text', 'characterId', 'dryRun']);
        if (a['dryRun'] !== undefined && typeof a['dryRun'] !== 'boolean')
          fail('INVALID_ARGUMENT', 'dryRun must be boolean.');
        const tab = this.tab(textArgument(a['tabId']), true);
        const piece = a['characterId'] === undefined ? null : this.piece(textArgument(a['characterId']));
        if (a['dryRun'] === true) return { tabId: tab.identifier, dryRun: true };
        return this.session.send(tab, textArgument(a['text'], 2000), piece, guard);
      }
      case 'chat_read_recent': {
        onlyKeys(a, ['tabId', 'limit']);
        const tab = this.tab(textArgument(a['tabId']));
        const limit = pageSize(a['limit'], 20);
        return {
          messages: tab.chatMessages
            .filter((m) => !m.isSecret && !m.isDirect && m.isDisplayable)
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
    }
  }

  private piece(identifier: string): GameCharacter {
    const piece = this.store.get(identifier);
    if (!(piece instanceof GameCharacter) || !this.policy.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
    return piece;
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
