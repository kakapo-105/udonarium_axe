import { type FacadeResult, failure } from '#mcp/facade-client.js';

export const MAX_PIECES = 20;
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

export const MAX_IMAGES = 20;
const IMAGE_IDENTIFIER = /^[0-9a-f]{64}$/;
const IMAGE_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

export type FetchText = (url: URL) => Promise<{ ok: boolean; status: number; text: string }>;
export type FetchBytes = (url: URL) => Promise<{ ok: boolean; status: number; type: string; bytes: Uint8Array }>;
/** A picture a sheet names: its SHA-256 and where the source keeps it. */
export type ImageRef = { identifier: string; url: URL };
/** A picture as the browser takes it: its SHA-256, type and bytes in base64. */
export type PieceImage = { identifier: string; type: string; data: string };
export type PieceSheets = { ok: true; pieces: unknown[]; images: ImageRef[]; warnings: string[] };

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

/** A candidate the source offers, by name: a plain string, or a record carrying its name (and level). */
function candidateName(candidate: unknown): string {
  if (!candidate || typeof candidate !== 'object') return String(candidate);
  const record = candidate as Record<string, unknown>;
  const name = String(record['name'] ?? record['id'] ?? '?');
  return typeof record['level'] === 'number' ? `${name} (Lv${record['level']})` : name;
}

export const fetchBytes: FetchBytes = async (url) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('Piece source answered with too large a picture.');
  return { ok: response.ok, status: response.status, type: response.headers.get('content-type') ?? '', bytes };
};

export const fetchText: FetchText = async (url) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Piece source answered with too much data.');
  return { ok: response.ok, status: response.status, text };
};

type SourceAnswer = { ok: true; url: URL; body: unknown; record: Record<string, unknown>; warnings: string[] };

/**
 * Fetches JSON from an allowed source. An `error` with `candidates` in a failed answer is passed on,
 * so a name that matched several things can be asked again; `warnings` are gathered.
 */
async function fetchSourceJson(
  source: string,
  origins: readonly string[],
  fetchImpl: FetchText
): Promise<SourceAnswer | FacadeResult> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return failure('INVALID_ARGUMENT', 'The source URL is not a URL.');
  }
  if (!origins.includes(url.origin))
    return failure('FORBIDDEN', 'The source URL is not on an allowed piece source (set UDONARIUM_PIECE_SOURCES).');
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
      ? ` Candidates: ${record['candidates'].slice(0, 10).map(candidateName).join(', ')}`
      : '';
    return failure(
      'INVALID_ARGUMENT',
      `${String(record['error'] ?? `HTTP ${answer.status}`).slice(0, 200)}.${candidates}`
    );
  }
  const warnings = Array.isArray(record['warnings'])
    ? record['warnings'].slice(0, 20).map((w) => String(w).slice(0, 300))
    : [];
  return { ok: true, url, body, record, warnings };
}

/**
 * The pictures an answer names in `images`, each SHA-256 with where it is kept, relative to the answer.
 * A picture kept anywhere but an allowed source is left out with a warning.
 */
function imageRefsOf(answer: SourceAnswer, origins: readonly string[]): ImageRef[] | FacadeResult {
  const images: ImageRef[] = [];
  const named =
    answer.record['images'] && typeof answer.record['images'] === 'object'
      ? (answer.record['images'] as Record<string, unknown>)
      : {};
  for (const [identifier, where] of Object.entries(named)) {
    if (!IMAGE_IDENTIFIER.test(identifier) || typeof where !== 'string') continue;
    let at: URL;
    try {
      at = new URL(where, answer.url);
    } catch {
      continue;
    }
    if (!origins.includes(at.origin)) {
      answer.warnings.push(`A picture kept outside the allowed sources was left out: ${at.origin}`);
      continue;
    }
    images.push({ identifier, url: at });
  }
  if (images.length > MAX_IMAGES)
    return failure('INVALID_ARGUMENT', `The piece source must name at most ${MAX_IMAGES} pictures.`);
  return images;
}

/**
 * Fetches the sheets to build pieces from, so that they reach the browser without passing through
 * the model.
 *
 * The answer may be a list of sheets, one sheet in the clipboard form (`{"kind":"character",...}`)
 * or an object carrying them in `pieces`, as the rulebook search server's `/api/ccfolia` and
 * `/api/udonarium` give them; its `warnings` are passed on, and its `images` are gathered for
 * {@link fetchPieceImages}.
 */
