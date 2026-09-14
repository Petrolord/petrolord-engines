/**
 * Product blending optimisation (DS2).
 *
 * The recipe this returns is a purchase decision, so the tests are mostly
 * identities: the blend really meets the specs it claims to, the achieved
 * properties recomputed independently agree with the constraint rows the LP
 * solved, and the cheapest feasible recipe is actually the cheapest.
 */
import {
  BLEND_BASIS, RVP_INDEX_EXPONENT,
  rvpIndex, rvpFromIndex,
  propertyOfBlend, optimiseBlend, valueGiveaway, SPEC_TEMPLATES,
} from '../engines/downstream/productBlending.js';

// A small, hand-checkable pool: a cheap low-octane stream, an expensive
// high-octane one, and butane which is cheap, boosts octane and wrecks RVP.
const POOL = [
  {
    id: 'reformate', name: 'Reformate', cost: 92, api: 45, sg: 0.80,
    ron: 100, mon: 89, sulfurPpm: 2, rvp: 3.0, density: 0.800, maxVolume: 1000,
  },
  {
    id: 'fcc', name: 'FCC gasoline', cost: 84, api: 55, sg: 0.75,
    ron: 92, mon: 80, sulfurPpm: 120, rvp: 6.0, density: 0.750, maxVolume: 1000,
  },
  {
    id: 'butane', name: 'Butane', cost: 55, api: 110, sg: 0.58,
    ron: 94, mon: 89, sulfurPpm: 1, rvp: 52, density: 0.580, maxVolume: 100,
  },
];

const SPECS = [
  { id: 'ron', name: 'RON', basis: BLEND_BASIS.VOLUME, min: 93 },
  { id: 'sulfurPpm', name: 'Sulfur', basis: BLEND_BASIS.MASS, max: 50, unit: 'ppm' },
  {
    id: 'rvp', name: 'RVP', basis: BLEND_BASIS.INDEX, max: 9.0, unit: 'psi',
    toIndex: (v) => rvpIndex(v), fromIndex: (i) => rvpFromIndex(i),
  },
];

describe('the RVP index', () => {
  it('round-trips', () => {
    [1, 6, 9, 52].forEach((v) => {
      expect(rvpFromIndex(rvpIndex(v))).toBeCloseTo(v, 8);
    });
  });

  it('makes a splash of butane count for far more than its volume', () => {
    // 5 percent butane at 52 psi into a 6 psi base. Linear would say 8.3.
    // Through the index it lands materially higher, which is why the index
    // exists: light ends dominate the vapour space.
    const linear = 0.95 * 6 + 0.05 * 52;
    const viaIndex = rvpFromIndex(0.95 * rvpIndex(6) + 0.05 * rvpIndex(52));
    expect(viaIndex).toBeGreaterThan(linear);
  });

  it('takes the exponent as a parameter rather than burying it', () => {
    expect(RVP_INDEX_EXPONENT).toBeCloseTo(1.25, 10);
    // A refiner tuning to their own pool must be able to change it.
    expect(rvpIndex(9, 1.0)).toBeCloseTo(9, 10);
    expect(rvpFromIndex(rvpIndex(9, 1.4), 1.4)).toBeCloseTo(9, 8);
  });
});

