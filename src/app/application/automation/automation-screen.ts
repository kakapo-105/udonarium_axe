import { Injectable, InjectionToken } from '@angular/core';

/** Someone standing on the novel stage as this screen draws it. */
export interface NovelCastMember {
  name: string;
  /** Which of the stage's places, 0 to 11 from the left. */
  slot: number;
  /** Whether they are leaving on the line being read. */
  leaving: boolean;
}

/**
 * What only the parts of the screen know, read for automation: the stage the novel overlay draws.
 *
 * The overlay is above this layer, so it hands its reading in while it is open and takes it back as
 * it closes; with no overlay there is nothing on stage to read.
 */
@Injectable({ providedIn: 'root' })
export class AutomationScreenService {
  private castReader: (() => readonly NovelCastMember[]) | null = null;

  /** Lends the stage's cast to automation while the overlay stands; the answer takes it back. */
  lendNovelCast(reader: () => readonly NovelCastMember[]): () => void {
    this.castReader = reader;
    return () => {
      if (this.castReader === reader) this.castReader = null;
    };
  }

  /** Who stands on the novel stage this screen draws, or null where no stage is drawn. */
  novelCast(): NovelCastMember[] | null {
    return this.castReader ? [...this.castReader()] : null;
  }
}

/**
 * Presses the switch on the ground at a point of the table in view, in pixels, exactly as clicking
 * there does on this seat; answers how it went, or null where no switch is there.
 *
 * The press is carried out by the board's own switch handling, above this layer, so the composition
 * root hands it in. Left unprovided, nothing can be pressed.
 */
export type SwitchPresser = (x: number, y: number) => Promise<string | null>;
export const SWITCH_PRESSER = new InjectionToken<SwitchPresser | null>('SWITCH_PRESSER', {
  providedIn: 'root',
  factory: () => null,
});
