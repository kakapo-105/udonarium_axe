import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appUrl } from '../dist/browser-session.js';
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
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: 'session_get', arguments: {} });
    assert.equal(result.structuredContent.error.code, 'NOT_READY');
    assert.match(stderr, /Udonarium browser/);
  } finally {
    await client.close();
  }
});

async function connected(invoke, work) {
  const server = createServer({ invoke });
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

test('exposes exactly the six bounded tools with schemas and read annotations', async () => {
  await connected(
    async () => ({ ok: true, data: {} }),
    async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'chat_read_recent',
        'chat_send',
        'object_get',
        'piece_move',
        'scene_list',
        'session_get',
      ]);
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
      assert.deepEqual(received, ['piece_move', { identifier: 'piece', x: 1, y: 2 }, 'retry', 'session']);
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
