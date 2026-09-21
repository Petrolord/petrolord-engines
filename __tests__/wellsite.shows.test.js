/** WS4 shows: controlled values, the derived quality against the hand-derived golden, and the language rule. */
import g from '../test-data/wellsite/show-goldens.json';
import { SHOW_TABLES, DISTRIBUTION_PERCENT, validateShow, emptyShow, showSummary, showAbbrev, distributionScore } from '../engines/wellsite/shows';

test('every show table has unique codes and the empty show validates as no show', () => {
  for (const list of Object.values(SHOW_TABLES)) expect(new Set(list.map((t) => t.code)).size).toBe(list.length);
  expect(validateShow(emptyShow())).toEqual([]);
  expect(showSummary(emptyShow()).quality).toBe('none');
  expect(DISTRIBUTION_PERCENT).toEqual([0, 5, 10, 25, 50, 75, 100]);
  expect([0, 5, 10, 25, 50, 75, 100].map(distributionScore)).toEqual([0, 1, 1, 2, 2, 3, 3]);
});

test('the goldens: score, band, parts, wording and short form', () => {
  for (const c of g.cases) {
    expect(validateShow(c.show)).toEqual([]);
    const s = showSummary(c.show);
    expect(s.score).toBe(c.expected.score);
    expect(s.quality).toBe(c.expected.quality);
    expect(s.parts).toEqual(c.expected.parts);
    expect(s.text).toBe(c.expected.text);
    expect(showAbbrev(c.show)).toBe(c.expected.abbrev);
  }
});

test('uncontrolled values and contradictions are refused; the wording never claims a determination', () => {
  const bad = { ...emptyShow(), fluorescence: { colour: 'neon', intensity: 'blinding', distributionPct: 33 }, stain: 'lots' };
  const e = validateShow(bad);
  expect(e).toContain('Fluorescence colour must be a controlled value.');
  expect(e).toContain('Fluorescence intensity must be a controlled value.');
  expect(e).toContain('Fluorescence distribution must be one of 0, 5, 10, 25, 50, 75, 100 percent.');
  expect(e).toContain('Stain must be a controlled value.');
  expect(validateShow({ ...emptyShow(), fluorescence: { colour: 'yellow', intensity: 'none', distributionPct: 0 } })).toEqual(['Fluorescence colour needs an intensity above none.']);
  expect(validateShow({ ...emptyShow(), cut: { speed: 'none', colour: 'none', type: 'streaming' } })).toEqual(['A cut type needs a cut speed above none.']);
  for (const c of g.cases) expect(showSummary(c.show).text).not.toMatch(/determined|confirmed|oil show|gas show/i);
});
