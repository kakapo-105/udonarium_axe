import { inject, Injectable, signal } from '@angular/core';
import { AutomationScope, fail } from '@axe/application/automation/automation-contract';
import { DisclosureService } from '@axe/application/permission/disclosure.service';
import { RolePermissionService } from '@axe/application/permission/role-permission.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';

@Injectable({ providedIn: 'root' })
export class AutomationPolicyService {
  private readonly disclosure = inject(DisclosureService);
  private readonly role = inject(RolePermissionService);
  private readonly vision = inject(VisionService);
  private readonly store = inject(ObjectStore);
  private readonly active = signal(false);
  private readonly grants = signal<readonly AutomationScope[]>(['read_visible']);
  readonly enabled = this.active.asReadonly();
  readonly scopes = this.grants.asReadonly();
  readonly sessionId = signal(crypto.randomUUID());

  enable(): void {
    this.stop();
    this.active.set(true);
  }
  stop(): void {
    this.active.set(false);
    this.grants.set(['read_visible']);
    this.sessionId.set(crypto.randomUUID());
  }
  setScope(scope: AutomationScope, allowed: boolean): void {
    this.grants.update((current) => (allowed ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  }
  require(scope: AutomationScope): void {
    if (!this.active()) fail('NOT_READY', 'Automation is disabled.');
    if (!this.grants().includes(scope)) fail('FORBIDDEN', `Scope required: ${scope}.`);
  }
  canSee(piece: GameCharacter): boolean {
    return piece.location.name === 'table' && this.disclosure.canView(piece) && this.vision.isTokenVisible(piece);
  }
  canControl(piece: GameCharacter): void {
    if (!this.role.canEditTabletop) fail('FORBIDDEN', 'Guests cannot control pieces.');
    if (!this.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
    if (piece.isLock) fail('LOCKED', 'The piece is locked.');
    const ownedOnly = this.store.get<Config>('Config')?.automationOwnedOnly !== false;
    if (ownedOnly && (!PeerCursor.myCursor?.userId || piece.owner !== PeerCursor.myCursor.userId)) {
      fail('FORBIDDEN', 'Only your own pieces may be controlled.');
    }
  }
}
