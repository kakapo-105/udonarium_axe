import { expect, Page, test } from '@playwright/test';

import type { BrowserAutomationApi } from '../../src/app/application/automation/automation-contract';

async function invoke(page: Page, command: string, args = {}, requestId: string = crypto.randomUUID()) {
  return page.evaluate(
    async ({ command, args, requestId }) => {
      const api = (window as unknown as { udonariumAxeAutomation: BrowserAutomationApi }).udonariumAxeAutomation;
      const { sessionId } = await api.health();
      return api.invoke({ sessionId, requestId, command, arguments: args });
    },
    { command, args, requestId }
  );
}
async function ready(page: Page, seat: string) {
  await page.goto(`/?automation=1&seat=${seat}`);
  await expect(page.locator('textarea.chat-input')).toBeVisible({ timeout: 20000 });
  await page.evaluate((role) => window.__automationTest.prepare(role), seat === 'a' ? 'gm' : 'pl');
  await page.getByTestId('automation-enable').click();
  await expect.poll(() => page.evaluate(() => window.udonariumAxeAutomation?.health())).toMatchObject({ ready: true });
}

test('two clients receive movement and chat, while the PL facade excludes private content', async ({ context }) => {
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await ready(sender, 'a');
  await ready(receiver, 'b');
  const ids = await sender.evaluate(() => window.__automationTest.seed());
  await sender.evaluate(() => window.__automationTest.snapshot());
  await expect
    .poll(() => receiver.evaluate((id) => window.__automationTest.position(id), ids.pieceId))
    .toMatchObject({ x: 50, y: 50 });
  await sender.getByTestId('automation-scope-move_piece').check();
  await sender.getByTestId('automation-scope-send_chat').check();
  const move = await invoke(sender, 'piece_move', { identifier: ids.pieceId, x: 4, y: 3 }, 'move-once');
  expect(move.ok).toBe(true);
  await expect
    .poll(() => receiver.evaluate((id) => window.__automationTest.position(id), ids.pieceId))
    .toMatchObject({ x: 200, y: 150 });
  expect(await invoke(sender, 'piece_move', { identifier: ids.pieceId, x: 4, y: 3 }, 'move-once')).toEqual(move);
  expect((await invoke(sender, 'chat_send', { tabId: ids.tabId, text: 'Hello from MCP' })).ok).toBe(true);
  await expect
    .poll(() => receiver.evaluate((id) => window.__automationTest.messages(id), ids.tabId))
    .toContain('Hello from MCP');
  const scene = JSON.stringify(await invoke(receiver, 'scene_list'));
  expect(scene).toContain(ids.pieceId);
  expect(scene).not.toContain(ids.hiddenId);
  expect(scene).not.toContain('Private GM piece');
  const chat = JSON.stringify(await invoke(receiver, 'chat_read_recent', { tabId: ids.tabId }));
  expect(chat).toContain('Hello from MCP');
  expect(chat).not.toContain('private roll result');
  expect(chat).not.toContain('private whisper');
});

test('stop and reload remove the API and discard write grants and old session IDs', async ({ page }) => {
  await ready(page, 'a');
  const old = await page.evaluate(() => window.udonariumAxeAutomation!.health());
  await page.getByTestId('automation-scope-move_piece').check();
  await page.getByTestId('automation-stop').click();
  await expect.poll(() => page.evaluate(() => !!window.udonariumAxeAutomation)).toBe(false);
  await page.getByTestId('automation-enable').click();
  await expect(page.getByTestId('automation-scope-move_piece')).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.udonariumAxeAutomation?.health())).toMatchObject({ ready: true });
  expect(
    await page.evaluate(
      (sessionId) =>
        window.udonariumAxeAutomation!.invoke({ sessionId, requestId: 'old', command: 'session_get', arguments: {} }),
      old.sessionId
    )
  ).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
  await page.reload();
  await expect(page.getByTestId('automation-enable')).toBeVisible();
  expect(await page.evaluate(() => !!window.udonariumAxeAutomation)).toBe(false);
});

test('ordinary startup publishes neither the control UI nor the API', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('textarea.chat-input')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('automation-control')).toHaveCount(0);
  expect(await page.evaluate(() => !!window.udonariumAxeAutomation)).toBe(false);
});
