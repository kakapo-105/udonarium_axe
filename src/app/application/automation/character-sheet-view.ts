import { GameCharacter } from '@axe/domain/character/game-character';
import { DataElement, DataElementFieldType } from '@axe/domain/data/data-element';
import { createCalcPass, evaluateCalcElement } from '@axe/domain/data/data-element-calc-env';

/** One field of a character sheet as automation reads it. */
export interface SheetFieldView {
  /** The section and groups it sits under and its own name, joined by `/` as `{...}` references write them. */
  path: string;
  type: string;
  value: string;
  /** For a resource, what is left; `value` is then its maximum. */
  current?: string;
}

const MAX_FIELDS = 300;
const MAX_TEXT = 500;
/** Kinds whose value means nothing read as text: a picture's key, a drawn range, a stored effect. */
const UNREADABLE = new Set<string>([
  DataElementFieldType.IMAGE,
  DataElementFieldType.RANGE_SHAPE,
  DataElementFieldType.EFFECT,
]);

/**
 * The fields of a character's sheet, section by section, with calculating fields worked out.
 *
 * Pictures, drawn ranges and stored effects are left out, long text is cut short, and at most
 * {@link MAX_FIELDS} fields are listed; `truncated` says when there were more.
 */
export function characterSheetView(character: GameCharacter): { fields: SheetFieldView[]; truncated: boolean } {
  const fields: SheetFieldView[] = [];
  const pass = createCalcPass();
  let truncated = false;

  const visit = (element: DataElement, trail: readonly string[]) => {
    if (truncated) return;
    const path = [...trail, element.name];
    if (element.children.length > 0) {
      for (const child of element.children) visit(child, path);
      return;
    }
    if (UNREADABLE.has(element.fieldType)) return;
    if (fields.length >= MAX_FIELDS) {
      truncated = true;
      return;
    }
    const field: SheetFieldView = {
      path: path.join('/'),
      type: element.fieldType,
      value: textOf(
        element.fieldType === DataElementFieldType.CALC ? evaluateCalcElement(element, pass) : element.value
      ),
    };
    if (element.isNumberResource) field.current = textOf(element.currentValue);
    fields.push(field);
  };

  for (const section of character.detailDataElement?.children ?? []) visit(section as DataElement, []);
  return { fields, truncated };
}

function textOf(value: unknown): string {
  return String(value ?? '').slice(0, MAX_TEXT);
}
