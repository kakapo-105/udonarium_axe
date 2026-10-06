import { type FacadeResult, failure } from '#mcp/facade-client.js';

export const MAX_PIECES = 20;
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

export type FetchText = (url: URL) => Promise<{ ok: boolean; status: number; text: string }>;
export type PieceSheets = { ok: true; pieces: unknown[]; warnings: string[] };

/**
 * The origins pieces may be fetched from, read from a comma-separated list such as
 * `http://LLM-PC:8765,https://example.com`. Anything that is not a plain HTTP(S) origin is refused,
 * so a mistyped entry is noticed at startup rather than silently allowing nothing.
 */
export function pieceSourceOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => {
    const url = new URL(entry.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error(`Piece sources must be HTTP(S) origins without credentials: ${entry.trim()}`);
    return url.origin;
  });
}

export const fetchText: FetchText = async (url) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Piece source answered with too much data.');
  return { ok: response.ok, status: response.status, text };
};

/**
 * Fetches the sheets to build pieces from, so that they reach the browser without passing through
 * the model.
 *
 * The answer may be a list of sheets, one sheet in the clipboard form (`{"kind":"character",...}`)
 * or an object carrying them in `pieces`, as the rulebook search server's `/api/ccfolia` gives them;
 * its `warnings` are passed on. An `error` with `candidates` in a failed answer is passed on too, so
 * a name that matched several monsters can be asked again.
 */
export async function fetchPieceSheets(
  source: string,
  origins: readonly string[],
  fetchImpl: FetchText = fetchText
): Promise<PieceSheets | FacadeResult> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return failure('INVALID_ARGUMENT', 'sourceUrl is not a URL.');
  }
  if (!origins.includes(url.origin))
    return failure('FORBIDDEN', 'sourceUrl is not on an allowed piece source (set UDONARIUM_PIECE_SOURCES).');
  let answer: { ok: boolean; status: number; text: string };
  try {
    answer = await fetchImpl(url);
  } catch (error) {
    console.error('Piece source:', error instanceof Error ? error.message : 'request failed');
    return failure('NOT_READY', 'The piece source could not be reached.');
  }
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return failure('INVALID_ARGUMENT', `The piece source answered ${answer.status} with something other than JSON.`);
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!answer.ok || typeof record['error'] === 'string') {
    const candidates = Array.isArray(record['candidates'])
      ? ` Candidates: ${record['candidates'].slice(0, 10).map(String).join(', ')}`
      : '';
    return failure(
      'INVALID_ARGUMENT',
      `${String(record['error'] ?? `HTTP ${answer.status}`).slice(0, 200)}.${candidates}`
    );
  }
  const pieces = Array.isArray(body)
    ? body
    : Array.isArray(record['pieces'])
      ? record['pieces']
      : record['kind'] === 'character'
        ? [body]
        : null;
  if (!pieces || pieces.length < 1 || pieces.length > MAX_PIECES)
    return failure('INVALID_ARGUMENT', `The piece source must give 1 to ${MAX_PIECES} pieces.`);
  const warnings = Array.isArray(record['warnings'])
    ? record['warnings'].slice(0, 20).map((w) => String(w).slice(0, 300))
    : [];
  return { ok: true, pieces, warnings };
}
