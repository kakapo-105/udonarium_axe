/** Where the user guide is served, beside the app, when it is built with it. */
export const MANUAL_HREF = 'docs/';

/**
 * The address the user guide opens at: its place beside the app read from the address the app is
 * served under, so it is found wherever the app is published, and not at the root of the site.
 *
 * Where that address cannot be read as one, as in a page with no real address of its own, the
 * place is handed back as it is written, and whatever opens it reads it from the page instead.
 */
export function manualUrl(appBase: string): string {
  try {
    return new URL(MANUAL_HREF, appBase).href;
  } catch {
    return MANUAL_HREF;
  }
}
