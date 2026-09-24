import { fillInConditions, fillInRollReferences } from '@axe/domain/data/inline-condition';

describe('fillInConditions()', () => {
  it('puts the number an if gives in its place', () => {
    expect(fillInConditions('2d6+if(4<=5,3,0) 攻撃')).toBe('2d6+3 攻撃');
    expect(fillInConditions('2d6+if(9<=5,3,0) 攻撃')).toBe('2d6+0 攻撃');
  });

  it('works out an if nested in another as one', () => {
    expect(fillInConditions(':MP-if(4>=5,10,if(4>=3,6,3))')).toBe(':MP-6');
  });

  it('puts a negative answer in parentheses so it can follow an operator', () => {
    expect(fillInConditions(':HP-if(1,-3,0)')).toBe(':HP-(-3)');
  });

  it('reads full-width digits, signs and spaces inside the if', () => {
    expect(fillInConditions('if(４ ＜＝ ５， ３， ０)')).toBe('3');
  });

  it('leaves an if holding a roll to the resource edit, closed up so the command stays whole', () => {
    expect(fillInConditions(':HP-if([2d6] >= 10, 5, $1)')).toBe(':HP-if([2d6]>=10,5,$1)');
  });

  it('leaves an if it cannot work out as written', () => {
    expect(fillInConditions('if({HP}<=5,3,0)')).toBe('if({HP}<=5,3,0)');
    expect(fillInConditions('if(1,2')).toBe('if(1,2');
  });

  it('does not read a word that only ends in if as one', () => {
    expect(fillInConditions('motif(1,2,3)')).toBe('motif(1,2,3)');
  });

  it('works out each if in a line', () => {
    expect(fillInConditions('if(1,1,0) と if(0,1,0)')).toBe('1 と 0');
  });
});

describe('fillInRollReferences()', () => {
  it('puts the n-th answer in place of $n', () => {
    expect(fillInRollReferences('if($1>=7,$2,0)', [8, 4])).toBe('if(8>=7,4,0)');
  });

  it('puts a negative answer in parentheses', () => {
    expect(fillInRollReferences('5+$1', [-2])).toBe('5+(-2)');
  });

  it('gives null when a $n names a roll that is not there', () => {
    expect(fillInRollReferences('$2', [8])).toBeNull();
  });
});
