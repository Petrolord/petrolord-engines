// Primary cementing engine (Drilling D4): job volumes, plug-flow placement
// simulation with U-tube/free-fall detection and ECD, API 10D-style
// centralization standoff, and an honest placement-quality checklist.
//
// Model
//   * The cemented CASING is the inner tubular; the outer boundary is the
//     wellbore's hole sections (previous casing + open hole). v1 covers a
//     FULL casing string from surface (liner jobs with a running string are
//     a later phase; hangerMd must be 0).
//   * Placement is PLUG FLOW volume bookkeeping (no intermixing). The flow
//     path is parametrized by a VOLUME COORDINATE: 0 at surface inside the
//     casing, vInside at the shoe, vInside+vAnnulus back at surface. At
//     pumped volume V the fronts sit at a_i = clamp(V − Σ_{j<i} vol_j),
//     partitioning the path into fluid intervals (original mud ahead of
//     the first front). Hydrostatic heads integrate the exact
//     minimum-curvature TVDs; friction sums the D2 loss kernel per
//     constant-fluid sub-interval at the pump rate.
//       pump pressure = max(0, annulusHead + friction − insideHead)
//     A negative raw value flags FREE FALL (the transient free-fall rate
//     is NOT modeled; the deficit is reported).
//   * Open-hole excess inflates open-hole annular capacities for BOTH the
//     volume table and the placement (excess models washout: the physical
//     hole is bigger; the effective bore diameter follows).
//   * Centralization: API 10D convention. Lateral load per centralizer
//     W = buoyed weight per length x spacing x sin(inc); bow-spring
//     deflection via the linear spring k = F_restoring/((1−0.67)·clearance)
//     (restoring force is quoted at 67% standoff); mid-span sag
//     δ = w_perp·L⁴/(384·E·I) (fixed-end uniform beam). The tension x
//     dogleg lateral-load term is deliberately out of v1 (stated).
//
// Units STRICT SI. Validation: independent oracle (oracle_cementing.py)
// with a self-asserting vertical closed-form fixture + exactness gates in
// __tests__/drilling.cementing.test.js.

import { attitudeAtMd } from './surveyMath.js';
import { tvdAt } from './wellControl.js';
import { elementLoss } from './hydraulics.js';
import { stringProperties } from './torqueDrag.js';

const G = 9.80665;
export const API_TARGET_STANDOFF = 0.67;

// ---- geometry: capacity rows ----------------------------------------------

// Annulus capacity rows between the casing OD and the hole sections, from
// surface (md 0) down to the casing shoe, split at section boundaries.
// Open-hole rows are inflated by the excess factor (washout model); the
// effective bore diameter follows the inflated capacity.
export function annulusRows({ holeSections, casing, excessOpenHolePct = 0 }) {
  if (!(casing.odM > 0) || !(casing.idM > 0) || casing.idM >= casing.odM) throw new Error('Invalid casing OD/ID.');
  if (!(casing.shoeMd > 0)) throw new Error('Casing shoe MD must be positive.');
  const rows = [];
  const cuts = new Set([0, casing.shoeMd]);
  for (const s of holeSections || []) {
    if (s.from_md_m < casing.shoeMd) cuts.add(Math.max(0, s.from_md_m));
    if (s.to_md_m < casing.shoeMd) cuts.add(Math.max(0, s.to_md_m));
  }
  const edges = Array.from(cuts).sort((a, b) => a - b);
  for (let i = 0; i < edges.length - 1; i += 1) {
    const fromMd = edges[i];
    const toMd = edges[i + 1];
    if (toMd - fromMd < 1e-9) continue;
    const mid = (fromMd + toMd) / 2;
    const sec = (holeSections || []).find((s) => mid >= s.from_md_m - 1e-9 && mid <= s.to_md_m + 1e-9);
    if (!sec) throw new Error(`Hole geometry does not cover ${fromMd.toFixed(0)}-${toMd.toFixed(0)} m.`);
    const boreId = sec.cased ? sec.casing_id_m : sec.hole_id_m;
    if (!(boreId > casing.odM)) {
      throw new Error(`Casing OD does not fit the ${sec.cased ? 'casing' : 'hole'} at ${fromMd.toFixed(0)}-${toMd.toFixed(0)} m.`);
    }
    let capM2 = (Math.PI / 4) * (boreId * boreId - casing.odM * casing.odM);
    const openHole = !sec.cased;
    if (openHole && excessOpenHolePct > 0) capM2 *= 1 + excessOpenHolePct / 100;
    const boreIdEffM = Math.sqrt((capM2 * 4) / Math.PI + casing.odM * casing.odM);
    rows.push({ fromMd, toMd, capM2, boreIdEffM, openHole });
  }
  return rows;
}

