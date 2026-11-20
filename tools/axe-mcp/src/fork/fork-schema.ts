/**
 * Checks a tool's input against the JSON Schema the fork's bridge tools are given in: the part of it
 * they use, anyOf, patterns and open objects among it, which the app's own schema check leaves out.
 * Returns one line for each thing wrong, naming where it is; none for an input that fits.
 */
export function checkForkInput(schema: Readonly<Record<string, unknown>>, value: unknown, at = 'input'): string[] {
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const tries = anyOf.map((each) => checkForkInput(each as Record<string, unknown>, value, at));
    return tries.some((problems) => problems.length === 0) ? [] : (tries[0] ?? [`${at} fits none of its forms`]);
  }
  const enumerated = schema['enum'];
  if (Array.isArray(enumerated) && !enumerated.includes(value)) {
    return [`${at} must be one of ${enumerated.join(', ')}`];
  }
  switch (schema['type']) {
    case 'string':
      return checkString(schema, value, at);
    case 'number':
    case 'integer':
      return checkNumber(schema, value, at);
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} must be true or false`];
    case 'array':
      return checkArray(schema, value, at);
    case 'object':
      return checkObject(schema, value, at);
    default:
      return [];
  }
}

function checkString(schema: Readonly<Record<string, unknown>>, value: unknown, at: string): string[] {
  if (typeof value !== 'string') return [`${at} must be a string`];
  const { minLength, maxLength, pattern } = schema as { minLength?: number; maxLength?: number; pattern?: string };
  if (minLength !== undefined && value.length < minLength) return [`${at} must be at least ${minLength} characters`];
  if (maxLength !== undefined && value.length > maxLength) return [`${at} must be at most ${maxLength} characters`];
  if (pattern !== undefined && !new RegExp(pattern, 'u').test(value)) return [`${at} is not in the form asked for`];
  return [];
}

function checkNumber(schema: Readonly<Record<string, unknown>>, value: unknown, at: string): string[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at} must be a number`];
  if (schema['type'] === 'integer' && !Number.isInteger(value)) return [`${at} must be a whole number`];
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema as Record<string, number | undefined>;
  if (minimum !== undefined && value < minimum) return [`${at} must be at least ${minimum}`];
  if (maximum !== undefined && value > maximum) return [`${at} must be at most ${maximum}`];
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
    return [`${at} must be more than ${exclusiveMinimum}`];
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum)
    return [`${at} must be less than ${exclusiveMaximum}`];
  return [];
}

function checkArray(schema: Readonly<Record<string, unknown>>, value: unknown, at: string): string[] {
  if (!Array.isArray(value)) return [`${at} must be a list`];
  const { minItems, maxItems } = schema as { minItems?: number; maxItems?: number };
  if (minItems !== undefined && value.length < minItems) return [`${at} must hold at least ${minItems} items`];
  if (maxItems !== undefined && value.length > maxItems) return [`${at} must hold at most ${maxItems} items`];
  const items = schema['items'] as Record<string, unknown> | undefined;
  return items ? value.flatMap((item, index) => checkForkInput(items, item, `${at}[${index}]`)) : [];
}

function checkObject(schema: Readonly<Record<string, unknown>>, value: unknown, at: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at} must be an object`];
  const record = value as Record<string, unknown>;
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const extra = schema['additionalProperties'];
  const problems: string[] = [];
  for (const name of (schema['required'] ?? []) as string[]) {
    if (record[name] === undefined) problems.push(`${at}.${name} is required`);
  }
  for (const [name, item] of Object.entries(record)) {
    if (item === undefined) continue;
    const inner = properties[name];
    if (inner) problems.push(...checkForkInput(inner, item, `${at}.${name}`));
    else if (extra === false) problems.push(`${at}.${name} is not known`);
    else if (typeof extra === 'object' && extra !== null) {
      problems.push(...checkForkInput(extra as Record<string, unknown>, item, `${at}.${name}`));
    }
  }
  return problems;
}
