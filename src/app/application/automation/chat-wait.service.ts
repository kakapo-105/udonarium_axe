import { inject, Injectable } from '@angular/core';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatMessage } from '@axe/domain/chat/chat-message';
import { ChatTab } from '@axe/domain/chat/chat-tab';

const POLL_MS = 500;
/** How long a piece must stand still before its move counts: a drag passes through many places. */
export const SETTLE_MS = 1500;
/** As long as a wait keeps gathering lines after the first one came, however long they keep coming. */
export const CHAT_SETTLE_CAP_MS = 20000;

/** A piece that was moved and has come to rest, in pixels of the table. */
export interface PieceMove {
  piece: GameCharacter;
  fromX: number;
  fromY: number;
  x: number;
  y: number;
}

/**
 * A public message as automation reads it. A dice bot's answer also says how the roll came out
 * (`critical`, `fumble`, `success` or `failure`) when the bot told, so a double one needs no reading of the text.
 */
export function chatMessageView(message: ChatMessage) {
  const outcome = message.isDicebot ? (message.rollDetail?.outcome ?? '') : '';
  return {
    identifier: message.identifier,
    tabId: message.tabIdentifier,
    name: message.name.slice(0, 256),
    text: message.text.slice(0, 2000),
    timestamp: message.timestamp,
    ...(outcome ? { outcome } : {}),
  };
}

