import { inject, Injectable } from '@angular/core';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatMessage } from '@axe/domain/chat/chat-message';
import { ChatTab } from '@axe/domain/chat/chat-tab';

const POLL_MS = 500;
/** How long a piece must stand still before its move counts: a drag passes through many places. */
export const SETTLE_MS = 1500;

/** A piece that was moved and has come to rest, in pixels of the table. */
export interface PieceMove {
  piece: GameCharacter;
  fromX: number;
  fromY: number;
  x: number;
  y: number;
}

/** A public message as automation reads it. */
export function chatMessageView(message: ChatMessage) {
  return {
    identifier: message.identifier,
    tabId: message.tabIdentifier,
    name: message.name.slice(0, 256),
    text: message.text.slice(0, 2000),
    timestamp: message.timestamp,
  };
}

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
   * `guard` runs before every look, so a withdrawn permission ends the wait.
   */
  async wait(
    tabs: readonly ChatTab[],
    allTabs: readonly ChatTab[],
    options: { waitMs: number; limit: number; pieces?: () => readonly GameCharacter[] },
    guard: () => void
  ) {
    if (!this.primed) {
      for (const tab of allTabs) for (const message of tab.chatMessages) this.handed.add(message.identifier);
      this.primed = true;
    }
    const until = Date.now() + options.waitMs;
    for (;;) {
      guard();
      const moves = options.pieces ? this.movesOf(options.pieces()) : [];
      const fresh = this.freshIn(tabs);
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
