/**
 * Geologic time scale (ST0): the committed ICS 2023/09 chart. Guards pin
 * well-known boundaries from the chart itself, check that every level is
 * monotonic and gap-free, and exercise the lookups. The reference is the
 * International Chronostratigraphic Chart v2023/09 (ICS, CC BY 4.0).
 */
import {
  TIMESCALE_VERSION, RANKS, timescaleUnits, unitsOfRank, timescaleUnit, ageBounds, unitsAt, unitAt, unitsBetween, lineage,
} from '../engines/stratigraphy/timescale';

describe('chart identity and shape', () => {
  test('version stamp and ranks', () => {
    expect(TIMESCALE_VERSION).toBe('ICS 2023/09');
    expect(RANKS).toEqual(['eon', 'era', 'period', 'epoch', 'age']);
  });

  test('every unit is frozen, named once, and spans a positive duration', () => {
    const units = timescaleUnits();
    expect(Object.isFrozen(units)).toBe(true);
    const names = units.map((u) => u.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const u of units) {
      expect(Object.isFrozen(u)).toBe(true);
      expect(u.base_ma).toBeGreaterThan(u.top_ma);
    }
  });

  test('siblings tile their parent exactly, youngest first, with no gaps or overlaps', () => {
    const units = timescaleUnits();
    for (const parent of units) {
      const kids = units.filter((u) => u.parent === parent.name && u.path.length === parent.path.length + 1);
      if (!kids.length) continue;
      expect(kids[0].top_ma).toBe(parent.top_ma);
      expect(kids[kids.length - 1].base_ma).toBe(parent.base_ma);
      for (let i = 1; i < kids.length; i++) expect(kids[i].top_ma).toBe(kids[i - 1].base_ma);
    }
    const eons = unitsOfRank('eon');
    expect(eons.map((e) => e.name)).toEqual(['Phanerozoic', 'Proterozoic', 'Archean', 'Hadean']);
    expect(eons[0].top_ma).toBe(0);
    expect(eons[3].base_ma).toBe(4567.3);
  });
});

describe('boundary guards (ICS 2023/09)', () => {
  test.each([
    ['Holocene', 0, 0.0117],
    ['Quaternary', 0, 2.58],
    ['Neogene', 2.58, 23.03],
    ['Paleogene', 23.03, 66.0],
    ['Danian', 61.6, 66.0],
    ['Cretaceous', 66.0, 145.0],
    ['Jurassic', 145.0, 201.4],
    ['Triassic', 201.4, 251.902],
    ['Permian', 251.902, 298.9],
    ['Carboniferous', 298.9, 358.9],
    ['Devonian', 358.9, 419.2],
    ['Silurian', 419.2, 443.8],
    ['Ordovician', 443.8, 485.4],
    ['Cambrian', 485.4, 538.8],
    ['Ediacaran', 538.8, 635.0],
    ['Phanerozoic', 0, 538.8],
    ['Proterozoic', 538.8, 2500.0],
    ['Archean', 2500.0, 4031.0],
  ])('%s spans %s to %s Ma', (name, top, base) => {
    expect(ageBounds(name)).toMatchObject({ top_ma: top, base_ma: base });
  });

  test('approximate boundaries are flagged, defined ones are not', () => {
    expect(ageBounds('Albian').approx).toBe(true);
    expect(ageBounds('Danian').approx).toBe(false);
    expect(ageBounds('Hettangian').approx).toBe(true);
    expect(ageBounds('Induan').approx).toBe(false);
  });

  test('ages are counted, 102 Phanerozoic stages', () => {
    const ages = unitsOfRank('age');
    expect(ages).toHaveLength(102);
    expect(ages[0].name).toBe('Meghalayan');
    expect(ages[ages.length - 1].name).toBe('Fortunian');
  });
});

describe('lookups', () => {
  test('lookup is case-insensitive and unknown names are null', () => {
    expect(timescaleUnit('maastrichtian').base_ma).toBe(72.1);
    expect(timescaleUnit('Atlantis')).toBeNull();
    expect(ageBounds('Atlantis')).toBeNull();
  });

  test('unitsAt walks every rank; a boundary age belongs to the unit below it', () => {
    expect(unitsAt(70).map((u) => u.name)).toEqual(['Phanerozoic', 'Mesozoic', 'Cretaceous', 'Upper Cretaceous', 'Maastrichtian']);
    expect(unitAt(66.0).name).toBe('Danian');              // base of the Danian, inclusive
    expect(unitAt(66.0000001).name).toBe('Maastrichtian');
    expect(unitAt(0).name).toBe('Meghalayan');
    expect(unitAt(3000).name).toBe('Mesoarchean');
    expect(unitsAt(3000).map((u) => u.rank)).toEqual(['eon', 'era']);
    expect(unitsAt(-1)).toEqual([]);
    expect(unitsAt(5000)).toEqual([]);
    expect(unitsAt(NaN)).toEqual([]);
  });

  test('unitsBetween returns overlapping units of a rank, youngest first, either argument order', () => {
    expect(unitsBetween(60, 75, 'age').map((u) => u.name)).toEqual(['Selandian', 'Danian', 'Maastrichtian', 'Campanian']);
    expect(unitsBetween(75, 60, 'age').map((u) => u.name)).toEqual(['Selandian', 'Danian', 'Maastrichtian', 'Campanian']);
    expect(unitsBetween(60, 75, 'period').map((u) => u.name)).toEqual(['Paleogene', 'Cretaceous']);
    expect(unitsBetween(66.0, 72.1, 'age').map((u) => u.name)).toEqual(['Maastrichtian']);   // touching ends excluded
  });

  test('lineage runs eon first', () => {
    expect(lineage('Danian').map((u) => u.name)).toEqual(['Phanerozoic', 'Cenozoic', 'Paleogene', 'Paleocene', 'Danian']);
    expect(lineage('nope')).toEqual([]);
  });
});
