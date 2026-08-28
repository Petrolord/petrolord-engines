/**
 * Sucker-rod string mechanics (Production P6).
 *
 * Everything in this module is closed form. The string is a stepped
 * elastic bar: each taper section has its own area, so it has its own
 * stiffness and its own weight, and the whole-string properties are
 * sums over the sections.
 *
 *   area          A = pi d^2 / 4, from the diameter, never tabled
 *   stiffness     1/kr = sum( L_i / (E A_i) )      [in/lb]
 *   weight        W  = sum( w_i L_i )              [lb, in air]
 *   buoyed weight W_rf = W (1 - SG_fluid / SG_steel)   Archimedes
 *
 * The natural frequency is the one place where a stepped bar needs
 * more than a sum. For a UNIFORM string, fixed at the surface and free
 * at the pump, the fundamental is the quarter-wave
 *
 *   N0 [spm] = 60 a / (4 L)   ->   245,000 / L  for a = 16,333 ft/s
 *
 * For a TAPERED string the industry reads a frequency factor off a
 * table by taper designation. This module does not: the fundamental of
 * a stepped bar is an eigenvalue problem with an exact transfer-matrix
 * statement, and it is solved here directly. The uniform case falls
 * out of the same solver, which is the gate on it.
 *
 * Three defects in the predecessor Artificial Lift Designer lived in
 * this arithmetic, and all three are fixed here:
 *
 *  1. Rod diameter came from `parseFloat("7/8".replace('/', '.'))`,
 *     which is 7.8 inches. Areas were roughly eighty times too large
 *     and the string could not stretch. See `data/rodCatalog.parseRodSize`.
 *  2. The buoyancy factor was `1 - 1.2 * SG / 7.85`. Archimedes has no
 *     1.2 in it; that factor removed about a fifth of the rod weight.
 *  3. Section stretch used the same wrong area, so the elastic
 *     constant that sets plunger stroke was wrong by the same order.
 *
 * Field units: length ft, diameter in, area in2, weight lb,
 * stiffness lb/in, frequency spm.
 */

import {
  ROD_ELASTIC_MODULUS_PSI, STEEL_SG, ROD_ACOUSTIC_VELOCITY_FT_S,
  rodArea, parseRodSize, rodWeightLbPerFt, rodGrade,
} from './data/rodCatalog.js';

const IN_PER_FT = 12;
export const G_FT_S2 = 32.174;

/**
 * Wave speed of a rod section, ft/s, from what the section IS:
 *
 *   a = sqrt( E A g / w )
 *
 * with EA the bare-rod stiffness and w the API weight per foot, which
 * includes the couplings. That distinction is the whole story of the
 * familiar 245,000 constant. Couplings add mass and almost no
 * stiffness, so they slow the wave: bare steel gives about 16,980 ft/s,
 * and dividing by the square root of the 1.087 coupling allowance gives
 * about 16,290 ft/s, which is the value 245,000/L is built on. The
 * constant is therefore derived here rather than asserted, and the
 * gates check it lands on 245,000/L.
 */
export const sectionWaveSpeedFtS = ({ areaIn2, weightLbPerFt }) =>
  Math.sqrt((ROD_ELASTIC_MODULUS_PSI * areaIn2 * G_FT_S2) / weightLbPerFt);

/** Length-weighted wave speed of a whole string, ft/s. */
export const stringWaveSpeedFtS = (string) => {
  const total = string.sections.reduce((a, s) => a + s.lengthFt, 0);
  if (!(total > 0)) return ROD_ACOUSTIC_VELOCITY_FT_S;
  return string.sections.reduce(
    (a, s) => a + sectionWaveSpeedFtS(s) * s.lengthFt, 0,
  ) / total;
};

/**
 * One taper section, resolved from what the user typed.
 *
 * `size` may be a catalog label ('7/8'), a mixed number or a decimal
 * diameter; a size that cannot be read is reported rather than
 * defaulted, because a defaulted rod diameter is a silently wrong
 * string.
 */
export const rodSection = ({ size, lengthFt }) => {
  const dIn = parseRodSize(size);
  const L = Number(lengthFt);
  if (!Number.isFinite(dIn) || !(dIn > 0)) {
    return { ok: false, error: `Rod size "${size}" could not be read as a diameter.` };
  }
  if (!Number.isFinite(L) || !(L > 0)) {
    return { ok: false, error: `Section length for the ${size} rods must be a positive number of feet.` };
  }
  const areaIn2 = rodArea(dIn);
  const { weightLbPerFt, source } = rodWeightLbPerFt(dIn, typeof size === 'string' ? size.trim() : null);
  return {
    ok: true,
    label: String(size).trim(),
    dIn,
    areaIn2,
    lengthFt: L,
    weightLbPerFt,
    weightSource: source,
    weightLb: weightLbPerFt * L,
    // Stretch of this section under one pound of axial load, in/lb.
    stretchPerLb: (L * IN_PER_FT) / (ROD_ELASTIC_MODULUS_PSI * areaIn2),
  };
};

