import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { failure } from '#mcp/facade-client.js';

/** The most a file of prepared lines may weigh. */
const MAX_FILE_BYTES = 1_000_000;

/** One line of chat as chat_send takes it. */
export const chatLineSchema = z
  .object({
    text: z.string().min(1).max(2000),
    characterId: z.string().min(1).max(256).optional(),
    style: z.enum(['normal', 'narration', 'location', 'scene']).optional(),
  })
  .strict();

export type ChatLine = z.infer<typeof chatLineSchema>;

/**
 * The lines kept under a key in a JSON file of the scenario folder, written before the session, so
 * a long description is said without being written out again. Only what is said reaches the room:
 * the file stays on this machine, and the scenario folder is the furthest it can reach.
 */
export async function readPreparedLines(root: string | undefined, file: string, key: string, maxLines: number) {
  if (!root)
    return failure('NOT_READY', 'No scenario folder is set. Start the MCP server with UDONARIUM_SCENARIO_DIR.');
  const base = path.resolve(root);
  const full = path.resolve(base, file);
  if (!full.startsWith(base + path.sep) || path.extname(full) !== '.json')
    return failure('INVALID_ARGUMENT', 'linesFile must name a .json file inside the scenario folder.');
  let parsed: unknown;
  try {
    if ((await stat(full)).size > MAX_FILE_BYTES) return failure('INVALID_ARGUMENT', 'linesFile is too large.');
    parsed = JSON.parse(await readFile(full, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('NOT_FOUND', `No file ${file}.`);
    return failure('INVALID_ARGUMENT', `${file} could not be read as JSON.`);
  }
  const entry = (parsed as Record<string, unknown> | null)?.[key];
  if (entry === undefined) return failure('NOT_FOUND', `${file} has nothing under ${key}.`);
  const lines = z.array(chatLineSchema).min(1).max(maxLines).safeParse(entry);
  if (!lines.success) return failure('INVALID_ARGUMENT', `The lines under ${key} in ${file} are not chat lines.`);
  return { lines: lines.data };
}
