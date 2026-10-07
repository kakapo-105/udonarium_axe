import { inject, Injectable, signal } from '@angular/core';
import { AutomationScope, fail } from '@axe/application/automation/automation-contract';
import { DisclosureService } from '@axe/application/permission/disclosure.service';
import { RolePermissionService } from '@axe/application/permission/role-permission.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { LocalModePreferenceService } from '@axe/application/ui/local-mode-preference.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { CONCEALED_LOCATION } from '@axe/domain/tabletop/board-switch/concealment';

@Injectable({ providedIn: 'root' })
export class AutomationPolicyService {
  private readonly disclosure = inject(DisclosureService);
  private readonly role = inject(RolePermissionService);
  private readonly vision = inject(VisionService);
  private readonly store = inject(ObjectStore);
  private readonly localMode = inject(LocalModePreferenceService);
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
  /**
   * Whether something with this owner is yours.
   *
   * Offline there is no network to give you a user id, and what you make there is owned by nobody;
   * with nobody else in the room, what nobody owns is yours. Online, only what carries your id is.
   */
  isMine(owner: string): boolean {
    const me = PeerCursor.myCursor?.userId ?? '';
    if (me) return owner === me;
    return this.localMode.enabled() && owner === '';
  }
  canSee(piece: GameCharacter): boolean {
    return piece.location.name === 'table' && this.disclosure.canView(piece) && this.vision.isTokenVisible(piece);
  }
  /**
   * Whether a piece put out of sight may be read: by the game master, as the out-of-sight tab lists
   * them, or by whoever owns it.
   */
  canSeeConcealed(piece: GameCharacter): boolean {
    if (piece.location.name !== CONCEALED_LOCATION) return false;
    return this.role.canSeeHidden || this.isMine(piece.owner);
  }
  /** Only the game master puts things out of sight and brings them back, as in the table's own menus. */
  requireGameMaster(): void {
    if (!this.role.canSeeHidden) fail('FORBIDDEN', 'Only the game master can put pieces out of sight.');
  }
  /**
   * Whether what a piece carries may be managed across the table, as the buff manager lets anyone at
   * the table do: any piece that can be seen, whoever owns it. Guests only watch.
   */
  canManage(piece: GameCharacter): void {
    if (!this.role.canEditTabletop) fail('FORBIDDEN', 'Guests cannot manage pieces.');
    if (!this.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
  }
  /** Whether new pieces may be put on the table, which a guest, who only watches, may not. */
  canCreatePieces(): void {
    if (!this.role.canEditTabletop) fail('FORBIDDEN', 'Guests cannot put pieces on the table.');
  }
  canControl(piece: GameCharacter): void {
    if (!this.role.canEditTabletop) fail('FORBIDDEN', 'Guests cannot control pieces.');
    if (!this.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
    if (piece.isLock) fail('LOCKED', 'The piece is locked.');
    const ownedOnly = this.store.get<Config>('Config')?.automationOwnedOnly !== false;
    if (ownedOnly && !this.isMine(piece.owner)) {
      fail('FORBIDDEN', 'Only your own pieces may be controlled.');
    }
  }
}
