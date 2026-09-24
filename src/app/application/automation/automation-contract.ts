/** The browser boundary accepts JSON only; domain objects never cross it. */
export const AUTOMATION_COMMANDS = [
  'session_get',
  'scene_list',
  'object_get',
  'piece_move',
  'chat_send',
  'chat_read_recent',
] as const;
export type AutomationCommand = (typeof AUTOMATION_COMMANDS)[number];
export const AUTOMATION_SCOPES = ['read_visible', 'move_piece', 'send_chat', 'edit_resource'] as const;
export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];
export type AutomationErrorCode =
  | 'NOT_READY'
  | 'NOT_FOUND'
  | 'NOT_VISIBLE'
  | 'FORBIDDEN'
  | 'LOCKED'
  | 'INVALID_ARGUMENT'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';
export type AutomationResult =
  { ok: true; data: unknown } | { ok: false; error: { code: AutomationErrorCode; message: string } };
export interface AutomationRequest {
  sessionId: string;
  requestId: string;
  command: AutomationCommand;
  arguments: Record<string, unknown>;
}
export interface AutomationHealth {
  ready: boolean;
  sessionId: string;
  apiVersion: '1';
}
export interface BrowserAutomationApi {
  readonly apiVersion: '1';
  health(): Promise<AutomationHealth>;
  invoke(request: unknown): Promise<AutomationResult>;
}
export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string
  ) {
    super(message);
  }
}
export function fail(code: AutomationErrorCode, message: string): never {
  throw new AutomationError(code, message);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_ARGUMENT', 'Unknown argument.');
}
export function textArgument(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_ARGUMENT', 'Invalid string.');
  return value;
}
export function numberArgument(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_ARGUMENT', 'Expected a finite number.');
  return value;
}
export function pageSize(value: unknown, fallback = 50): number {
  const size = value === undefined ? fallback : numberArgument(value);
  if (!Number.isInteger(size) || size < 1 || size > 100) fail('INVALID_ARGUMENT', 'Limit must be 1–100.');
  return size;
}
