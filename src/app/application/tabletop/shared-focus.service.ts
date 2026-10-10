import { DestroyRef, inject, Injectable } from '@angular/core';
import { TableFocusService } from '@axe/application/tabletop/table-focus.service';
import { FollowFocusPreferenceService } from '@axe/application/ui/follow-focus-preference.service';
import { SelectionSignalService } from '@axe/application/ui/selection-signal.service';
import { networkMessage$, networkSend } from '@axe/core/network/network-messaging';
import { ObjectStore } from '@axe/core/sync/object-store';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TabletopObject } from '@axe/domain/tabletop/tabletop-object';

export const SHARED_FOCUS_EVENT_NAME = 'SHARE_TABLE_FOCUS';

/** Where the game master points everyone: a piece, or a point on the table in view. */
export interface SharedFocus {
  readonly table: string;
  readonly x: number;
  readonly y: number;
  readonly identifier?: string;
}

/**
 * Lets the game master point everyone's view at a place on the table: "look here".
 *
 * Each view is its own, so this only asks: a reader who has turned following off, or who is looking
 * at another table, stays where they are. Only a game master's pointing is followed, so a player
 * cannot pull everyone's view about. A piece pointed at also flashes, as when it is found from the
 * inventory. Flat or in perspective, the view glides the same way.
 */
@Injectable({ providedIn: 'root' })
export class SharedFocusService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(ObjectStore);
  private readonly tables = inject(TableSelecter);
  private readonly tableFocus = inject(TableFocusService);
  private readonly selection = inject(SelectionSignalService);
  private readonly follow = inject(FollowFocusPreferenceService);

  constructor() {
    networkMessage$.subscribe((message) => {
      if (message.eventName !== SHARED_FOCUS_EVENT_NAME) return;
      const focus = sharedFocusOf(message.data);
      if (!focus) return;
      const sender = message.isSendFromSelf ? PeerCursor.myCursor : PeerCursor.findByPeerId(message.sendFrom);
      if (!sender?.isGameMaster) return;
      if (!message.isSendFromSelf && !this.follow.enabled()) return;
      this.look(focus);
    }, this.destroyRef);
  }

  /** Points everyone, this reader included, at a piece on the table in view. */
  showPiece(object: TabletopObject): SharedFocus | null {
    const table = this.tables.viewTable;
    if (!table) return null;
    return this.send({
      table: table.identifier,
      x: object.location.x,
      y: object.location.y,
      identifier: object.identifier,
    });
  }

  /** Points everyone, this reader included, at a point on the table in view, in pixels. */
  showPoint(x: number, y: number): SharedFocus | null {
    const table = this.tables.viewTable;
    if (!table) return null;
    return this.send({ table: table.identifier, x, y });
  }

  private send(focus: SharedFocus): SharedFocus {
    networkSend(SHARED_FOCUS_EVENT_NAME, focus);
    return focus;
  }

  private look(focus: SharedFocus): void {
    if (this.tables.viewTable?.identifier !== focus.table) return;
    const object = focus.identifier ? this.store.get(focus.identifier) : null;
    if (object instanceof TabletopObject) {
      this.tableFocus.focusOn(object);
      this.selection.highlightObject(object.identifier);
    } else this.selection.focusToCoordinate(focus.x, focus.y);
  }
}

/** A focus as it arrives from a peer, or null when it is not one. */
export function sharedFocusOf(data: unknown): SharedFocus | null {
  if (!data || typeof data !== 'object') return null;
  const { table, x, y, identifier } = data as Record<string, unknown>;
  if (typeof table !== 'string' || typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (identifier !== undefined && typeof identifier !== 'string') return null;
  return { table, x, y, ...(identifier ? { identifier } : {}) };
}
