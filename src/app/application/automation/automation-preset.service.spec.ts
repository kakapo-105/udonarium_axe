import { TestBed } from '@angular/core/testing';
import { AUTOMATION_SCOPES } from '@axe/application/automation/automation-contract';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { automationPresetOf, AutomationPresetService } from '@axe/application/automation/automation-preset.service';
import { LocalModePreferenceService } from '@axe/application/ui/local-mode-preference.service';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ObjectSynchronizer } from '@axe/core/sync/object-synchronizer';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('AutomationPresetService', () => {
  const store = ObjectStore.instance;

  function start(address: string): { preset: AutomationPresetService; policy: AutomationPolicyService } {
    // A cursor another spec left behind could read as a game master already in the room.
    for (const object of store.getObjects()) store.remove(object);
    TestBed.configureTestingModule({
      providers: [...TEST_PROVIDERS, { provide: PAGE_ADDRESS, useValue: () => `http://localhost:4200${address}` }],
    });
    TestBed.inject(LocalModePreferenceService).enabled.set(true);
    Config.instance.initialize();
    new GameTable().initialize();
    PeerCursor.createMyCursor();
    PeerCursor.myCursor.userId = 'operator';
    PeerCursor.myCursor.role = PeerRole.Player;
    return { preset: TestBed.inject(AutomationPresetService), policy: TestBed.inject(AutomationPolicyService) };
  }

  afterEach(() => {
    ObjectSynchronizer.instance.destroy();
    for (const object of store.getObjects()) store.remove(object);
    store.clearDeleteHistory();
  });

  it('reads the preset from the address alone', () => {
    expect(automationPresetOf('http://localhost:4200/?automation=1&automationPreset=gm')).toBe('gm');
    expect(automationPresetOf('http://localhost:4200/?automation=1')).toBeNull();
    expect(automationPresetOf('http://localhost:4200/?automationPreset=root')).toBeNull();
  });

  it('does nothing without a preset', () => {
    const { preset, policy } = start('/?automation=1');
    preset.apply();
    preset.apply();
    expect(PeerCursor.myCursor.role).toBe(PeerRole.Player);
    expect(policy.enabled()).toBe(false);
  });

  it('makes the seat the game master, then enables every grant and control of every piece', () => {
    const { preset, policy } = start('/?automation=1&automationPreset=gm');

    preset.apply();
    expect(PeerCursor.myCursor.role).toBe(PeerRole.GameMaster);

    preset.apply();
    expect(policy.enabled()).toBe(true);
    expect([...policy.scopes()].sort()).toEqual([...AUTOMATION_SCOPES].sort());
    expect(Config.instance.automationOwnedOnly).toBe(false);

    const session = policy.sessionId();
    preset.apply();
    expect(policy.sessionId()).toBe(session);
  });

  it('gives the grants back after something ends the session, but not after a person pressed stop', () => {
    const { preset, policy } = start('/?automation=1&automationPreset=gm');
    preset.apply();
    preset.apply();

    policy.stop();
    preset.apply();
    expect(policy.enabled()).toBe(true);

    policy.stopByUser();
    preset.apply();
    expect(policy.enabled()).toBe(false);

    policy.enable();
    expect(policy.stoppedByUser()).toBe(false);
  });

  it('never takes the game master’s seat from somebody who has it', () => {
    const { preset } = start('/?automation=1&automationPreset=gm');
    const other = new PeerCursor();
    other.initialize();
    other.role = PeerRole.GameMaster;

    preset.apply();

    expect(PeerCursor.myCursor.role).toBe(PeerRole.Player);
  });
});
