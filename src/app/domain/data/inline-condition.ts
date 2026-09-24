import { toHalfWidth } from '@axe/core/util/string-util';
import { evalCalcFormula } from '@axe/domain/data/data-element-calc';

interface ConditionSite {
  start: number;
  end: number;
}

const CONDITION_START = /(^|[^\p{L}\p{N}_])(if\s*\()/giu;

/**
 * The outermost `if(...)` runs in a line. An `if` nested in another belongs to the outer one, and one
 * whose brackets never close is left out.
 */
function findConditions(text: string): ConditionSite[] {
  const sites: ConditionSite[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    CONDITION_START.lastIndex = searchFrom;
    const found = CONDITION_START.exec(text);
    if (!found) break;
    const start = found.index + found[1].length;
    let depth = 0;
    let end = -1;
    for (let index = start + found[2].length - 1; index < text.length; index++) {
      if (text[index] === '(') depth++;
      else if (text[index] === ')' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) break;
    sites.push({ start, end });
    searchFrom = end;
  }
  return sites;
}

/** A worked-out value as it goes back into a line, in parentheses when negative so it can follow an operator. */
function formatAnswer(value: number): string {
  return value < 0 ? `(${value})` : `${value}`;
}

/**
 * Works out each `if(condition, then, else)` in a line and puts the number it gives in its place.
 *
 * The condition and both branches are formulas as a calculating field reads them, so `if` can nest.
 * One that still holds a roll in brackets or a `$n` reference to one is left to the resource edit that
 * rolls it, with its spaces taken out so the command is not split there. One that cannot be worked
 * out is left as written.
 */
export function fillInConditions(text: string): string {
  const sites = findConditions(text);
  if (sites.length < 1) return text;

  let filled = '';
  let cursor = 0;
  for (const site of sites) {
    const written = text.slice(site.start, site.end);
    filled += text.slice(cursor, site.start);
    cursor = site.end;

    if (/[[\]$［］＄]/.test(written)) {
      filled += written.replace(/\s+/g, '');
      continue;
    }
    const value = evalCalcFormula(toHalfWidth(written), () => NaN);
    filled += Number.isFinite(value) ? formatAnswer(value) : written;
  }
  return filled + text.slice(cursor);
}

/**
 * Puts the answer of the n-th bracketed roll in place of each `$n`, counting from 1.
 *
 * Returns null when a `$n` names a roll that is not there.
 */
export function fillInRollReferences(text: string, answers: readonly number[]): string | null {
  let missing = false;
  const filled = text.replace(/[$＄]([0-9０-９]+)/g, (_match, digits: string) => {
    const answer = answers[Number(toHalfWidth(digits)) - 1];
    if (answer == null) {
      missing = true;
      return '';
    }
    return formatAnswer(answer);
  });
  return missing ? null : filled;
}
