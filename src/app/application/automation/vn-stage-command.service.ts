import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { AutomationImage, AutomationImageService } from '@axe/application/automation/automation-image.service';
import { ChatWaitService } from '@axe/application/automation/chat-wait.service';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { encodeI18nMessage } from '@axe/application/i18n/i18n-message';
import { networkSend } from '@axe/core/network/network-messaging';
import { ObjectStore } from '@axe/core/sync/object-store';
import { ChatTab } from '@axe/domain/chat/chat-tab';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { VN_MODE_EVENT, VnStage, VnStageTransition } from '@axe/domain/visual-novel/vn-stage';

/** What the master asks of the novel stage; each part left out is left as it is. */
export interface VnStageRequest {
  /** Opens novel mode on every screen, or closes it. */
  open?: boolean;
  /** The picture behind the speakers, by its SHA-256; empty clears it. */
  background?: string;
  transition?: VnStageTransition;
  /** The tab whose portraits are cleared, so the scene starts with nobody standing; none leaves them. */
  resetCast?: ChatTab;
  images: readonly AutomationImage[];
}

/**
 * Sets the novel stage for a scene of talk: the picture behind the speakers, and novel mode opened or
 * closed on every screen. The speakers stand in by themselves, from the pieces whose lines are shown,
 * and the cast of the scene before is cleared away as the stage's reset does.
 */
@Injectable({ providedIn: 'root' })
export class VnStageCommandService {
  private readonly store = inject(ObjectStore);
  private readonly images = inject(AutomationImageService);
  private readonly chat = inject(ChatMessageService);
  private readonly chatWait = inject(ChatWaitService);

  async set(request: VnStageRequest, guard: () => void) {
    const stage = this.store.get<VnStage>('VnStage');
    if (!stage) fail('NOT_READY', 'The room has no novel stage.');
    const pictures = await this.images.check(request.images);
    guard();
    await this.images.add(pictures);
    guard();
    if (request.background !== undefined) stage.setBackground(request.background, request.transition);
    else if (request.transition !== undefined) stage.playTransition(request.transition);
    if (request.resetCast) this.resetCast(request.resetCast);
    if (request.open !== undefined) networkSend(VN_MODE_EVENT, { active: request.open });
    return {
      background: stage.backgroundImageIdentifier || null,
      transition: stage.transition,
      ...(request.open !== undefined ? { open: request.open } : {}),
      ...(request.resetCast ? { castReset: request.resetCast.identifier } : {}),
    };
  }

  /** Draws the line the stage's reset button draws: nothing said before it stands any more. */
  private resetCast(tab: ChatTab) {
    const cursor = PeerCursor.myCursor;
    // Said by automation itself, so a wait does not hand it back as if a player had spoken.
    const notice = this.chatWait.said(() =>
      this.chat.sendSystemMessageToTab(
        tab,
        encodeI18nMessage('feature.visualNovel.stageResetBy', {
          user: cursor?.name?.trim() || cursor?.identifier || '',
        }),
        undefined,
        cursor?.userId,
        true
      )
    );
    tab.vnPortraitResetAt = notice.placedAt;
  }
}
