/**
 * Product blending against an exact oracle (MD1-0).
 *
 * The golden is written by tools/validation/downstream/oracle_productblending.py:
 * the optimum by exact vertex enumeration, the achieved properties from
 * physical inventories of the recipe, and the value of relief on every
 * specification by RE-SOLVING with the limit moved. Every assertion below calls
 * optimiseBlend; none restates it.
 *
 * The shadow-price block is the reason this file exists. Until MD1-0 the
 * engine handed back each spec ROW's dual as "what one unit of relief would
 * save", and at the Suite's default pool that read 0.072 for sulfur against a
 * re-solved 55.01 per ppm, and 0.267 for RVP against 578.91 per psi.
 */
import fs from 'fs';
import path from 'path';
import {
  optimiseBlend, SPEC_TEMPLATES, BLEND_BASIS, RVP_INDEX_EXPONENT, BINDING_TOLERANCE,
} from '../engines/downstream/productBlending.js';
import { viscosityBlendIndex } from '../engines/downstream/crudeAssay.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'downstream', 'goldens', 'productblending_cases.json'),
  'utf8',
));

const rel = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** The engine's own template spec, with the golden's limits laid over it. */
const specsFor = (gc) => gc.specs.map((s) => {
  const base = SPEC_TEMPLATES[gc.template].specs.find((t) => t.id === s.id);
  return { ...base, min: s.min ?? undefined, max: s.max ?? undefined };
});

const run = (gc) => optimiseBlend({
  components: gc.components,
  specs: specsFor(gc),
  targetVolume: gc.targetVolume,
});

describe('the golden, and what it honestly is', () => {
  it('was written by the exact oracle and says the pools are illustrative', () => {
    expect(G.provenance.oracle).toBe('tools/validation/downstream/oracle_productblending.py');
    expect(G.provenance.published).toMatch(/illustrative/);
  });

  it('types the same template limits the engine ships, so the two cannot drift', () => {
    G.cases.filter((c) => !c.specOverride).forEach((gc) => {
      gc.specs.forEach((s) => {
        const t = SPEC_TEMPLATES[gc.template].specs.find((x) => x.id === s.id);
        expect(t.min ?? null).toBe(s.min);
        expect(t.max ?? null).toBe(s.max);
        const rule = t.basis === BLEND_BASIS.INDEX ? (t.indexOnMass ? 'refutas' : 'rvp') : t.basis;
        expect(rule).toBe(s.rule);
      });
    });
  });

  it('can discriminate: it prices a max row, a min row, a binding index and a shifted row', () => {
    const priced = G.cases.flatMap((c) => (c.relief || []).filter((r) => (r.relaxSide ?? 0) > 1e-6));
    expect(priced.some((r) => r.bound === 'max')).toBe(true);
    expect(priced.some((r) => r.bound === 'min')).toBe(true);
    expect(priced.some((r) => r.specId === 'rvp')).toBe(true);
    expect(G.cases.some((c) => c.status === 'optimal' && c.components.some((k) => k.minVolume > 0))).toBe(true);
    expect(G.cases.some((c) => c.status === 'infeasible')).toBe(true);
  });
});

describe('held constants: PINNED against a literal here, not validated', () => {
  it('RVP index exponent', () => {
    expect(RVP_INDEX_EXPONENT).toBe(1.25);
    expect(G.provenance.heldConstants.rvpIndexExponent).toBe(1.25);
  });
  it('Refutas pair, 14.534 and 10.975', () => {
    expect(G.provenance.heldConstants.refutasA).toBe(14.534);
    expect(G.provenance.heldConstants.refutasB).toBe(10.975);
    // at nu = e^e - 0.8 the double log is exactly 1, so VBI = A + B
    expect(viscosityBlendIndex(Math.exp(Math.E) - 0.8)).toBeCloseTo(14.534 + 10.975, 10);
    // at nu = e - 0.8 the double log is exactly 0, so VBI = B
    expect(viscosityBlendIndex(Math.E - 0.8)).toBeCloseTo(10.975, 10);
  });
});

