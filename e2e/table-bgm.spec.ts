import { expect, test } from '@playwright/test';

import { openPanel, waitAppReady } from './helpers';

/** 最小限の MP3 ヘッダ。デコードはされないが、ジュークボックスの一覧には曲として載る。 */
const TINY_MP3 = Buffer.from(
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64'
);

test.describe('テーブルごとの BGM', () => {
  test('人の手の速さでクリックしても、BGM に曲を選べること', async ({ page }) => {
    await page.goto('/');
    await waitAppReady(page);
    await openPanel(page, 'ジュークボックス');
    await page.locator('app-jukebox input[type="file"][accept="audio/*"]').setInputFiles({
      name: 'battle.mp3',
      mimeType: 'audio/mpeg',
      buffer: TINY_MP3,
    });
    await expect(page.locator('app-jukebox').getByText('battle.mp3').first()).toBeVisible({ timeout: 15000 });

    await openPanel(page, 'テーブル設定');
    const bgm = page.locator('game-table-setting').getByTestId('table-bgm');
    await bgm.click();
    const option = page.locator('ng-dropdown-panel .ng-option', { hasText: 'battle.mp3' });
    await expect(option).toBeVisible({ timeout: 5000 });

    // 押してから離すまでに画面が描き直されても、選択肢が作り直されずにクリックが届くこと。
    // 一瞬のクリックでは描き直しが挟まらず、この不具合は見逃される。
    const box = (await option.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();

    await expect(bgm.locator('.ng-value-label')).toHaveText('battle.mp3');
  });
});