const volBetween = (rows, fromMd, toMd) => rows.reduce((acc, r) => {
  const a = Math.max(fromMd, r.fromMd);
  const b = Math.min(toMd, r.toMd);
  return acc + (b > a ? (b - a) * r.capM2 : 0);
}, 0);

// ---- job volumes -----------------------------------------------------------

export function jobVolumes({
  stations, holeSections, casing, tocMd, excessOpenHolePct = 0,
  spacerVolM3 = 0, slurryYieldM3PerSack = null, leadTailSplitMd = null,
  pumpRateM3s = null,
}) {
  if ((casing.hangerMd ?? 0) !== 0) throw new Error('Liner jobs (hangerMd > 0) are a later phase; v1 cements a full string from surface.');
  const fcMd = casing.floatCollarMd ?? casing.shoeMd;
  if (!(fcMd > 0) || fcMd > casing.shoeMd) throw new Error('Float collar must sit at or above the shoe.');
  const toc = tocMd;
  if (!(toc >= 0)) throw new Error('TOC MD must be >= 0.');
  if (toc > casing.shoeMd) throw new Error('TOC must be above the shoe.');
  const ann = annulusRows({ holeSections, casing, excessOpenHolePct });
  const capInside = (Math.PI / 4) * casing.idM * casing.idM;

  const annularSlurryM3 = volBetween(ann, toc, casing.shoeMd);
  const shoeTrackM3 = capInside * (casing.shoeMd - fcMd);
  const slurryM3 = annularSlurryM3 + shoeTrackM3;
  let leadM3 = 0;
  let tailM3 = slurryM3;
  if (leadTailSplitMd != null) {
    if (leadTailSplitMd < toc || leadTailSplitMd > casing.shoeMd) throw new Error('Lead/tail split must sit between TOC and the shoe.');
    leadM3 = volBetween(ann, toc, leadTailSplitMd);
    tailM3 = slurryM3 - leadM3;
  }
  const displacementM3 = capInside * fcMd;
  const out = {
    annulusRows: ann,
    capInsideM2: capInside,
    annularSlurryM3,
    shoeTrackM3,
    slurryM3,
    leadM3,
    tailM3,
    spacerVolM3,
    displacementM3,
    totalPumpedM3: spacerVolM3 + slurryM3 + displacementM3,
    tvdShoeM: tvdAt(stations, casing.shoeMd),
    tvdTocM: tvdAt(stations, toc),
  };
  if (slurryYieldM3PerSack > 0) out.sacks = slurryM3 / slurryYieldM3PerSack;
  if (pumpRateM3s > 0) out.jobTimeS = out.totalPumpedM3 / pumpRateM3s;
  return out;
}

// ---- placement simulation --------------------------------------------------

// Fluid intervals of the flow path in VOLUME coordinates at pumped volume V.
// fronts a_i = clamp(V − Σ_{j<i} vol_j, 0, vPath), a_0 >= a_1 >= ...
// Occupancy: [a_0, vPath] mud; [a_{i+1}, a_i] pumped fluid i; [0, a_last]
// the last-entered fluid.
export function fluidIntervals({ V, fluids, mudInHole, vPath }) {
  const fronts = [];
  let before = 0;
  for (const f of fluids) {
    fronts.push(Math.min(Math.max(V - before, 0), vPath));
    before += f.volumeM3;
  }
  const intervals = [];
  if (fronts[0] < vPath) intervals.push({ v0: fronts[0], v1: vPath, fluid: mudInHole });
  for (let i = 0; i < fluids.length; i += 1) {
    const hi = fronts[i];
    const lo = i + 1 < fronts.length ? fronts[i + 1] : 0;
    if (hi - lo > 1e-12) intervals.push({ v0: lo, v1: hi, fluid: fluids[i] });
  }
  return intervals;
}