export async function fetchPieceSheets(
  source: string,
  origins: readonly string[],
  fetchImpl: FetchText = fetchText
): Promise<PieceSheets | FacadeResult> {
  const answer = await fetchSourceJson(source, origins, fetchImpl);
  if (!('body' in answer)) return answer;
  const { body, record } = answer;
  const pieces = Array.isArray(body)
    ? body
    : Array.isArray(record['pieces'])
      ? record['pieces']
      : record['kind'] === 'character'
        ? [body]
        : null;
  if (!pieces || pieces.length < 1 || pieces.length > MAX_PIECES)
    return failure('INVALID_ARGUMENT', `The piece source must give 1 to ${MAX_PIECES} pieces.`);
  const images = imageRefsOf(answer, origins);
  if (!Array.isArray(images)) return images;
  return { ok: true, pieces, images, warnings: answer.warnings };
}

/** A board template: a table's size, the picture it wears, and what the model needs to use it. */
export type BoardTemplate = {
  ok: true;
  table: { name: string; width: number; height: number; grid: boolean; flat: boolean; background: string };
  /** Passed to the model as they are: the rule, how to use the board, where its areas lie and its scale. */
  notes: Record<string, unknown>;
  images: ImageRef[];
  warnings: string[];
};

/**
 * Fetches a board template, such as the rulebook search server's `/api/boards/basic`: the size of
 * the table in cells, the picture it wears and where its areas lie.
 */
export async function fetchBoardTemplate(
  source: string,
  origins: readonly string[],
  fetchImpl: FetchText = fetchText
): Promise<BoardTemplate | FacadeResult> {
  const answer = await fetchSourceJson(source, origins, fetchImpl);
  if (!('body' in answer)) return answer;
  const { record } = answer;
  const whole = (key: string) =>
    typeof record[key] === 'number' && Number.isInteger(record[key]) && (record[key] as number) >= 1
      ? (record[key] as number)
      : null;
  const width = whole('width');
  const height = whole('height');
  if (!width || !height) return failure('INVALID_ARGUMENT', 'The board template gives no width and height.');
  const images = imageRefsOf(answer, origins);
  if (!Array.isArray(images)) return images;
  const notes: Record<string, unknown> = {};
  for (const key of ['rule', 'guide', 'areas', 'origin', 'metersPerCell']) if (key in record) notes[key] = record[key];
  return {
    ok: true,
    table: {
      name: String(record['name'] ?? 'Board').slice(0, 256),
      width,
      height,
      grid: record['grid'] === true,
      flat: record['flat'] === true,
      background: typeof record['background'] === 'string' ? record['background'] : '',
    },
    notes,
    images,
    warnings: answer.warnings,
  };
}

/**
 * Fetches the pictures the sheets wear. One that cannot be fetched is left out with a warning rather
 * than failing the pieces: they are built all the same, only without it. The browser checks each
 * picture against its SHA-256 before taking it.
 */
export async function fetchPieceImages(
  images: readonly ImageRef[],
  fetchImpl: FetchBytes = fetchBytes
): Promise<{ images: PieceImage[]; warnings: string[] }> {
  const fetched: PieceImage[] = [];
  const warnings: string[] = [];
  for (const { identifier, url } of images) {
    try {
      const answer = await fetchImpl(url);
      const type =
        answer.type.split(';')[0].trim().toLowerCase() || IMAGE_TYPES[url.pathname.split('.').pop() ?? ''] || '';
      if (!answer.ok || !Object.values(IMAGE_TYPES).includes(type)) {
        warnings.push(
          `The picture ${identifier.slice(0, 12)}… could not be fetched (HTTP ${answer.status}, ${type || 'no type'}).`
        );
        continue;
      }
      fetched.push({ identifier, type, data: Buffer.from(answer.bytes).toString('base64') });
    } catch (error) {
      console.error('Piece source picture:', error instanceof Error ? error.message : 'request failed');
      warnings.push(`The picture ${identifier.slice(0, 12)}… could not be fetched.`);
    }
  }
  return { images: fetched, warnings };
}
