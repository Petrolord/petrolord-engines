/**
 * E1a extraction gate for engines/qi/prestackQc.js: every assertion calls the
 * shipped function and compares it with test-data/qi/goldens.prestackQc.json,
 * written by tools/validation/qi/oracle_qi_prestack.py. The stretch is the
 * rationalised closed form, the mute offset a bisection root, and residual
 * moveout is checked against the DESIGNED parabolic residual of gathers the
 * oracle built analytically (its own semblance estimate recovers it too).
 * Negative controls: tools/validation/qi/negcontrol_e1a.sh.
 */
import G from '../test-data/qi/goldens.prestackQc.json';
import { nmoStretch, stretchMuteOffset, residualMoveout, foldSummary } from '../engines/qi/prestackQc';

const sweep = (xs) => { expect(xs.length).toBeGreaterThan(0); return xs; };

test('NMO stretch matches the rationalised closed form', () => {
  for (const c of sweep(G.stretch)) {
    const s = nmoStretch(c.offsetM, c.t0S, c.v);
    if (c.stretch === null) expect(s).toBeNaN(); else expect(Math.abs(s - c.stretch)).toBeLessThanOrEqual(1e-13);
  }
});

test('the stretch-mute offset matches the bisection root', () => {
  for (const c of sweep(G.mute)) expect(Math.abs(stretchMuteOffset(c.t0S, c.v, c.maxStretch) - c.offsetM)).toBeLessThanOrEqual(1e-8);
});

describe('residual moveout recovers the designed far-offset residual', () => {
  // 2 ms sampling: the engine's sub-sample estimate is held to a tenth of a sample
  test.each(sweep(G.rmo).map((c) => [c.name, c]))('%s', (_, c) => {
    const r = residualMoveout({ traces: c.traces, offsets: c.offsets, dtMs: c.dtMs, centreMs: c.centreMs });
    expect(r.used).toBe(c.offsets.length);
    expect(r.method).toBe(c.expectMethod);
    expect(r.farOffset).toBe(c.offsets[c.offsets.length - 1]);
    expect(Math.abs(r.rmoFarMs - c.designedRmoFarMs)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(r.rmoFarMs - c.oracleRmoFarMs)).toBeLessThanOrEqual(0.2);
  });
});

test('fold summary', () => {
  for (const c of sweep(G.fold)) {
    const s = foldSummary(c.fold, c.centres, c.minFold);
    expect(s.total).toBe(c.summary.total);
    expect(s.liveBins).toBe(c.summary.liveBins);
    if (c.summary.farOffset === null) expect(s.farOffset).toBeNaN(); else expect(s.farOffset).toBe(c.summary.farOffset);
  }
});
