// Casing & tubing design engine (Drilling D6): API 5C3-grade tubular
// ratings, canonical load-case pressure/axial profiles, string evaluation,
// and the Lubinski/Hammerlindl tubing-packer force system.
//
// Formulas (published sources named per function):
//   * Burst: API internal yield (Barlow with 12.5% wall tolerance)
//       P = tol · 2·Yp·t / D
//   * Collapse: the API Bulletin/TR 5C3 FOUR-regime system (yield,
//     plastic, transition, elastic) with the published coefficient
//     polynomials A,B,C,F,G in Yp and the D/t regime boundaries; combined
//     loading (collapse under tension) via the axial-adjusted yield
//       Ypa = Yp·[sqrt(1 − 0.75·(σa/Yp)²) − 0.5·σa/Yp]
//     feeding the same formulas.
//   * Triaxial: Lamé hoop/radial at inner and outer wall + axial with
//     optional bending σb = E·(OD/2)·κ, von Mises equivalent, worst-point
//     safety factor.
//   * Tubing-packer (Lubinski 1962 / Hammerlindl 1977 planning forms):
//     piston ΔF1 = (Ap−Ai)·ΔPi − (Ap−Ao)·ΔPo; ballooning
//     ΔF2 = 0.6·(ΔPi·Ai − ΔPo·Ao); thermal ΔF3 = −E·A·α·ΔT with ΔT from
//     a linear temperature profile; buckling thresholds from the D1
//     Dawson-Paslay/Chen limits (bucklingLimits) with the real radial
//     clearance.
//
// UNITS: STRICT SI at the API (Pa, N, m, kg/m³, °C). The 5C3 coefficient
// polynomials are inherently imperial-empirical: Yp converts to psi and
// D/t is dimensionless INSIDE api5c3CollapsePa only, with the constants
// documented — the single sanctioned boundary (the Fann-dial precedent).
//
// Validation: independent numpy oracle (oracle_tubular.py) with
// self-asserted closed forms (Barlow algebra, regime-boundary continuity,
// VME identity, thermal ΔF) + goldens; jest gates in
// __tests__/drilling.tubular.test.js.

import { bucklingLimits, stringProperties, STEEL_E_PA } from './torqueDrag.js';

const G = 9.80665;
const PSI = 6894.757293168;
export const STEEL_ALPHA_PER_C = 12e-6;
export const BALLOONING_FACTOR = 0.6; // 2*nu for nu=0.3, the Lubinski planning form

// ---- ratings ---------------------------------------------------------------

export function barlowBurstPa({ odM, wallM, yieldPa, wallTolerance = 0.875 }) {
  if (!(odM > 0) || !(wallM > 0) || wallM >= odM / 2) throw new Error('Invalid OD/wall.');
  if (!(yieldPa > 0)) throw new Error('Yield must be positive.');
  return (wallTolerance * 2 * yieldPa * wallM) / odM;
}

export function pipeBodyYieldN({ odM, idM, yieldPa }) {
  const { areaM2 } = stringProperties({ odM, idM });
  return yieldPa * areaM2;
}

export function jointStrengthN({ odM, idM, yieldPa, connectionEfficiency = 1 }) {
  return pipeBodyYieldN({ odM, idM, yieldPa }) * connectionEfficiency;
}

// Axial-adjusted yield for combined loading (tension reduces collapse).
export function adjustedYieldPa(yieldPa, axialStressPa) {
  const r = axialStressPa / yieldPa;
  if (r >= 1) return 0;
  const s = 1 - 0.75 * r * r;
  if (s <= 0) return 0;
  return Math.max(0, yieldPa * (Math.sqrt(s) - 0.5 * r));
}

// API 5C3 four-regime collapse. Coefficients per the published Bulletin
// 5C3 polynomials with Yp in psi.
export function api5c3CollapsePa({ odM, wallM, yieldPa, axialStressPa = 0 }) {
  if (!(odM > 0) || !(wallM > 0) || wallM >= odM / 2) throw new Error('Invalid OD/wall.');
  const yp0 = yieldPa;
  const ypEff = axialStressPa > 0 ? adjustedYieldPa(yp0, axialStressPa) : yp0;
  if (!(ypEff > 0)) return { collapsePa: 0, regime: 'yield-exhausted' };
  const Yp = ypEff / PSI; // psi, for the empirical polynomials
  const dt = odM / wallM;

  const A = 2.8762 + 0.10679e-5 * Yp + 0.21301e-10 * Yp * Yp - 0.53132e-16 * Yp ** 3;
  const B = 0.026233 + 0.50609e-6 * Yp;
  const C = -465.93 + 0.030867 * Yp - 0.10483e-7 * Yp * Yp + 0.36989e-13 * Yp ** 3;
  const ba = B / A;
  const x = (3 * ba) / (2 + ba);
  const F = (46.95e6 * x ** 3) / (Yp * (x - ba) * (1 - x) ** 2);
  const Gc = F * ba;

  const dtYp = (Math.sqrt((A - 2) ** 2 + 8 * (B + C / Yp)) + (A - 2)) / (2 * (B + C / Yp));
  const dtPt = (Yp * (A - F)) / (C + Yp * (B - Gc));
  const dtTe = (2 + ba) / (3 * ba);

  let pPsi;
  let regime;
  if (dt <= dtYp) {
    pPsi = 2 * Yp * ((dt - 1) / (dt * dt));
    regime = 'yield';
  } else if (dt <= dtPt) {
    pPsi = Yp * (A / dt - B) - C;
    regime = 'plastic';
  } else if (dt <= dtTe) {
    pPsi = Yp * (F / dt - Gc);
    regime = 'transition';
  } else {
    pPsi = 46.95e6 / (dt * (dt - 1) ** 2);
    regime = 'elastic';
  }
  return { collapsePa: Math.max(0, pPsi) * PSI, regime, boundaries: { dtYp, dtPt, dtTe }, dt };
}

