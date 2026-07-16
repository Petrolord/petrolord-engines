/**
 * Package smoke suite: every engine module must import cleanly from
 * its package-relative paths (the main breakage mode after
 * extraction), and per-domain anchors must match the committed
 * goldens. The FULL acceptance suites run in the Suite's CI against
 * the vendored copy; this suite guards this repo standalone.
 */

import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');

const jsFilesUnder = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
};

describe('every module imports cleanly', () => {
  const files = [
    ...jsFilesUnder(path.join(root, 'engines')),
    ...jsFilesUnder(path.join(root, 'lib')),
  ];
  test.each(files.map((f) => [path.relative(root, f), f]))('%s', async (_rel, file) => {
    const mod = await import(file);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

describe('golden anchors', () => {
  const goldens = (domain) => JSON.parse(
    fs.readFileSync(path.join(root, 'test-data', domain, 'goldens.json'), 'utf8'),
  );
  const close = (a, b, tol = 1e-12) =>
    Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

  test('porepressure: eaton, gardner and bowers rows reproduce', async () => {
    const { eaton } = await import('../engines/porepressure/eaton.js');
    const { gardnerRho } = await import('../engines/porepressure/gardner.js');
    const { bowersVLoading } = await import('../engines/porepressure/bowers.js');
    const G = goldens('porepressure');
    for (const c of G.eaton) {
      expect(close(eaton(c.S_pa, c.Ph_pa, c.ratio, c.n), c.pp_pa)).toBe(true);
    }
    for (const c of G.gardner) {
      expect(close(gardnerRho(c.v_ms), c.rho_kg_m3)).toBe(true);
    }
    for (const c of G.bowers_loading) {
      expect(close(bowersVLoading(c.sigma_pa, c.A, c.B), c.v_ms)).toBe(true);
    }
  });

  test('waveform: ricker peaks at 1 at t=0', async () => {
    const { rickerWavelet } = await import('../lib/waveform.js');
    const w = rickerWavelet(25, 1, 60);
    expect(close(Math.max(...w), 1, 1e-9)).toBe(true);
  });

  test('basin: Easy%Ro weights and the reference-basin anchors hold', async () => {
    const { EasyRoWeights } = await import('../engines/basin/KerogenLibrary.js');
    const G = goldens('basin');
    const wsum = EasyRoWeights.reduce((s, w) => s + w, 0);
    expect(close(wsum, 0.85, 1e-9)).toBe(true);
    // Erosion signature (oracle anchor A10): the reference run's final
    // source-rock Ro exceeds the committed no-erosion control; charge
    // (A11): expelled stays below generated, both positive at the end.
    const rb = G.reference_basin;
    const src = rb.series.source_shale;
    const last = src.ro.length - 1;
    expect(src.ro[last]).toBeGreaterThan(rb.final_source_ro_no_erosion);
    expect(src.generated_kg_m2[last]).toBeGreaterThan(0);
    expect(src.expelled_kg_m2[last]).toBeGreaterThan(0);
    expect(src.expelled_kg_m2[last]).toBeLessThan(src.generated_kg_m2[last]);
  });

  test('goldens exist for every extracted domain', () => {
    for (const d of ['wells', 'petrophysics', 'rockphysics', 'earthmodel', 'porepressure', 'basin']) {
      const dir = path.join(root, 'test-data', d);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    }
  });
});