describe('propertyOfBlend', () => {
  const volumes = [500, 400, 100];

  it('blends a volume-basis property on volume', () => {
    const ron = propertyOfBlend({ components: POOL, volumes, spec: SPECS[0] });
    expect(ron).toBeCloseTo((500 * 100 + 400 * 92 + 100 * 94) / 1000, 10);
  });

  it('blends a mass-basis property on mass, not volume', () => {
    const sulfur = propertyOfBlend({ components: POOL, volumes, spec: SPECS[1] });
    const mass = 500 * 0.80 + 400 * 0.75 + 100 * 0.58;
    const expected = (500 * 0.80 * 2 + 400 * 0.75 * 120 + 100 * 0.58 * 1) / mass;
    expect(sulfur).toBeCloseTo(expected, 10);

    // And it differs from the volumetric answer, in a direction that follows
    // from the densities: the sulfur-rich component here is the lighter of
    // the two majors, so it carries less mass than its volume suggests and
    // the true blend is BELOW what a volumetric average would report. Half a
    // ppm against a 50 ppm limit is the difference between on-spec and off.
    const volumetric = (500 * 2 + 400 * 120 + 100 * 1) / 1000;
    expect(sulfur).toBeLessThan(volumetric);
    expect(volumetric - sulfur).toBeGreaterThan(0.4);
  });

  it('blends an index-basis property through its index', () => {
    const rvp = propertyOfBlend({ components: POOL, volumes, spec: SPECS[2] });
    const expected = rvpFromIndex(
      (500 * rvpIndex(3) + 400 * rvpIndex(6) + 100 * rvpIndex(52)) / 1000,
    );
    expect(rvp).toBeCloseTo(expected, 8);
  });

  it('returns null for an empty recipe rather than zero', () => {
    expect(propertyOfBlend({ components: POOL, volumes: [0, 0, 0], spec: SPECS[0] })).toBeNull();
  });
});

describe('the optimum', () => {
  const run = (over = {}) => optimiseBlend({
    components: POOL, specs: SPECS, targetVolume: 1000, ...over,
  });

  it('makes exactly the volume asked for', () => {
    const out = run();
    expect(out.status).toBe('optimal');
    expect(out.totalVolume).toBeCloseTo(1000, 6);
  });

  it('meets every specification it applied', () => {
    // The identity that matters: the recipe really is on-spec.
    const out = run();
    out.achieved.filter((a) => a.applied).forEach((a) => {
      if (a.min !== null) expect(a.value).toBeGreaterThanOrEqual(a.min - 1e-6);
      if (a.max !== null) expect(a.value).toBeLessThanOrEqual(a.max + 1e-6);
    });
  });

  it('agrees with itself: the recomputed properties match the constraint rows', () => {
    // The LP's rows are one expression of the blending rules and
    // propertyOfBlend is another. Agreement is a check, not a tautology.
    const out = run();
    const volumes = out.recipe.map((r) => r.volume);
    out.achieved.filter((a) => a.applied).forEach((a) => {
      const spec = SPECS.find((s) => s.id === a.id);
      const recomputed = propertyOfBlend({ components: POOL, volumes, spec });
      expect(recomputed).toBeCloseTo(a.value, 8);
    });
  });

  it('costs exactly what the recipe it returned costs', () => {
    const out = run();
    const cost = out.recipe.reduce((s, r, i) => s + r.volume * POOL[i].cost, 0);
    expect(out.totalCost).toBeCloseTo(cost, 6);
    expect(out.unitCost).toBeCloseTo(cost / 1000, 8);
  });

  it('is cheaper than any feasible recipe a person would guess', () => {
    // A blender's instinct is to meet octane with reformate. Check the
    // optimum beats a hand-built feasible alternative.
    const out = run();
    const handBuilt = [700, 300, 0]; // 97.6 RON, sulfur fine, RVP fine
    const handRon = propertyOfBlend({ components: POOL, volumes: handBuilt, spec: SPECS[0] });
    expect(handRon).toBeGreaterThan(93);
    const handCost = handBuilt.reduce((s, v, i) => s + v * POOL[i].cost, 0);
    expect(out.totalCost).toBeLessThan(handCost);
  });

  it('uses the cheap octane booster up to where a spec stops it', () => {
    // Butane is the cheapest source of octane and the RVP spec is what
    // limits it. So RVP should bind and butane should be in the recipe.
    const out = run();
    const butane = out.recipe.find((r) => r.id === 'butane');
    expect(butane.volume).toBeGreaterThan(0);
    expect(out.bindingSpecs.length).toBeGreaterThan(0);
  });

  it('respects a component ceiling', () => {
    const capped = optimiseBlend({
      components: POOL.map((c) => (c.id === 'butane' ? { ...c, maxVolume: 10 } : c)),
      specs: SPECS,
      targetVolume: 1000,
    });
    expect(capped.status).toBe('optimal');
    expect(capped.recipe.find((r) => r.id === 'butane').volume).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('respects a component floor', () => {
    const floored = optimiseBlend({
      components: POOL.map((c) => (c.id === 'fcc' ? { ...c, minVolume: 300 } : c)),
      specs: SPECS,
      targetVolume: 1000,
    });
    expect(floored.status).toBe('optimal');
    expect(floored.recipe.find((r) => r.id === 'fcc').volume).toBeGreaterThanOrEqual(300 - 1e-9);
  });

  it('says infeasible when a floor forces the blend off spec', () => {
    // 600 barrels of a 120 ppm stream cannot be brought under 50 ppm by
    // anything else in this pool. The floor is a real constraint and the
    // right answer is that there is no recipe, not a recipe that misses.
    const floored = optimiseBlend({
      components: POOL.map((c) => (c.id === 'fcc' ? { ...c, minVolume: 600 } : c)),
      specs: SPECS,
      targetVolume: 1000,
    });
    expect(floored.status).toBe('infeasible');
  });
});

describe('when there is no recipe', () => {
  it('says infeasible rather than returning a blend that misses the spec', () => {
    // Nothing in the pool reaches 105 RON, so no mixture can.
    const out = optimiseBlend({
      components: POOL,
      specs: [{ id: 'ron', name: 'RON', basis: BLEND_BASIS.VOLUME, min: 105 }],
      targetVolume: 1000,
    });
    expect(out.status).toBe('infeasible');
    expect(out.error).toMatch(/cannot meet every specification|Relax a limit/);
    expect(out.recipe).toBeUndefined();
  });

  it('refuses an empty pool and a zero target', () => {
    expect(optimiseBlend({ components: [], specs: SPECS, targetVolume: 100 }).status).toBe('invalid');
    expect(optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 0 }).status).toBe('invalid');
  });
});

