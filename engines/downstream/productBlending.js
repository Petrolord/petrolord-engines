/**
 * Product blending optimisation (Midstream & Downstream DS2).
 *
 * Least-cost recipe for a finished fuel: pick volumes of the available
 * components so the blend meets every specification at the lowest cost. This
 * is the first consumer of the LP kernel built at DS0.
 *
 * WHY AN LP AND NOT A SEARCH
 *
 * A blender with eight components and six specifications has a continuous
 * decision, not a menu. The optimum sits on a vertex where some set of
 * specifications binds exactly, and simplex finds that vertex and tells you
 * WHICH ones bind and what each is costing you. That last part is the whole
 * value: the shadow price of a specification is the money that would be saved
 * by one unit of relief on it, which is the argument a refiner takes to the
 * regulator or to the crude buyer.
 *
 * THE BLENDING RULES ARE THE MODEL
 *
 * Every specification here declares HOW its property blends, because that is
 * the modelling decision and it must be visible rather than buried:
 *
 *   volume  - the property is per unit volume and mixes linearly on volume
 *   mass    - the property is per unit mass (sulfur, and anything in wt% or
 *             ppm by mass); linear in volumes once weighted by density
 *   index   - the property does not mix linearly at all and is linearised
 *             through a stated index (RVP, viscosity), blended, and inverted
 *
 * All three are linear in the decision variables, which is what keeps the
 * problem an LP.
 *
 * WHAT THIS REFUSES TO GUESS
 *
 * Octane does not truly blend linearly: a component's effective octane
 * depends on the pool it sits in, which is why refiners carry measured
 * BLENDING octane numbers rather than neat ones. Published index methods
 * (Ethyl, Chevron) are coefficient tables, and this package does not
 * reproduce published tables from memory. So a component may carry a
 * blending octane number, which is used as given; where only the neat octane
 * is known it is blended linearly and the result is LABELLED as the linear
 * approximation it is. The same applies to cetane.
 *
 * The ASTM D4737 cetane index, which computes cetane from density and
 * distillation, is not implemented for the same reason: its coefficients are
 * published and this package will not reproduce them from memory.
 */

import { solveLP, LP_STATUS } from '../../lib/lp/simplex.js';
import { sgFromApi, viscosityBlendIndex, viscosityFromBlendIndex } from './crudeAssay.js';

/**
 * Numeric coercion that treats ABSENCE as absent.
 *
 * Number(null) is 0 and Number('') is 0, so the obvious implementation turns
 * a missing value into a real zero. That is the exact failure this module
 * family exists to avoid: a sulfur content nobody supplied is not zero
 * sulfur, an emission factor nobody supplied is not zero carbon, and a dip
 * nobody read is not an empty tank. Missing stays missing.
 */
const num = (v, fallback = NaN) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const BLEND_BASIS = {
  VOLUME: 'volume',
  MASS: 'mass',
  INDEX: 'index',
};

/**
 * Reid vapour pressure blending index.
 *
 *   RVPI = RVP^n, blended on volume, then inverted.
 *
 * RVP mixes non-linearly because the light ends dominate the vapour space:
 * a splash of butane lifts a whole blend far more than its volume suggests.
 * The exponent is the common approximation and is a NAMED, OVERRIDABLE
 * parameter rather than a constant buried in the code, because refiners tune
 * it to their own pools and because a value this influential should be
 * visible.
 */
export const RVP_INDEX_EXPONENT = 1.25;

export const rvpIndex = (rvp, exponent = RVP_INDEX_EXPONENT) => {
  const v = num(rvp);
  if (!(v >= 0)) return null;
  return v ** exponent;
};

export const rvpFromIndex = (index, exponent = RVP_INDEX_EXPONENT) => {
  const i = num(index);
  if (!(i >= 0)) return null;
  return i ** (1 / exponent);
};

