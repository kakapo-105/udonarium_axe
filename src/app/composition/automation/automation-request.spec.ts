import { automationRequested } from '@axe/composition/automation/automation-request';

describe('automationRequested()', () => {
  it('asks for AI control only with automation=1 in the address', () => {
    expect(automationRequested('http://localhost:4200/?automation=1&samples=0')).toBe(true);
    expect(automationRequested('https://example.github.io/udonarium_axe/?automation=1')).toBe(true);
    expect(automationRequested('http://localhost:4200/')).toBe(false);
    expect(automationRequested('http://localhost:4200/?automation=0')).toBe(false);
    expect(automationRequested('not an address')).toBe(false);
  });
});
