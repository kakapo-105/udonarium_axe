import { createHash } from 'node:crypto';

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

  // Set out early, out of sight: on the player's side it is in the store, yet nowhere to be found.
  const hidden = await invoke(gm, 'character_create', {
    pieces: [sheet('ドレイク')],
    x: 2,
    y: 2,
    disclosure: 'all',
    concealed: true,
  });
  const [drake] = (hidden as { data: { pieces: { identifier: string }[] } }).data.pieces;
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.position(id), drake.identifier))
    .toMatchObject({ name: 'concealed', x: 100, y: 100 });
  expect(await seen()).not.toContain(drake.identifier);
  expect(JSON.stringify(await invoke(player, 'scene_list', { place: 'concealed' }))).not.toContain(drake.identifier);
  expect((await invoke(gm, 'piece_reveal', { identifiers: [drake.identifier] })).ok).toBe(true);
  await expect.poll(seen).toContain(drake.identifier);
});

test('a GM sets the room up: a generated dungeon in view, a tab of its own and a handout kept back', async ({
  context,
}) => {
  const gm = await context.newPage();
  const player = await context.newPage();
  await ready(gm, 'a');
  await ready(player, 'b');
  await gm.evaluate(() => window.__automationTest.seed());
  await gm.evaluate(() => window.__automationTest.snapshot());
  await gm.getByTestId('automation-scope-prepare_room').check();
  // Bringing a handout out is done as for any piece, so it needs that grant too.
  await gm.getByTestId('automation-scope-create_piece').check();
  const viewing = (page: Page) =>
    invoke(page, 'session_get').then((result) => (result as { data: { table: { identifier: string } } }).data.table);

  const created = await invoke(gm, 'table_create', {
    kind: 'dungeon',
    atmosphere: 'crypt',
    roomCount: 4,
    seed: 11,
    name: '地下墓地',
  });
  expect(created).toMatchObject({ ok: true, data: { name: '地下墓地', unit: 'grid' } });
  const dungeon = (created as { data: { identifier: string; rooms: { x: number; w: number }[]; width: number } }).data;
  expect(dungeon.rooms.length).toBeGreaterThanOrEqual(3);
  for (const room of dungeon.rooms) expect(room.x + room.w).toBeLessThanOrEqual(dungeon.width);

  expect((await invoke(gm, 'table_select', { identifier: dungeon.identifier })).ok).toBe(true);
  await expect.poll(() => viewing(player).then((table) => table.identifier)).toBe(dungeon.identifier);

  const tab = await invoke(gm, 'chat_tab_create', { name: 'GM', playersRead: false, guestsRead: false });
  const tabId = (tab as { data: { identifier: string } }).data.identifier;
  await expect.poll(() => invoke(gm, 'session_get').then((result) => JSON.stringify(result))).toContain(tabId);
  expect(JSON.stringify(await invoke(player, 'session_get'))).not.toContain(tabId);

  const note = await invoke(gm, 'note_create', { title: '依頼書', text: '墓地の調査', x: 1, y: 1, concealed: true });
  const noteId = (note as { data: { identifier: string } }).data.identifier;
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.position(id), noteId))
    .toMatchObject({ name: 'concealed' });
  expect((await invoke(gm, 'piece_reveal', { identifiers: [noteId] })).ok).toBe(true);
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.position(id), noteId))
    .toMatchObject({ name: 'table', x: 50, y: 50 });
});

test('a GM puts out a piece of this tool’s own, wearing a picture the players receive', async ({ context }) => {
  const gm = await context.newPage();
  const player = await context.newPage();
  await ready(gm, 'a');
  await ready(player, 'b');
  await gm.evaluate(() => window.__automationTest.seed());
  await gm.evaluate(() => window.__automationTest.snapshot());
  await gm.getByTestId('automation-scope-create_piece').check();
  // A picture drawn in the browser, identified by its SHA-256 as save data names pictures.
  const png = Buffer.from(
    await gm.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#3a6';
      context.fillRect(0, 0, 8, 8);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64'
  );
  const identifier = createHash('sha256').update(png).digest('hex');
  // Dotted attributes such as location.name are what save data carries; a browser reads them.
  const xml = `<character location.name="graveyard" location.x="0" location.y="0" posZ="0" disclosureMode="all" owner="">
  <data name="character">
    <data name="image"><data type="image" name="imageIdentifier">${identifier}</data></data>
    <data name="common"><data name="name">トロール</data><data name="size">1</data><data name="altitude">0</data></data>
    <data name="detail"><data role="section" name="リソース"><data role="group" name="基本">
      <data fieldType="resource" type="numberResource" currentValue="30" role="field" name="HP">30</data>
    </data></data></data>
  </data>
  <chat-palette dicebot="SwordWorld2.5">2d6+5 【命中力判定】</chat-palette>
</character>`;

  const created = await invoke(gm, 'character_create', {
    pieces: [xml],
    x: 3,
    y: 3,
    disclosure: 'all',
    images: [{ identifier, type: 'image/png', data: png.toString('base64') }],
  });
  expect(created).toMatchObject({ ok: true, data: { pieces: [{ name: 'トロール', x: 150, y: 150 }] } });
  const [troll] = (created as { data: { pieces: { identifier: string }[] } }).data.pieces;
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.position(id), troll.identifier))
    .toMatchObject({ name: 'table', x: 150, y: 150 });
  expect(await gm.evaluate((id) => window.__automationTest.imageState(id), identifier)).toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => player.evaluate((id) => window.__automationTest.imageState(id), identifier))
    .toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(await invoke(player, 'scene_list'))).toContain('トロール');
});

test('a browser started with the gm preset is the game master with every grant, until a person stops it', async ({
  page,
}) => {
  await page.goto('/?automation=1&automationPreset=gm&seat=a');
  await expect(page.locator('textarea.chat-input')).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => window.__automationTest.seed());

  await expect
    .poll(() => page.evaluate(() => window.udonariumAxeAutomation?.health()), { timeout: 10000 })
    .toMatchObject({ ready: true });
  const session = (await invoke(page, 'session_get')) as { data: { role: string; scopes: string[] } };
  expect(session.data.role).toBe('gm');
  expect(session.data.scopes).toEqual(
    expect.arrayContaining(['create_piece', 'prepare_room', 'move_piece', 'edit_resource'])
  );

  await page.getByTestId('automation-stop').click();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.udonariumAxeAutomation === undefined)).toBe(true);
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