// Map fluid volume-intervals to MD segments for one leg.
//   inside leg:  volume [0, vInside] → md 0..shoeMd (constant capInside)
//   annulus leg: volume [vInside, vInside+vAnnulus] → md shoeMd..0 walking
//                the annulus rows bottom-up.
export function segmentsForLeg({ intervals, leg, capInside, vInside, annDown }) {
  const segs = [];
  if (leg === 'inside') {
    for (const it of intervals) {
      const v0 = Math.max(it.v0, 0);
      const v1 = Math.min(it.v1, vInside);
      if (v1 - v0 > 1e-12) segs.push({ fromMd: v0 / capInside, toMd: v1 / capInside, fluid: it.fluid });
    }
    segs.sort((a, b) => a.fromMd - b.fromMd);
    return segs;
  }
  // annulus: cumulative volume from the shoe upward.
  let acc = vInside;
  for (const r of annDown) { // annDown: shoe → surface order
    const rv = r.capM2 * (r.toMd - r.fromMd);
    const rowV0 = acc;
    const rowV1 = acc + rv;
    for (const it of intervals) {
      const v0 = Math.max(it.v0, rowV0);
      const v1 = Math.min(it.v1, rowV1);
      if (v1 - v0 > 1e-12) {
        // volume v measured from rowV0 corresponds to md = r.toMd − (v−rowV0)/cap
        const mdHi = r.toMd - (v0 - rowV0) / r.capM2; // deeper
        const mdLo = r.toMd - (v1 - rowV0) / r.capM2; // shallower
        segs.push({ fromMd: mdLo, toMd: mdHi, fluid: it.fluid, boreIdEffM: r.boreIdEffM, capM2: r.capM2 });
      }
    }
    acc = rowV1;
  }
  segs.sort((a, b) => a.fromMd - b.fromMd);
  return segs;
}

