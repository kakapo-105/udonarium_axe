import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GameObjectInventoryService } from '@axe/application/inventory/game-object-inventory.service';
import { DisclosureService } from '@axe/application/permission/disclosure.service';
import { ObjectChangeService } from '@axe/application/sync/object-change.service';
import { TableFocusService } from '@axe/application/tabletop/table-focus.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { SelectionSignalService } from '@axe/application/ui/selection-signal.service';
import { WIDGET_ROSTER } from '@axe/application/ui/widget-place';
import { WidgetVisibilityService } from '@axe/application/ui/widget-visibility.service';
import { ObjectStore } from '@axe/core/sync/object-store';
import { GameCharacter } from '@axe/domain/character/game-character';
import { rosterBarRatio, rosterElementsOf, RosterField, rosterFieldsOf } from '@axe/domain/character/roster-fields';
import { DataElement } from '@axe/domain/data/data-element';
import { ObjectPanelService } from '@axe/features/panels/object-panel.service';
import { DraggableDirective } from '@axe/ui/directives/draggable.directive';
import { WidgetPlaceDirective } from '@axe/ui/directives/widget-place.directive';
import { SafePipe } from '@axe/ui/pipes/safe.pipe';
import { TranslocoModule } from '@jsverse/transloco';

/** One character as the roster shows it. */
export interface RosterEntry {
  character: GameCharacter;
  name: string;
  imageUrl: string;
  fields: RosterField[];
}

const EDGE_MARGIN = 12;
/** Clear of the mini player that sits in the top-right corner. */
const FALLBACK_TOP = 140;

/**
 * The characters on the table listed down the side of the screen with the fields they pop up with,
 * so the table's state can be read at a glance.
 *
 * Only what this reader may see is listed: a piece kept in the dark, under the fog or out of this
 * reader's disclosure is left out, and so is one set to stay out of the roster. It only shows;
 * a click finds the piece on the table and a double-click opens its sheet.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-character-roster',
  templateUrl: './character-roster.component.html',
  imports: [DraggableDirective, WidgetPlaceDirective, SafePipe, TranslocoModule],
})
export class CharacterRosterComponent {
  private readonly store = inject(ObjectStore);
  private readonly objectChange = inject(ObjectChangeService);
  private readonly inventory = inject(GameObjectInventoryService);
  private readonly vision = inject(VisionService);
  private readonly disclosure = inject(DisclosureService);
  private readonly selection = inject(SelectionSignalService);
  private readonly tableFocus = inject(TableFocusService);
  private readonly objectPanels = inject(ObjectPanelService);
  protected readonly widgets = inject(WidgetVisibilityService);
  protected readonly widgetName = WIDGET_ROSTER;
  /**
   * On the right edge below the mini player until it is dragged somewhere else. The left side is
   * where the panels a seat opens with are put, and they would cover it from the start.
   */
  protected readonly fallback = (element: HTMLElement) => ({
    left: Math.max(EDGE_MARGIN, window.innerWidth - element.offsetWidth - EDGE_MARGIN),
    top: FALLBACK_TOP,
  });
  protected readonly barRatio = rosterBarRatio;

  /** Whether the list is folded down to its header. */
  readonly collapsed = signal(false);

  readonly entries = computed<RosterEntry[]>(() => {
    // Bumped for any change to a character, to a field on one, or to the room's display items.
    this.inventory.inventoryVersion();
    this.objectChange.collectionOf(GameCharacter.aliasName)();
    this.objectChange.trackMyCursor();
    const table = this.inventory.tableInventory;
    const newLine = this.inventory.newLineString;
    const isLineBreak = (element: DataElement) => element.name === newLine && !element.parent;
    const findById = (identifier: string) => this.store.get<DataElement>(identifier) ?? null;

    return (table.tabletopObjects as GameCharacter[])
      .filter(
        (character) =>
          character instanceof GameCharacter &&
          !character.hideFromRoster &&
          this.disclosure.canView(character) &&
          this.vision.mayBeListed(character)
      )
      .map((character) => ({
        character,
        name: character.name,
        imageUrl: character.imageFile?.url ?? '',
        fields: rosterFieldsOf(
          rosterElementsOf(character, table.dataElementMap.get(character.identifier) ?? [], findById),
          isLineBreak
        ),
      }));
  });

  protected resourceFields(entry: RosterEntry) {
    return entry.fields.filter((field) => field.kind === 'resource');
  }

  protected valueFields(entry: RosterEntry) {
    return entry.fields.filter((field) => field.kind === 'value');
  }

  /** Picks the piece and brings the table round to it. */
  protected focus(character: GameCharacter): void {
    this.selection.selectObject(character.identifier, character.aliasName);
    this.tableFocus.focusOn(character);
  }

  protected openSheet(character: GameCharacter): void {
    this.objectPanels.openCharacterSheet(character);
  }

  protected close(): void {
    this.widgets.roster.set(false);
  }
}
