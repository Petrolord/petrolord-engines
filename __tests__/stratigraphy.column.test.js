/**
 * Stratigraphic column arithmetic (ST0): flat registry rows to an ordered
 * tree, validation the editor refuses to save, inherited ages. Analytic
 * fixtures (a three-level column with one deliberate defect per test).
 */
import {
  RANKS, isRank, compareSiblings, buildColumnTree, orderedUnits, lineageOf, validateColumn, inheritedTopAge,
} from '../engines/stratigraphy/column';

const U = (id, name, rank, parent_id = null, extra = {}) => ({ id, name, rank, parent_id, order_index: null, age_top_ma: null, age_base_ma: null, ...extra });

const column = () => [
  U('g1', 'Agbada Group', 'group', null, { age_top_ma: 2.58, age_base_ma: 33.9 }),
  U('f2', 'Lower Agbada', 'formation', 'g1', { order_index: 1, age_top_ma: 15.98, age_base_ma: 33.9 }),
  U('f1', 'Upper Agbada', 'formation', 'g1', { order_index: 0, age_top_ma: 2.58, age_base_ma: 15.98 }),
  U('m1', 'D1 Sand', 'member', 'f1', { age_top_ma: 5.333 }),
  U('m2', 'D2 Sand', 'member', 'f1', { age_top_ma: 7.246 }),
  U('g2', 'Akata Group', 'group', null, { age_top_ma: 33.9, age_base_ma: 56.0 }),
];

describe('tree', () => {
  test('ranks', () => {
    expect(RANKS).toEqual(['group', 'formation', 'member', 'bed']);
    expect(isRank('member')).toBe(true);
    expect(isRank('zone')).toBe(false);
  });

  test('siblings sort by order_index, then top age, then name', () => {
    const rows = [U('a', 'Zulu', 'bed'), U('b', 'Alpha', 'bed'), U('c', 'Mid', 'bed', null, { age_top_ma: 10 }), U('d', 'Ordered', 'bed', null, { order_index: 0 })];
    rows.sort(compareSiblings);
    expect(rows.map((r) => r.name)).toEqual(['Ordered', 'Mid', 'Alpha', 'Zulu']);
  });

  test('buildColumnTree nests, orders and reports nothing on a sound column', () => {
    const t = buildColumnTree(column());
    expect(t.orphans).toEqual([]);
    expect(t.cycles).toEqual([]);
    expect(t.roots.map((r) => r.name)).toEqual(['Agbada Group', 'Akata Group']);
    const agbada = t.roots[0];
    expect(agbada.children.map((c) => c.name)).toEqual(['Upper Agbada', 'Lower Agbada']);
    expect(agbada.children[0].children.map((c) => c.name)).toEqual(['D1 Sand', 'D2 Sand']);
    expect(agbada.children[0].children[1].depth).toBe(2);
  });

  test('orderedUnits is the drawing order, top-down and depth-first', () => {
    expect(orderedUnits(column()).map((u) => `${u.depth}:${u.name}`)).toEqual([
      '0:Agbada Group', '1:Upper Agbada', '2:D1 Sand', '2:D2 Sand', '1:Lower Agbada', '0:Akata Group',
    ]);
  });

  test('a missing parent makes an orphan root; a loop is cut and reported', () => {
    const rows = [...column(), U('x', 'Lost Member', 'member', 'gone')];
    const t = buildColumnTree(rows);
    expect(t.orphans).toEqual(['x']);
    expect(t.roots.map((r) => r.name)).toContain('Lost Member');
    const loop = [U('a', 'A', 'group', 'b'), U('b', 'B', 'formation', 'a')];
    const t2 = buildColumnTree(loop);
    expect(t2.cycles.length).toBeGreaterThan(0);
    expect(t2.roots.length).toBe(2);
  });

  test('lineage runs outermost first and survives a loop', () => {
    expect(lineageOf(column(), 'm2').map((u) => u.name)).toEqual(['Agbada Group', 'Upper Agbada', 'D2 Sand']);
    expect(lineageOf([U('a', 'A', 'group', 'b'), U('b', 'B', 'formation', 'a')], 'a').length).toBe(2);
    expect(lineageOf(column(), 'nope')).toEqual([]);
  });
});

describe('validation', () => {
  test('a sound column has no problems', () => {
    expect(validateColumn(column())).toEqual([]);
  });

  test.each([
    ['orphan', [U('x', 'Lost', 'member', 'gone')], /parent is not in this column/],
    ['cycle', [U('a', 'A', 'group', 'b'), U('b', 'B', 'formation', 'a')], /loops back/],
    ['name', [U('n', '  ', 'group')], /no name/],
    ['rank', [U('r', 'R', 'zone')], /rank "zone" is not one of/],
    ['age-order', [U('o', 'O', 'group', null, { age_top_ma: 50, age_base_ma: 40 })], /base age \(40 Ma\) is younger than the top age \(50 Ma\)/],
    ['rank-order', [U('p', 'P', 'formation'), U('q', 'Q', 'group', 'p')], /Q \(group\) cannot sit inside P \(formation\)/],
    ['age-outside', [U('p', 'P', 'group', null, { age_top_ma: 10, age_base_ma: 20 }), U('q', 'Q', 'formation', 'p', { age_top_ma: 5 })], /top \(5 Ma\) is younger than the top of P \(10 Ma\)/],
    ['age-outside', [U('p', 'P', 'group', null, { age_top_ma: 10, age_base_ma: 20 }), U('q', 'Q', 'formation', 'p', { age_base_ma: 25 })], /base \(25 Ma\) is older than the base of P \(20 Ma\)/],
  ])('refuses %s', (code, rows, message) => {
    const problems = validateColumn(rows);
    expect(problems.some((p) => p.code === code && message.test(p.message))).toBe(true);
  });

  test('non-numeric ages are refused', () => {
    const p = validateColumn([U('a', 'A', 'group', null, { age_top_ma: 'old' })]);
    expect(p).toEqual([{ id: 'a', code: 'age', message: 'A: the top age is not a number.' }]);
  });
});

describe('inherited ages', () => {
  test('own age, else the nearest ancestor, else null', () => {
    const rows = column();
    expect(inheritedTopAge(rows, 'm1')).toBe(5.333);
    rows.find((u) => u.id === 'm1').age_top_ma = null;
    expect(inheritedTopAge(rows, 'm1')).toBe(2.58);   // Upper Agbada
    expect(inheritedTopAge([U('a', 'A', 'group')], 'a')).toBeNull();
    expect(inheritedTopAge(rows, 'nope')).toBeNull();
  });
});
