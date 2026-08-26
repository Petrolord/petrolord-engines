// Drilling hydraulics: circulating pressure losses, bit hydraulics and ECD
// (Drilling D2). API RP 13D-style method:
//
//   * flow path: down the drillstring bore, through the bit nozzles, up the
//     annulus. Elements are the intersections of string components (D1
//     bottom-up shape) with hole sections (wp_wellbore_geometry shape).
//   * per element: characteristic wall shear rate with the (3n'+1)/4n'
//     pipe or (2n'+1)/3n' slot-annulus correction, local power-law
//     linearization n'/K' of the fitted Herschel-Bulkley (or chosen) model,
//     generalized Reynolds number Re = ρ·v·d/μe with μe = τw/γ̇w,
//     laminar Fanning f = 16/Re (pipe) or 24/Re (slot annulus),
//     turbulent f = a/Re^b with a = (log10 n' + 3.93)/50 and
//     b = (1.75 − log10 n')/7 (the Bourgoyne/API form), linear blend
//     between Re_c = 3470 − 1370·n' and Re_c + 800.
//     ΔP = 2·f·ρ·v²·L/d (Fanning; d = bore ID in pipe, d_hole − d_od in
//     the annulus).
//   * bit: ΔP = ρ·Q² / (2·Cd²·A_t²), Cd = 0.95; jet velocity, hydraulic
//     power, impact force.
//   * ECD(md) = ρ_mud + ΣΔP_annulus(surface→md) / (g·TVD(md)).
//
// Units STRICT SI: m, m³/s, kg/m³, Pa. Field conversions live in the UI.
// Validation: independent numpy oracle (oracle_hydraulics.py) goldens +
// closed forms (Newtonian limit = Hagen-Poiseuille exactly, power-law
// laminar pipe closed form, bit/ECD algebra) in the jest suites.

import { computeSurveyTable } from './surveyMath.js';
import { localPowerLaw } from './rheology.js';

const G = 9.80665;
export const BIT_CD = 0.95;

// ---- geometry: flow elements ----------------------------------------------

function componentSpans(string, bitMd) {
  // string is bottom-up: string[0] at the bit. Spans in MD from surface.
  const spans = [];
  let distFromBit = 0;
  for (const c of string) {
    const bottom = bitMd - distFromBit;
    const top = Math.max(0, bottom - c.lengthM);
    spans.push({ top, bottom, comp: c });
    distFromBit += c.lengthM;
    if (top <= 0) break;
  }
  return spans.reverse(); // surface → bit
}

// Split [top,bottom) component spans at hole-section boundaries.
export function buildFlowElements({ stations, string, geometry }) {
  if (!Array.isArray(stations) || stations.length < 2) throw new Error('Need at least 2 survey stations.');
  if (!Array.isArray(string) || !string.length) throw new Error('The drillstring is empty.');
  if (!Array.isArray(geometry) || !geometry.length) throw new Error('Need at least one hole section.');
  const tdMax = stations[stations.length - 1].md;
  const totalLen = string.reduce((a, c) => a + c.lengthM, 0);
  const bitMd = Math.min(totalLen, tdMax);

  const spans = componentSpans(string, bitMd);
  const cuts = new Set([0, bitMd]);
  for (const s of spans) { cuts.add(s.top); cuts.add(s.bottom); }
  for (const g of geometry) {
    if (g.fromMd < bitMd) cuts.add(Math.max(0, g.fromMd));
    if (g.toMd < bitMd) cuts.add(Math.max(0, g.toMd));
  }
  const edges = Array.from(cuts).filter((x) => x >= 0 && x <= bitMd).sort((a, b) => a - b);

  const pipeElements = [];
  const annulusElements = [];
  let uncovered = false;
  for (let i = 0; i < edges.length - 1; i += 1) {
    const fromMd = edges[i];
    const toMd = edges[i + 1];
    if (toMd - fromMd < 1e-9) continue;
    const mid = (fromMd + toMd) / 2;
    const span = spans.find((s) => mid >= s.top && mid <= s.bottom);
    if (!span) continue;
    const sec = geometry.find((g) => mid >= g.fromMd - 1e-9 && mid <= g.toMd + 1e-9);
    const holeIdM = sec ? sec.holeIdM : null;
    if (!sec) uncovered = true;
    pipeElements.push({ fromMd, toMd, lengthM: toMd - fromMd, dM: span.comp.idM, comp: span.comp });
    annulusElements.push({
      fromMd, toMd, lengthM: toMd - fromMd,
      dHoleM: holeIdM, dPipeOdM: span.comp.odM, comp: span.comp,
    });
  }
  return { pipeElements, annulusElements, bitMd, uncovered };
}

