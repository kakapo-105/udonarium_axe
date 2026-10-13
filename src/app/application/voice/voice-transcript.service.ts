import { inject, Injectable } from '@angular/core';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { ChatTabList } from '@axe/domain/chat/chat-tab-list';

const MAX_TEXT = 2000;
const MAX_NAME = 100;
const SAY_KEYS = new Set(['type', 'id', 'name', 'text', 'tab', 'character']);

/** One line the transcriber heard, already worded as it should appear in the chat. */
export interface VoiceSay {
  type: 'say';
  /** The transcriber's own id for the line, echoed back so it knows the line arrived. */
  id: string;
  /** The name the line goes under: a player's, or the character they speak as. */
  name: string;
  text: string;
  /** The tab to post into, by name; the first tab people talk in when absent or not found. */
  tab?: string;
  /** A character on the table, by name, whose portrait and colour the line wears. */
  character?: string;
}

export type VoicePostResult = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * Reads a line from the transcriber, or says why it cannot be taken.
 *
 * The socket is on this machine but its words become the room's, so anything not shaped exactly
 * as a line is refused rather than guessed at.
 */
export function parseVoiceSay(raw: unknown): VoiceSay | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not an object';
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!SAY_KEYS.has(key)) return `unknown key: ${key}`;
  if (record['type'] !== 'say') return 'type must be say';
  const { id, name, text, tab, character } = record;
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_NAME) return 'id must be a short string';
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > MAX_NAME)
    return 'name must be a short string';
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > MAX_TEXT)
    return 'text must be 1-2000 characters';
  if (tab !== undefined && (typeof tab !== 'string' || tab.length > MAX_NAME)) return 'tab must be a short string';
  if (character !== undefined && (typeof character !== 'string' || character.length > MAX_NAME))
    return 'character must be a short string';
  const say: VoiceSay = { type: 'say', id, name: name.trim(), text: text.trim() };
  if (tab) say.tab = tab;
  if (character) say.character = character;
  return say;
}

/** Posts what the transcriber heard into the room's chat, in this seat's browser. */
@Injectable({ providedIn: 'root' })
export class VoiceTranscriptService {
  private readonly chat = inject(ChatMessageService);
  private readonly chatTabList = inject(ChatTabList);
  private readonly store = inject(ObjectStore);

  post(say: VoiceSay): VoicePostResult {
    const warnings: string[] = [];
    const tabs = this.chatTabList.spokenChatTabs;
    let tab: ChatTab | undefined = say.tab ? tabs.find((t) => t.name === say.tab) : tabs[0];
    if (!tab) {
      tab = tabs[0];
      if (tab) warnings.push(`no tab named ${say.tab}; posted to ${tab.name}`);
    }
    if (!tab) return { ok: false, error: 'the room has no chat tab' };

    let character: GameCharacter | null = null;
    if (say.character) {
      character = this.findCharacter(say.character);
      if (!character) warnings.push(`no character named ${say.character}; posted under the name alone`);
    }
    this.chat.sendTranscript(tab, say.text, say.name, character);
    return { ok: true, warnings };
  }

  /** The piece of that exact name, one standing on the table before one put away; never the graveyard's. */
  private findCharacter(name: string): GameCharacter | null {
    const named = this.store
      .getObjects<GameCharacter>(GameCharacter)
      .filter((piece) => piece.name === name && piece.location.name !== 'graveyard');
    return named.find((piece) => piece.location.name === 'table') ?? named[0] ?? null;
  }
}
