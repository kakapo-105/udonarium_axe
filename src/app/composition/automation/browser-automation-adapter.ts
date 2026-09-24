import { DestroyRef, effect, inject, Injectable, untracked } from '@angular/core';
import { BrowserAutomationApi } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { networkMessage$ } from '@axe/core/network/network-messaging';

declare global {
  interface Window {
    udonariumAxeAutomation?: BrowserAutomationApi;
  }
}

/** Explicit startup opt-in exposes only the permission UI, never write grants. */
@Injectable({ providedIn: 'root' })
export class BrowserAutomationAdapter {
  readonly available = new URL(location.href).searchParams.get('automation') === '1';
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
    const stop = () => this.policy.stop();
    window.addEventListener('pagehide', stop);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', stop);
      if (window.udonariumAxeAutomation === api) delete window.udonariumAxeAutomation;
      stop();
    });
  }
}
