// QI pilot sub-volume (2026-10-14): runVolumeJob with a window computes only
// the traces inside it, writes only the bricks it touches, and inside the
// window equals the full run exactly (each trace is computed over its whole
// length, so a position- and length-dependent compute behaves as in the full
// run). Read back through pilotBrickFetcher, bricks outside are null and are
// never fetched. Negative control: a full run of a different compute differs.
import { runVolumeJob, pilotWindow, pilotBricks } from '../engines/seismolord/volumeJob';
import { pilotBrickFetcher, v4BrickFetcher } from '../engines/seismolord/brickCodecV4';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NIL = 11; const NXL = 9; const NS = 23; const B = 4;
const GRID = [3, 3, 6];
const geom = { nIl: NIL, nXl: NXL, ns: NS, brickSize: B, grid: GRID };
const NULL_F32 = Math.fround(NULL_VALUE);
const val = (il, xl, k) => Math.fround(Math.cos(il * 0.4 + xl * 0.9 + k * 0.2) * (2 + xl));

function parent() {
  const m = new Map();
  for (let i = 0; i < GRID[0]; i++) for (let j = 0; j < GRID[1]; j++) for (let k = 0; k < GRID[2]; k++) m.set(`${i}-${j}-${k}`, new Float32Array(B ** 3).fill(NULL_VALUE));
  for (let il = 0; il < NIL; il++) for (let xl = 0; xl < NXL; xl++) for (let k = 0; k < NS; k++) {
    m.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(k / B)}`)[((il % B) * B + (xl % B)) * B + (k % B)] = val(il, xl, k);
  }
  return m;
}
// a compute that depends on the whole trace and on the position: a running sum plus il*xl
const compute = (bias = 0) => (trace, out, il, xl) => { let s = 0; for (let k = 0; k < trace.length; k++) { s += trace[k]; out[k] = s + il * xl + bias; } };

async function run(window, c = compute()) {
  const P = parent();
  const out = new Map();
  let fetched = 0;
  const res = await runVolumeJob({
    geom, compute: c, window,
    fetchBrick: async (i, j, k) => { fetched += 1; return P.get(`${i}-${j}-${k}`); },
    onBrick: ({ i, j, k, data }) => { out.set(`${i}-${j}-${k}`, data); },
  });
  return { out, res, fetched };
}
const at = (bricks, il, xl, k) => {
  const b = bricks.get(`${Math.floor(il / B)}-${Math.floor(xl / B)}-${Math.floor(k / B)}`);
  return b ? b[((il % B) * B + (xl % B)) * B + (k % B)] : NULL_F32;
};

describe('pilot sub-volume', () => {
  const W = { i0: 3, i1: 6, j0: 2, j1: 5, k0: 5, k1: 13 };
  test('equals the full run inside the window, null outside, only its bricks written', async () => {
    const full = await run(null);
    const pilot = await run(W);
    const bw = pilotBricks(W, B);
    expect(bw).toEqual({ i0: 0, i1: 1, j0: 0, j1: 1, k0: 1, k1: 3 });
    expect(pilot.out.size).toBe(2 * 2 * 3);
    expect(pilot.res.bricksWritten).toBe(12);
    expect(pilot.res.traceCount).toBe(16);
    expect(pilot.fetched).toBe(2 * 2 * 6); // the whole trace of each pilot column, never the rest
    for (let il = 0; il < NIL; il++) for (let xl = 0; xl < NXL; xl++) for (let k = 0; k < NS; k++) {
      const inside = il >= 3 && il <= 6 && xl >= 2 && xl <= 5 && k >= 5 && k <= 13;
      if (inside) expect(at(pilot.out, il, xl, k)).toBe(at(full.out, il, xl, k));
      else expect(at(pilot.out, il, xl, k)).toBe(NULL_F32);
    }
    // negative control: a different compute is caught by the same comparison
    const other = await run(null, compute(1));
    expect(at(pilot.out, 4, 3, 7)).not.toBe(at(other.out, 4, 3, 7));
  });
  test('the window is clamped and an empty one refused', () => {
    expect(pilotWindow({ i0: -5, i1: 99, j0: 1, j1: 2, k0: 0, k1: 1000 }, geom)).toEqual({ i0: 0, i1: 10, j0: 1, j1: 2, k0: 0, k1: 22 });
    expect(() => pilotWindow({ i0: 5, i1: 4 }, geom)).toThrow(/empty/);
  });
  test('reading a pilot volume: bricks outside are null and never fetched', async () => {
    const asked = [];
    const raw = async (p) => { asked.push(p); return new Float32Array(B ** 3).fill(7).buffer; };
    const manifest = { manifest_version: 2, brick: { size: B }, pilot: { bricks: { i0: 0, i1: 1, j0: 0, j1: 1, k0: 1, k1: 3 } } };
    const f = v4BrickFetcher(raw, manifest);
    expect(new Float32Array(await f('u/v/bricks/2-0-1.f32'))[0]).toBe(NULL_F32);
    expect(new Float32Array(await f('u/v/bricks/1-1-0.f32'))[5]).toBe(NULL_F32);
    expect(new Float32Array(await f('u/v/bricks/1-1-2.f32'))[5]).toBe(7);
    expect(asked).toEqual(['u/v/bricks/1-1-2.f32']);
    expect(pilotBrickFetcher(raw, { brick: { size: B } })).toBe(raw);
  });
});