// ---- pressure-loss kernel --------------------------------------------------

// One element loss. kind 'pipe' | 'annulus'; dCharM = bore ID or (dHole−dOd).
export function elementLoss({ model, rhoKgM3, vMs, dCharM, kind, lengthM }) {
  if (!(dCharM > 0)) throw new Error('Flow element needs a positive characteristic diameter.');
  if (!(vMs >= 0)) throw new Error('Velocity must be >= 0.');
  if (vMs === 0) return { dpPa: 0, regime: 'static', reynolds: 0, nPrime: 1 };
  const base = kind === 'pipe' ? (8 * vMs) / dCharM : (12 * vMs) / dCharM;
  let gd = base;
  let np = 1;
  for (let i = 0; i < 6; i += 1) {
    ({ nPrime: np } = localPowerLaw(model, gd));
    gd = kind === 'pipe'
      ? base * ((3 * np + 1) / (4 * np))
      : base * ((2 * np + 1) / (3 * np));
  }
  const { tau } = localPowerLaw(model, gd);
  // Metzner-Reed generalized viscosity: wall stress over the UNCORRECTED
  // Newtonian rate, so laminar f = 16/Re (pipe) and 24/Re (slot annulus)
  // reproduce the exact Newtonian and power-law laminar solutions
  // (ΔP = 4·τw·L/d in both conventions). Dividing by the corrected rate
  // instead would understate laminar losses by (3n'+1)/4n'.
  const mue = tau / base;
  const re = (rhoKgM3 * vMs * dCharM) / mue;
  const fLamCoef = kind === 'pipe' ? 16 : 24;
  const a = (Math.log10(np) + 3.93) / 50;
  const b = (1.75 - Math.log10(np)) / 7;
  const rec1 = 3470 - 1370 * np;
  const rec2 = rec1 + 800;
  let f;
  let regime;
  if (re <= rec1) {
    f = fLamCoef / re;
    regime = 'laminar';
  } else if (re >= rec2) {
    f = a / re ** b;
    regime = 'turbulent';
  } else {
    const f1 = fLamCoef / rec1;
    const f2 = a / rec2 ** b;
    f = f1 + ((re - rec1) / (rec2 - rec1)) * (f2 - f1);
    regime = 'transitional';
  }
  return { dpPa: (2 * f * rhoKgM3 * vMs * vMs * lengthM) / dCharM, regime, reynolds: re, nPrime: np };
}

export function bitHydraulics({ rhoKgM3, flowRateM3s, nozzleTfaM2, cd = BIT_CD }) {
  if (!(nozzleTfaM2 > 0)) return null;
  const vj = flowRateM3s / nozzleTfaM2;
  const dpPa = (rhoKgM3 * flowRateM3s * flowRateM3s) / (2 * cd * cd * nozzleTfaM2 * nozzleTfaM2);
  return {
    dpPa,
    jetVelocityMs: vj,
    hydraulicPowerW: dpPa * flowRateM3s,
    impactForceN: rhoKgM3 * flowRateM3s * vj,
  };
}

// ---- main -----------------------------------------------------------------

