/** Where the user guide is served, beside the app, when it is built with it. */
export const MANUAL_HREF = 'docs/';

/**
 * The address the user guide opens at: its place beside the app read from the address the app is
 * served under, so it is found wherever the app is published, and not at the root of the site.
 */
export function manualUrl(appBase: string): string {
  return new URL(MANUAL_HREF, appBase).href;
}
