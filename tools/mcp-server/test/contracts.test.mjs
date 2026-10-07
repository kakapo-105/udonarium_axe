import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appUrl } from '../dist/browser-session.js';
import { pieceSourceOrigins } from '../dist/piece-source.js';
import { createServer } from '../dist/tools.js';

test('the real stdio entry point lists tools and reports missing Chromium without corrupting stdout', async () => {
  const client = new Client({ name: 'stdio-contract-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(new URL('../.cache/absent-test-browser', import.meta.url)),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 24);
    const result = await client.callTool({ name: 'session_get', arguments: {} });
    assert.equal(result.structuredContent.error.code, 'NOT_READY');
    assert.match(stderr, /Udonarium browser/);
  } finally {
    await client.close();
  }
});

async function connected(invoke, work, options) {
  const server = createServer({ invoke }, options);
  const client = new Client({ name: 'contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('exposes exactly the twenty-four bounded tools with schemas and read annotations', async () => {
  await connected(
    async () => ({ ok: true, data: {} }),
    async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'buff_edit',
        'buff_list',
        'buff_send',
        'buff_sweep',
        'character_create',
        'character_sheet_get',
        'chat_read_recent',
        'chat_send',
        'chat_tab_create',
        'chat_wait',
        'note_create',
        'object_get',
        'palette_get',
        'palette_send',
        'piece_conceal',
        'piece_disclose',
        'piece_move',
        'piece_remove',
        'piece_reveal',
        'scene_list',
        'session_get',
        'table_create',
        'table_list',
        'table_select',
      ]);
      assert.equal(tools.find((t) => t.name === 'palette_send').annotations.readOnlyHint, false);
      assert.equal(tools.find((t) => t.name === 'palette_get').annotations.readOnlyHint, true);
      const move = tools.find((t) => t.name === 'piece_move');
      assert(move.inputSchema.required.includes('sessionId'));
      assert.equal(move.annotations.readOnlyHint, false);
      assert.equal(tools.find((t) => t.name === 'scene_list').annotations.readOnlyHint, true);
    }
  );
});
test('rejects writes without a session and unknown properties before reaching the browser', async () => {
  let count = 0;
  await connected(
    async () => {
      count++;
      return { ok: true, data: {} };
    },
    async (client) => {
      assert.equal(
        (await client.callTool({ name: 'piece_move', arguments: { identifier: 'piece', x: 1, y: 2 } })).isError,
        true
      );
      assert.equal((await client.callTool({ name: 'scene_list', arguments: { script: 'bad' } })).isError, true);
      assert.equal(count, 0);
    }
  );
});
test('passes retry identity separately from operation arguments and maps structured errors', async () => {
  let received;
  await connected(
    async (...args) => {
      received = args;
      return { ok: false, error: { code: 'CONFLICT', message: 'stale' } };
    },
    async (client) => {
      const result = await client.callTool({
        name: 'piece_move',
        arguments: { sessionId: 'session', requestId: 'retry', identifier: 'piece', x: 1, y: 2 },
      });
      assert.deepEqual(received, ['piece_move', { identifier: 'piece', x: 1, y: 2 }, 'retry', 'session', 20000]);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'CONFLICT');
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
  );
});
test('assigns request IDs and preserves NOT_READY and TIMEOUT responses', async () => {
  for (const code of ['NOT_READY', 'TIMEOUT']) {
    await connected(
      async (command, args, requestId) => {
        assert.match(requestId, /^[0-9a-f-]{36}$/);
        return { ok: false, error: { code, message: 'waiting' } };
      },
      async (client) => {
        assert.equal(
          (await client.callTool({ name: 'session_get', arguments: {} })).structuredContent.error.code,
          code
        );
      }
    );
  }
});
test('only opens a fixed HTTP(S) application origin with explicit opt-in', () => {
  assert.equal(appUrl('http://localhost:4200/app').href, 'http://localhost:4200/app?automation=1');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://example.com',
    'https://name:password@example.com',
  ]) {
    assert.throws(() => appUrl(url));
  }
  assert.equal(appUrl('https://example.com').origin, 'https://example.com');
});
test('gives a wait for chat as long as it asks for, and other requests the usual time', async () => {
  const timeouts = {};
  await connected(
    async (command, args, requestId, sessionId, timeoutMs) => {
      timeouts[command] = timeoutMs;
      return { ok: true, data: { messages: [] } };
    },
    async (client) => {
      await client.callTool({ name: 'chat_wait', arguments: { waitSeconds: 120 } });
      await client.callTool({ name: 'session_get', arguments: {} });
      await client.callTool({
        name: 'table_create',
        arguments: { sessionId: 'session', kind: 'dungeon', atmosphere: 'crypt' },
      });
      assert.equal((await client.callTool({ name: 'chat_wait', arguments: { waitSeconds: 301 } })).isError, true);
    }
  );
  assert.deepEqual(timeouts, { chat_wait: 130000, session_get: 20000, table_create: 130000 });
});
test('fetches pieces from an allowed source so they reach the browser, not the conversation', async () => {
  const sheet = { kind: 'character', data: { name: 'ゴブリン' } };
  let fetched;
  let received;
  await connected(
    async (command, args) => {
      received = args;
      return { ok: true, data: { pieces: [{ identifier: 'made', name: 'ゴブリン' }] } };
    },
    async (client) => {
      const result = await client.callTool({
        name: 'character_create',
        arguments: {
          sessionId: 'session',
          sourceUrl: 'http://rules:8765/api/ccfolia?name=ゴブリン&count=2',
          x: 1,
          y: 2,
        },
      });
      assert.equal(new URL(fetched).pathname, '/api/ccfolia');
      assert.deepEqual(received, { pieces: [sheet, sheet], x: 1, y: 2 });
      assert.deepEqual(result.structuredContent.data.sourceWarnings, ['no palette']);
      assert.doesNotMatch(result.content[0].text, /"kind"/);
    },
    {
      pieceSources: pieceSourceOrigins('http://rules:8765'),
      fetchText: async (url) => {
        fetched = url.href;
        return { ok: true, status: 200, text: JSON.stringify({ pieces: [sheet, sheet], warnings: ['no palette'] }) };
      },
    }
  );
});
test('refuses piece sources that are not allowed, and passes on what a source could not find', async () => {
  let count = 0;
  await connected(
    async () => {
      count++;
      return { ok: true, data: {} };
    },
    async (client) => {
      const create = (args) =>
        client.callTool({ name: 'character_create', arguments: { sessionId: 'session', x: 0, y: 0, ...args } });
      assert.equal((await create({ sourceUrl: 'http://elsewhere/api' })).structuredContent.error.code, 'FORBIDDEN');
      assert.equal((await create({})).structuredContent.error.code, 'INVALID_ARGUMENT');
      assert.equal(
        (await create({ pieces: [{ kind: 'character' }], sourceUrl: 'http://rules:8765/a' })).structuredContent.error
          .code,
        'INVALID_ARGUMENT'
      );
      const missing = await create({ sourceUrl: 'http://rules:8765/api/ccfolia?name=ドレイク' });
      assert.equal(missing.structuredContent.error.code, 'INVALID_ARGUMENT');
      assert.match(missing.structuredContent.error.message, /ドレイク\(竜形態\) \(Lv7\)/);
      assert.doesNotMatch(missing.structuredContent.error.message, /object Object/);
      assert.equal(count, 0);
    },
    {
      pieceSources: pieceSourceOrigins('http://rules:8765'),
      fetchText: async () => ({
        ok: false,
        status: 404,
        text: JSON.stringify({
          error: '魔物が1体に決まりませんでした',
          candidates: [
            { id: '魔物/ドレイク(人間形態)', kind: '魔物', name: 'ドレイク(人間形態)', level: 6 },
            { id: '魔物/ドレイク(竜形態)', kind: '魔物', name: 'ドレイク(竜形態)', level: 7 },
          ],
        }),
      }),
    }
  );
  assert.throws(() => pieceSourceOrigins('file:///etc'));
  assert.deepEqual(pieceSourceOrigins(' http://a:1/x , https://b '), ['http://a:1', 'https://b']);
});
test('fetches the pictures a source names and hands them to the browser in base64', async () => {
  const hash = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const missing = 'c'.repeat(64);
  let received;
  const asked = [];
  await connected(
    async (command, args) => {
      received = args;
      return { ok: true, data: { pieces: [{ identifier: 'made' }] } };
    },
    async (client) => {
      const result = await client.callTool({
        name: 'character_create',
        arguments: { sessionId: 'session', sourceUrl: 'http://rules:8765/api/udonarium?name=x', x: 0, y: 0 },
      });
      assert.deepEqual(received.pieces, ['<character/>']);
      assert.deepEqual(received.images, [
        { identifier: hash, type: 'image/webp', data: Buffer.from([1, 2, 3]).toString('base64') },
      ]);
      assert.deepEqual(asked, [
        `http://rules:8765/api/images/${hash}.webp`,
        `http://rules:8765/api/images/${missing}.webp`,
      ]);
      const warnings = result.structuredContent.data.sourceWarnings.join(' ');
      assert.match(warnings, /outside the allowed sources/);
      assert.match(warnings, /could not be fetched/);
    },
    {
      pieceSources: pieceSourceOrigins('http://rules:8765'),
      fetchText: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          pieces: ['<character/>'],
          images: {
            [hash]: `/api/images/${hash}.webp`,
            [other]: 'http://elsewhere/evil.webp',
            [missing]: `/api/images/${missing}.webp`,
            'not-a-hash': '/api/images/x.webp',
          },
        }),
      }),
      fetchBytes: async (url) => {
        asked.push(url.href);
        return url.href.includes(hash)
          ? { ok: true, status: 200, type: 'image/webp', bytes: new Uint8Array([1, 2, 3]) }
          : { ok: false, status: 404, type: 'application/json', bytes: new Uint8Array() };
      },
    }
  );
});
test('builds a board from a template, handing the browser its picture and the model its areas', async () => {
  const hash = 'd'.repeat(64);
  let received;
  await connected(
    async (command, args) => {
      received = [command, args];
      return { ok: true, data: { identifier: 'table', name: args.name, width: args.width, height: args.height } };
    },
    async (client) => {
      const result = await client.callTool({
        name: 'table_create',
        arguments: {
          sessionId: 'session',
          kind: 'board',
          templateUrl: 'http://rules:8765/api/boards/basic',
          height: 16,
        },
      });
      assert.equal(received[0], 'table_create');
      assert.deepEqual(received[1], {
        kind: 'board',
        name: '基本戦闘',
        width: 32,
        height: 16,
        background: hash,
        grid: false,
        flat: true,
        images: [{ identifier: hash, type: 'image/png', data: Buffer.from([7]).toString('base64') }],
      });
      const data = result.structuredContent.data;
      assert.equal(data.rule, '基本戦闘 (ルールブックDX p.71)');
      assert.deepEqual(data.areas[0], { name: '自軍後方エリア', x: 1, y: 2, w: 8, h: 11 });
      assert.match(data.guide, /3つのエリア/);
      const missing = await client.callTool({
        name: 'table_create',
        arguments: { sessionId: 'session', kind: 'board' },
      });
      assert.equal(missing.structuredContent.error.code, 'INVALID_ARGUMENT');
    },
    {
      pieceSources: pieceSourceOrigins('http://rules:8765'),
      fetchText: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          id: 'basic',
          name: '基本戦闘',
          rule: '基本戦闘 (ルールブックDX p.71)',
          width: 32,
          height: 14,
          grid: false,
          flat: true,
          background: hash,
          images: { [hash]: `/api/images/${hash}.png` },
          areas: [{ name: '自軍後方エリア', x: 1, y: 2, w: 8, h: 11 }],
          guide: '戦場は3つのエリアだけ',
        }),
      }),
      fetchBytes: async () => ({ ok: true, status: 200, type: 'image/png', bytes: new Uint8Array([7]) }),
    }
  );
});
