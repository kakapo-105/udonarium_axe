import path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { BrowserSession } from '#mcp/browser-session.js';
import { pieceSourceOrigins } from '#mcp/piece-source.js';
import { createServer } from '#mcp/tools.js';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--url')) {
  console.error('Usage: node dist/server.js [--url http://localhost:4200]');
  process.exit(1);
}
const session = new BrowserSession(args[1] ?? process.env.UDONARIUM_URL ?? 'http://localhost:4200');
let pieceSources: string[];
try {
  pieceSources = pieceSourceOrigins(process.env.UDONARIUM_PIECE_SOURCES);
} catch (error) {
  console.error('UDONARIUM_PIECE_SOURCES:', error instanceof Error ? error.message : error);
  process.exit(1);
}
const audioFolders = (process.env.UDONARIUM_AUDIO_DIR ?? '')
  .split(path.delimiter)
  .filter((folder) => folder.trim().length > 0);
const server = createServer(session, {
  pieceSources,
  templates: {
    templates: process.env.UDONARIUM_TEMPLATE_DIR || undefined,
    audio: audioFolders,
    images: process.env.UDONARIUM_IMAGE_DIR || undefined,
  },
});
const stop = async () => {
  await session.close();
  await server.close();
};
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
server.server.onclose = () => {
  void session.close();
};
await server.connect(new StdioServerTransport());
// The protocol starts even if the application is not running yet.
void session
  .start()
  .catch((error) => console.error('Udonarium browser startup:', error instanceof Error ? error.message : error));
