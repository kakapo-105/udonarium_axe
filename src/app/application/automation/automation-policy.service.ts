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
  private readonly halted = signal(false);
  /** Whether a person pressed stop, which nothing but their pressing enable again undoes until the page reloads. */
  readonly stoppedByUser = this.halted.asReadonly();

  enable(): void {
    this.stop();
    this.halted.set(false);
    this.active.set(true);
  }
  /** Stops automation at a person's word, and keeps it stopped until they enable it again. */
  stopByUser(): void {
    this.halted.set(true);
    this.stop();
  }
  stop(): void {
    this.active.set(false);
    this.grants.set(['read_visible']);
    this.sessionId.set(crypto.randomUUID());
  }
  /** How many calls of the AI link are running through the facade; see {@link throughAiLink}. */
  private aiLinkDepth = 0;
  /** Whether a call of the AI link is running, so that what it says is marked as the AI's. */
  get viaAiLink(): boolean {
    return this.aiLinkDepth > 0;
  }
  /**
   * Runs a call the AI link made through the facade. The facade runs one write at a time, and only
   * writes speak, so a line said while it runs is the AI's.
   */
  async throughAiLink<T>(run: () => Promise<T>): Promise<T> {
    this.aiLinkDepth++;
    try {
      return await run();
    } finally {
      this.aiLinkDepth--;
    }
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
   * Whether a piece stands on the table where this seat sees it, as the board draws it: a piece whose
   * sheet is kept to the game master still stands there with its name, as a monster does before it is
   * identified, so it can be found and aimed at. Its sheet is read only where canSee allows.
   */
  canSeeOnBoard(piece: GameCharacter): boolean {
    return piece.location.name === 'table' && this.vision.isTokenVisible(piece);
  }
  /**
   * Whether a piece put out of sight may be read: by the game master, as the out-of-sight tab lists
   * them, or by whoever owns it.
   */
  canSeeConcealed(piece: { location: { name: string }; owner: string }): boolean {
    if (piece.location.name !== CONCEALED_LOCATION) return false;
    return this.role.canSeeHidden() || this.isMine(piece.owner);
  }
  /** Only the game master puts things out of sight and brings them back, as in the table's own menus. */
  requireGameMaster(): void {
    if (!this.role.canSeeHidden()) fail('FORBIDDEN', 'Only the game master can put pieces out of sight.');
  }
  /**
   * Whether what a piece carries may be managed across the table, as the buff manager lets anyone at
   * the table do: any piece that can be seen, whoever owns it. Guests only watch.
   */
  canManage(piece: GameCharacter): void {
    if (!this.role.canEditTabletop()) fail('FORBIDDEN', 'Guests cannot manage pieces.');
    if (!this.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
  }
  /** Whether new pieces may be put on the table, which a guest, who only watches, may not. */
  canCreatePieces(): void {
    if (!this.role.canEditTabletop()) fail('FORBIDDEN', 'Guests cannot put pieces on the table.');
  }
  canControl(piece: GameCharacter): void {
    if (!this.role.canEditTabletop()) fail('FORBIDDEN', 'Guests cannot control pieces.');
    if (!this.canSee(piece)) fail('NOT_FOUND', 'Visible piece not found.');
    // A lock keeps others from moving a piece; whoever owns it can still move it through automation.
    if (piece.isLock && !this.isMine(piece.owner)) fail('LOCKED', 'The piece is locked.');
    const ownedOnly = this.store.get<Config>('Config')?.automationOwnedOnly !== false;
    if (ownedOnly && !this.isMine(piece.owner)) {
      fail('FORBIDDEN', 'Only your own pieces may be controlled.');
    }
  }
}
