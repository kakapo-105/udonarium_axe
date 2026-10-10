/**
 * Whether the page was opened for AI control, with `automation=1` in its address.
 *
 * Kept apart from the adapter so the app can ask without loading it: everything automation needs is
 * fetched only by a page that asks for it, and the players' pages never carry it.
 */
export function automationRequested(href: string): boolean {
  try {
    return new URL(href).searchParams.get('automation') === '1';
  } catch {
    return false;
  }
}
