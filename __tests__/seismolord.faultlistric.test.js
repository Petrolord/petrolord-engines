/**
 * Automatic fault picking on a listric fault (Ekene kit v4: the growth
 * fault is about 78 degrees near its tip and flattens to its sole). The
 * fault is seen only where it breaks a reflector, so it arrives as pieces;
 * the deep pieces move sideways faster than the shallow trend, and the
 * planar bridge (one straight trend through both pieces) refuses them.
 * Following each patch's ridge down (followDown) keeps it one fault.
 *
 * The synthetic below is built here, from the truth curve xl = xf(s):
 * reflectors every 22 samples, the hanging wall (xl > xf) thrown down by a
 * throw that grows with depth. Every stick point is scored against xf.
 */
import { detectFaults } from '../engines/seismolord/faultDetect';

const GEOM = { nIl: 24, nXl: 80, ns: 320 };
const S_TOP = 20;
const S_BASE = 300;
/** The fault's crossline at sample s: steep at the top, flattening down. */
const xf = (s) => 14 + 46 * ((Math.min(Math.max(s, S_TOP), S_BASE) - S_TOP) / (S_BASE - S_TOP)) ** 2.4;
const throwAt = (s) => 5 + 10 * (s / GEOM.ns);
const REFLECTORS = [];
for (let r = 12, k = 0; r < GEOM.ns - 8; r += 22, k++) REFLECTORS.push({ s: r, a: k % 2 ? -0.8 : 1 });

function ricker(t, f = 0.07) { // t in samples, f cycles per sample (about 17 Hz at 4 ms)
  const x = (Math.PI * f * t) ** 2;
  return (1 - 2 * x) * Math.exp(-x);
}

function makeTrace(il, xl) {
  let seed = (il * 7919 + xl * 104729) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const out = new Float32Array(GEOM.ns);
  for (let s = 0; s < GEOM.ns; s++) {
    const hanging = xl > xf(s);
    let v = 0;
    for (const r of REFLECTORS) {
      const at = hanging ? r.s + throwAt(r.s) : r.s;
      v += r.a * ricker(s - at);
    }
    out[s] = v + 0.03 * rnd();
  }
  return out;
}

async function run(params = {}) {
  return detectFaults({
    getTrace: (il, xl) => makeTrace(il, xl), geom: GEOM, dtMs: 4, params: { sensitivity: 'high', ...params },
  });
}

const deepest = (f) => Math.max(...f.sticks.map((st) => st.points[st.points.length - 1].s));
const shallowest = (f) => Math.min(...f.sticks.map((st) => st.points[0].s));
const misses = (f) => f.sticks.flatMap((st) => st.points.map((p) => Math.abs(p.xl - xf(p.s))));

describe('automatic fault picking follows a listric fault to its sole', () => {
  let det;
  let off;
  beforeAll(async () => {
    det = await run();
    off = await run({ followDown: false });
  });

  test('one fault spans the listric curve from near the top to near the sole', () => {
    expect(det.faults.length).toBeGreaterThanOrEqual(1);
    const f = det.faults[0];
    expect(shallowest(f)).toBeLessThan(S_TOP + 40);
    expect(deepest(f)).toBeGreaterThan(S_BASE - 40);
  });

  test('its stick points sit on the curve, steep and flat parts alike', () => {
    const m = misses(det.faults[0]).sort((a, b) => a - b);
    expect(m.filter((d) => d <= 2).length / m.length).toBeGreaterThanOrEqual(0.9);
    // the deep, flat part is really there (it moves > 20 cells below s 200)
    const deep = det.faults[0].sticks.flatMap((st) => st.points).filter((p) => p.s > 250);
    expect(deep.length).toBeGreaterThan(0);
    expect(Math.min(...deep.map((p) => p.xl))).toBeGreaterThan(xf(200) + 10);
  });

  test('negative control: without following, the main fault stops short of the sole', () => {
    expect(deepest(off.faults[0])).toBeLessThan(deepest(det.faults[0]) - 30);
  });
});
