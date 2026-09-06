/**
 * LAS 3.0 data blocks (Stratigraphy ST1): parseLas hands back every
 * non-log block with its columns and rows, and lasBlocks turns the
 * interval-shaped ones (core description in feet, a user lithology block
 * in metres) into geo_wells_intervals rows while leaving point blocks
 * (tops) alone. Golden: test-data/wells/goldens/las3_intervals_30.intervals.json,
 * written by tools/validation/wells/genfixtures.py with the answers
 * derived by hand.
 */
import fs from 'fs';
import path from 'path';
import { parseLas } from '../engines/welldata/lasParse';
import { intervalsFromLasBlocks, blockRoles, blockKind } from '../engines/welldata/lasBlocks';

const LAS = path.join(__dirname, '..', 'test-data', 'wells', 'las');
const GOLD = path.join(__dirname, '..', 'test-data', 'wells', 'goldens');
const load = (name) => fs.readFileSync(path.join(LAS, `${name}.las`), 'utf8');

describe('parseLas blocks', () => {
  test('every non-log block comes back with columns and text rows; the log data is untouched', () => {
    const p = parseLas(load('las3_intervals_30'));
    expect(p.curves.map((c) => c.mnemonic)).toEqual(['DEPT', 'GR']);
    expect(p.ignoredSections).toEqual(['Core', 'Lithology', 'Tops']);
    expect(Object.keys(p.blocks)).toEqual(['Core', 'Lithology', 'Tops']);
    expect(p.blocks.Core.columns.map((c) => `${c.mnemonic}.${c.unit}`)).toEqual(['CORT.F', 'CORB.F', 'LITH.', 'GSIZE.', 'DESC.']);
    expect(p.blocks.Core.params.CORN.value).toBe(1);
    expect(p.blocks.Core.rows).toHaveLength(4);
    expect(p.blocks.Core.rows[2]).toEqual(['4926.18', '4929.46', 'SST W/ SH STRINGERS', 'M', 'Sandstone with shale stringers']);
    expect(p.blocks.Tops.rows).toEqual([['Top Sand A', '1500.4']]);
  });

  test('the comma fixture still parses as before, its point blocks now visible', () => {
    const p = parseLas(load('las3_comma_30'));
    expect(p.ignoredSections).toEqual(['Core', 'Tops']);
    expect(p.blocks.Core.columns.map((c) => c.mnemonic)).toEqual(['CDEP', 'CPOR']);
    expect(p.blocks.Core.rows).toEqual([['1500.2000', '21.5'], ['1501.7000', '18.0']]);
    expect(blockRoles(p.blocks.Core)).toBeNull();   // one depth: a point block
  });
});

describe('blocks to intervals', () => {
  test('block kinds and column roles', () => {
    expect(blockKind('Core')).toBe('core_description');
    expect(blockKind('Lithology')).toBe('lithology');
    expect(blockKind('Facies')).toBe('facies');
    expect(blockKind('Tops')).toBeNull();
    const p = parseLas(load('las3_intervals_30'));
    expect(blockRoles(p.blocks.Core)).toEqual({ top: 0, base: 1, lithology: 2, description: 4, grain: 3 });
    expect(blockRoles(p.blocks.Lithology)).toEqual({ top: 0, base: 1, lithology: 2, colour: 3 });
  });

  test('matches the golden: feet to metres, codes resolved, bad rows dropped and named, point blocks skipped', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(GOLD, 'las3_intervals_30.intervals.json'), 'utf8'));
    const p = parseLas(load('las3_intervals_30'));
    expect(Object.keys(p.blocks)).toEqual(golden.blocks);
    const { intervals, skipped } = intervalsFromLasBlocks(p.blocks);
    expect(skipped).toEqual(golden.skipped);
    expect(intervals).toHaveLength(golden.intervals.length);
    intervals.forEach((row, i) => {
      const g = golden.intervals[i];
      expect(row.kind).toBe(g.kind);
      expect(row.top_md_m).toBeCloseTo(g.top_md_m, 9);
      expect(row.base_md_m).toBeCloseTo(g.base_md_m, 9);
      expect(row.code).toBe(g.code);
      expect(row.label).toBe(g.label);
      expect(row.properties).toEqual(g.properties);
      expect(row.source).toBe(g.source);
    });
  });

  test('a block with an unknown depth unit is skipped, not mis-scaled', () => {
    const blocks = { Core: { name: 'Core', columns: [{ mnemonic: 'CORT', unit: 'CM' }, { mnemonic: 'CORB', unit: 'CM' }, { mnemonic: 'LITH', unit: '' }], rows: [['1', '2', 'SST']] } };
    const { intervals, skipped } = intervalsFromLasBlocks(blocks);
    expect(intervals).toEqual([]);
    expect(skipped[0].reason).toMatch(/depth unit "CM"/);
  });

  test('a facies block keeps its facies names as codes', () => {
    const blocks = { Facies: { name: 'Facies', columns: [{ mnemonic: 'TOP', unit: 'M' }, { mnemonic: 'BASE', unit: 'M' }, { mnemonic: 'FACIES', unit: '' }], rows: [['10', '12', 'Channel'], ['12', '15', 'Overbank']] } };
    const { intervals } = intervalsFromLasBlocks(blocks, { source: 'core' });
    expect(intervals.map((r) => [r.kind, r.code, r.source])).toEqual([['facies', 'Channel', 'core'], ['facies', 'Overbank', 'core']]);
  });
});
