import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { FacadeResult } from '#mcp/facade-client.js';

export function mapResult(result: FacadeResult): CallToolResult {
  return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
