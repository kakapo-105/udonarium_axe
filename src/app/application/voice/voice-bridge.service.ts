import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import { voiceEndpoint } from '@axe/application/voice/voice-request';
import { parseVoiceSay, VoiceTranscriptService } from '@axe/application/voice/voice-transcript.service';

export type VoiceBridgeStatus = 'connecting' | 'open' | 'closed';

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30000;

/**
 * Takes spoken lines from the transcriber running on this machine and posts them to the chat.
 *
 * The page is the client, since a page cannot listen: it dials the address given with `voice=`,
 * and dials again with a growing pause whenever the transcriber is not there, so either may be
 * started first. Each line is answered with an `ack`, so the transcriber can keep and resend what
 * did not arrive.
 */
@Injectable({ providedIn: 'root' })
export class VoiceBridge {
  readonly endpoint = voiceEndpoint(inject(PAGE_ADDRESS)());
  readonly status = signal<VoiceBridgeStatus>('closed');
  readonly posted = signal(0);
  private readonly transcripts = inject(VoiceTranscriptService);
  private socket: WebSocket | null = null;
  private retryMs = RETRY_FIRST_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {
    if (!this.endpoint) return;
    this.connect(this.endpoint);
    inject(DestroyRef).onDestroy(() => {
      this.stopped = true;
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.socket?.close();
    });
  }

  private connect(endpoint: string): void {
    this.status.set('connecting');
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = RETRY_FIRST_MS;
      this.status.set('open');
      socket.send(JSON.stringify({ type: 'hello', version: 1 }));
    };
    socket.onmessage = (event) => this.receive(socket, event.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.status.set('closed');
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(endpoint), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  private receive(socket: WebSocket, data: unknown): void {
    let raw: unknown;
    try {
      raw = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      raw = null;
    }
    const id = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : undefined;
    const say = parseVoiceSay(raw);
    const result = typeof say === 'string' ? ({ ok: false, error: say } as const) : this.transcripts.post(say);
    if (result.ok) this.posted.update((n) => n + 1);
    socket.send(JSON.stringify({ type: 'ack', id: typeof id === 'string' ? id : null, ...result }));
  }
}
