import { DestroyRef, effect, inject, Injectable, untracked } from '@angular/core';
import { BrowserAutomationApi } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { AutomationPresetService } from '@axe/application/automation/automation-preset.service';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import { automationRequested } from '@axe/composition/automation/automation-request';
import { networkMessage$ } from '@axe/core/network/network-messaging';

declare global {
  interface Window {
    udonariumAxeAutomation?: BrowserAutomationApi;
  }
}

const PRESET_INTERVAL_MS = 1000;

/**
 * Explicit startup opt-in exposes only the permission UI, never write grants, unless the address also
 * asks for a preset, which the one starting the dedicated browser chooses.
 */
@Injectable({ providedIn: 'root' })
export class BrowserAutomationAdapter {
  readonly available = automationRequested(inject(PAGE_ADDRESS)());
  private readonly facade = inject(AutomationFacadeService);
  private readonly policy = inject(AutomationPolicyService);

  constructor() {
    if (!this.available) return;
    const changes = inject(ObjectChangeService);
    const destroyRef = inject(DestroyRef);
    effect(() => {
      changes.trackMyCursor();
      untracked(() => this.facade.health());
    });
    changes.networkOpen$.subscribe(() => this.policy.stop(), destroyRef);
    networkMessage$.subscribe((message) => {
      if (message.eventName === 'CLOSE_NETWORK') this.policy.stop();
    }, destroyRef);
    const api: BrowserAutomationApi = Object.freeze({
      apiVersion: '1',
      health: async () => this.facade.health(),
      invoke: (request: unknown) => this.facade.invoke(request),
    });
    effect(() => {
      if (this.policy.enabled()) window.udonariumAxeAutomation = api;
      else if (window.udonariumAxeAutomation === api) delete window.udonariumAxeAutomation;
    });
    // A preset asked for in the address is applied again and again, since joining a room or taking a
    // role ends the session it set up.
    const preset = inject(AutomationPresetService);
    const presetTimer = preset.preset ? setInterval(() => preset.apply(), PRESET_INTERVAL_MS) : null;
    const stop = () => this.policy.stop();
    window.addEventListener('pagehide', stop);
    inject(DestroyRef).onDestroy(() => {
      if (presetTimer !== null) clearInterval(presetTimer);
      window.removeEventListener('pagehide', stop);
      if (window.udonariumAxeAutomation === api) delete window.udonariumAxeAutomation;
      stop();
    });
  }
}
