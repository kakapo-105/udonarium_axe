import { GameCharacter } from '@axe/domain/character/game-character';
import { DataElement, DataElementAttribute, DataElementFieldType } from '@axe/domain/data/data-element';
import { createCalcPass, evaluateCalcElement } from '@axe/domain/data/data-element-calc-env';

/** One line under a character in the roster: a resource drawn as a bar, or any other field as its value. */
export type RosterField =
  | { identifier: string; name: string; kind: 'resource'; current: number; max: number }
  | { identifier: string; name: string; kind: 'value'; value: string };

/** How many lines one character is given, so a sheet with a long list does not push the others away. */
export const MAX_ROSTER_FIELDS = 12;
const MAX_VALUE_LENGTH = 40;
/** Kinds with nothing to read out in a line: a picture's key, a drawn range, a stored effect, a grid of ticks. */
const UNLISTED = new Set<string>([
  DataElementFieldType.IMAGE,
  DataElementFieldType.RANGE_SHAPE,
  DataElementFieldType.EFFECT,
  DataElementFieldType.CHECK_TABLE,
]);

/**
 * The sheet fields a character shows in the roster, the same ones its overview pops up with: the
 * room's display items (`inventoryElements`, in their order) and the fields marked on the sheet to pop
 * up, a field already covered by a group that is listed being left out.
 */
export function rosterElementsOf(
  character: GameCharacter,
  inventoryElements: readonly (DataElement | null)[],
  findById: (identifier: string) => DataElement | null
): DataElement[] {
  const popups = popupElementsOf(character, findById);
  const result: DataElement[] = [];
  const append = (element: DataElement) => {
    if (result.some((shown) => shown === element || isAncestorOf(shown, element))) return;
    for (let index = result.length - 1; index >= 0; index--) {
      if (isAncestorOf(element, result[index])) result.splice(index, 1);
    }
    result.push(element);
  };
  for (const element of inventoryElements) {
    if (!element) continue;
    append(popups.find((popup) => popup === element || isAncestorOf(popup, element)) ?? element);
  }
  for (const popup of popups) append(popup);
  return result;
}

/**
 * The lines the roster draws for those fields. A group gives its fields in turn, a resource becomes a
 * bar, a calculating field its worked-out result, and long text is cut short. `skip` leaves out a
 * marker such as the inventory's line break. At most {@link MAX_ROSTER_FIELDS} lines are given.
 */
export function rosterFieldsOf(
  elements: readonly DataElement[],
  skip: (element: DataElement) => boolean = () => false
): RosterField[] {
  const fields: RosterField[] = [];
  const pass = createCalcPass();
  const visit = (element: DataElement) => {
    if (fields.length >= MAX_ROSTER_FIELDS || skip(element)) return;
    if (element.children.length > 0) {
      for (const child of element.children as DataElement[]) visit(child);
      return;
    }
    if (UNLISTED.has(element.fieldType)) return;
    if (element.isNumberResource) {
      fields.push({
        identifier: element.identifier,
        name: element.name,
        kind: 'resource',
        current: Number(element.currentValue) || 0,
        max: Number(element.value) || 0,
      });
      return;
    }
    const raw = element.fieldType === DataElementFieldType.CALC ? evaluateCalcElement(element, pass) : element.value;
    fields.push({
      identifier: element.identifier,
      name: element.name,
      kind: 'value',
      value: String(raw ?? '').slice(0, MAX_VALUE_LENGTH),
    });
  };
  for (const element of elements) visit(element);
  return fields;
}

/** How full a resource bar is, from 0 to 1; an empty or broken maximum shows as empty. */
export function rosterBarRatio(field: { current: number; max: number }): number {
  if (!(field.max > 0)) return 0;
  return Math.min(1, Math.max(0, field.current / field.max));
}

function popupElementsOf(
  character: GameCharacter,
  findById: (identifier: string) => DataElement | null
): DataElement[] {
  const elements: DataElement[] = [];
  const used = new Set<string>();
  const collect = (element: DataElement) => {
    if (element.getAttribute(DataElementAttribute.POPUP) === 'true') {
      elements.push(element);
      used.add(element.identifier);
    }
    for (const child of element.children as DataElement[]) collect(child);
  };
  for (const child of (character.detailDataElement?.children ?? []) as DataElement[]) collect(child);
  // Pieces from before the popup mark lived on the sheet still name theirs in a list on the piece.
  for (const identifier of character.overViewDataTags) {
    if (used.has(identifier)) continue;
    const element = findById(identifier);
    if (!element) continue;
    elements.push(element);
    used.add(identifier);
  }
  const chosen = new Set(elements.map((element) => element.identifier));
  return elements.filter((element) => !hasChosenAncestor(element, chosen));
}

function isAncestorOf(ancestor: DataElement, element: DataElement): boolean {
  for (let node = element.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function hasChosenAncestor(element: DataElement, chosen: ReadonlySet<string>): boolean {
  for (let node = element.parent; node; node = node.parent) if (chosen.has(node.identifier)) return true;
  return false;
}