/** Buoyancy factor: Archimedes, and nothing else. */
export const buoyancyFactor = (fluidSg) => 1 - Number(fluidSg) / STEEL_SG;

/**
 * Build the whole string from its sections, top section first.
 *
 * returns {
 *   ok, errors, sections, lengthFt, weightAirLb, weightFluidLb,
 *   buoyancy, krLbPerIn, erInPerLb, grade
 * }
 */
export const buildRodString = ({ sections, fluidSg = 0, gradeId = 'D' }) => {
  const errors = [];
  const resolved = (sections || []).map((s) => rodSection(s));
  resolved.forEach((s) => { if (!s.ok) errors.push(s.error); });
  if (!resolved.length) errors.push('A rod string needs at least one taper section.');
  if (errors.length) {
    return { ok: false, errors, sections: [], lengthFt: 0 };
  }
  // A taper carries the heaviest rods at the top, where the load is
  // greatest. A string that steps UP going down is a real design error
  // and is reported rather than quietly accepted.
  const stepsUp = resolved.some((s, i) => i > 0 && s.dIn > resolved[i - 1].dIn + 1e-9);
  const lengthFt = resolved.reduce((a, s) => a + s.lengthFt, 0);
  const weightAirLb = resolved.reduce((a, s) => a + s.weightLb, 0);
  const erInPerLb = resolved.reduce((a, s) => a + s.stretchPerLb, 0);
  const bf = buoyancyFactor(fluidSg);
  return {
    ok: true,
    errors: [],
    warnings: stepsUp
      ? [{
        code: 'taperStepsUp',
        message: 'A section is larger than the one above it. A taper carries its heaviest rods at the top, where the load is; check the section order.',
      }]
      : [],
    sections: resolved,
    lengthFt,
    weightAirLb,
    weightFluidLb: weightAirLb * bf,
    weightLbPerFt: weightAirLb / lengthFt,
    buoyancy: bf,
    erInPerLb,
    krLbPerIn: 1 / erInPerLb,
    grade: rodGrade(gradeId),
  };
};

/**
 * Static stretch of the string under a load applied at the pump, in.
 * This is the head the plunger loses before it moves at all.
 */
export const rodStretchIn = ({ string, loadLb }) => string.erInPerLb * loadLb;

/**
 * Fundamental natural frequency of the string, in strokes per minute.
 *
 * Uniform string: the quarter-wave, 60 a / (4 L).
 *
 * Tapered string: the smallest omega for which a bar clamped at the
 * surface and free at the pump has a non-trivial solution. Each
 * section propagates the state (displacement, force) by its own
 * transfer matrix
 *
 *   [ u ]      [   cos(kL)         sin(kL)/(EA k) ] [ u ]
 *   [ F ]_bot= [ -EA k sin(kL)     cos(kL)        ] [ F ]_top
 *
 * with k = omega / a. Clamped at the top means u = 0 there, so the
 * state starts as (0, 1) up to scale, and the free pump end requires
 * F = 0 at the bottom. The fundamental is the first root of that
 * function of omega, bracketed from below and closed by bisection.
 *
 * returns { n0Spm, nPrimeSpm, taperFactor, acousticVelocityFtS, uniform }
 */