/**
 * A specification the blend must meet.
 *
 * @typedef {object} Spec
 * @property {string} id            property key on each component
 * @property {string} name          what to call it
 * @property {string} basis         one of BLEND_BASIS
 * @property {number} [min]         lower limit, if any
 * @property {number} [max]         upper limit, if any
 * @property {string} [unit]
 * @property {(v:number)=>number} [toIndex]   required for basis 'index'
 * @property {(i:number)=>number} [fromIndex] required for basis 'index'
 * @property {string} [note]        how the property is being treated
 */

/** The property value a component contributes, on the spec's own basis. */
const contributionValue = (component, spec) => {
  const raw = num(component[spec.id]);
  if (!Number.isFinite(raw)) return null;
  if (spec.basis === BLEND_BASIS.INDEX) {
    const idx = spec.toIndex ? spec.toIndex(raw) : null;
    return Number.isFinite(idx) ? idx : null;
  }
  return raw;
};

/** Density weight for a mass-basis property; 1 for the others. */
const basisWeight = (component, spec) => {
  if (spec.basis !== BLEND_BASIS.MASS) return 1;
  const sg = Number.isFinite(num(component.sg)) ? num(component.sg) : sgFromApi(num(component.api));
  return Number.isFinite(sg) ? sg : 1;
};

/**
 * Recompute a property from a finished recipe, by the spec's own rule.
 *
 * Deliberately separate from the LP: the constraint rows are one expression
 * of the blending rule and this is another, so agreement between them is a
 * check rather than a tautology. The tests assert they agree.
 */
export const propertyOfBlend = ({ components, volumes, spec }) => {
  const total = volumes.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;

  if (spec.basis === BLEND_BASIS.MASS) {
    let mass = 0;
    let weighted = 0;
    components.forEach((c, i) => {
      const w = basisWeight(c, spec) * volumes[i];
      const value = num(c[spec.id]);
      if (!Number.isFinite(value)) return;
      mass += w;
      weighted += w * value;
    });
    return mass > 0 ? weighted / mass : null;
  }

  if (spec.basis === BLEND_BASIS.INDEX) {
    let weighted = 0;
    let covered = 0;
    components.forEach((c, i) => {
      const idx = contributionValue(c, spec);
      if (idx === null) return;
      // Viscosity's index is blended on mass, RVP's on volume. The spec says
      // which through indexOnMass, because getting this wrong is a real error
      // and not a detail.
      const w = (spec.indexOnMass ? basisWeight(c, { basis: BLEND_BASIS.MASS }) : 1) * volumes[i];
      weighted += w * idx;
      covered += w;
    });
    if (!(covered > 0)) return null;
    const blendedIndex = weighted / covered;
    return spec.fromIndex ? spec.fromIndex(blendedIndex) : blendedIndex;
  }

  let weighted = 0;
  let covered = 0;
  components.forEach((c, i) => {
    const value = num(c[spec.id]);
    if (!Number.isFinite(value)) return;
    weighted += volumes[i] * value;
    covered += volumes[i];
  });
  return covered > 0 ? weighted / covered : null;
};

/**
 * Solve the least-cost recipe.
 *
 * @param {object} p
 * @param {object[]} p.components  each with cost, api or sg, availability and
 *                                 the properties the specs name
 * @param {Spec[]} p.specs
 * @param {number} p.targetVolume
 * @returns {object}
 */
