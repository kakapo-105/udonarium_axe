import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { BRIDGE, buildBridgeIfStale } from './ai-bridge';
import { becomeGm, openFabMenu, putAwayTutorial, waitAppReady } from './helpers';

/** What a tool answered, read back from its JSON text. */
function answerOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first.text) as Record<string, unknown>;
}

test.describe("the fork's tools over the AI link", () => {
  test.beforeAll(() => {
    buildBridgeIfStale();
  });

  test('offers them beside upstream’s, reads through them, and writes only once the seat allows it', async ({
    page,
  }, info) => {
    const port = 47800 + info.parallelIndex;
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: 'node', args: [BRIDGE, '--port', String(port)], stderr: 'ignore' })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['send_chat', 'table_list', 'note_create']));

      await waitAppReady(page);
      await putAwayTutorial(page);
      // Notes are the game master's to lay, as the facade checks.
      await becomeGm(page);
      await openFabMenu(page);
      await page.getByTestId('fab-ai-link').click();
      const panel = page.locator('ai-link-panel');
      const portInput = panel.getByTestId('ai-link-port');
      await portInput.fill(String(port));
      await portInput.press('Tab');
      await panel.getByTestId('ai-link-toggle').click();
      await expect(panel.getByTestId('ai-link-state')).toHaveAttribute('data-state', 'connected', { timeout: 15000 });

      // A fork tool that reads runs while the seat lets the AI read only.
      const tables = answerOf(await client.callTool({ name: 'table_list', arguments: {} }));
      expect(JSON.stringify(tables)).toContain('identifier');

      // One that writes is refused until the seat allows changes.
      const note = { title: '依頼の手紙', text: '北の塔へ', x: 2, y: 2 };
      const refused = await client.callTool({ name: 'note_create', arguments: note });
      expect(refused.isError).toBe(true);

      await panel.getByTestId('ai-link-scope-write').check();
      answerOf(await client.callTool({ name: 'note_create', arguments: note }));
      await expect(panel.getByTestId('ai-link-history-entry')).toHaveCount(2);
    } finally {
      await client.close();
    }
  });
});
