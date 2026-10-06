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

test('a GM puts monsters out, discloses and clears them, and hears the players through a wait', async ({ context }) => {
  const gm = await context.newPage();
  const player = await context.newPage();
  await ready(gm, 'a');
  await ready(player, 'b');
  const ids = await gm.evaluate(() => window.__automationTest.seed());
  await gm.evaluate(() => window.__automationTest.snapshot());
  await gm.getByTestId('automation-scope-create_piece').check();
  await gm.getByTestId('automation-scope-send_chat').check();
  await player.getByTestId('automation-scope-send_chat').check();
  const sheet = (name: string) => ({
    kind: 'character',
    data: { name, status: [{ label: 'HP', value: '16', max: '16' }] },
  });

  const created = await invoke(gm, 'character_create', {
    pieces: [sheet('ゴブリンA'), sheet('ゴブリンB')],
    x: 6,
    y: 1,
  });
  expect(created.ok).toBe(true);
  const [first] = (created as { data: { pieces: { identifier: string }[] } }).data.pieces;
  const seen = () => invoke(player, 'scene_list').then((result) => JSON.stringify(result));
  // Kept to the game master, the monster's numbers are not for the players to read yet.
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.position(id), first.identifier))
    .toMatchObject({ x: 300, y: 50 });
  expect(await seen()).not.toContain(first.identifier);
  expect((await invoke(gm, 'piece_disclose', { identifier: first.identifier, disclosure: 'all' })).ok).toBe(true);
  await expect.poll(seen).toContain(first.identifier);

  expect(await invoke(gm, 'chat_wait', { tabIds: [ids.tabId], waitSeconds: 1 })).toMatchObject({
    ok: true,
    data: { timedOut: true },
  });
  const waiting = invoke(gm, 'chat_wait', { tabIds: [ids.tabId], waitSeconds: 20 });
  expect((await invoke(gm, 'chat_send', { tabId: ids.tabId, text: 'GM narration' })).ok).toBe(true);
  expect((await invoke(player, 'chat_send', { tabId: ids.tabId, text: '攻撃します' })).ok).toBe(true);
  expect(await waiting).toMatchObject({ ok: true, data: { messages: [{ text: '攻撃します' }], timedOut: false } });

  expect((await invoke(gm, 'piece_remove', { identifiers: [first.identifier] })).ok).toBe(true);
  await expect.poll(seen).not.toContain(first.identifier);
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
