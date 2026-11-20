import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AGENT_TOOLS } from '@axe/core/agent/agent-tools';
import { FORK_BRIDGE_TOOL_NAME } from '@axe/core/agent/fork-agent-tools';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ForkBridge, type TabCall, type TabOutcome, withForkBridgeTools } from './fork-bridge';
import { FORK_BRIDGE_TOOLS } from './fork-bridge-tools';

/** What a tool answered, read back from its JSON text. */
function answerOf(result: CallToolResult): Record<string, unknown> {
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first.text) as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

describe('ForkBridge', () => {
  let root: string;
  let calls: { tool: string; command: string; args: Record<string, unknown>; timeout: number }[];
  let answerWith: (command: string, args: Record<string, unknown>) => TabOutcome;
  let slept: number[];
  let bridge: ForkBridge;
  const tab: TabCall = async (tool, input, timeout) => {
    const command = String(input['command']);
    const args = JSON.parse(String(input['payload'])) as Record<string, unknown>;
    calls.push({ tool, command, args, timeout });
    return answerWith(command, args);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fork-bridge-'));
    for (const folder of ['audio', 'images', 'scenarios', 'templates']) await mkdir(path.join(root, folder));
    await writeFile(path.join(root, 'audio', 'battle.mp3'), Buffer.from('not really music'));
    await writeFile(path.join(root, 'images', 'tavern.png'), Buffer.from('not really a picture'));
    await writeFile(
      path.join(root, 'scenarios', 'lines.json'),
      JSON.stringify({ opening: [{ text: '港町へようこそ', style: 'scene' }, { text: '潮の香りがする' }] })
    );
    calls = [];
    slept = [];
    answerWith = (command) => ({ ok: true, value: { done: command } });
    bridge = new ForkBridge({
      templates: {
        templates: path.join(root, 'templates'),
        audio: [path.join(root, 'audio')],
        images: path.join(root, 'images'),
        scenarios: path.join(root, 'scenarios'),
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('offers its tools in place of the one the tab keeps for it', () => {
    const names = withForkBridgeTools(AGENT_TOOLS).map((tool) => tool.name);
    expect(names).not.toContain(FORK_BRIDGE_TOOL_NAME);
    for (const tool of FORK_BRIDGE_TOOLS) expect(names).toContain(tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of FORK_BRIDGE_TOOLS) {
      expect(Object.keys(tool.inputSchema['properties'] as object)).not.toContain('sessionId');
    }
  });

  it('reads the music and the picture a novel scene names, and hands the tab them by their hashes', async () => {
    const result = await bridge.call(
      'vn_stage',
      { open: true, bgmFile: 'battle.mp3', backgroundFile: 'tavern.png' },
      tab
    );
    expect(answerOf(result)).toEqual({ done: 'vn_stage' });
    const [{ tool, command, args, timeout }] = calls;
    expect(tool).toBe(FORK_BRIDGE_TOOL_NAME);
    expect(command).toBe('vn_stage');
    const music = createHash('sha256').update('not really music').digest('hex');
    const picture = createHash('sha256').update('not really a picture').digest('hex');
    expect(args).toMatchObject({ open: true, bgm: music, background: picture });
    expect(args).not.toHaveProperty('bgmFile');
    expect((args['audios'] as { identifier: string }[])[0].identifier).toBe(music);
    expect((args['images'] as { identifier: string; data: string }[])[0]).toMatchObject({
      identifier: picture,
      data: Buffer.from('not really a picture').toString('base64'),
    });
    expect(timeout).toBeGreaterThan(60_000);
  });

  it('says prepared lines one at a time, waiting for each to be read', async () => {
    const result = answerOf(
      await bridge.call('chat_send', { tabId: 'MainTab', linesFile: 'lines.json', linesKey: 'opening' }, tab)
    );
    expect(calls.map((call) => call.args)).toEqual([
      { tabId: 'MainTab', text: '港町へようこそ', style: 'scene' },
      { tabId: 'MainTab', text: '潮の香りがする' },
    ]);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(2000);
    expect(result['sent']).toHaveLength(2);
  });

  it('stops at the first line the tab refuses, and says which', async () => {
    answerWith = (_, args) =>
      args['text'] === '二行目'
        ? { ok: false, error: { code: 'not_allowed', message: 'no' } }
        : { ok: true, value: {} };
    const result = answerOf(
      await bridge.call(
        'chat_send',
        { tabId: 'MainTab', lines: [{ text: '一行目' }, { text: '二行目' }, { text: '三行目' }] },
        tab
      )
    );
    expect(result).toMatchObject({ sent: [{}], failed: { index: 1, error: { code: 'not_allowed' } } });
    expect(calls).toHaveLength(2);
  });

  it('lists the files of this machine without asking the tab', async () => {
    const listed = answerOf(await bridge.call('room_template_list', {}, tab));
    expect(listed['sounds']).toMatchObject([{ file: 'battle.mp3' }]);
    expect(listed['images']).toMatchObject([{ file: 'tavern.png' }]);
    expect(calls).toHaveLength(0);
  });

  it('refuses a file that is not there, and an input that does not fit, before reaching the tab', async () => {
    expect(textOf(await bridge.call('bgm_play', { file: 'missing.mp3' }, tab))).toMatch(/^NOT_FOUND:/);
    expect(textOf(await bridge.call('vn_stage', { open: 'yes' }, tab))).toMatch(/^invalid_input:.*open/);
    expect(textOf(await bridge.call('character_create', { x: 1, y: 1, pieces: 3 }, tab))).toMatch(/^invalid_input:/);
    expect(calls).toHaveLength(0);
  });

  it('hands sheets given inline straight on, as text or as objects', async () => {
    answerOf(await bridge.call('character_create', { x: 1, y: 1, pieces: ['<character/>'] }, tab));
    answerOf(await bridge.call('character_create', { x: 1, y: 1, pieces: [{ name: 'ゴブリン' }] }, tab));
    expect(calls.map((call) => call.args['pieces'])).toEqual([['<character/>'], [{ name: 'ゴブリン' }]]);
  });

  it('tells a refusal of the tab as the link tells its own', async () => {
    answerWith = () => ({ ok: false, error: { code: 'not_allowed', message: "Only the game master's seat." } });
    const result = await bridge.call('self_set', { name: 'GM', imageFile: 'tavern.png' }, tab);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("not_allowed: Only the game master's seat.");
  });
});