// mud: {densityKgM3, model} where model comes from rheology.fitModels.
export function computeHydraulics({
  stations, string, geometry, mud, flowRateM3s, nozzleTfaM2 = 0, params = {},
}) {
  const { surfaceLossPa = 0 } = params;
  if (!(flowRateM3s > 0)) throw new Error('Flow rate must be positive.');
  if (!mud || !(mud.densityKgM3 > 0) || !mud.model) throw new Error('Mud needs densityKgM3 and a rheology model.');
  const rho = mud.densityKgM3;
  const { pipeElements, annulusElements, bitMd, uncovered } = buildFlowElements({ stations, string, geometry });

  const table = computeSurveyTable(stations, { mdUnit: 'm' });
  const tvdAt = (md) => {
    if (md <= table[0].md) return table[0].tvd;
    for (let i = 1; i < table.length; i += 1) {
      if (md <= table[i].md) {
        const f = (md - table[i - 1].md) / (table[i].md - table[i - 1].md);
        return table[i - 1].tvd + f * (table[i].tvd - table[i - 1].tvd);
      }
    }
    return table[table.length - 1].tvd;
  };

  const warnings = [];
  if (uncovered) warnings.push('Hole geometry does not cover the full string; uncovered annulus spans are skipped.');

  const elements = [];
  let pipeDp = 0;
  for (const el of pipeElements) {
    if (!(el.dM > 0)) { warnings.push(`Component over ${el.fromMd.toFixed(0)}-${el.toMd.toFixed(0)} m has no bore; pipe flow skipped.`); continue; }
    const v = flowRateM3s / ((Math.PI / 4) * el.dM * el.dM);
    const loss = elementLoss({ model: mud.model, rhoKgM3: rho, vMs: v, dCharM: el.dM, kind: 'pipe', lengthM: el.lengthM });
    pipeDp += loss.dpPa;
    elements.push({ path: 'pipe', fromMd: el.fromMd, toMd: el.toMd, lengthM: el.lengthM, velocityMs: v, ...loss });
  }

  let annDp = 0;
  let minAnnV = Infinity;
  const annRows = [];
  for (const el of annulusElements) {
    if (!(el.dHoleM > 0)) continue; // uncovered span, already warned
    const area = (Math.PI / 4) * (el.dHoleM * el.dHoleM - el.dPipeOdM * el.dPipeOdM);
    if (!(area > 0)) { warnings.push(`Pipe OD exceeds hole ID over ${el.fromMd.toFixed(0)}-${el.toMd.toFixed(0)} m.`); continue; }
    const v = flowRateM3s / area;
    const loss = elementLoss({
      model: mud.model, rhoKgM3: rho, vMs: v, dCharM: el.dHoleM - el.dPipeOdM, kind: 'annulus', lengthM: el.lengthM,
    });
    annDp += loss.dpPa;
    if (v < minAnnV) minAnnV = v;
    const row = { path: 'annulus', fromMd: el.fromMd, toMd: el.toMd, lengthM: el.lengthM, velocityMs: v, ...loss };
    elements.push(row);
    annRows.push(row);
  }

  const bit = bitHydraulics({ rhoKgM3: rho, flowRateM3s, nozzleTfaM2 });
  if (!bit) warnings.push('No nozzle TFA given; bit pressure drop excluded.');

  // ECD profile: cumulative annular losses from surface downward.
  annRows.sort((a, b) => a.fromMd - b.fromMd);
  const ecdProfile = [];
  let cum = 0;
  for (const row of annRows) {
    cum += row.dpPa;
    const md = row.toMd;
    const tvd = tvdAt(md);
    ecdProfile.push({
      md, tvd, annularDpPa: cum,
      ecdKgM3: tvd > 0 ? rho + cum / (G * tvd) : rho,
    });
  }
  const ecdAtTd = ecdProfile.length ? ecdProfile[ecdProfile.length - 1].ecdKgM3 : rho;

  const pumpPressurePa = surfaceLossPa + pipeDp + (bit ? bit.dpPa : 0) + annDp;
  return {
    engine: 'hydraulics-1.0.0',
    bitMd,
    elements,
    bit,
    ecdProfile,
    summary: {
      pumpPressurePa,
      pipeDpPa: pipeDp,
      annulusDpPa: annDp,
      bitDpPa: bit ? bit.dpPa : 0,
      ecdAtTdKgM3: ecdAtTd,
      minAnnularVelocityMs: Number.isFinite(minAnnV) ? minAnnV : 0,
      warnings,
    },
  };
}
