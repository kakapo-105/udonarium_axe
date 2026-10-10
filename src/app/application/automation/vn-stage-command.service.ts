import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { AutomationImage, AutomationImageService } from '@axe/application/automation/automation-image.service';
import { networkSend } from '@axe/core/network/network-messaging';
import { ObjectStore } from '@axe/core/sync/object-store';
import { VN_MODE_EVENT, VnStage, VnStageTransition } from '@axe/domain/visual-novel/vn-stage';

/** What the master asks of the novel stage; each part left out is left as it is. */
export interface VnStageRequest {
  /** Opens novel mode on every screen, or closes it. */
  open?: boolean;
  /** The picture behind the speakers, by its SHA-256; empty clears it. */
  background?: string;
  transition?: VnStageTransition;
  images: readonly AutomationImage[];
}

/**
 * Sets the novel stage for a scene of talk: the picture behind the speakers, and novel mode opened or
 * closed on every screen. The speakers stand in by themselves, from the pieces whose lines are shown.
 */
@Injectable({ providedIn: 'root' })
export class VnStageCommandService {
  private readonly store = inject(ObjectStore);
  private readonly images = inject(AutomationImageService);

  async set(request: VnStageRequest, guard: () => void) {
    const stage = this.store.get<VnStage>('VnStage');
    if (!stage) fail('NOT_READY', 'The room has no novel stage.');
    const pictures = await this.images.check(request.images);
    guard();
    await this.images.add(pictures);
    guard();
    if (request.background !== undefined) stage.setBackground(request.background, request.transition);
    else if (request.transition !== undefined) stage.playTransition(request.transition);
    if (request.open !== undefined) networkSend(VN_MODE_EVENT, { active: request.open });
    return {
      background: stage.backgroundImageIdentifier || null,
      transition: stage.transition,
      ...(request.open !== undefined ? { open: request.open } : {}),
    };
  }
}
