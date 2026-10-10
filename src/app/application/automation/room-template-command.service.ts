import { inject, Injectable } from '@angular/core';
import { AutomationAudio, AutomationAudioService } from '@axe/application/automation/automation-audio.service';
import { fail } from '@axe/application/automation/automation-contract';
import { AutomationImage, AutomationImageService } from '@axe/application/automation/automation-image.service';
import { GameObject } from '@axe/core/sync/game-object';
import { ObjectSerializer } from '@axe/core/sync/object-serializer';
import { ObjectStore } from '@axe/core/sync/object-store';
import { xml2element } from '@axe/core/util/xml-util';
import { CutIn } from '@axe/domain/media/cut-in';
import { Jukebox } from '@axe/domain/media/jukebox';
import { Config } from '@axe/domain/peer/config';
import { GameTable } from '@axe/domain/tabletop/game-table';
import { clearOwnership } from '@axe/domain/tabletop/ownership';

/** What a saved room brings that is not a table but goes with one, as a battlefield's ranges and cut-ins do. */
const TEMPLATE_PARTS = new Set([
  'range',
  'cut-in',
  'text-note',
  'character',
  'card-stack',
  'card',
  'dice-symbol',
  'coin',
  'dice-table',
  'light-source',
  'effect-field',
]);
/**
 * The room settings a template does not carry over: how loud this room plays and whose face the
 * system speaks with belong to the room in play, and how far automation may reach is the master's.
 */
const CONFIG_KEPT = new Set([
  'automationOwnedOnly',
  '_roomVolume',
  '_systemAvatarIdentifier',
  '_systemDiceAvatarIdentifier',
]);

/** A saved room to build from: its room, settings and sound tags as save data writes them, and what it wears. */
export interface TemplateRequest {
  /** The room's `data.xml`. */
  room: string;
  /** The names of the tables to build; null builds them all. */
  tables: readonly string[] | null;
  /** Whether the effect library saved with the room replaces nothing but is added. */
  presets: boolean;
  /** The room's `config.xml`, or null to keep the settings in play. */
  config: string | null;
  /** The room's `audiotag.xml`, or null. */
  audioTags: string | null;
  images: readonly AutomationImage[];
  audios: readonly AutomationAudio[];
}

/**
 * Builds tables out of a saved room alongside the ones in play, for a master who keeps rooms as
 * templates: a scene's backdrop and music, a battlefield with its ranges and cut-ins. Loading a
 * room file replaces the room; this adds to it, and only the parts asked for.
 *
 * A save keeps its pictures but not its sounds, so the sounds come separately and are taken in under
 * the identifiers the room points at.
 */
@Injectable({ providedIn: 'root' })
export class RoomTemplateCommandService {
  private readonly store = inject(ObjectStore);
  private readonly images = inject(AutomationImageService);
  private readonly audios = inject(AutomationAudioService);

