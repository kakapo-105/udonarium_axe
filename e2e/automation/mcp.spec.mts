import { expect, test } from '@playwright/test';
import { Client } from '../../tools/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../tools/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { BrowserSession } from '../../tools/mcp-server/dist/browser-session.js';
import { createServer } from '../../tools/mcp-server/dist/tools.js';

test('MCP client operates its own Chromium and reconnects after reload without carrying grants', async () => {
  const browser = new BrowserSession('http://localhost:4310/?seat=mcp', true);
  const server = createServer(browser);
  const client = new Client({ name: 'browser-integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as { ok: boolean; data: Record<string, unknown>; error: { code: string } };
  };
  try {
    const page = await browser.start();
    await expect(page.locator('textarea.chat-input')).toBeVisible({ timeout: 20000 });
    expect((await call('session_get')).error.code).toBe('NOT_READY');
    await page.evaluate(() => window.__automationTest.prepare('gm'));
    const ids = await page.evaluate(() => window.__automationTest.seed());
    await page.getByTestId('automation-enable').click();
    await expect
      .poll(() => page.evaluate(() => window.udonariumAxeAutomation?.health()))
      .toMatchObject({ ready: true });
    const session = await call('session_get');
    expect(session.ok).toBe(true);
    expect((await call('scene_list')).ok).toBe(true);
    const sessionId = session.data.sessionId;
    const moveArgs = { sessionId, requestId: 'mcp-move', identifier: ids.pieceId, x: 3, y: 4 };
    expect((await call('piece_move', moveArgs)).error.code).toBe('FORBIDDEN');
    await page.getByTestId('automation-scope-move_piece').check();
    expect((await call('piece_move', moveArgs)).ok).toBe(true);
    expect((await call('object_get', { identifier: ids.pieceId })).data).toMatchObject({ x: 150, y: 200 });
    await page.getByTestId('automation-scope-send_chat').check();
    expect((await call('chat_send', { sessionId, tabId: ids.tabId, text: 'MCP protocol message' })).ok).toBe(true);
    expect(JSON.stringify(await call('chat_read_recent', { tabId: ids.tabId }))).toContain('MCP protocol message');
    await page.reload();
    await expect(page.getByTestId('automation-enable')).toBeVisible();
    expect((await call('session_get')).error.code).toBe('NOT_READY');
    await page.getByTestId('automation-enable').click();
    await expect.poll(async () => (await call('session_get')).ok).toBe(true);
    expect((await call('piece_move', moveArgs)).error.code).toBe('NOT_READY');
    await page.goto('http://127.0.0.1:4310').catch(() => {});
    expect(new URL(page.url()).origin).toBe('http://localhost:4310');
  } finally {
    await client.close();
    await server.close();
    await browser.close();
  }
});
