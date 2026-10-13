import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { VoiceBridge } from '@axe/application/voice/voice-bridge.service';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Shows whether the page is taking lines from the voice transcriber. Built only for a page opened
 * with `voice=`, and building it is what starts the bridge.
 */
@Component({
  selector: 'voice-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoModule],
  template: `
    <div
      class="border-ui-border-panel bg-ui-panel text-ui-text fixed bottom-3 left-3 z-300 rounded-lg border px-3 py-1 text-xs shadow-lg select-none"
      data-testid="voice-status"
      [title]="bridge.endpoint"
    >
      <span [class]="bridge.status() === 'open' ? 'text-green-600' : 'text-red-600'">●</span>
      {{ 'feature.voice.' + bridge.status() | transloco }}
      @if (bridge.posted() > 0) {
        <span class="opacity-70">({{ bridge.posted() }})</span>
      }
    </div>
  `,
})
export class VoiceStatusComponent {
  readonly bridge = inject(VoiceBridge);
}