/** Whether a line said holds dice to roll, which is when its answer is worth waiting for. */
export const ROLL_LIKE = /\d[dD]\d|\d[dD](?![a-zA-Z])|[cC]\(|\[\d*[dD]/;
/** How long to wait for the dice bot's answer to a line, and how long it must stay quiet before the wait ends. */
const ROLL_WAIT_MS = 2500;
const ROLL_QUIET_MS = 350;
const ROLL_POLL_MS = 100;

/** Whether automation may read a message: shown in the log, and neither a secret roll nor a whisper. */
export function isPublicMessage(message: ChatMessage): boolean {
  return !message.isSecret && !message.isDirect && message.isDisplayable;
}

/**
 * Waits for chat that automation has not been handed yet.
 *
 * Messages are told apart by identity rather than by time, so one sent from a peer whose clock runs
 * behind, or two sent in the same millisecond, still arrive once each. What was already in the log
 * when the first wait of a session began counts as handed over; older chat is read with the recent
 * history instead.
 */
@Injectable({ providedIn: 'root' })
export class ChatWaitService {
  private readonly store = inject(ObjectStore);
  private handed = new Set<string>();
  private primed = false;
  /** Where each watched piece was last said to stand. */
  private standing = new Map<string, { x: number; y: number }>();
  /** Where a moving piece is now, and since when it has stood there. */
  private moving = new Map<string, { x: number; y: number; since: number }>();

  /** Forgets what was handed over, for a new automation session. */
  reset(): void {
    this.handed = new Set();
    this.primed = false;
    this.standing = new Map();
    this.moving = new Map();
  }

  /**
   * Takes a piece's place as already known, as after automation moved it itself, so the next wait
   * does not hand the move back as a player's.
   */
  settle(piece: GameCharacter): void {
    this.standing.set(piece.identifier, { x: piece.location.x, y: piece.location.y });
    this.moving.delete(piece.identifier);
  }

  /**
   * Runs `say`, which speaks for automation there and then, and counts every line it put in any tab
   * as already handed over, so a wait does not answer automation with its own words.
   *
   * Nothing from anyone else can arrive while code runs without yielding, so exactly the lines `say`
   * made are counted, whoever's name is on them and whatever the network knows about the sender.
   */
  /** The identifiers of the lines in a tab now, to tell afterwards which came since. */
  linesOf(tab: ChatTab): Set<string> {
    return new Set(tab.chatMessages.map((message) => message.identifier));
  }

  /**
   * The dice bot's answers that came into the tab since `before` was taken, handed over at once so a later wait does not
   * repeat them. Answers arrive a moment after the line is said, so this waits for the first and then for quiet; a line
   * with no dice in it (`text`) is not waited for at all.
   */
  async rollsSince(tab: ChatTab, before: ReadonlySet<string>, text: string, guard: () => void) {
    if (!ROLL_LIKE.test(text)) return [];
    const answers = () =>
      tab.chatMessages.filter(
        (m) => !before.has(m.identifier) && !this.handed.has(m.identifier) && m.isDicebot && isPublicMessage(m)
      );
    const started = Date.now();
    let count = 0;
    let lastChange = started;
    for (;;) {
      guard();
      const now = answers().length;
      if (now !== count) {
        count = now;
        lastChange = Date.now();
      }
      const elapsed = Date.now() - started;
      if ((count > 0 && Date.now() - lastChange >= ROLL_QUIET_MS) || elapsed >= ROLL_WAIT_MS) break;
      await new Promise((resolve) => setTimeout(resolve, ROLL_POLL_MS));
    }
    const found = answers();
    for (const message of found) this.handed.add(message.identifier);
    return found.map(chatMessageView);
  }

  said<T>(say: () => T): T {
    const lines = () => this.store.getObjects<ChatTab>(ChatTab).flatMap((tab) => tab.chatMessages);
    const before = new Set(lines().map((message) => message.identifier));
    try {
      return say();
    } finally {
      for (const message of lines()) if (!before.has(message.identifier)) this.handed.add(message.identifier);
    }
  }

  /**
   * The public messages in `tabs` not yet handed over, oldest first and at most `limit` of them,
   * as soon as there is at least one; none once `waitMs` has passed.
   *
   * With `settleMs`, a wait that has found chat keeps watching until nothing new has come for that
   * long (or {@link CHAT_SETTLE_CAP_MS} has passed since the first line) and hands over what it has
   * gathered at once, so speech that arrives in fragments is one answer rather than many.
   *
   * `guard` runs before every look, so a withdrawn permission ends the wait.
   */
  async wait(
    tabs: readonly ChatTab[],
    allTabs: readonly ChatTab[],
    options: { waitMs: number; limit: number; settleMs?: number; pieces?: () => readonly GameCharacter[] },
    guard: () => void
  ) {
    if (!this.primed) {
      for (const tab of allTabs) for (const message of tab.chatMessages) this.handed.add(message.identifier);
      this.primed = true;
    }
    const until = Date.now() + options.waitMs;
    const settleMs = options.settleMs ?? 0;
    let gathered = 0;
    let firstAt = 0;
    let changedAt = 0;
    for (;;) {
      guard();
      const moves = options.pieces ? this.movesOf(options.pieces()) : [];
      const fresh = this.freshIn(tabs);
      if (fresh.length > 0 && settleMs > 0 && moves.length === 0) {
        const now = Date.now();
        if (fresh.length !== gathered) {
          if (gathered === 0) firstAt = now;
          gathered = fresh.length;
          changedAt = now;
        }
        const quiet = now - changedAt >= settleMs || now - firstAt >= CHAT_SETTLE_CAP_MS;
        if (!quiet) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
      }
      if (fresh.length > 0 || moves.length > 0) {
        const messages = fresh.slice(0, options.limit);
        this.remember(messages);
        return {
          messages: messages.map(chatMessageView),
          moves,
          more: fresh.length > messages.length,
          timedOut: false,
          untrustedContent: true,
        };
      }
      const left = until - Date.now();
      if (left <= 0) return { messages: [], moves: [], more: false, timedOut: true, untrustedContent: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)));
    }
  }

  /**
   * The watched pieces that have come to rest somewhere new since they were last said to stand. A
   * piece seen for the first time, as one just brought out, is only taken note of.
   */
  private movesOf(pieces: readonly GameCharacter[]): PieceMove[] {
    const now = Date.now();
    const moves: PieceMove[] = [];
    for (const piece of pieces) {
      const { x, y } = piece.location;
      const stood = this.standing.get(piece.identifier);
      if (!stood) {
        this.standing.set(piece.identifier, { x, y });
        continue;
      }
      if (stood.x === x && stood.y === y) {
        this.moving.delete(piece.identifier);
        continue;
      }
      const move = this.moving.get(piece.identifier);
      if (!move || move.x !== x || move.y !== y) {
        this.moving.set(piece.identifier, { x, y, since: now });
      } else if (now - move.since >= SETTLE_MS) {
        moves.push({ piece, fromX: stood.x, fromY: stood.y, x, y });
        this.settle(piece);
      }
    }
    return moves;
  }

  private freshIn(tabs: readonly ChatTab[]): ChatMessage[] {
    return tabs
      .flatMap((tab) => tab.chatMessages)
      .filter((message) => !this.handed.has(message.identifier) && isPublicMessage(message))
      .sort((l, r) => l.timestamp - r.timestamp);
  }

  private remember(messages: readonly ChatMessage[]): void {
    for (const message of messages) this.handed.add(message.identifier);
  }
}
