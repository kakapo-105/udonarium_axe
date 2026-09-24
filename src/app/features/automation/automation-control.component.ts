import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AutomationAuditService } from '@axe/application/automation/automation-audit.service';
import { AUTOMATION_SCOPES, AutomationScope } from '@axe/application/automation/automation-contract';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { TranslocoModule } from '@jsverse/transloco';

@Component({
  selector: 'automation-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoModule],
  templateUrl: './automation-control.component.html',
})
export class AutomationControlComponent {
  readonly policy = inject(AutomationPolicyService);
  readonly audit = inject(AutomationAuditService);
  readonly expanded = signal(false);
  readonly scopes = AUTOMATION_SCOPES;
  private readonly changes = inject(ObjectChangeService);
  private readonly store = inject(ObjectStore);
  readonly isGm = computed(() => {
    this.changes.trackMyCursor();
    return PeerCursor.isMyselfGameMaster;
  });
  readonly ownedOnly = computed(() => {
    this.changes.versionOf('Config')();
    return this.store.get<Config>('Config')?.automationOwnedOnly !== false;
  });
  grant(scope: AutomationScope, event: Event): void {
    this.policy.setScope(scope, (event.target as HTMLInputElement).checked);
  }
  setOwnedOnly(event: Event): void {
    const config = this.store.get<Config>('Config');
    if (PeerCursor.isMyselfGameMaster && config)
      config.automationOwnedOnly = (event.target as HTMLInputElement).checked;
  }
}
