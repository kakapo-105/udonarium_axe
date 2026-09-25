import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'playwright';

import { type FacadeResult, failure, invokeFacade } from '#mcp/facade-client.js';

export function appUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    throw new Error('Use an HTTP(S) application URL without credentials.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Remote application URLs require HTTPS.');
  url.searchParams.set('automation', '1');
  return url;
}

export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private opening?: Promise<Page>;
  private closed = false;
  readonly url: URL;

  constructor(
    url: string,
    private readonly headless = false
  ) {
    this.url = appUrl(url);
  }

  async start(): Promise<Page> {
    if (this.closed) throw new Error('Browser session has been closed.');
    if (this.opening) return this.opening;
    if (this.page && !this.page.isClosed()) return this.page;
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  private async open(): Promise<Page> {
    await this.browser?.close();
    // Keep Chromium downloads inside this package, not in the user's shared browser cache.
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('../.cache/browsers', import.meta.url));
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: this.headless, timeout: 15000 });
    if (this.closed) {
      await this.browser.close();
      throw new Error('Browser startup was cancelled.');
    }
    const context = await this.browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    this.page = page;
    context.on('page', (opened) => {
      if (opened !== page) void opened.close();
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        new URL(request.url()).origin !== this.url.origin
      ) {
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    try {
      await page.goto(this.url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (error) {
      await this.browser.close();
      this.page = undefined;
      throw error;
    }
    return page;
  }

  async invoke(
    command: string,
    args: Record<string, unknown>,
    requestId: string,
    sessionId?: string
  ): Promise<FacadeResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.start().then((page) => {
          if (new URL(page.url()).origin !== this.url.origin)
            return failure('NOT_READY', 'Application origin changed.');
          return invokeFacade(page, { command, arguments: args, requestId, sessionId });
        }),
        new Promise<FacadeResult>((resolve) => {
          timer = setTimeout(() => {
            // Do not leave a timed-out write alive in a page or retry it in another session.
            void this.close();
            resolve(
              failure(
                'TIMEOUT',
                'Browser request timed out. Restart the MCP server and inspect the board before retrying.'
              )
            );
          }, 20000);
        }),
      ]);
    } catch (error) {
      console.error('Udonarium browser:', error instanceof Error ? error.message : 'request failed');
      return failure(
        'NOT_READY',
        'Browser unavailable. Check the dedicated browser and MCP stderr. No operation was retried.'
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.browser?.close();
  }
}