describe('a specification nobody could check', () => {
  it('is reported as skipped rather than quietly dropped', () => {
    // Only one component carries the property. Applying the spec to the
    // others would invent values; dropping it silently would return a recipe
    // that appears to meet a spec nobody checked.
    const out = optimiseBlend({
      components: POOL.map((c, i) => (i === 0 ? { ...c, cetane: 50 } : c)),
      specs: [...SPECS, { id: 'cetane', name: 'Cetane', basis: BLEND_BASIS.VOLUME, min: 48 }],
      targetVolume: 1000,
    });
    expect(out.status).toBe('optimal');
    expect(out.skippedSpecs.map((s) => s.id)).toContain('cetane');
    expect(out.achieved.find((a) => a.id === 'cetane').applied).toBe(false);
  });
});

describe('giveaway', () => {
  it('measures how far inside each limit the blend sits', () => {
    const out = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1000 });
    const sulfur = out.achieved.find((a) => a.id === 'sulfurPpm');
    // The sulfur limit is 50 ppm; whatever the blend achieves, the giveaway
    // is the gap to it.
    expect(sulfur.giveaway).toBeCloseTo(50 - sulfur.value, 8);
  });

  it('reports a binding spec as binding, with no giveaway', () => {
    const out = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1000 });
    const binding = out.achieved.filter((a) => a.binding);
    expect(binding.length).toBeGreaterThan(0);
    binding.forEach((a) => expect(Math.abs(a.giveaway)).toBeLessThan(1e-6));
  });

  it('prices the gap only where a unit value is supplied', () => {
    const out = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1000 });
    const valued = valueGiveaway({
      achieved: out.achieved,
      totalVolume: out.totalVolume,
      unitValues: { ron: 0.6 },
    });
    const ron = valued.find((v) => v.id === 'ron');
    if (ron) {
      expect(ron.value).toBeCloseTo(ron.giveaway * 0.6 * 1000, 6);
    }
    // A gap with no unit value is still reported, without a price on it: a
    // giveaway figure invented from a guessed unit value is worse than none.
    valued.filter((v) => v.unitValue === null).forEach((v) => {
      expect(v.value).toBeNull();
      expect(v.giveaway).toBeGreaterThan(0);
    });
  });
});