  async load(request: TemplateRequest, guard: () => void) {
    const room = xml2element(request.room);
    if (!room || room.tagName !== 'room') fail('INVALID_ARGUMENT', 'A template room must be save data <room>.');
    const children = Array.from(room.children);
    const tableNames = children
      .filter((child) => child.tagName === GameTable.aliasName)
      .map((child) => child.getAttribute('name') ?? '');
    const unknown = (request.tables ?? []).filter((name) => !tableNames.includes(name));
    if (unknown.length > 0)
      fail('NOT_FOUND', `The template has no table named ${unknown.join(', ')}. It has ${tableNames.join(', ')}.`);
    const config = request.config === null ? null : xml2element(request.config);
    if (request.config !== null && config?.tagName !== Config.aliasName)
      fail('INVALID_ARGUMENT', 'A template config must be save data <config>.');
    const audioTags = request.audioTags === null ? null : xml2element(request.audioTags);
    if (request.audioTags !== null && audioTags?.tagName !== 'audio-tag-list')
      fail('INVALID_ARGUMENT', 'A template audio tag list must be save data <audio-tag-list>.');

    let skipped = 0;
    const wanted = children.filter((child) => {
      if (child.tagName === GameTable.aliasName)
        return request.tables === null || request.tables.includes(child.getAttribute('name') ?? '');
      if (child.tagName === 'effect-preset' && !request.presets) return false;
      if (child.tagName !== 'effect-preset' && !TEMPLATE_PARTS.has(child.tagName)) return false;
      // What is saved under an identifier of its own, such as the sample cut-ins or a cut-in loaded
      // before, is in the room already; read again it would be a second copy of it.
      const identifier = child.getAttribute('identifier');
      if (identifier && this.store.get(identifier)) {
        skipped++;
        return false;
      }
      return true;
    });

    const pictures = await this.images.check(request.images);
    const sounds = await this.audios.check(request.audios);
    guard();
    await this.images.add(pictures);
    await this.audios.add(sounds);
    guard();

    const built = GameObject.batch(() =>
      wanted.map((child) => ObjectSerializer.instance.parseXml(child)).filter((object) => object !== null)
    );
    clearOwnership(built);
    if (audioTags) ObjectSerializer.instance.parseXml(audioTags);
    if (config) this.applyConfig(config);

    const tables = built.filter((object): object is GameTable => object instanceof GameTable);
    const cutIns = built.filter((object): object is CutIn => object instanceof CutIn);
    return {
      tables: tables.map((table) => ({
        identifier: table.identifier,
        name: table.name.slice(0, 256),
        width: table.width,
        height: table.height,
        bgm: table.bgm || null,
        cutIns: table.cutInIdentifiers.split(',').filter((identifier) => identifier.length > 0),
      })),
      cutIns: cutIns.map((cutIn) => ({ identifier: cutIn.identifier, name: cutIn.name.slice(0, 256) })),
      others: built.length - tables.length - cutIns.length,
      skipped,
      missingAudio: this.unheard(tables, cutIns),
      config: config !== null,
    };
  }

  /**
   * Takes in the sounds the room's tables and cut-ins name but the room does not hold, as after a
   * saved room is loaded, which keeps no sounds; answers what is still missing after them.
   */
  async restoreAudio(audios: readonly AutomationAudio[], guard: () => void) {
    const sounds = await this.audios.check(audios);
    guard();
    await this.audios.add(sounds);
    guard();
    return {
      added: sounds.length,
      missingAudio: this.unheard(this.store.getObjects<GameTable>(GameTable), this.store.getObjects<CutIn>(CutIn)),
    };
  }

  /** The sounds the tables play and the cut-ins sound that the room does not hold. */
  private unheard(tables: readonly GameTable[], cutIns: readonly CutIn[]): string[] {
    const heard = [
      ...tables.map((table) => table.bgm),
      ...cutIns.flatMap((cutIn) => [cutIn.audioIdentifier, ...(cutIn.scene?.soundList.map((sound) => sound.a) ?? [])]),
    ].filter((identifier) => identifier.length > 0);
    return [...new Set(heard)].filter((identifier) => !this.audios.has(identifier));
  }

  /** Takes the room's rules of play from the template, keeping what belongs to the room in play. */
  private applyConfig(element: Element): void {
    const config = this.store.get<Config>('Config');
    if (!config) fail('NOT_READY', 'The room has no settings to change.');
    // Only the settings saved under their own names, each read as the kind of value it holds now.
    const fields = config as unknown as Record<string, unknown>;
    for (const { name, value } of Array.from(element.attributes)) {
      if (CONFIG_KEPT.has(name) || !name.startsWith('_') || !(name in fields)) continue;
      const held = fields[name];
      if (typeof held === 'number') {
        const number = Number(value);
        if (Number.isFinite(number)) fields[name] = number;
      } else if (typeof held === 'string') fields[name] = value;
    }
    config.update();
  }

  /**
   * Plays a sound as the room's music for everyone, taking it in first when it is brought along, or
   * stops the music when given none.
   */
  async play(identifier: string | null, loop: boolean, audios: readonly AutomationAudio[], guard: () => void) {
    const jukebox = this.store.get<Jukebox>('Jukebox');
    if (!jukebox) fail('NOT_READY', 'The room has no jukebox.');
    if (identifier === null) {
      jukebox.stop();
      return { playing: null };
    }
    const sounds = await this.audios.check(audios);
    guard();
    await this.audios.add(sounds);
    guard();
    if (!this.audios.has(identifier)) fail('NOT_FOUND', 'The room holds no such sound.');
    jukebox.play(identifier, loop);
    return { playing: identifier, loop };
  }
}
