import { inject, Injectable } from '@angular/core';
import { fail } from '@axe/application/automation/automation-contract';
import { ConcealmentService } from '@axe/application/tabletop/concealment.service';
import { BoardSwitch, resetSwitch, switchOf, switchWasPressed } from '@axe/domain/tabletop/board-switch/board-switch';
import {
  defaultSwitchDefinition,
  MAX_SWITCH_ACTIONS,
  newSwitchAction,
  SWITCH_SECRET_READERS,
  SWITCH_SPEAKERS,
  SwitchAction,
  SwitchDefinition,
} from '@axe/domain/tabletop/board-switch/switch-definition';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { SHOWN_TO, ShownTo } from '@axe/domain/tabletop/shown-to';
import { TableSelecter } from '@axe/domain/tabletop/table-selecter';
import { TableTrigger, triggersOn } from '@axe/domain/tabletop/table-trigger';
import { Terrain } from '@axe/domain/tabletop/terrain';
import { terrainBoxOf } from '@axe/domain/tabletop/terrain-box';
import { TRIGGER_REPEATS, TriggerRepeat } from '@axe/domain/tabletop/trigger-event';

/** The things a switch set by automation may do. The rest need the switch panel. */
export const SWITCH_ACTION_NAMES = [
  'say',
  'secret',
  'sound',
  'effect',
  'cutIn',
  'reveal',
  'conceal',
  'removeSelf',
] as const;

/** A switch as automation asks for it. Anything left out keeps what the switch already has. */
export interface SwitchRequest {
  label?: string;
  speaker?: string;
  range?: number;
  needsSight?: boolean;
  guests?: boolean;
  repeat?: string;
  actions?: Record<string, unknown>[];
}

/** Ground laid for a switch to stand on. */
export interface SwitchGround {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  shownTo: string;
  color?: string;
}

const MAX_LISTED = 200;
const SPEAKER_NAMES: readonly string[] = SWITCH_SPEAKERS;
const REPEAT_NAMES: readonly string[] = TRIGGER_REPEATS;
const SHOWN_NAMES: readonly string[] = SHOWN_TO;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function text(value: unknown, key: string, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    fail('INVALID_ARGUMENT', `${key} must be a string of ${max} characters or fewer.`);
  return value;
}

function delay(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000)
    fail('INVALID_ARGUMENT', 'delayMs must be 0 to 10000.');
  return Math.round(value);
}

/** One action as the caller wrote it, checked, and made into what the switch keeps. */
function actionOf(raw: Record<string, unknown>): SwitchAction {
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(SWITCH_ACTION_NAMES as readonly string[]).includes(kind))
    fail('INVALID_ARGUMENT', `An action's kind must be one of ${SWITCH_ACTION_NAMES.join(', ')}.`);
  const delayMs = delay(raw['delayMs']);
  switch (kind) {
    case 'say': {
      const action = newSwitchAction('say');
      action.text = text(raw['text'], 'text', 2000);
      action.delayMs = delayMs;
      return action;
    }
    case 'secret': {
      const action = newSwitchAction('secret');
      action.text = text(raw['text'], 'text', 2000);
      const to = raw['to'] ?? 'presser';
      if (!(SWITCH_SECRET_READERS as readonly unknown[]).includes(to))
        fail('INVALID_ARGUMENT', `to must be one of ${SWITCH_SECRET_READERS.join(', ')}.`);
      action.to = to as (typeof SWITCH_SECRET_READERS)[number];
      action.delayMs = delayMs;
      return action;
    }
    case 'sound':
    case 'effect':
    case 'cutIn': {
      const action = newSwitchAction(kind);
      action.name = text(raw['name'], 'name', 256);
      action.delayMs = delayMs;
      return action;
    }
    case 'reveal':
    case 'conceal': {
      const action = newSwitchAction(kind);
      action.target = { identifier: text(raw['target'], 'target', 256), name: '' };
      action.delayMs = delayMs;
      return action;
    }
    default: {
      const action = newSwitchAction('removeSelf');
      action.delayMs = delayMs;
      return action;
    }
  }
}

