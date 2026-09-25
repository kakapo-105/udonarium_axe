import { inject, Injectable } from '@angular/core';
import { AudioStorage } from '@axe/core/storage/audio-storage';
import { ObjectStore } from '@axe/core/sync/object-store';
import { Jukebox } from '@axe/domain/media/jukebox';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { TableBgmAction, tableBgmAction } from '@axe/domain/tabletop/table-bgm';

/**
 * Changes the room's music to what a table asks for, as the table is chosen.
 *
 * Run on the machine that changed the table, once; the jukebox carries the change to everyone else.
 */
@Injectable({ providedIn: 'root' })
export class TableBgmService {
  private readonly store = inject(ObjectStore);

  /** Plays or stops the room's music for the table, and says what it did. */
  applyFor(table: GameTable): TableBgmAction {
    const jukebox = this.store.get<Jukebox>('Jukebox');
    if (!jukebox) return { kind: 'keep' };
    const action = tableBgmAction(table.bgm, jukebox, (identifier) => AudioStorage.instance.get(identifier) != null);
    if (action.kind === 'play') jukebox.play(action.identifier, true);
    else if (action.kind === 'stop') jukebox.stop();
    return action;
  }
}
