import { inject, Injectable } from '@angular/core';
import { AUTOMATION_SCOPES } from '@axe/application/automation/automation-contract';
import { AutomationFacadeService } from '@axe/application/automation/automation-facade.service';
import { AutomationPolicyService } from '@axe/application/automation/automation-policy.service';
import { SessionCommandService } from '@axe/application/automation/session-command.service';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import { ObjectStore } from '@axe/core/sync/object-store';
import { Config } from '@axe/domain/peer/config';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';

/** The address parameter that asks for a preset, as `automationPreset=gm`. */
export const AUTOMATION_PRESET_PARAM = 'automationPreset';

export type AutomationPreset = 'gm';

/** The preset an address asks for, or none. */
export function automationPresetOf(href: string): AutomationPreset | null {
  try {
    return new URL(href).searchParams.get(AUTOMATION_PRESET_PARAM) === 'gm' ? 'gm' : null;
  } catch {
    return null;
  }
}

/**
 * Brings a browser that AI control was started in to the state its owner asked for in the address,
 * so the one running the session does not tick every box by hand each time.
 *
 * The `gm` preset makes the seat the game master while nobody else is one, enables AI control with
 * every grant once the seat is in a room or offline, and lets it control every piece rather than
 * only its own, as a game master may. Grants still fall away on a reload, a new room or a new role,
 * as they always do; the preset gives them back the next time it is applied. Pressing stop is
 * respected: nothing is given back until the person enables AI control again.
 *
 * The address is the only way in. A preset is asked for by whoever starts the dedicated browser,
 * and the panel shows AI control as active the whole time.
 */
@Injectable({ providedIn: 'root' })
export class AutomationPresetService {
  private readonly facade = inject(AutomationFacadeService);
  private readonly policy = inject(AutomationPolicyService);
  private readonly session = inject(SessionCommandService);
  private readonly store = inject(ObjectStore);
  readonly preset: AutomationPreset | null = automationPresetOf(inject(PAGE_ADDRESS)());

  /** Applies the preset once, doing as much as the seat's state allows; meant to be run again and again. */
  apply(): void {
    if (this.preset !== 'gm' || this.policy.stoppedByUser()) return;
    const me = PeerCursor.myCursor;
    if (!me) return;
    // A seat that changed since it was last looked at drops its old session first, so the one
    // enabled here is not ended by that afterwards.
    this.facade.health();
    if (me.role !== PeerRole.GameMaster) {
      // Never pushed into a room that has a game master of its own.
      if (this.someoneElseIsGameMaster(me)) return;
      me.role = PeerRole.GameMaster;
      me.update();
      // The new role ends the session there was; the next run enables a fresh one.
      return;
    }
    if (!this.session.ready) return;
    if (!this.policy.enabled()) {
      this.policy.enable();
      for (const scope of AUTOMATION_SCOPES) this.policy.setScope(scope, true);
    }
    const config = this.store.get<Config>('Config');
    if (config && config.automationOwnedOnly !== false) config.automationOwnedOnly = false;
  }

  private someoneElseIsGameMaster(me: PeerCursor): boolean {
    return this.store
      .getObjects<PeerCursor>(PeerCursor)
      .some((cursor) => cursor !== me && cursor.role === PeerRole.GameMaster);
  }
}
