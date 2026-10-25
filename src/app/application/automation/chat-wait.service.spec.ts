import { chatMessageView, isRollLine } from '@axe/application/automation/chat-wait.service';
import { encodeI18nMessage } from '@axe/application/i18n/i18n-message';
import { ChatMessage } from '@axe/domain/chat/chat-message';
import { DynamicLoader } from 'bcdice';
import { describe, expect, it } from 'vitest';

describe('isRollLine', () => {
  it('waits for dice wherever they are written, with no game system to ask', () => {
    expect(isRollLine('2d6+5 【命中力判定】')).toBe(true);
    expect(isRollLine('こんにちは')).toBe(false);
    expect(isRollLine('CCB<=50 【目星】')).toBe(false);
  });

  it("waits for a game system's own commands, read as its dice bot reads them", async () => {
    const loader = new DynamicLoader();
    const sixth = (await loader.dynamicLoad('Cthulhu')).COMMAND_PATTERN;
    const seventh = (await loader.dynamicLoad('Cthulhu7th')).COMMAND_PATTERN;

    for (const line of ['CCB<=50 【目星】', 'RESB(12-10)', 'CBRB(50,40)', '3 CCB<=50', 'ＣＣＢ＜＝５０']) {
      expect(isRollLine(line, sixth)).toBe(true);
    }
    for (const line of ['CC<=50 【目星】', 'CC(1)<=50', 'BMR', 'PH', 'FAR(3,50,99)']) {
      expect(isRollLine(line, seventh)).toBe(true);
    }
    expect(isRollLine('目星をどうぞ', sixth)).toBe(false);
    expect(isRollLine('KP：正気度ロールをお願いします', seventh)).toBe(false);
  });
});

describe('chatMessageView', () => {
  const translate = (key: string) => (key === 'common.chat.systemName' ? 'システムメッセージ' : key);
  function message(context: Record<string, unknown>): ChatMessage {
    const line = new ChatMessage();
    for (const [key, value] of Object.entries(context)) line.setAttribute(key, String(value));
    return line;
  }

  it("reads a notice from the room in the reader's language, as the chat shows it", () => {
    const notice = message({ name: encodeI18nMessage('common.chat.systemName'), tag: 'system-message' });
    notice.value = '衣服の棚を開けた。';

    expect(chatMessageView(notice, translate)).toMatchObject({
      name: 'システムメッセージ',
      text: '衣服の棚を開けた。',
    });
  });

  it('leaves what a person wrote as it is, even when it looks like a packed key', () => {
    const said = message({ name: '@i18n:common.chat.systemName:{}', from: 'player' });
    said.value = 'hello';

    expect(chatMessageView(said, translate)).toMatchObject({ name: '@i18n:common.chat.systemName:{}' });
  });
});