// Lamé + von Mises worst-point triaxial safety factor.
export function triaxialSF({
  odM, idM, yieldPa, piPa, poPa, axialN = 0, bendingDlsDegPer30m = 0,
}) {
  const ro = odM / 2;
  const ri = idM / 2;
  const { areaM2 } = stringProperties({ odM, idM });
  const sigAxial = axialN / areaM2;
  const kappa = (bendingDlsDegPer30m * Math.PI / 180) / 30; // rad/m
  const sigBend = STEEL_E_PA * ro * kappa;
  const denom = ro * ro - ri * ri;
  const evalAt = (r) => {
    const sigT = (piPa * ri * ri - poPa * ro * ro + ((piPa - poPa) * ri * ri * ro * ro) / (r * r)) / denom;
    const sigR = (piPa * ri * ri - poPa * ro * ro - ((piPa - poPa) * ri * ri * ro * ro) / (r * r)) / denom;
    let worst = 0;
    for (const sb of [sigBend, -sigBend]) {
      const sa = sigAxial + sb;
      const vme = Math.sqrt(0.5 * ((sigT - sigR) ** 2 + (sigR - sa) ** 2 + (sa - sigT) ** 2));
      if (vme > worst) worst = vme;
    }
    return worst;
  };
  const vme = Math.max(evalAt(ri), evalAt(ro));
  return { sf: vme > 0 ? yieldPa / vme : Infinity, vmePa: vme };
}

// ---- canonical load-case profiles ------------------------------------------

// All generators return {tvdM[], piPa[], poPa[], faN[]} on a uniform grid
// over [0, shoeTvdM]. Environment in SI. faN is the axial force AT depth
// (positive tension) for the running/static condition of that case.
const grid = (shoeTvdM, n = 50) => Array.from({ length: n + 1 }, (_, i) => (i / n) * shoeTvdM);

function axialProfile({ tvd, shoeTvdM, weightNPerM, buoyancyFactor, overpullN = 0 }) {
  // Buoyed weight hanging below each depth + optional overpull at surface.
  return tvd.map((z) => weightNPerM * buoyancyFactor * (shoeTvdM - z) + overpullN);
}