/** The switch a request describes, built on what the switch already is. */
export function switchDefinitionOf(request: SwitchRequest, base: SwitchDefinition): SwitchDefinition {
  const definition: SwitchDefinition = { ...base, actions: [...base.actions] };
  if (request.label !== undefined) definition.label = text(request.label, 'label', 256);
  if (request.speaker !== undefined) {
    if (!SPEAKER_NAMES.includes(request.speaker))
      fail('INVALID_ARGUMENT', `speaker must be one of ${SWITCH_SPEAKERS.join(', ')}.`);
    definition.speaker = request.speaker as (typeof SWITCH_SPEAKERS)[number];
  }
  if (request.range !== undefined) {
    if (!Number.isInteger(request.range) || request.range < 0 || request.range > 99)
      fail('INVALID_ARGUMENT', 'range must be a whole number from 0 to 99.');
    definition.range = request.range;
  }
  if (request.needsSight !== undefined) definition.needsSight = request.needsSight;
  if (request.guests !== undefined) definition.guests = request.guests;
  if (request.repeat !== undefined) {
    if (!REPEAT_NAMES.includes(request.repeat))
      fail('INVALID_ARGUMENT', `repeat must be one of ${TRIGGER_REPEATS.join(', ')}.`);
    definition.repeat = request.repeat as TriggerRepeat;
  }
  if (request.actions !== undefined) {
    if (request.actions.length > MAX_SWITCH_ACTIONS)
      fail('INVALID_ARGUMENT', `A switch holds ${MAX_SWITCH_ACTIONS} actions at most.`);
    definition.actions = request.actions.map(actionOf);
  }
  return definition;
}

/**
 * Lets the master lay switches on the table in view: painted ground that does something when it is
 * pressed, or a block already there made into one. Chests, levers, searches and traps the party
 * sets off by pressing are made this way, and go off without the master being asked.
 */
@Injectable({ providedIn: 'root' })
export class SwitchCommandService {
  private readonly tables = inject(TableSelecter);
  private readonly concealment = inject(ConcealmentService);

  private table(): GameTable {
    const table = this.tables.viewTable;
    if (!table || !Number.isFinite(table.gridSize) || table.gridSize <= 0) fail('NOT_READY', 'No usable table.');
    return table;
  }

  /** The pressed ground and the blocks with a switch on the table in view. */
  list() {
    const table = this.table();
    const grid = table.gridSize;
    const items: Record<string, unknown>[] = [];
    for (const trigger of triggersOn(table)) {
      const held = trigger.pressSwitch;
      if (!held) continue;
      const rect = trigger.rect;
      items.push({
        identifier: trigger.identifier,
        kind: 'ground',
        name: trigger.name.slice(0, 256),
        x: rect.col,
        y: rect.row,
        w: rect.width,
        h: rect.height,
        shownTo: trigger.shownTo || (trigger.open ? 'room' : 'master'),
        ...this.describe(held),
      });
    }
    for (const terrain of [...table.terrains, ...this.concealment.concealed().filter((o) => o instanceof Terrain)]) {
      const held = switchOf(terrain);
      if (!held) continue;
      const box = terrainBoxOf(terrain, grid);
      items.push({
        identifier: terrain.identifier,
        kind: 'block',
        name: terrain.name.slice(0, 256),
        x: box.minX / grid,
        y: box.minY / grid,
        w: (box.maxX - box.minX) / grid,
        h: (box.maxY - box.minY) / grid,
        fixed: terrain.isLocked,
        concealed: this.concealment.isConcealed(terrain),
        ...this.describe(held),
      });
    }
    return { unit: 'grid', items: items.slice(0, MAX_LISTED), more: items.length > MAX_LISTED };
  }

  private describe(held: BoardSwitch) {
    const definition = held.def;
    return {
      label: definition.label,
      speaker: definition.speaker,
      range: definition.range,
      needsSight: definition.needsSight,
      repeat: definition.repeat,
      pressed: switchWasPressed(held),
      actions: definition.actions.map((action) => ({ ...action, extra: undefined })),
    };
  }

