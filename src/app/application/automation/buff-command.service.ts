import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { ChatMessageService } from '@axe/application/chat/chat-message.service';
import { TRANSLATE_FN } from '@axe/application/i18n/translate.token';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { BuffRemovalRule, countBuffRemoval, removeBuffsAcross } from '@axe/domain/character/buff-bulk-removal';
import { BUFF_TIMINGS, BuffTiming } from '@axe/domain/character/buff-timing';
import { GameCharacter } from '@axe/domain/character/game-character';
import { DataElement, DataElementAttribute } from '@axe/domain/data/data-element';
import { PeerCursor } from '@axe/domain/peer/peer-cursor';
import { PeerRole } from '@axe/domain/peer/peer-role';

/** What a buff edit may change; anything left out stays as it is. */
export interface BuffChanges {
  name?: string;
  /** The note or modifier text the buff carries. */
  info?: string;
  rounds?: number;
  timing?: BuffTiming;
  /** The character whose turn counts the buff down, by name; empty clears it. */
  trigger?: string;
  remove?: boolean;
}

/**
 * Buffs handled across the table the way the buff manager handles them: one buff edited in place on
 * whichever piece carries it, or a sweep of the whole table, without anybody speaking in chat.
 */
@Injectable({ providedIn: 'root' })
export class BuffCommandService {
  private readonly store = inject(ObjectStore);
  private readonly objectChange = inject(ObjectChangeService);
  private readonly chat = inject(ChatMessageService);
  private readonly t = inject(TRANSLATE_FN);

  /** The buffs on a piece, each with the identifier {@link edit} takes it by. */
  buffsOf(piece: GameCharacter) {
    const elements = (piece.buffDataElement?.children[0]?.children ?? []) as DataElement[];
    const entries = piece.buffs.snapshot();
    return elements.map((element, index) => ({ identifier: element.identifier, ...entries[index] }));
  }

  /** A buff by its identifier and the piece that carries it; anything else is not found. */
  find(identifier: string): { buff: DataElement; owner: GameCharacter } {
    const buff = this.store.get(identifier);
    if (!(buff instanceof DataElement)) fail('NOT_FOUND', 'Buff not found.');
    let node = buff.parent;
    while (node && !(node instanceof GameCharacter)) node = node.parent;
    const owner = node instanceof GameCharacter ? node : null;
    if (!owner || buff.parent !== owner.buffDataElement?.children[0]) fail('NOT_FOUND', 'Buff not found.');
    return { buff, owner };
  }

  /** Checks a set of changes before any of them is made, so a bad one leaves the buff untouched. */
  validate(changes: BuffChanges): void {
    if (changes.name !== undefined && changes.name.trim().length < 1) fail('INVALID_ARGUMENT', 'Name is empty.');
    if (changes.rounds !== undefined && !Number.isFinite(changes.rounds))
      fail('INVALID_ARGUMENT', 'Rounds must be a finite number.');
    if (changes.timing !== undefined && !(BUFF_TIMINGS as readonly string[]).includes(changes.timing))
      fail('INVALID_ARGUMENT', `Timing must be one of ${BUFF_TIMINGS.join(', ')}.`);
  }

  /**
   * Changes one buff in place, as the buff manager's form does: rounds kept whole and at zero or
   * above, and a buff counted down at the end of the round dropping any trigger it had. Removing it
   * puts back whatever it moved on the sheet.
   */
  edit(buff: DataElement, owner: GameCharacter, changes: BuffChanges) {
    this.validate(changes);
    if (changes.remove) {
      owner.buffs.remove(buff);
      this.objectChange.notifyChanged(owner.identifier);
      return { identifier: buff.identifier, owner: owner.identifier, removed: true };
    }
    if (changes.name !== undefined) buff.name = changes.name.trim();
    if (changes.info !== undefined) buff.currentValue = changes.info;
    if (changes.rounds !== undefined) buff.value = Math.max(0, Math.round(changes.rounds));
    if (changes.timing !== undefined) {
      buff.setAttribute(DataElementAttribute.BUFF_TIMING, changes.timing);
      if (changes.timing === 'roundEnd') buff.removeAttribute(DataElementAttribute.BUFF_TRIGGER);
    }
    if (changes.trigger !== undefined) {
      const trigger = changes.trigger.trim();
      if (trigger.length > 0) buff.setAttribute(DataElementAttribute.BUFF_TRIGGER, trigger);
      else buff.removeAttribute(DataElementAttribute.BUFF_TRIGGER);
    }
    this.objectChange.notifyChanged(buff.identifier);
    this.objectChange.notifyChanged(owner.identifier);
    return { owner: owner.identifier, ...this.buffsOf(owner).find((entry) => entry.identifier === buff.identifier) };
  }

  /**
   * Takes the buffs a rule names off every piece on the table, as the buff manager's sweep does, and
   * says in the main tab what went. Only the game master may sweep. A dry run counts without taking.
   */
  sweep(rule: BuffRemovalRule, dryRun: boolean) {
    if (PeerCursor.myRole !== PeerRole.GameMaster) fail('FORBIDDEN', 'Only the game master may sweep buffs.');
    const pieces = this.store
      .getObjects<GameCharacter>(GameCharacter)
      .filter((piece) => piece.location.name === 'table');
    if (dryRun) return { ...countBuffRemoval(pieces, rule), dryRun: true };
    const removed = removeBuffsAcross(pieces, rule);
    for (const piece of pieces) this.objectChange.notifyChanged(piece.identifier);
    if (removed.buffs > 0) {
      const what = this.describe(rule);
      this.chat.sendSystemMessageToMainTab(this.t('feature.buffManager.sweepDone', { what, ...removed }));
    }
    return removed;
  }

  private describe(rule: BuffRemovalRule): string {
    switch (rule.kind) {
      case 'held':
        return this.t('feature.buffManager.sweepHeldWhat');
      case 'rounds':
        return this.t('feature.buffManager.sweepRoundsWhat', { n: rule.rounds });
      case 'name':
        return this.t('feature.buffManager.sweepNameWhat', { name: rule.name });
    }
  }
}
