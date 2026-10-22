import { isRollLine } from '@axe/application/automation/chat-wait.service';
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
