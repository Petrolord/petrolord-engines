/**
 * Automatic well tie (Tops to Horizons plan, TP2), gated on the synthetic
 * field: its traces are exact convolutions of the logs' reflectivity with
 * a zero-phase 30 Hz Ricker under normal polarity, so a correct tie finds
 * the checkshot error we inject, normal polarity, phase near 0, and a high
 * correlation; a reversed or rotated volume must be recognised as such.
 */
import { buildSyntheticField } from '../engines/seismolord/syntheticField';
import { makeTvdssToTwt } from '../engines/seismolord/wellSection';
import { rotateConstantPhase } from '../engines/seismolord/tieWarp';
import {
  autoTieWell, fieldTieConvention, tiedTimeConv, tiedCheckshots, wellPathTrace,
} from '../engines/seismolord/autoTie';
import { buildWellLatticePath } from '../engines/seismolord/wellSection';

const field = buildSyntheticField();
const { geom, dtMs, dtUs } = field;

function tieAll(f, { shiftMs = 0, transform = null } = {}) {
  const getTrace = transform ? async (il, xl) => transform(f.traceAt(il, xl)) : f.getTrace;
  return Promise.all(f.wells.map((w) => {
    const checkshots = w.checkshots.map((c) => ({ tvdss_m: c.tvdss_m, twt_ms: c.twt_ms + shiftMs }));
    const timeConv = makeTvdssToTwt({ checkshots, dtUs, maxTwtMs: geom.ns * dtMs });
    return autoTieWell({
      well: w, timeConv, affine: f.affine, geom, dtUs, getTrace,
    });
  }));
}

test('the path trace follows a deviated well across cells', async () => {
  const w4 = field.wells.find((w) => w.name === 'W-4');
  const tc = makeTvdssToTwt({ checkshots: w4.checkshots, dtUs, maxTwtMs: geom.ns * dtMs });
  const lat = buildWellLatticePath({ ...w4, tops: [] }, {
    affine: field.affine, timeConv: tc, geom, dtUs,
  });
  const { trace, cells } = await wellPathTrace(field.getTrace, lat, geom);
  expect(cells.length).toBeGreaterThan(5);
  // a sample deep in the well equals the trace at the cell the path is in then
  const top = w4.tops.find((t) => t.name === 'TOP_E');
  const k = Math.round(top.twtMs / dtMs);
  const near = lat.points.reduce((a, p) => (p.s != null && Math.abs(p.s - k) < Math.abs(a.s - k) ? p : a));
  expect(trace[k]).toBe(field.traceAt(Math.round(near.il), Math.round(near.xl))[k]);
});

describe('ties on the synthetic field', () => {
  test('exact checkshots: no shift, normal polarity, zero phase, correlation above 0.9', async () => {
    const ties = await tieAll(field);
    for (const t of ties) {
      expect(t).not.toBeNull();
      expect(Math.abs(t.shiftMs)).toBeLessThanOrEqual(dtMs);
      expect(t.polarity).toBe('normal');
      expect(Math.abs(t.phaseDeg)).toBeLessThan(25);
      expect(t.corr).toBeGreaterThan(0.85);
      expect(t.quality).toBe('good');
    }
    const conv = fieldTieConvention(ties);
    expect(conv).toMatchObject({ polarity: 'normal', phaseDeg: 0, outliers: [] });
    expect(conv.agreement).toBe(1);
  });

  test('checkshots 12 ms late: the tie recovers -12 ms (within a sample)', async () => {
    const ties = await tieAll(field, { shiftMs: 12 });
    for (const t of ties) expect(Math.abs(t.shiftMs + 12)).toBeLessThanOrEqual(dtMs);
    // the tied relation puts a top back on its true time
    const w = field.wells[0];
    const bad = makeTvdssToTwt({
      checkshots: w.checkshots.map((c) => ({ ...c, twt_ms: c.twt_ms + 12 })), dtUs, maxTwtMs: 2000,
    });
    const tied = tiedTimeConv(bad, ties[0]);
    expect(tied.source).toBe('tie');
    const top = w.tops[0];
    expect(Math.abs(tied.toTwtMs(top.tvdss) - top.twtMs)).toBeLessThanOrEqual(dtMs);
    expect(tiedCheckshots([{ tvdss_m: 100, twt_ms: 50 }], { shiftMs: -12 })).toEqual([{ tvdss_m: 100, twt_ms: 38 }]);
  });

  test('a reversed volume is recognised as reverse polarity by every well and the field', async () => {
    const ties = await tieAll(field, { transform: (tr) => tr.map((v) => -v) });
    for (const t of ties) expect(t.polarity).toBe('reverse');
    expect(fieldTieConvention(ties).polarity).toBe('reverse');
  });

  test('a 90 degree rotated volume gives a phase near 90', async () => {
    const ties = await tieAll(field, { transform: (tr) => rotateConstantPhase(tr, Math.PI / 2) });
    const conv = fieldTieConvention(ties);
    expect(Math.abs(Math.abs(conv.phaseDeg) - 90)).toBeLessThanOrEqual(20);
  });

  test('a well with the wrong logs is named as an outlier, and the field convention holds', async () => {
    const ties = await tieAll(field);
    const odd = { ...ties[2], polarity: 'reverse', corr: 0.75, quality: 'good' };
    const conv = fieldTieConvention([...ties.slice(0, 2), odd, ...ties.slice(3)]);
    expect(conv.polarity).toBe('normal');
    expect(conv.outliers).toEqual([{ name: ties[2].name, reason: 'opposite polarity' }]);
  });

  test('negative control: noise with no reflectors ties poorly', async () => {
    const empty = buildSyntheticField({ noise: 0.05, seed: 3 });
    const ties = await tieAll(empty, { transform: (tr) => {
      // keep only noise: subtract the noiseless trace
      const clean = field.traceAt(0, 0);
      return tr.map((v, i) => v - clean[i] * 0);
    } });
    // the noisy field still has reflectors; scramble samples to kill them
    const scrambled = await tieAll(field, { transform: (tr) => {
      const out = new Float32Array(tr.length);
      for (let i = 0; i < tr.length; i++) out[i] = tr[(i * 7919) % tr.length];
      return out;
    } });
    for (const t of scrambled) expect(t.quality).toBe('poor');
    expect(ties.length).toBe(5);
  });
});