describe('shadow prices', () => {
  it('names every row it prices', () => {
    const out = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1000 });
    expect(out.shadowPrices[0].kind).toBe('volume');
    out.shadowPrices.slice(1).forEach((row) => {
      expect(row.kind).toBe('spec');
      expect(row.name).toBeTruthy();
      expect(Number.isFinite(row.price)).toBe(true);
    });
  });

  it('prices the volume row at the marginal cost of a barrel', () => {
    // This is the test that found the kernel's shadow-price bug: with every
    // component bounded and the volume row an equality, the price read as
    // zero. Pinned at the kernel too (lp.simplex.test.js).
    const base = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1000 });
    const more = optimiseBlend({ components: POOL, specs: SPECS, targetVolume: 1001 });
    expect(more.totalCost - base.totalCost).toBeCloseTo(base.shadowPrices[0].price, 4);
  });
});

describe('the templates', () => {
  it('offers a shape for each product family', () => {
    ['gasoline_50ppm', 'gasoline_10ppm', 'diesel_50ppm', 'fuel_oil_380']
      .forEach((k) => expect(SPEC_TEMPLATES[k]).toBeTruthy());
  });

  it('says on every template that the regulation governs, not the template', () => {
    // These must never be read as a compliance oracle: fuel specifications
    // are set by regulation and they change.
    Object.values(SPEC_TEMPLATES).forEach((t) => {
      expect(t.note).toMatch(/Confirm every limit against/);
    });
  });

  it('declares a basis for every specification in every template', () => {
    Object.values(SPEC_TEMPLATES).forEach((t) => {
      t.specs.forEach((s) => {
        expect(Object.values(BLEND_BASIS)).toContain(s.basis);
        if (s.basis === BLEND_BASIS.INDEX) {
          expect(typeof s.toIndex).toBe('function');
          expect(typeof s.fromIndex).toBe('function');
        }
      });
    });
  });

  it('labels the octane and cetane linearity as the approximation it is', () => {
    const ron = SPEC_TEMPLATES.gasoline_50ppm.specs.find((s) => s.id === 'ron');
    expect(ron.note).toMatch(/approximation/);
    const cetane = SPEC_TEMPLATES.diesel_50ppm.specs.find((s) => s.id === 'cetane');
    expect(cetane.note).toMatch(/approximation/);
  });

  it('solves a diesel blend on its own template', () => {
    const dieselPool = [
      { id: 'lgo', name: 'Light gasoil', cost: 96, sg: 0.83, cetane: 52, sulfurPpm: 30, density: 0.830, viscosityCSt: 2.4, flashPointC: 62, maxVolume: 800 },
      { id: 'hgo', name: 'Heavy gasoil', cost: 92, sg: 0.86, cetane: 46, sulfurPpm: 80, density: 0.860, viscosityCSt: 5.5, flashPointC: 90, maxVolume: 800 },
      { id: 'kero', name: 'Kerosene', cost: 101, sg: 0.80, cetane: 45, sulfurPpm: 10, density: 0.800, viscosityCSt: 1.4, flashPointC: 40, maxVolume: 400 },
    ];
    const out = optimiseBlend({
      components: dieselPool,
      specs: SPEC_TEMPLATES.diesel_50ppm.specs,
      targetVolume: 1000,
    });
    expect(out.status).toBe('optimal');
    out.achieved.filter((a) => a.applied).forEach((a) => {
      if (a.min !== null) expect(a.value).toBeGreaterThanOrEqual(a.min - 1e-6);
      if (a.max !== null) expect(a.value).toBeLessThanOrEqual(a.max + 1e-6);
    });
  });
});
