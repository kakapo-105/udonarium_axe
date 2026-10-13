/** Where the transcriber listens when the address only says `voice=1`. */
export const DEFAULT_VOICE_ENDPOINT = 'ws://localhost:8770';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The transcriber this page was asked to take spoken lines from, with `voice=` in its address.
 *
 * Kept apart from the bridge so the app can ask without loading it, as with automation. Only a
 * WebSocket on this machine is taken: the lines it sends are posted to the room in this seat's
 * name, so nothing elsewhere may speak through it.
 */
export function voiceEndpoint(href: string): string | null {
  let asked: string | null;
  try {
    asked = new URL(href).searchParams.get('voice');
  } catch {
    return null;
  }
  // An address put together by hand can leave a slash behind, as in `?voice=1/#join?...`.
  asked = asked?.replace(/\/+$/, '') ?? null;
  if (!asked || asked === '0') return null;
  if (asked === '1') return DEFAULT_VOICE_ENDPOINT;
  try {
    const url = new URL(asked);
    if (url.protocol !== 'ws:' || !LOCAL_HOSTS.has(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}