export const optimiseBlend = ({ components, specs, targetVolume }) => {
  if (!Array.isArray(components) || components.length === 0) {
    return { status: 'invalid', error: 'No components to blend.' };
  }
  const target = num(targetVolume);
  if (!(target > 0)) {
    return { status: 'invalid', error: 'The target volume must be greater than zero.' };
  }

  const n = components.length;
  const cost = components.map((c) => num(c.cost, 0));
  const lo = components.map((c) => Math.max(0, num(c.minVolume, 0)));
  const hi = components.map((c) => {
    const cap = num(c.maxVolume, Infinity);
    return cap > 0 ? cap : Infinity;
  });

  const A = [];
  const b = [];
  const ops = [];

  // The recipe must make the volume asked for. Everything else is quality.
  A.push(new Array(n).fill(1));
  b.push(target);
  ops.push('=');

  // Which spec produced which row, so the shadow prices can be handed back
  // named rather than as an anonymous vector.
  const rowMeta = [{ kind: 'volume', name: 'Total volume' }];
  const skipped = [];

  (specs || []).forEach((spec) => {
    const values = components.map((c) => contributionValue(c, spec));
    if (values.some((v) => v === null)) {
      // A specification cannot be imposed on components that do not carry the
      // property. Dropping it silently would return a recipe that appears to
      // meet a spec nobody checked.
      skipped.push({
        id: spec.id,
        name: spec.name,
        reason: 'Not every component carries this property, so the specification was not applied.',
      });
      return;
    }
    const weights = components.map((c, i) => basisWeight(c, spec)
      * (spec.basis === BLEND_BASIS.INDEX && spec.indexOnMass
        ? basisWeight(c, { basis: BLEND_BASIS.MASS })
        : 1)
      * values[i]);
    const denominators = components.map((c) => basisWeight(c, spec)
      * (spec.basis === BLEND_BASIS.INDEX && spec.indexOnMass
        ? basisWeight(c, { basis: BLEND_BASIS.MASS })
        : 1));

    // sum(w_i v_i) / sum(d_i v_i) <= limit  becomes  sum((w_i - limit d_i) v_i) <= 0,
    // which is linear. The same rearrangement gives the lower limit.
    if (spec.max !== undefined && spec.max !== null) {
      const limit = spec.basis === BLEND_BASIS.INDEX && spec.toIndex
        ? spec.toIndex(num(spec.max))
        : num(spec.max);
      A.push(weights.map((w, i) => w - limit * denominators[i]));
      b.push(0);
      ops.push('<=');
      rowMeta.push({ kind: 'spec', specId: spec.id, name: `${spec.name} maximum`, bound: 'max', limit: spec.max });
    }
    if (spec.min !== undefined && spec.min !== null) {
      const limit = spec.basis === BLEND_BASIS.INDEX && spec.toIndex
        ? spec.toIndex(num(spec.min))
        : num(spec.min);
      A.push(weights.map((w, i) => w - limit * denominators[i]));
      b.push(0);
      ops.push('>=');
      rowMeta.push({ kind: 'spec', specId: spec.id, name: `${spec.name} minimum`, bound: 'min', limit: spec.min });
    }
  });

  const lp = solveLP({ c: cost, A, b, ops, lo, hi });

  if (lp.status === LP_STATUS.INFEASIBLE) {
    return {
      status: 'infeasible',
      skippedSpecs: skipped,
      // An infeasible blend is a real answer, and the useful one: the
      // specifications cannot be met by the components available.
      error: 'No recipe from these components can meet every specification. Relax a limit, or bring in a component that can.',
    };
  }
  if (lp.status === LP_STATUS.UNBOUNDED) {
    return { status: 'unbounded', skippedSpecs: skipped, error: 'The problem is unbounded, which means a component has no upper limit and no cost.' };
  }
  if (lp.status !== LP_STATUS.OPTIMAL) {
    return { status: lp.status, skippedSpecs: skipped, error: 'The solver did not reach an optimum.' };
  }

  const volumes = lp.x;
  const totalVolume = volumes.reduce((s, v) => s + v, 0);

  const recipe = components.map((c, i) => ({
    id: c.id,
    name: c.name,
    volume: volumes[i],
    volumeFraction: totalVolume > 0 ? volumes[i] / totalVolume : 0,
    cost: volumes[i] * cost[i],
  }));

  // Achieved properties, recomputed by each spec's own rule rather than read
  // off the constraint rows.
  const achieved = (specs || []).map((spec) => {
    const value = propertyOfBlend({ components, volumes, spec });
    const skippedHere = skipped.some((s) => s.id === spec.id);
    let giveaway = null;
    let binding = false;
    if (value !== null && !skippedHere) {
      if (spec.max !== undefined && spec.max !== null) {
        giveaway = num(spec.max) - value;   // positive means better than required
        binding = Math.abs(giveaway) < 1e-7;
      }
      if (spec.min !== undefined && spec.min !== null) {
        const over = value - num(spec.min);
        giveaway = giveaway === null ? over : Math.min(giveaway, over);
        binding = binding || Math.abs(over) < 1e-7;
      }
    }
    return {
      id: spec.id,
      name: spec.name,
      unit: spec.unit ?? null,
      basis: spec.basis,
      min: spec.min ?? null,
      max: spec.max ?? null,
      value,
      // How far inside the limit the blend sits. Positive is quality handed
      // over for nothing.
      giveaway,
      binding,
      applied: !skippedHere,
      note: spec.note ?? null,
    };
  });

  // Shadow prices, named. The volume row's price is the marginal cost of one
  // more barrel of product; a spec row's price is what one unit of relief on
  // that specification would be worth.
  const shadowPrices = rowMeta.map((meta, i) => ({
    ...meta,
    price: lp.shadowPrices ? lp.shadowPrices[i] : null,
  }));

  return {
    status: 'optimal',
    recipe,
    totalVolume,
    totalCost: lp.objective,
    unitCost: totalVolume > 0 ? lp.objective / totalVolume : null,
    achieved,
    shadowPrices,
    bindingSpecs: achieved.filter((a) => a.binding).map((a) => a.name),
    skippedSpecs: skipped,
  };
};