export function simulatePlacement({
  stations, holeSections, casing, mudInHole, fluids, pumpRateM3s,
  tocMd = null, excessOpenHolePct = 0, steps = 60, fracEmwKgM3 = null,
}) {
  if ((casing.hangerMd ?? 0) !== 0) throw new Error('Liner jobs (hangerMd > 0) are a later phase; v1 cements a full string from surface.');
  if (!Array.isArray(fluids) || !fluids.length) throw new Error('Give the pumped fluid sequence.');
  if (!(pumpRateM3s > 0)) throw new Error('Pump rate must be positive.');
  if (!mudInHole || !(mudInHole.densityKgM3 > 0)) throw new Error('Give the in-hole mud.');
  for (const f of fluids) {
    if (!(f.volumeM3 > 0)) throw new Error(`Fluid '${f.kind}' needs a positive volume.`);
    if (!(f.densityKgM3 > 0)) throw new Error(`Fluid '${f.kind}' needs a density.`);
  }
  const ann = annulusRows({ holeSections, casing, excessOpenHolePct });
  const annDown = [...ann].sort((a, b) => b.toMd - a.toMd);
  const capInside = (Math.PI / 4) * casing.idM * casing.idM;
  const vInside = capInside * casing.shoeMd;
  const vAnnulus = ann.reduce((a, r) => a + r.capM2 * (r.toMd - r.fromMd), 0);
  const vPath = vInside + vAnnulus;
  const vTotal = fluids.reduce((a, f) => a + f.volumeM3, 0);
  const prevShoeMd = (() => {
    const cased = (holeSections || []).filter((s) => s.cased && s.to_md_m <= casing.shoeMd + 1e-9);
    return cased.length ? Math.max(...cased.map((s) => s.to_md_m)) : null;
  })();

  const warnings = [];
  const chain = [mudInHole, ...fluids];
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i].kind === 'displacement') continue;
    if (chain[i].densityKgM3 < chain[i - 1].densityKgM3 - 1e-9) {
      warnings.push(`Density hierarchy: '${chain[i].kind ?? 'fluid'}' (${chain[i].densityKgM3} kg/m3) is lighter than the fluid ahead of it (${chain[i - 1].densityKgM3} kg/m3).`);
    }
  }

  const headOver = (segs) => segs.reduce((acc, s) => acc
    + s.fluid.densityKgM3 * G * (tvdAt(stations, s.toMd) - tvdAt(stations, s.fromMd)), 0);
  const frictionOver = (segs, leg) => segs.reduce((acc, s) => {
    const model = s.fluid.rheology;
    if (!model) return acc;
    if (leg === 'inside') {
      const v = pumpRateM3s / capInside;
      return acc + elementLoss({
        model, rhoKgM3: s.fluid.densityKgM3, vMs: v, dCharM: casing.idM,
        kind: 'pipe', lengthM: s.toMd - s.fromMd,
      }).dpPa;
    }
    const v = pumpRateM3s / s.capM2;
    return acc + elementLoss({
      model, rhoKgM3: s.fluid.densityKgM3, vMs: v, dCharM: s.boreIdEffM - casing.odM,
      kind: 'annulus', lengthM: s.toMd - s.fromMd,
    }).dpPa;
  }, 0);

  const legsAt = (V) => {
    const intervals = fluidIntervals({ V, fluids, mudInHole, vPath });
    return {
      inside: segmentsForLeg({ intervals, leg: 'inside', capInside, vInside, annDown }),
      annulus: segmentsForLeg({ intervals, leg: 'annulus', capInside, vInside, annDown }),
    };
  };

  const series = [];
  let freeFallAny = false;
  let maxEcdShoe = 0;
  const tvdShoe = tvdAt(stations, casing.shoeMd);
  const tvdPrev = prevShoeMd != null ? tvdAt(stations, prevShoeMd) : null;
  for (let k = 0; k <= steps; k += 1) {
    const V = (k / steps) * vTotal;
    const { inside, annulus } = legsAt(V);
    const insideHead = headOver(inside);
    const annHead = headOver(annulus);
    const friction = frictionOver(inside, 'inside') + frictionOver(annulus, 'annulus');
    const raw = annHead + friction - insideHead;
    // 1 Pa deadband: float residue must not flag free fall.
    const freeFall = raw < -1;
    if (freeFall) freeFallAny = true;
    let ecdPrevShoe = null;
    if (prevShoeMd != null && tvdPrev > 0) {
      const above = annulus
        .map((s) => ({ ...s, toMd: Math.min(s.toMd, prevShoeMd) }))
        .filter((s) => s.toMd > s.fromMd);
      ecdPrevShoe = (headOver(above) + frictionOver(above, 'annulus')) / (G * tvdPrev);
      if (ecdPrevShoe > maxEcdShoe) maxEcdShoe = ecdPrevShoe;
    }
    const ecdTd = tvdShoe > 0 ? (annHead + frictionOver(annulus, 'annulus')) / (G * tvdShoe) : null;
    series.push({
      pumpedM3: V,
      pumpPressurePa: Math.max(0, raw),
      uTubePa: raw,
      freeFall,
      ecdPrevShoeKgM3: ecdPrevShoe,
      ecdAtShoeKgM3: ecdTd,
    });
  }

  const { inside: endInside, annulus: endAnn } = legsAt(vTotal);
  const cementTops = endAnn
    .filter((s) => s.fluid.kind === 'lead' || s.fluid.kind === 'tail')
    .map((s) => s.fromMd);
  const achievedTocMd = cementTops.length ? Math.min(...cementTops) : null;
  if (achievedTocMd == null) warnings.push('No cement reached the annulus; check volumes.');
  else if (tocMd != null && Math.abs(achievedTocMd - tocMd) > 30) {
    warnings.push(`Achieved TOC ${achievedTocMd.toFixed(0)} m differs from target ${tocMd.toFixed(0)} m by more than 30 m.`);
  }
  const floatDiffPa = headOver(endAnn) - headOver(endInside);
  if (floatDiffPa < 0) warnings.push('Inside column is heavier than the annulus at the end of the job; floats must hold the reverse U-tube.');
  if (fracEmwKgM3 != null && maxEcdShoe > fracEmwKgM3) {
    warnings.push(`ECD at the previous shoe peaks at ${maxEcdShoe.toFixed(0)} kg/m3, above the fracture EMW ${fracEmwKgM3} kg/m3.`);
  }
  if (freeFallAny) warnings.push('Free fall (U-tube) occurs during the job; the transient rate is not modeled, surface pressure reads zero over those steps.');

  return {
    engine: 'cementing-1.0.0',
    series,
    endPumpPressurePa: series[series.length - 1].pumpPressurePa,
    maxEcdPrevShoeKgM3: maxEcdShoe || null,
    achievedTocMd,
    floatDiffPa,
    freeFall: freeFallAny,
    annulusEnd: endAnn.map((s) => ({
      fromMd: s.fromMd, toMd: s.toMd, kind: s.fluid.kind ?? 'mud', densityKgM3: s.fluid.densityKgM3,
    })),
    warnings,
  };
}

// ---- centralization (API 10D convention) ----------------------------------