export const naturalFrequency = ({ string, acousticVelocityFtS }) => {
  const a = Number.isFinite(Number(acousticVelocityFtS))
    ? Number(acousticVelocityFtS)
    : stringWaveSpeedFtS(string);
  const L = string.lengthFt;
  const n0Spm = (60 * a) / (4 * L);
  const uniform = string.sections.length <= 1;
  if (uniform) {
    return {
      n0Spm, nPrimeSpm: n0Spm, taperFactor: 1, acousticVelocityFtS: a, uniform: true,
    };
  }

  // Force at the free end after propagating through every section,
  // as a function of angular frequency. Sections are in order from the
  // surface down, which is the order the wave travels.
  const endForce = (omega) => {
    let u = 0;
    let f = 1;
    for (const s of string.sections) {
      // Each section carries its own wave speed; they differ only by
      // the small variation in the coupling allowance, but using the
      // section's own value keeps the matrix honest for a mixed string.
      const k = omega / sectionWaveSpeedFtS(s);  // rad per ft
      const kl = k * s.lengthFt;
      const ea = ROD_ELASTIC_MODULUS_PSI * s.areaIn2; // lb (per unit strain)
      // EA has to act on a strain measured in the same length unit as
      // the wave number, so the section impedance carries the ft->in
      // conversion once.
      const z = (ea / IN_PER_FT) * k;
      const c = Math.cos(kl);
      const sn = Math.sin(kl);
      const uNext = c * u + (z > 0 ? (sn / z) * f : 0);
      const fNext = -z * sn * u + c * f;
      u = uNext;
      f = fNext;
    }
    return f;
  };

  // The fundamental of any stepped string lies between the quarter-wave
  // of the stiffest uniform equivalent and that of the softest, so a
  // scan from just above zero to a few times n0 always brackets it.
  const omegaOf = (spm) => (2 * Math.PI * spm) / 60;
  const hi = n0Spm * 4;
  const steps = 400;
  let prevSpm = n0Spm * 0.05;
  let prev = endForce(omegaOf(prevSpm));
  for (let i = 1; i <= steps; i += 1) {
    const spm = prevSpm + ((hi - n0Spm * 0.05) * i) / steps;
    const here = endForce(omegaOf(spm));
    if (Number.isFinite(prev) && Number.isFinite(here) && prev * here < 0) {
      let lo = prevSpm;
      let up = spm;
      let fLo = prev;
      for (let j = 0; j < 200; j += 1) {
        const mid = 0.5 * (lo + up);
        const fMid = endForce(omegaOf(mid));
        if (fLo * fMid <= 0) { up = mid; } else { lo = mid; fLo = fMid; }
      }
      const nPrimeSpm = 0.5 * (lo + up);
      return {
        n0Spm,
        nPrimeSpm,
        taperFactor: nPrimeSpm / n0Spm,
        acousticVelocityFtS: a,
        uniform: false,
      };
    }
    prevSpm = spm;
    prev = here;
  }
  // No sign change found: report the uniform value rather than a guess.
  return {
    n0Spm, nPrimeSpm: n0Spm, taperFactor: 1, acousticVelocityFtS: a, uniform: false, unresolved: true,
  };
};

/**
 * A taper designed so every section carries the same peak stress.
 *
 * This is the standard way a taper is picked: the top section is the
 * largest because it carries the whole string plus the fluid load, and
 * each section below sheds the weight of the rods above it. Sizes are
 * chosen from the API list, so the result is a real orderable string
 * rather than a continuous ideal.
 *
 * returns { sections, ok, note }
 */
export const designTaper = ({ lengthFt, sizes, plungerAreaIn2, fluidLoadLb, fluidSg = 0 }) => {
  const list = (sizes || []).map((s) => ({ label: s, dIn: parseRodSize(s) }))
    .filter((s) => Number.isFinite(s.dIn))
    .sort((a, b) => b.dIn - a.dIn);
  if (!list.length) return { ok: false, sections: [], note: 'No usable rod sizes were given.' };
  if (list.length === 1) {
    return { ok: true, sections: [{ size: list[0].label, lengthFt }], note: 'Single-size string.' };
  }
  // Length fractions that equalise peak stress: solved by marching the
  // load down the string. Each section is sized so its top stress
  // matches the top stress of the section above.
  const bf = buoyancyFactor(fluidSg);
  const n = list.length;
  // Start from equal lengths and relax: the load at the top of section
  // i is the fluid load plus the buoyed weight of everything below.
  let lengths = new Array(n).fill(lengthFt / n);
  for (let iter = 0; iter < 200; iter += 1) {
    const weights = list.map((s, i) => {
      const { weightLbPerFt } = rodWeightLbPerFt(s.dIn, s.label);
      return weightLbPerFt * lengths[i] * bf;
    });
    // Top load of each section = fluid load + buoyed weight of all rods below.
    const topLoads = list.map((_, i) =>
      fluidLoadLb + weights.slice(i).reduce((a, w) => a + w, 0));
    const stresses = list.map((s, i) => topLoads[i] / rodArea(s.dIn));
    const target = stresses.reduce((a, v) => a + v, 0) / n;
    // Move length from the over-stressed sections to the under-stressed.
    const next = lengths.map((l, i) => l * (1 + 0.25 * (target - stresses[i]) / target));
    const total = next.reduce((a, v) => a + v, 0);
    lengths = next.map((l) => Math.max((l * lengthFt) / total, lengthFt * 0.02));
    const norm = lengths.reduce((a, v) => a + v, 0);
    lengths = lengths.map((l) => (l * lengthFt) / norm);
  }
  return {
    ok: true,
    sections: list.map((s, i) => ({ size: s.label, lengthFt: lengths[i] })),
    note: 'Lengths chosen so every section carries the same peak stress.',
    plungerAreaIn2,
  };
};