/**
 * Value the quality handed over for nothing.
 *
 * Giveaway is the gap between what the blend achieves and what it had to
 * achieve. It is only worth money where a unit of the property has a price:
 * an octane point costs something to make, a ppm of sulfur costs something to
 * remove. So the caller supplies a value per unit and the calculation says
 * what the gap is worth over the volume blended.
 *
 * Where no unit value is supplied the gap is still reported, without a price
 * on it. A giveaway figure invented from a guessed unit value would be worse
 * than none.
 */
export const valueGiveaway = ({ achieved, totalVolume, unitValues = {} }) =>
  (achieved || [])
    .filter((a) => a.applied && a.giveaway !== null && a.giveaway > 1e-9)
    .map((a) => {
      const unitValue = num(unitValues[a.id], NaN);
      return {
        id: a.id,
        name: a.name,
        giveaway: a.giveaway,
        unit: a.unit,
        unitValue: Number.isFinite(unitValue) ? unitValue : null,
        value: Number.isFinite(unitValue) ? a.giveaway * unitValue * num(totalVolume, 0) : null,
      };
    });

/**
 * Specification templates.
 *
 * STARTING POINTS, NOT A COMPLIANCE ORACLE. Fuel specifications are set by
 * regulation and they change; these are here so a user does not start from an
 * empty table, and every one is editable. The app says, and the help guide
 * repeats, that the current regulation governs and these must be checked
 * against it. Nothing here should be cited as the requirement.
 */
