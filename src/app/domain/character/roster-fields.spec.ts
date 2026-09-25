import { GameCharacter } from '@axe/domain/character/game-character';
import {
  MAX_ROSTER_FIELDS,
  rosterBarRatio,
  rosterElementsOf,
  rosterFieldsOf,
} from '@axe/domain/character/roster-fields';
import { DataElement, DataElementAttribute, DataElementFieldType } from '@axe/domain/data/data-element';

describe('the fields a character shows in the roster', () => {
  let character: GameCharacter;
  let status: DataElement;
  let hp: DataElement;
  let mp: DataElement;
  let agility: DataElement;

  beforeEach(() => {
    character = new GameCharacter();
    character.initialize();
    character.createDataElements();
    status = DataElement.create('ステータス', '');
    hp = DataElement.create('HP', 20, { type: 'numberResource', currentValue: 12 });
    mp = DataElement.create('MP', 10, { type: 'numberResource', currentValue: 10 });
    agility = DataElement.create('敏捷度', 5);
    status.appendChild(hp);
    status.appendChild(mp);
    status.appendChild(agility);
    character.detailDataElement!.appendChild(status);
  });

  const none = () => null;
  const names = (elements: DataElement[]) => elements.map((element) => element.name);

  it("lists the room's display items in their order", () => {
    expect(names(rosterElementsOf(character, [mp, null, hp], none))).toEqual(['MP', 'HP']);
  });

  it('adds the fields marked on the sheet to pop up, after the display items', () => {
    agility.setAttribute(DataElementAttribute.POPUP, 'true');

    expect(names(rosterElementsOf(character, [hp], none))).toEqual(['HP', '敏捷度']);
  });

  it('shows a marked group once, in place of the display items it already holds', () => {
    status.setAttribute(DataElementAttribute.POPUP, 'true');

    expect(names(rosterElementsOf(character, [hp, mp], none))).toEqual(['ステータス']);
  });

  it('reads the older list of picked fields kept on the piece', () => {
    character.overViewDataTags = [agility.identifier];

    expect(names(rosterElementsOf(character, [], (id) => (id === agility.identifier ? agility : null)))).toEqual([
      '敏捷度',
    ]);
  });

  it('draws a resource as a bar and anything else as its value, a group giving its fields in turn', () => {
    expect(rosterFieldsOf([status])).toEqual([
      { identifier: hp.identifier, name: 'HP', kind: 'resource', current: 12, max: 20 },
      { identifier: mp.identifier, name: 'MP', kind: 'resource', current: 10, max: 10 },
      { identifier: agility.identifier, name: '敏捷度', kind: 'value', value: '5' },
    ]);
  });

  it('works a calculating field out rather than showing its empty value', () => {
    const calc = DataElement.create('回避', '', { fieldType: DataElementFieldType.CALC, formula: '敏捷度 + 2' });
    status.appendChild(calc);

    expect(rosterFieldsOf([calc])).toEqual([{ identifier: calc.identifier, name: '回避', kind: 'value', value: '7' }]);
  });

  it('leaves out pictures, and whatever the caller marks to skip', () => {
    const picture = DataElement.create('立ち絵', 'image-id', { fieldType: DataElementFieldType.IMAGE });
    const lineBreak = DataElement.create('/', '');

    expect(rosterFieldsOf([picture, lineBreak, hp], (element) => element === lineBreak).map((f) => f.name)).toEqual([
      'HP',
    ]);
  });

  it('gives one character no more than its share of lines', () => {
    const many = Array.from({ length: MAX_ROSTER_FIELDS + 5 }, (_, index) => DataElement.create(`項目${index}`, index));

    expect(rosterFieldsOf(many)).toHaveLength(MAX_ROSTER_FIELDS);
  });

  it('fills a bar by what is left of the maximum, kept between empty and full', () => {
    expect(rosterBarRatio({ current: 12, max: 20 })).toBe(0.6);
    expect(rosterBarRatio({ current: 30, max: 20 })).toBe(1);
    expect(rosterBarRatio({ current: -3, max: 20 })).toBe(0);
    expect(rosterBarRatio({ current: 5, max: 0 })).toBe(0);
  });
});