  /** A switch-bearing thing on the table in view, by identifier. */
  find(identifier: string): TableTrigger | Terrain {
    const table = this.table();
    const ground = triggersOn(table).find((trigger) => trigger.identifier === identifier && trigger.pressSwitch);
    if (ground) return ground;
    const block = [...table.terrains, ...this.concealment.concealed()].find(
      (object): object is Terrain => object instanceof Terrain && object.identifier === identifier
    );
    if (!block) fail('NOT_FOUND', 'No block or pressed ground on the table in view has that identifier.');
    return block;
  }

  /** Lays ground that does something when pressed, on the table in view. */
  lay(ground: SwitchGround, request: SwitchRequest) {
    const table = this.table();
    const x = Math.floor(ground.x);
    const y = Math.floor(ground.y);
    const w = Math.max(1, Math.ceil(ground.w));
    const h = Math.max(1, Math.ceil(ground.h));
    if (x < 0 || y < 0 || x + w > table.width || y + h > table.height)
      fail('INVALID_ARGUMENT', 'The ground is not on the table in view.');
    if (!SHOWN_NAMES.includes(ground.shownTo))
      fail('INVALID_ARGUMENT', `shownTo must be one of ${SHOWN_TO.join(', ')}.`);
    if (ground.color !== undefined && !COLOR.test(ground.color))
      fail('INVALID_ARGUMENT', 'color must be like #c0392b.');
    const definition = switchDefinitionOf(request, defaultSwitchDefinition());
    if (definition.actions.length < 1) fail('INVALID_ARGUMENT', 'Give the actions the switch does.');
    const trigger = new TableTrigger();
    trigger.col = x;
    trigger.row = y;
    trigger.width = w;
    trigger.height = h;
    trigger.name = ground.name;
    trigger.moment = 'press';
    trigger.shownTo = ground.shownTo as ShownTo;
    trigger.open = ground.shownTo === 'room';
    if (ground.color) trigger.color = ground.color;
    // As the map editor lays pressed ground: its own count is the switch's, and this is kept spent so
    // an older version that reads it as ground to walk on never sets it off.
    trigger.once = true;
    trigger.repeat = 'once';
    trigger.spent = true;
    trigger.initialize();
    table.appendChild(trigger);
    const held = new BoardSwitch();
    held.initialize();
    held.write(definition);
    trigger.appendChild(held);
    return { identifier: trigger.identifier, kind: 'ground', name: trigger.name, x, y, w, h, unit: 'grid' };
  }

  /** Writes the switch of something, making it one where it is not. A block has to be fixed to be pressed. */
  set(target: TableTrigger | Terrain, request: SwitchRequest) {
    let held = switchOf(target);
    if (!held) {
      held = new BoardSwitch();
      held.initialize();
      target.appendChild(held);
    }
    const definition = switchDefinitionOf(request, held.def);
    if (definition.actions.length < 1) fail('INVALID_ARGUMENT', 'Give the actions the switch does.');
    held.write(definition);
    if (target instanceof Terrain && !target.isLocked) target.isLocked = true;
    return {
      identifier: target.identifier,
      kind: target instanceof Terrain ? 'block' : 'ground',
      ...this.describe(held),
    };
  }

  /** Lets a switch that was used up be pressed again. */
  reset(target: TableTrigger | Terrain) {
    const held = switchOf(target);
    if (!held) fail('NOT_FOUND', 'That has no switch.');
    resetSwitch(held);
    if (target instanceof TableTrigger && target.found) target.found = false;
    return { identifier: target.identifier, reset: true };
  }

  /** Takes a switch away: pressed ground is taken off the table, a block is left as the plain block it was. */
  remove(target: TableTrigger | Terrain) {
    if (target instanceof TableTrigger) {
      target.destroy();
      return { identifier: target.identifier, removed: true };
    }
    switchOf(target)?.destroy();
    return { identifier: target.identifier, removed: true };
  }
}