export const SPEC_TEMPLATES = {
  gasoline_50ppm: {
    id: 'gasoline_50ppm',
    name: 'Gasoline, 50 ppm sulfur',
    note: 'A regional 50 ppm sulfur gasoline shape. Confirm every limit against the regulation in force.',
    specs: [
      { id: 'ron', name: 'RON', basis: BLEND_BASIS.VOLUME, min: 91, unit: '', note: 'Blended linearly on volume. Supply blending octane numbers where you have them; neat octane blended linearly is an approximation.' },
      { id: 'mon', name: 'MON', basis: BLEND_BASIS.VOLUME, min: 81, unit: '' },
      { id: 'sulfurPpm', name: 'Sulfur', basis: BLEND_BASIS.MASS, max: 50, unit: 'ppm' },
      { id: 'rvp', name: 'RVP', basis: BLEND_BASIS.INDEX, max: 9.0, unit: 'psi', toIndex: (v) => rvpIndex(v), fromIndex: (i) => rvpFromIndex(i), note: 'Blended through the RVP index, because light ends dominate the vapour space.' },
      { id: 'density', name: 'Density', basis: BLEND_BASIS.VOLUME, min: 0.720, max: 0.775, unit: 'kg/l' },
    ],
  },
  gasoline_10ppm: {
    id: 'gasoline_10ppm',
    name: 'Gasoline, 10 ppm sulfur',
    note: 'A tighter 10 ppm sulfur gasoline shape. Confirm every limit against the regulation in force.',
    specs: [
      { id: 'ron', name: 'RON', basis: BLEND_BASIS.VOLUME, min: 95, unit: '' },
      { id: 'mon', name: 'MON', basis: BLEND_BASIS.VOLUME, min: 85, unit: '' },
      { id: 'sulfurPpm', name: 'Sulfur', basis: BLEND_BASIS.MASS, max: 10, unit: 'ppm' },
      { id: 'rvp', name: 'RVP', basis: BLEND_BASIS.INDEX, max: 8.5, unit: 'psi', toIndex: (v) => rvpIndex(v), fromIndex: (i) => rvpFromIndex(i) },
      { id: 'density', name: 'Density', basis: BLEND_BASIS.VOLUME, min: 0.720, max: 0.775, unit: 'kg/l' },
    ],
  },
  diesel_50ppm: {
    id: 'diesel_50ppm',
    name: 'Automotive gasoil, 50 ppm sulfur',
    note: 'A regional 50 ppm sulfur diesel shape. Confirm every limit against the regulation in force.',
    specs: [
      { id: 'cetane', name: 'Cetane number', basis: BLEND_BASIS.VOLUME, min: 48, unit: '', note: 'Blended linearly on volume, which is the usual screening assumption and an approximation.' },
      { id: 'sulfurPpm', name: 'Sulfur', basis: BLEND_BASIS.MASS, max: 50, unit: 'ppm' },
      { id: 'density', name: 'Density', basis: BLEND_BASIS.VOLUME, min: 0.820, max: 0.845, unit: 'kg/l' },
      { id: 'viscosityCSt', name: 'Viscosity at 40 C', basis: BLEND_BASIS.INDEX, min: 2.0, max: 4.5, unit: 'cSt', indexOnMass: true, toIndex: (v) => viscosityBlendIndex(v), fromIndex: (i) => viscosityFromBlendIndex(i), note: 'Blended through the Refutas index on mass, as in the assay studio.' },
      { id: 'flashPointC', name: 'Flash point', basis: BLEND_BASIS.VOLUME, min: 55, unit: 'C', note: 'Treated linearly on volume. Flash point blending indices are published correlations this package does not reproduce, so read this as a screening constraint and confirm the blend by test.' },
    ],
  },
  fuel_oil_380: {
    id: 'fuel_oil_380',
    name: 'Fuel oil, 380 cSt',
    note: 'A residual fuel oil shape. Confirm every limit against the contract.',
    specs: [
      { id: 'viscosityCSt', name: 'Viscosity at 50 C', basis: BLEND_BASIS.INDEX, max: 380, unit: 'cSt', indexOnMass: true, toIndex: (v) => viscosityBlendIndex(v), fromIndex: (i) => viscosityFromBlendIndex(i) },
      { id: 'sulfurPpm', name: 'Sulfur', basis: BLEND_BASIS.MASS, max: 35000, unit: 'ppm' },
      { id: 'density', name: 'Density', basis: BLEND_BASIS.VOLUME, max: 0.991, unit: 'kg/l' },
      { id: 'flashPointC', name: 'Flash point', basis: BLEND_BASIS.VOLUME, min: 60, unit: 'C' },
    ],
  },
};
