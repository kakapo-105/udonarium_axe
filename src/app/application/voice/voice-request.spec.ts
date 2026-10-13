import { DEFAULT_VOICE_ENDPOINT, voiceEndpoint } from '@axe/application/voice/voice-request';

describe('voiceEndpoint()', () => {
  it('takes a WebSocket on this machine from voice= in the address', () => {
    expect(voiceEndpoint('http://localhost:4200/?voice=ws://localhost:9000')).toBe('ws://localhost:9000/');
    expect(voiceEndpoint('https://example.github.io/udonarium_axe/?voice=ws%3A%2F%2F127.0.0.1%3A8770')).toBe(
      'ws://127.0.0.1:8770/'
    );
    expect(voiceEndpoint('http://localhost:4200/?voice=1')).toBe(DEFAULT_VOICE_ENDPOINT);
    expect(voiceEndpoint('https://example.github.io/udonarium_axe/?voice=1/#join?r=abc&n=room')).toBe(
      DEFAULT_VOICE_ENDPOINT
    );
  });

  it('takes nothing when not asked, or when asked to dial anywhere else', () => {
    expect(voiceEndpoint('http://localhost:4200/')).toBeNull();
    expect(voiceEndpoint('http://localhost:4200/?voice=0')).toBeNull();
    expect(voiceEndpoint('http://localhost:4200/?voice=ws://192.168.11.3:8770')).toBeNull();
    expect(voiceEndpoint('http://localhost:4200/?voice=wss://example.com')).toBeNull();
    expect(voiceEndpoint('http://localhost:4200/?voice=http://localhost:8770')).toBeNull();
    expect(voiceEndpoint('http://localhost:4200/?voice=nonsense')).toBeNull();
    expect(voiceEndpoint('not an address')).toBeNull();
  });
});
