// Hole cleaning screening (Drilling D2): cuttings slip velocity, transport
// ratio and annular cuttings concentration.
//
// Model (Moore-style slip with Schiller-Naumann drag):
//   * apparent viscosity at the annular characteristic shear rate
//     γ̇ = (12·v/d_hyd)·((2n'+1)/3n') from the fitted mud model
//   * particle force balance  v_s = sqrt( 4·g·d_p·(ρ_s − ρ_f) / (3·C_D·ρ_f) )
//     with C_D(Re_p): 24/Re (Re ≤ 1, Stokes), 24/Re·(1 + 0.15·Re^0.687)
//     (1 < Re < 1000, Schiller-Naumann), 0.44 (Re ≥ 1000); Re_p =
//     ρ_f·v_s·d_p/μ_a. Solved by deterministic fixed-point iteration.
//   * transport ratio TR = 1 − v_s/v_a per annulus element (can go
//     negative: cuttings fall faster than the mud rises — flagged).
//   * cuttings feed Q_c = ROP·(π/4)·d_bit²; annular cuttings
//     concentration ≈ Q_c / (Q·TR) where TR > 0.
//
// LIMITATION (stated, not hidden): the slip-velocity basis is a
// vertical-well correlation. Elements with inclination above 35° carry a
// warning; mechanistic cuttings-bed models are a later phase.
//
// Units STRICT SI. Validation: oracle_hydraulics.py goldens + Stokes-limit
// closed form in __tests__/drilling.mudops.test.js.

import { attitudeAtMd } from './surveyMath.js';
import { buildFlowElements } from './hydraulics.js';
import { localPowerLaw } from './rheology.js';

const G = 9.80665;

export function dragCoefficient(re) {
  if (!(re > 0)) return Infinity;
  if (re <= 1) return 24 / re;
  if (re < 1000) return (24 / re) * (1 + 0.15 * re ** 0.687);
  return 0.44;
}

// Slip velocity by fixed-point iteration (deterministic, 80 rounds with
// damping — converges for every physical input).
export function slipVelocity({ mudModel, rhoFluidKgM3, rhoSolidKgM3, dParticleM, gammaDot }) {
  if (!(rhoSolidKgM3 > rhoFluidKgM3)) throw new Error('Cuttings must be denser than the mud.');
  if (!(dParticleM > 0)) throw new Error('Particle diameter must be positive.');
  const { tau } = localPowerLaw(mudModel, Math.max(gammaDot, 1e-6));
  const mua = tau / Math.max(gammaDot, 1e-6);
  let vs = (G * dParticleM * dParticleM * (rhoSolidKgM3 - rhoFluidKgM3)) / (18 * mua); // Stokes seed
  for (let i = 0; i < 80; i += 1) {
    const re = (rhoFluidKgM3 * vs * dParticleM) / mua;
    const cd = dragCoefficient(Math.max(re, 1e-12));
    const next = Math.sqrt((4 * G * dParticleM * (rhoSolidKgM3 - rhoFluidKgM3)) / (3 * cd * rhoFluidKgM3));
    vs = 0.5 * vs + 0.5 * next;
  }
  return { slipMs: vs, apparentViscosityPaS: mua };
}

export function computeHoleCleaning({
  stations, string, geometry, mud, flowRateM3s,
  cuttings = {},
}) {
  const {
    ropMs = 0.005, dParticleM = 0.006, rhoSolidKgM3 = 2600, bitDiameterM = null,
  } = cuttings;
  if (!(flowRateM3s > 0)) throw new Error('Flow rate must be positive.');
  if (!mud || !(mud.densityKgM3 > 0) || !mud.model) throw new Error('Mud needs densityKgM3 and a rheology model.');
  const { annulusElements, bitMd } = buildFlowElements({ stations, string, geometry });
  const usable = annulusElements.filter((e) => e.dHoleM > 0);
  if (!usable.length) throw new Error('No annulus elements with hole geometry.');
  const dBit = bitDiameterM
    ?? usable[usable.length - 1].dHoleM; // deepest section's hole size
  const feedM3s = ropMs * (Math.PI / 4) * dBit * dBit;

  const warnings = [];
  let minTr = Infinity;
  let worst = null;
  const rows = usable.map((el) => {
    const area = (Math.PI / 4) * (el.dHoleM * el.dHoleM - el.dPipeOdM * el.dPipeOdM);
    const va = flowRateM3s / area;
    const dHyd = el.dHoleM - el.dPipeOdM;
    let gd = (12 * va) / dHyd;
    for (let i = 0; i < 4; i += 1) {
      const { nPrime } = localPowerLaw(mud.model, gd);
      gd = ((12 * va) / dHyd) * ((2 * nPrime + 1) / (3 * nPrime));
    }
    const { slipMs, apparentViscosityPaS } = slipVelocity({
      mudModel: mud.model, rhoFluidKgM3: mud.densityKgM3, rhoSolidKgM3, dParticleM, gammaDot: gd,
    });
    const tr = 1 - slipMs / va;
    const att = attitudeAtMd(stations, Math.min((el.fromMd + el.toMd) / 2, stations[stations.length - 1].md));
    const inc = att ? att.inc : 0;
    const concPct = tr > 0 ? (100 * feedM3s) / (flowRateM3s * tr) : null;
    if (tr < minTr) { minTr = tr; worst = el; }
    return {
      fromMd: el.fromMd, toMd: el.toMd, incDeg: inc,
      annularVelocityMs: va, slipMs, apparentViscosityPaS,
      transportRatio: tr, cuttingsConcPct: concPct,
    };
  });

  if (rows.some((r) => r.incDeg > 35)) {
    warnings.push('Sections above 35 deg inclination: the vertical-well slip correlation understates bed formation; treat transport ratios as optimistic.');
  }
  if (minTr < 0.5) warnings.push('Transport ratio below 0.5 in at least one section; raise flow rate or mud lifting capacity.');
  const maxConc = rows.reduce((m, r) => (r.cuttingsConcPct != null && r.cuttingsConcPct > m ? r.cuttingsConcPct : m), 0);
  if (maxConc > 5) warnings.push('Annular cuttings concentration exceeds 5 percent.');

  return {
    engine: 'holeCleaning-1.0.0',
    bitMd,
    rows,
    summary: {
      minTransportRatio: minTr,
      worstFromMd: worst?.fromMd ?? null,
      worstToMd: worst?.toMd ?? null,
      maxCuttingsConcPct: maxConc,
      feedM3s,
      warnings,
    },
  };
}

// Minimum flow rate for min transport ratio >= target, by bisection.
export function minFlowRate({
  stations, string, geometry, mud, cuttings = {}, targetTr = 0.5, qMaxM3s = 0.2,
}) {
  const trAt = (q) => computeHoleCleaning({
    stations, string, geometry, mud, flowRateM3s: q, cuttings,
  }).summary.minTransportRatio;
  if (trAt(qMaxM3s) < targetTr) return null; // not achievable in range
  let lo = 1e-4;
  let hi = qMaxM3s;
  if (trAt(lo) >= targetTr) return lo;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (trAt(mid) >= targetTr) hi = mid; else lo = mid;
  }
  return hi;
}
