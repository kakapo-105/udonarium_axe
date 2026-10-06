import { MANUAL_HREF, manualUrl } from '@axe/domain/ui/manual-link';

describe('the way to the user guide', () => {
  it('names a place beside the app rather than any one address', () => {
    expect(MANUAL_HREF).not.toMatch(/^[a-z]+:|^\//);
  });

  it('finds the guide beside the app, wherever the app is published', () => {
    expect(manualUrl('https://kakapo-105.github.io/udonarium_axe/')).toBe(
      'https://kakapo-105.github.io/udonarium_axe/docs/'
    );
    expect(manualUrl('https://kakapo-105.github.io/udonarium_axe/?automation=1#room')).toBe(
      'https://kakapo-105.github.io/udonarium_axe/docs/'
    );
    expect(manualUrl('http://localhost:4200/')).toBe('http://localhost:4200/docs/');
  });

  it('hands the place back as written where the page has no address to read it from', () => {
    expect(manualUrl('about:blank')).toBe(MANUAL_HREF);
    expect(manualUrl('')).toBe(MANUAL_HREF);
  });
});
