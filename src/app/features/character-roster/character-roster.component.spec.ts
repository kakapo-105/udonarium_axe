import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GameObjectInventoryService } from '@axe/application/inventory/game-object-inventory.service';
import { TableFocusService } from '@axe/application/tabletop/table-focus.service';
import { VisionService } from '@axe/application/tabletop/vision.service';
import { WidgetVisibilityService } from '@axe/application/ui/widget-visibility.service';
import { GameCharacter } from '@axe/domain/character/game-character';
import { DataElement } from '@axe/domain/data/data-element';
import { CharacterRosterComponent } from '@axe/features/character-roster/character-roster.component';
import { ObjectPanelService } from '@axe/features/panels/object-panel.service';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('CharacterRosterComponent', () => {
  let fixture: ComponentFixture<CharacterRosterComponent>;
  let component: CharacterRosterComponent;

  function makeCharacter(name: string, hp = 12): GameCharacter {
    const character = GameCharacter.create(name, 1, '');
    DataElement.findElementByReference(character.rootDataElement!, 'HP')!.currentValue = hp;
    return character;
  }

  /** Puts pieces on the table with the room showing their HP as its display item. */
  function onTable(characters: GameCharacter[]): void {
    const inventory = TestBed.inject(GameObjectInventoryService).tableInventory;
    vi.spyOn(inventory, 'tabletopObjects', 'get').mockReturnValue(characters);
    vi.spyOn(inventory, 'dataElementMap', 'get').mockReturnValue(
      new Map(
        characters.map((character) => [
          character.identifier,
          [DataElement.findElementByReference(character.rootDataElement!, 'HP')],
        ])
      )
    );
  }

  function shown(testId: string): HTMLElement[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [CharacterRosterComponent], providers: [...TEST_PROVIDERS] });
    fixture = TestBed.createComponent(CharacterRosterComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is shown from the start and lists each piece on the table with its display items', () => {
    onTable([makeCharacter('勇者', 12), makeCharacter('魔法使い', 7)]);
    fixture.detectChanges();

    expect(shown('character-roster')).toHaveLength(1);
    expect(shown('roster-name').map((el) => el.textContent?.trim())).toEqual(['勇者', '魔法使い']);
    expect(shown('roster-resource').map((el) => el.textContent?.trim())).toHaveLength(2);
    expect(shown('roster-resource')[0].textContent).toMatch(/^12\//);
  });

  it('leaves out a piece set to stay out of the roster, and one this reader may not see', () => {
    const hero = makeCharacter('勇者');
    const extra = makeCharacter('モブ');
    extra.hideFromRoster = true;
    const lurker = makeCharacter('闇の魔物');
    onTable([hero, extra, lurker]);
    vi.spyOn(TestBed.inject(VisionService), 'mayBeListed').mockImplementation((character) => character !== lurker);

    expect(component.entries().map((entry) => entry.name)).toEqual(['勇者']);
  });

  it('starts on the right edge below the mini player, clear of the panels that open on the left', () => {
    const fallback = (component as unknown as { fallback: (el: HTMLElement) => { left: number; top: number } })
      .fallback;

    expect(fallback({ offsetWidth: 224 } as HTMLElement)).toEqual({ left: window.innerWidth - 236, top: 140 });
  });

  it('finds the piece on a click and opens its sheet on a double-click', () => {
    const hero = makeCharacter('勇者');
    onTable([hero]);
    const focus = vi.spyOn(TestBed.inject(TableFocusService), 'focusOn').mockImplementation(() => undefined);
    const sheet = vi
      .spyOn(TestBed.inject(ObjectPanelService), 'openCharacterSheet')
      .mockImplementation(() => undefined);
    fixture.detectChanges();

    const row = shown('roster-entry')[0];
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick'));

    expect(focus).toHaveBeenCalledWith(hero);
    expect(sheet).toHaveBeenCalledWith(hero);
  });

  it('folds down to its header, and goes away when hidden from the widgets', () => {
    onTable([makeCharacter('勇者')]);
    fixture.detectChanges();

    component.collapsed.set(true);
    fixture.detectChanges();
    expect(shown('roster-entry')).toHaveLength(0);
    expect(shown('character-roster')).toHaveLength(1);

    TestBed.inject(WidgetVisibilityService).roster.set(false);
    fixture.detectChanges();
    expect(shown('character-roster')).toHaveLength(0);
  });
});
