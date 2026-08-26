// Surge and swab pressures for tripping (Drilling D2). Steady-state
// Burkhardt-style model:
//
//   effective annular velocity from pipe movement:
//     closed-ended (worst case): displaced flow Q = Vp · (π/4)·d_od²
//     open-ended:                Q = Vp · (π/4)·(d_od² − d_id²)
//   per annulus element: v_eff = Q/A_ann + Kc·Vp with the mud-clinging
//   constant Kc = 0.45 (the customary Burkhardt planning value; documented
//   constant, not fitted). Pressure via the SAME annular-loss kernel as
//   circulating hydraulics (local n'/K', laminar/transitional/turbulent).
//   Surge adds to the static head, swab subtracts:
//     EMW(md) = ρ ± ΣΔP(surface→md) / (g·TVD(md))
//
// Units STRICT SI. Validation: oracle_hydraulics.py goldens + monotonicity
// and zero-speed identities in __tests__/drilling.mudops.test.js.

import { computeSurveyTable } from './surveyMath.js';
import { buildFlowElements, elementLoss } from './hydraulics.js';

const G = 9.80665;
export const CLINGING_CONSTANT = 0.45;

function tvdInterp(table, md) {
  if (md <= table[0].md) return table[0].tvd;
  for (let i = 1; i < table.length; i += 1) {
    if (md <= table[i].md) {
      const f = (md - table[i - 1].md) / (table[i].md - table[i - 1].md);
      return table[i - 1].tvd + f * (table[i].tvd - table[i - 1].tvd);
    }
  }
  return table[table.length - 1].tvd;
}

// One trip speed → surge and swab EMW at a reference MD (default: bit).
export function computeSurgeSwab({
  stations, string, geometry, mud, tripSpeedMs, mode = 'closed', referenceMd = null,
}) {
  if (!(tripSpeedMs >= 0)) throw new Error('Trip speed must be >= 0.');
  if (!['closed', 'open'].includes(mode)) throw new Error("mode must be 'closed' or 'open'.");
  if (!mud || !(mud.densityKgM3 > 0) || !mud.model) throw new Error('Mud needs densityKgM3 and a rheology model.');
  const rho = mud.densityKgM3;
  const { annulusElements, bitMd } = buildFlowElements({ stations, string, geometry });
  const refMd = referenceMd ?? bitMd;
  const table = computeSurveyTable(stations, { mdUnit: 'm' });

  let cum = 0;
  const rows = [];
  for (const el of annulusElements.filter((e) => e.dHoleM > 0).sort((a, b) => a.fromMd - b.fromMd)) {
    if (el.fromMd >= refMd) break;
    const area = (Math.PI / 4) * (el.dHoleM * el.dHoleM - el.dPipeOdM * el.dPipeOdM);
    if (!(area > 0)) continue;
    const dispArea = mode === 'closed'
      ? (Math.PI / 4) * el.dPipeOdM * el.dPipeOdM
      : (Math.PI / 4) * (el.dPipeOdM * el.dPipeOdM - (el.comp.idM || 0) * (el.comp.idM || 0));
    const q = tripSpeedMs * dispArea;
    const vEff = q / area + CLINGING_CONSTANT * tripSpeedMs;
    const lengthM = Math.min(el.toMd, refMd) - el.fromMd;
    const loss = elementLoss({
      model: mud.model, rhoKgM3: rho, vMs: vEff,
      dCharM: el.dHoleM - el.dPipeOdM, kind: 'annulus', lengthM,
    });
    cum += loss.dpPa;
    rows.push({ fromMd: el.fromMd, toMd: Math.min(el.toMd, refMd), vEffMs: vEff, dpPa: loss.dpPa, regime: loss.regime });
  }

  const tvd = tvdInterp(table, refMd);
  const dEmw = tvd > 0 ? cum / (G * tvd) : 0;
  return {
    engine: 'surgeSwab-1.0.0',
    mode,
    tripSpeedMs,
    referenceMd: refMd,
    dpPa: cum,
    rows,
    surgeEmwKgM3: rho + dEmw,
    swabEmwKgM3: rho - dEmw,
  };
}

export function sweepTripSpeeds({ stations, string, geometry, mud, speeds, mode = 'closed', referenceMd = null }) {
  return speeds.map((v) => {
    const r = computeSurgeSwab({ stations, string, geometry, mud, tripSpeedMs: v, mode, referenceMd });
    return { tripSpeedMs: v, surgeEmwKgM3: r.surgeEmwKgM3, swabEmwKgM3: r.swabEmwKgM3, dpPa: r.dpPa };
  });
}

// Largest trip speed keeping surge below fracEmw AND swab above poreEmw
// (either limit may be null). Deterministic bisection on [0, vMax].
export function maxTripSpeed({
  stations, string, geometry, mud, mode = 'closed', referenceMd = null,
  fracEmwKgM3 = null, poreEmwKgM3 = null, vMaxMs = 3,
}) {
  const ok = (v) => {
    const r = computeSurgeSwab({ stations, string, geometry, mud, tripSpeedMs: v, mode, referenceMd });
    if (fracEmwKgM3 != null && r.surgeEmwKgM3 > fracEmwKgM3) return false;
    if (poreEmwKgM3 != null && r.swabEmwKgM3 < poreEmwKgM3) return false;
    return true;
  };
  if (fracEmwKgM3 == null && poreEmwKgM3 == null) return vMaxMs;
  if (!ok(0)) return 0;
  if (ok(vMaxMs)) return vMaxMs;
  let lo = 0;
  let hi = vMaxMs;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}
