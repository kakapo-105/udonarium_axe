/** What a command of the fork's facade answers: its data, or why it was refused. */
export type FacadeResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export const failure = (code: string, message: string): FacadeResult => ({ ok: false, error: { code, message } });
