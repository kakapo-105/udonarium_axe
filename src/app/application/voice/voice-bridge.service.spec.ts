import { TestBed } from '@angular/core/testing';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import { VOICE_REPLACED_CODE, VoiceBridge } from '@axe/application/voice/voice-bridge.service';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

class FakeSocket {
  static made: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}
}

describe('VoiceBridge', () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    TestBed.configureTestingModule({
      providers: [
        ...TEST_PROVIDERS,
        VoiceBridge,
        { provide: PAGE_ADDRESS, useValue: () => 'http://localhost:4200/?voice=1' },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('greets the transcriber and dials again when the line drops', () => {
    const bridge = TestBed.inject(VoiceBridge);
    const [first] = FakeSocket.made;
    expect(first.url).toBe('ws://localhost:8770');
    first.onopen!();
    expect(bridge.status()).toBe('open');
    expect(JSON.parse(first.sent[0])).toEqual({ type: 'hello', version: 1 });

    first.onclose!({ code: 1006 });
    expect(bridge.status()).toBe('closed');
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('stays away once a newer page has taken the line', () => {
    const bridge = TestBed.inject(VoiceBridge);
    const [first] = FakeSocket.made;
    first.onopen!();

    first.onclose!({ code: VOICE_REPLACED_CODE });

    expect(bridge.status()).toBe('replaced');
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('answers a malformed line with a refusal rather than posting it', () => {
    TestBed.inject(VoiceBridge);
    const [socket] = FakeSocket.made;
    socket.onopen!();

    socket.onmessage!({ data: JSON.stringify({ type: 'say', id: 'x1', name: 'n', text: 't', evil: true }) });

    expect(JSON.parse(socket.sent[1])).toEqual({ type: 'ack', id: 'x1', ok: false, error: 'unknown key: evil' });
  });
});
