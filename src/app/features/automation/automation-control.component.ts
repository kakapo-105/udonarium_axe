import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AutomationAuditService } from '@axe/application/automation/automation-audit.service';
import { AUTOMATION_SCOPES, AutomationScope } from '@axe/application/automation/automation-contract';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { WidgetLayoutService } from '@axe/application/ui/widget-layout.service';
import { WIDGET_AUTOMATION } from '@axe/application/ui/widget-place';
import { ObjectStore } from '@axe/core/sync/object-store';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { DraggableDirective } from '@axe/ui/directives/draggable.directive';
import { WidgetPlaceDirective } from '@axe/ui/directives/widget-place.directive';
import { TranslocoModule } from '@jsverse/transloco';

const EDGE_MARGIN = 12;

@Component({
  selector: 'automation-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DraggableDirective, WidgetPlaceDirective, TranslocoModule],
  templateUrl: './automation-control.component.html',
})
export class AutomationControlComponent {
  readonly policy = inject(AutomationPolicyService);
  readonly audit = inject(AutomationAuditService);
  readonly expanded = signal(false);
  readonly scopes = AUTOMATION_SCOPES;
  private readonly changes = inject(ObjectChangeService);
  private readonly store = inject(ObjectStore);
  private readonly layout = inject(WidgetLayoutService);
  private readonly injector = inject(Injector);
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  protected readonly widgetName = WIDGET_AUTOMATION;
  /** Bottom-right until it is dragged somewhere else, where it then opens from. */
  protected readonly fallback = (element: HTMLElement) => ({
    left: window.innerWidth - element.offsetWidth - EDGE_MARGIN,
    top: window.innerHeight - element.offsetHeight - EDGE_MARGIN,
  });

  constructor() {
    // Opening the panel makes it taller, so one left near the bottom edge is pushed back into view.
    effect(() => {
      this.expanded();
      untracked(() => afterNextRender(() => this.keepInView(), { injector: this.injector }));
    });
  }

  private keepInView(): void {
    const element = this.panel().nativeElement;
    const spot = this.layout.keepInView(
      { left: element.offsetLeft, top: element.offsetTop },
      element.offsetWidth,
      element.offsetHeight
    );
    element.style.left = `${spot.left}px`;
    element.style.top = `${spot.top}px`;
  }
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