describe.each(G.cases.map((c) => [c.name, c]))('%s', (_n, gc) => {
  const r = run(gc);

  it('reaches the oracle status', () => {
    expect(r.status).toBe(gc.status);
  });
  if (gc.status !== 'optimal') return;

  it('costs exactly the cheapest feasible recipe', () => {
    expect(rel(r.totalCost, gc.totalCost, 1e-9)).toBe(true);
  });

  if (gc.unique) {
    it('returns the unique optimal recipe', () => {
      gc.volumes.forEach((v, i) => expect(Math.abs(r.recipe[i].volume - v)).toBeLessThan(1e-6));
    });
  }

  it('reports every achieved property as the physical inventory gives it', () => {
    Object.entries(gc.achieved).forEach(([id, v]) => {
      const a = r.achieved.find((x) => x.id === id);
      expect(rel(a.value, v, 1e-8)).toBe(true);
    });
  });

  it('prices one unit of relief on each specification as the re-solve does', () => {
    gc.relief.forEach(({ specId, bound, relaxSide, tightenSide }) => {
      const row = r.shadowPrices.find((s) => s.specId === specId && s.bound === bound);
      const sides = [relaxSide, tightenSide].filter((v) => v !== null);
      const lo = Math.min(...sides);
      const hi = Math.max(...sides);
      const slack = 1e-4 * Math.max(1, Math.abs(lo), Math.abs(hi));
      expect(row.price).toBeGreaterThanOrEqual(lo - slack);
      expect(row.price).toBeLessThanOrEqual(hi + slack);
    });
  });

  it('prices the volume row at the marginal cost of a barrel', () => {
    const row = r.shadowPrices.find((s) => s.kind === 'volume');
    const sides = [gc.marginalBarrel.up, gc.marginalBarrel.down].filter((v) => v !== null);
    expect(row.price).toBeGreaterThanOrEqual(Math.min(...sides) - 1e-6);
    expect(row.price).toBeLessThanOrEqual(Math.max(...sides) + 1e-6);
  });

  it('calls a spec binding exactly when relief on it is worth money', () => {
    gc.relief.forEach(({ specId, bound, relaxSide }) => {
      if (!(relaxSide > 1e-6)) return;
      const a = r.achieved.find((x) => x.id === specId);
      expect(a.binding).toBe(true);
      expect(bound === 'max' || bound === 'min').toBe(true);
    });
  });
});

describe('refusals and the inputs that used to fail open', () => {
  const pool = G.cases[0].components;
  const specs = specsFor(G.cases[0]);

  it('a typed maximum of zero is none, not unlimited', () => {
    const r = optimiseBlend({
      components: pool.map((c) => (c.id === 'butane' ? { ...c, maxVolume: 0 } : c)), specs, targetVolume: 1000,
    });
    expect(r.recipe.find((x) => x.id === 'butane').volume).toBe(0);
  });

  it('a blank maximum is unlimited, and says nothing else', () => {
    ['', null, undefined].forEach((blank) => {
      const r = optimiseBlend({
        components: pool.map((c) => (c.id === 'isomerate' ? { ...c, maxVolume: blank } : c)), specs, targetVolume: 1000,
      });
      expect(r.status).toBe('optimal');
    });
  });

  it('refuses a component with no cost rather than treating it as free', () => {
    const r = optimiseBlend({
      components: pool.map((c) => (c.id === 'isomerate' ? { ...c, cost: undefined } : c)), specs, targetVolume: 1000,
    });
    expect(r.status).toBe('invalid');
    expect(r.unpricedComponents).toEqual(['Isomerate']);
  });

  it('refuses a negative availability and a floor above its ceiling', () => {
    expect(optimiseBlend({
      components: pool.map((c) => (c.id === 'fcc' ? { ...c, maxVolume: -5 } : c)), specs, targetVolume: 1000,
    }).status).toBe('invalid');
    expect(optimiseBlend({
      components: pool.map((c) => (c.id === 'fcc' ? { ...c, minVolume: 700 } : c)), specs, targetVolume: 1000,
    }).status).toBe('invalid');
  });

  it('does not blend sulfur on mass for a stream with no density: it skips the spec and says why', () => {
    const r = optimiseBlend({
      components: pool.map(({ sg, density, ...c }) => c), specs, targetVolume: 1000,
    });
    const s = r.skippedSpecs.find((x) => x.id === 'sulfurPpm');
    expect(s.reason).toMatch(/density/);
    expect(r.achieved.find((a) => a.id === 'sulfurPpm').applied).toBe(false);
  });

  it('judges binding relative to the limit, so a 35,000 ppm sulfur limit can bind', () => {
    expect(BINDING_TOLERANCE).toBe(1e-7);
    const fo = G.cases.find((c) => c.template === 'fuel_oil_380');
    const r = run(fo);
    const s = r.achieved.find((a) => a.id === 'viscosityCSt');
    expect(s.binding).toBe(true);
  });
});