export function loadCaseProfiles({
  kind, shoeTvdM, env = {}, string = {},
}) {
  const {
    mudKgM3 = 1440, cementKgM3 = 1900, gasGradPaPerM = 2300,
    fracEmwAtShoeKgM3 = null, reservoirPressurePa = null,
    testPressurePa = 35e6, evacuationFraction = 1, seawaterKgM3 = 1030,
    overpullN = 0, packerFluidKgM3 = null,
  } = env;
  const { weightKgM = 70 } = string;
  const tvd = grid(shoeTvdM);
  const weightN = weightKgM * G;
  const bf = 1 - mudKgM3 / 7850;
  const fa = axialProfile({ tvd, shoeTvdM, weightNPerM: weightN, buoyancyFactor: bf, overpullN: kind === 'runningAxial' ? overpullN : 0 });
  const mudP = (z) => mudKgM3 * G * z;
  let pi;
  let po;
  const meta = { kind };
  switch (kind) {
    case 'gasKickBurst': {
      // Internal: gas column from the shoe control pressure to surface.
      const pShoe = reservoirPressurePa
        ?? (fracEmwAtShoeKgM3 != null ? fracEmwAtShoeKgM3 * G * shoeTvdM : 1.2 * mudKgM3 * G * shoeTvdM);
      pi = tvd.map((z) => Math.max(0, pShoe - gasGradPaPerM * (shoeTvdM - z)));
      po = tvd.map((z) => seawaterKgM3 * G * z); // backup: pore/mix water
      meta.pShoePa = pShoe;
      break;
    }
    case 'pressureTestBurst':
      pi = tvd.map((z) => testPressurePa + mudP(z));
      po = tvd.map((z) => seawaterKgM3 * G * z);
      break;
    case 'fullEvacuationCollapse':
      pi = tvd.map(() => 0);
      po = tvd.map((z) => mudP(z));
      break;
    case 'partialEvacuationCollapse': {
      // Evacuated (gas) down to a level, packer/completion fluid below.
      const level = (1 - evacuationFraction) * shoeTvdM;
      const fluid = packerFluidKgM3 ?? mudKgM3;
      pi = tvd.map((z) => (z <= level ? 0 : fluid * G * (z - level)));
      po = tvd.map((z) => mudP(z));
      meta.evacToTvdM = level;
      break;
    }
    case 'cementingCollapse':
      pi = tvd.map((z) => seawaterKgM3 * G * z); // displacement water inside
      po = tvd.map((z) => cementKgM3 * G * z);   // wet cement outside
      break;
    case 'runningAxial':
      pi = tvd.map((z) => mudP(z));
      po = tvd.map((z) => mudP(z));
      break;
    case 'customGradient': {
      const iRho = env.internalKgM3 ?? mudKgM3;
      const oRho = env.externalKgM3 ?? mudKgM3;
      const surf = env.surfacePressurePa ?? 0;
      pi = tvd.map((z) => surf + iRho * G * z);
      po = tvd.map((z) => oRho * G * z);
      break;
    }
    default:
      throw new Error(`Unknown load case kind '${kind}'.`);
  }
  return { tvdM: tvd, piPa: pi, poPa: po, faN: fa, meta };
}

export const LOAD_CASE_KINDS = [
  'gasKickBurst', 'pressureTestBurst', 'fullEvacuationCollapse',
  'partialEvacuationCollapse', 'cementingCollapse', 'runningAxial',
  'customGradient',
];

// ---- string evaluation -----------------------------------------------------

// sections: [{topTvdM, bottomTvdM, odM, wallM, idM, yieldPa,
//             connectionEfficiency?, weightKgM?}]
// profile: from loadCaseProfiles. safetyFactors: {burst, collapse, tension,
// triaxial}. Scans the WHOLE profile inside each section (not just the
// bottom — the legacy app's governing-depth miss).
export function evaluateString({ sections, profile, safetyFactors = {}, bendingDlsDegPer30m = 0 }) {
  const df = {
    burst: safetyFactors.burst ?? 1.1,
    collapse: safetyFactors.collapse ?? 1.0,
    tension: safetyFactors.tension ?? 1.6,
    triaxial: safetyFactors.triaxial ?? 1.25,
  };
  const { tvdM, piPa, poPa, faN } = profile;
  const out = sections.map((sec) => {
    const idM = sec.idM ?? sec.odM - 2 * sec.wallM;
    const wallM = sec.wallM ?? (sec.odM - idM) / 2;
    const burstRating = barlowBurstPa({ odM: sec.odM, wallM, yieldPa: sec.yieldPa });
    const bodyYield = jointStrengthN({
      odM: sec.odM, idM, yieldPa: sec.yieldPa,
      connectionEfficiency: sec.connectionEfficiency ?? 1,
    });
    const { areaM2 } = stringProperties({ odM: sec.odM, idM });
    let worst = {
      burstSF: Infinity, collapseSF: Infinity, tensionSF: Infinity, triaxSF: Infinity,
      burstAtTvdM: null, collapseAtTvdM: null, collapseRegime: null,
    };
    for (let i = 0; i < tvdM.length; i += 1) {
      const z = tvdM[i];
      if (z < sec.topTvdM - 1e-9 || z > sec.bottomTvdM + 1e-9) continue;
      const dPb = piPa[i] - poPa[i];
      if (dPb > 0) {
        const sf = burstRating / dPb;
        if (sf < worst.burstSF) { worst.burstSF = sf; worst.burstAtTvdM = z; }
      }
      const dPc = poPa[i] - piPa[i];
      if (dPc > 0) {
        const sigA = Math.max(0, faN[i]) / areaM2;
        const col = api5c3CollapsePa({ odM: sec.odM, wallM, yieldPa: sec.yieldPa, axialStressPa: sigA });
        const sf = col.collapsePa / dPc;
        if (sf < worst.collapseSF) {
          worst.collapseSF = sf; worst.collapseAtTvdM = z; worst.collapseRegime = col.regime;
        }
      }
      if (faN[i] > 0) {
        const sf = bodyYield / faN[i];
        if (sf < worst.tensionSF) worst.tensionSF = sf;
      }
      const tri = triaxialSF({
        odM: sec.odM, idM, yieldPa: sec.yieldPa,
        piPa: piPa[i], poPa: poPa[i], axialN: faN[i], bendingDlsDegPer30m,
      });
      if (tri.sf < worst.triaxSF) worst.triaxSF = tri.sf;
    }
    const status = (worst.burstSF < df.burst || worst.collapseSF < df.collapse
      || worst.tensionSF < df.tension || worst.triaxSF < df.triaxial)
      ? 'FAIL'
      : (worst.burstSF < df.burst * 1.1 || worst.collapseSF < df.collapse * 1.1
        || worst.triaxSF < df.triaxial * 1.1)
        ? 'WARNING' : 'PASS';
    return {
      sectionId: sec.id ?? null,
      burstRatingPa: burstRating,
      bodyYieldN: bodyYield,
      ...worst,
      status,
    };
  });
  return { sections: out, designFactors: df };
}

