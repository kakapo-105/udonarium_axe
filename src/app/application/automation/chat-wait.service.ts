import { inject, Injectable } from '@angular/core';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ChatMessage } from '@axe/domain/chat/chat-message';
import { ChatTab } from '@axe/domain/chat/chat-tab';

const POLL_MS = 500;

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

  /** Forgets what was handed over, for a new automation session. */
  reset(): void {
    this.handed = new Set();
    this.primed = false;
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
    options: { waitMs: number; limit: number },
    guard: () => void
  ) {
    if (!this.primed) {
      for (const tab of allTabs) for (const message of tab.chatMessages) this.handed.add(message.identifier);
      this.primed = true;
    }
    const until = Date.now() + options.waitMs;
    for (;;) {
      guard();
      const fresh = this.freshIn(tabs);
      if (fresh.length > 0) {
        const messages = fresh.slice(0, options.limit);
        this.remember(messages);
        return {
          messages: messages.map(chatMessageView),
          more: fresh.length > messages.length,
          timedOut: false,
          untrustedContent: true,
        };
      }
      const left = until - Date.now();
      if (left <= 0) return { messages: [], more: false, timedOut: true, untrustedContent: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)));
    }
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
