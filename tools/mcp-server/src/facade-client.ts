import type { Page } from 'playwright';

export type FacadeResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
export const failure = (code: string, message: string): FacadeResult => ({ ok: false, error: { code, message } });
export interface FacadeRequest {
  sessionId: string;
  requestId: string;
  command: string;
  arguments: Record<string, unknown>;
}
interface FacadeApi {
  apiVersion: string;
  health(): Promise<{ ready: boolean; sessionId: string; apiVersion: string }>;
  invoke(request: FacadeRequest): Promise<FacadeResult>;
}
declare global {
  interface Window {
    udonariumAxeAutomation?: FacadeApi;
  }
}

/** No eval strings, selectors or caller-supplied code are accepted by this bridge. */
export async function invokeFacade(
  page: Page,
  request: Omit<FacadeRequest, 'sessionId'> & { sessionId?: string }
): Promise<FacadeResult> {
  return page.evaluate(async (input) => {
    const api = window.udonariumAxeAutomation;
    if (!api || api.apiVersion !== '1')
      return { ok: false, error: { code: 'NOT_READY', message: 'Enable AI control in the dedicated browser.' } };
    const health = await api.health();
    if (!health.ready)
      return {
        ok: false,
        error: { code: 'NOT_READY', message: 'Join a room or select offline mode, then enable AI control.' },
      };
    if (input.sessionId && input.sessionId !== health.sessionId)
      return {
        ok: false,
        error: { code: 'NOT_READY', message: 'Session changed. Read session_get before issuing a new operation.' },
      };
    return api.invoke({ ...input, sessionId: input.sessionId ?? health.sessionId });
  }, request);
}