// ---- tubing-packer system (Lubinski/Hammerlindl planning forms) ------------

export function tubingLoads({
  tubing, packer, loadCase, tempProfile = {}, casingIdM,
}) {
  const {
    odM, idM, lengthM, weightKgM, yieldPa = 5.5e8,
  } = tubing;
  if (!(odM > 0) || !(idM > 0) || !(lengthM > 0)) throw new Error('Invalid tubing definition.');
  const {
    sealBoreM = odM, hasPacker = true, ratingN = 4.45e5, strokeM = 0,
  } = packer || {};
  const Ai = (Math.PI / 4) * idM * idM;
  const Ao = (Math.PI / 4) * odM * odM;
  const Ap = (Math.PI / 4) * sealBoreM * sealBoreM;
  const A = Ao - Ai;
  const { eiNm2 } = stringProperties({ odM, idM });

  const {
    dPiPa = 0, dPoPa = 0, // pressure CHANGES at the packer vs initial
    finalPiSurfacePa = 0, internalKgM3 = 1000, externalKgM3 = 1440,
  } = loadCase || {};
  const { surfC = 20, gradCPerM = 0.03, deltaOpC = null } = tempProfile;

  // Average tubing temperature change: production heats the string toward
  // bottomhole temperature; planning form uses the mean of the linear
  // profile change. deltaOpC overrides when given.
  const dT = deltaOpC ?? (gradCPerM * lengthM) / 2;

  const piston = hasPacker ? (Ap - Ai) * dPiPa - (Ap - Ao) * dPoPa : 0;
  const ballooning = BALLOONING_FACTOR * (dPiPa * Ai - dPoPa * Ao);
  const thermal = -STEEL_E_PA * A * STEEL_ALPHA_PER_C * dT;
  const totalN = piston + ballooning + thermal; // positive = tension added to the packer

  // Buckling check at the packer with the final internal/external columns.
  const bfExt = 1 - externalKgM3 / 7850;
  const wcN = weightKgM * G * bfExt;
  const clearance = casingIdM ? (casingIdM - odM) / 2 : 0.02;
  const limits = bucklingLimits({
    eiNm2, wcNPerM: Math.max(wcN, 1), incDeg: 90, radialClearanceM: Math.max(clearance, 1e-3),
  });
  const compression = Math.max(0, -totalN);
  let buckling = 'none';
  if (compression > limits.helicalN) buckling = 'helical';
  else if (compression > limits.sinusoidalN) buckling = 'sinusoidal';

  // Length changes (planning forms; reported, not fed back).
  const dL1 = (piston * lengthM) / (STEEL_E_PA * A) * -1;
  const dL2 = (-2 * 0.3 * lengthM / STEEL_E_PA) * ((dPiPa * Ai - dPoPa * Ao) / A);
  const dL4 = STEEL_ALPHA_PER_C * lengthM * dT;
  const totalDL = dL1 + dL2 + dL4;
  const strokeOk = strokeM <= 0 ? null : Math.abs(totalDL) <= strokeM;

  const packerSF = ratingN > 0 ? ratingN / Math.max(1, Math.abs(totalN)) : null;
  return {
    forces: { pistonN: piston, ballooningN: ballooning, thermalN: thermal, totalN },
    lengthChanges: { pistonM: dL1, ballooningM: dL2, thermalM: dL4, totalM: totalDL },
    buckling: { state: buckling, sinusoidalN: limits.sinusoidalN, helicalN: limits.helicalN, compressionN: compression },
    packer: { sf: packerSF, ratingN, strokeOk },
    meta: { dTC: dT, Ai, Ao, Ap },
  };
}

// API RP 14E erosional velocity (the one honest flow fragment kept).
export function erosionalVelocityMs({ mixtureKgM3, cFactor = 100 }) {
  if (!(mixtureKgM3 > 0)) throw new Error('Density must be positive.');
  // C-factor form: Ve[ft/s] = C / sqrt(rho[lb/ft3]).
  const rhoLbFt3 = mixtureKgM3 / 16.018463;
  return (cFactor / Math.sqrt(rhoLbFt3)) * 0.3048;
}