export function standoffProfile({
  stations, holeSections, casing, mudDensityKgM3, centralizer, intervalM = 30,
}) {
  const {
    type = 'bow', spacingM, restoringForceN = 8900,
    standoffAtRestoringForce = API_TARGET_STANDOFF, bladeOdM = null,
  } = centralizer || {};
  if (!(spacingM > 0)) throw new Error('Centralizer spacing must be positive.');
  const ann = annulusRows({ holeSections, casing, excessOpenHolePct: 0 });
  const bf = 1 - mudDensityKgM3 / 7850;
  const wAir = casing.weightKgM ?? (Math.PI / 4) * (casing.odM ** 2 - casing.idM ** 2) * 7850;
  const wBuoyN = wAir * G * bf;
  const { eiNm2 } = stringProperties({ odM: casing.odM, idM: casing.idM });
  const rows = [];
  let minStandoff = 1;
  for (const r of ann) {
    for (let top = r.fromMd; top < r.toMd - 1e-9; top += intervalM) {
      const bottom = Math.min(top + intervalM, r.toMd);
      const mid = (top + bottom) / 2;
      const att = attitudeAtMd(stations, Math.min(mid, stations[stations.length - 1].md));
      const inc = att ? att.inc : 0;
      const sinI = Math.sin((inc * Math.PI) / 180);
      const clearance = (r.boreIdEffM - casing.odM) / 2;
      let atCent;
      if (type === 'rigid') {
        const blade = bladeOdM ?? r.boreIdEffM - 0.01;
        atCent = Math.min(1, Math.max(0, (blade - casing.odM) / (r.boreIdEffM - casing.odM)));
      } else {
        const k = restoringForceN / ((1 - standoffAtRestoringForce) * clearance);
        const W = wBuoyN * spacingM * sinI;
        const defl = Math.min(clearance, W / k);
        atCent = (clearance - defl) / clearance;
      }
      const sag = Math.min(clearance, (wBuoyN * sinI * spacingM ** 4) / (384 * eiNm2));
      const atCentDefl = clearance * (1 - atCent);
      const midStandoff = Math.max(0, (clearance - atCentDefl - sag) / clearance);
      const standoff = Math.min(atCent, midStandoff);
      rows.push({
        fromMd: top, toMd: bottom, incDeg: inc, clearanceM: clearance,
        standoffAtCentralizer: atCent, standoffMidSpan: midStandoff, standoff,
      });
      if (standoff < minStandoff) minStandoff = standoff;
    }
  }
  return { engine: 'cementing-1.0.0', rows, minStandoff, spacingM };
}

export function requiredSpacing({
  stations, holeSections, casing, mudDensityKgM3, centralizer,
  targetStandoff = API_TARGET_STANDOFF, minSpacingM = 3, maxSpacingM = 30,
}) {
  const minAt = (s) => standoffProfile({
    stations, holeSections, casing, mudDensityKgM3,
    centralizer: { ...centralizer, spacingM: s },
  }).minStandoff;
  if (minAt(maxSpacingM) >= targetStandoff) return maxSpacingM;
  if (minAt(minSpacingM) < targetStandoff) return null; // not achievable
  let lo = minSpacingM;
  let hi = maxSpacingM;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (minAt(mid) >= targetStandoff) lo = mid; else hi = mid;
  }
  return lo;
}

// ---- quality checklist (honest, not a fake efficiency %) -------------------

export function placementChecklist({
  placement, standoff, mudInHole, fluids, pumpRateM3s, annulusRowsList,
}) {
  const items = [];
  const push = (id, ok, detail) => items.push({ id, ok, detail });
  const chain = [mudInHole, ...fluids.filter((f) => f.kind !== 'displacement')];
  let hierarchyOk = true;
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i].densityKgM3 < chain[i - 1].densityKgM3 - 1e-9) hierarchyOk = false;
  }
  push('density-hierarchy', hierarchyOk, 'Each pumped fluid at least as dense as the fluid ahead of it.');
  push('standoff', standoff ? standoff.minStandoff >= API_TARGET_STANDOFF : false,
    `Minimum standoff ${(100 * (standoff?.minStandoff ?? 0)).toFixed(0)}% vs the API 67% target.`);
  push('no-free-fall', !placement.freeFall, 'No free-fall period during placement.');
  push('float-holds', placement.floatDiffPa >= 0, 'Annulus heavier than the inside at the end of the job (floats hold).');
  if (annulusRowsList && pumpRateM3s > 0) {
    const minV = Math.min(...annulusRowsList.map((r) => pumpRateM3s / r.capM2));
    push('annular-velocity', minV >= 0.3, `Minimum annular velocity ${minV.toFixed(2)} m/s (target >= 0.3 m/s for mud removal).`);
  }
  return { items, passed: items.filter((i) => i.ok).length, total: items.length };
}
