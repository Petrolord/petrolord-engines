// Pattern waterflood forecast engine — five-spot analytical prediction.
//
// Combines the 1-D Buckley-Leverett/Welge displacement (imported from
// fractionalFlowCalculations.js, never re-implemented) with the published
// five-spot areal-sweep correlations to produce a screening-level rate-time
// forecast: qo, qw, WOR, water cut, Np and EA vs time at constant injection.
//
// Published correlations used (both verified against their quoted anchor
// behavior, see the jest suite):
//   * Areal sweep at breakthrough vs mobility ratio (Craig's five-spot data,
//     Willhite's regression, as reproduced in Ahmed "Reservoir Engineering
//     Handbook" Ch.14):
//       EAbt = 0.54602036 + 0.03170817/M + 0.30222997*e^(-M) - 0.00509693*M
//     (quoted validity M ~ 0.15 to 10; anchors: EAbt -> ~1.0 at M = 0.15,
//      ~0.50 at M = 10)
//   * Areal sweep growth after breakthrough (Dyes, Caudle & Erickson 1954,
//     five-spot form as in Ahmed Ch.14):
//       EA = EAbt + 0.2749 * ln(Wi/WiBT), capped at 1.
//
// Forecast scheme (documented simplifications, surfaced as warnings):
//   * Piston-like areal growth: injected water occupies the swept region;
//     inside it the outlet state follows the 1-D Welge solution at
//     Qi_swept = Wi / (PV * EA) pore volumes.
//   * Np is material-balance-consistent by construction:
//       Np_rb = PV * EA * ED(Qi_swept) * (1 - Swc)
//     and rates come from differencing Np, with q_w = i_w - q_o (reservoir
//     barrels; production balances injection after fill-up).
//   * Optional initial gas fill-up: the first PV*Sgi barrels of injection
//     produce nothing (free gas is refilled first).
//   * Optional vertical-sweep multiplier EV (e.g. a Dykstra-Parsons coverage
//     from layeredSweepCalculations.js) applied to the displaceable volume.
//
// This is the analytical screening toolchain (Craig SPE Monograph Vol.1
// lineage), not a simulator: no interference between patterns, constant
// injectivity, piston areal growth.

import { analyzeDisplacement } from '../scal/fractionalFlow.js';

/** Five-spot areal sweep efficiency at breakthrough vs mobility ratio. */
export function arealSweepAtBreakthrough(M) {
  if (!(M > 0)) return null;
  const ea = 0.54602036 + 0.03170817 / M + 0.30222997 * Math.exp(-M) - 0.00509693 * M;
  return Math.min(1, Math.max(0, ea));
}

/** Five-spot areal sweep after breakthrough, capped at 1. */
export function arealSweepAfterBreakthrough(EAbt, wiOverWibt) {
  if (!(EAbt > 0) || !(wiOverWibt >= 1)) return EAbt;
  return Math.min(1, EAbt + 0.2749 * Math.log(wiOverWibt));
}

// Interpolate the Welge recovery profile (from analyzeDisplacement) at a
// given Qi (PV injected into the swept region). Below breakthrough the
// outlet is dry: ED grows linearly with Qi (piston fill of the BL profile),
// fw2 = 0.
export function displacementStateAtQi(displacement, Qi) {
  const { bl, recovery } = displacement;
  if (!bl || bl.QiBt == null) return null;
  if (Qi <= 0) return { ED: 0, fw2: 0, beforeBT: true };
  if (Qi < bl.QiBt) {
    // All injected water stays behind the front: SwAvg - Swc = Qi.
    return { ED: Qi / (1 - displacementSwc(displacement)), fw2: 0, beforeBT: true };
  }
  const pts = recovery;
  if (!pts.length) return null;
  if (Qi >= pts[pts.length - 1].Qi) {
    const last = pts[pts.length - 1];
    return { ED: last.ED, fw2: last.fw, beforeBT: false, exhausted: true };
  }
  let i = 1;
  while (i < pts.length && pts[i].Qi < Qi) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const t = (Qi - a.Qi) / (b.Qi - a.Qi);
  return { ED: a.ED + t * (b.ED - a.ED), fw2: a.fw + t * (b.fw - a.fw), beforeBT: false };
}

function displacementSwc(displacement) {
  return displacement.curves?.[0]?.Sw ?? 0;
}

/**
 * Five-spot pattern rate-time forecast.
 *
 * inputs = {
 *   displacementSpec,        // { krSpec, muW, muO, gravity?, polymerMuMult? }
 *   pattern: {
 *     area_acres, h_ft, phi, // flood-element geometry
 *     Bo, Bw,                // rb/stb
 *     iw_bpd,                // constant injection rate, rb/d
 *     Sgi,                   // optional initial free-gas saturation (fill-up)
 *     EV,                    // optional vertical sweep multiplier (0-1]
 *     worLimit,              // stop when surface WOR exceeds this (default 50)
 *     maxYears,              // horizon (default 30)
 *     stepDays,              // time step (default 30.4375 = monthly)
 *   },
 * }
 * Returns { series, breakthrough, summary, displacement, warnings }.
 */
export function forecastPattern({ displacementSpec, pattern }) {
  const warnings = [];
  const displacement = analyzeDisplacement(displacementSpec);
  warnings.push(...displacement.warnings);

  const { area_acres, h_ft, phi, Bo, Bw, iw_bpd } = pattern;
  const Sgi = pattern.Sgi > 0 ? pattern.Sgi : 0;
  const EV = pattern.EV > 0 && pattern.EV <= 1 ? pattern.EV : 1;
  const worLimit = pattern.worLimit > 0 ? pattern.worLimit : 50;
  const maxYears = pattern.maxYears > 0 ? pattern.maxYears : 30;
  const stepDays = pattern.stepDays > 0 ? pattern.stepDays : 30.4375;

  if (![area_acres, h_ft, phi, Bo, Bw, iw_bpd].every((v) => v > 0)) {
    return { series: [], warnings: ['All pattern inputs must be positive.'], displacement };
  }

  const M = displacement.M;
  const EAbt = arealSweepAtBreakthrough(M);
  if (M < 0.15 || M > 10) {
    warnings.push('Mobility ratio is outside the 0.15 to 10 validity range quoted for the five-spot areal sweep correlation.');
  }
  if (EV < 1) {
    warnings.push('Vertical sweep applied as a constant multiplier on the flooded volume (screening simplification).');
  }

  const PV = 7758 * area_acres * h_ft * phi * EV; // rb
  const Swc = displacementSwc(displacement);
  const fillupBbl = PV * Sgi;
  if (Sgi > 0) warnings.push('Initial free gas: injection first refills PV*Sgi with no production response (fill-up simplification).');

  // Pattern breakthrough: the swept region has grown to EAbt with the BL
  // profile behind the front, i.e. WiBT = QiBt * PV * EAbt (+ fill-up).
  const QiBt = displacement.bl.QiBt;
  if (QiBt == null) {
    return { series: [], warnings: [...warnings, 'No Welge tangent (degenerate rel-perm inputs).'], displacement };
  }
  const WiBT = QiBt * PV * EAbt;

  const series = [];
  let prevNpRb = 0;
  let breakthrough = null;
  const maxSteps = Math.ceil((maxYears * 365.25) / stepDays);
  let stopped = null;

  for (let s = 1; s <= maxSteps; s++) {
    const t = s * stepDays;
    const WiTotal = iw_bpd * t;
    const Wi = Math.max(0, WiTotal - fillupBbl);

    let EA;
    if (Wi <= 0) {
      EA = 0;
    } else if (Wi <= WiBT) {
      // Swept area grows toward EAbt in proportion to injected volume.
      EA = EAbt * (Wi / WiBT);
    } else {
      EA = arealSweepAfterBreakthrough(EAbt, Wi / WiBT);
    }

    // Outlet state inside the swept region.
    let NpRb = 0;
    let state = null;
    if (Wi > 0 && EA > 0) {
      // Before pattern BT every injected barrel displaces oil (piston areal
      // growth of the BL profile): Np_rb = Wi.
      if (Wi <= WiBT) {
        NpRb = Wi;
        state = { beforeBT: true, fw2: 0 };
      } else {
        const Qi = Wi / (PV * EA);
        state = displacementStateAtQi(displacement, Qi);
        NpRb = PV * EA * state.ED * (1 - Swc);
      }
    }
    NpRb = Math.max(NpRb, prevNpRb); // recovery never decreases

    const dNp = NpRb - prevNpRb;
    const qoRb = dNp / stepDays;
    const qwRb = Wi > 0 ? Math.max(0, iw_bpd - qoRb) : 0;
    const qo = qoRb / Bo; // stb/d
    const qw = qwRb / Bw; // stb/d
    const WOR = qo > 1e-9 ? qw / qo : Infinity;
    const fwSurf = qo + qw > 0 ? qw / (qo + qw) : 0;

    if (!breakthrough && Wi > WiBT) {
      breakthrough = { t_days: t, Wi_bbl: Wi, EAbt, WiBT_bbl: WiBT, QiBt };
    }

    series.push({
      t_days: t,
      Wi_bbl: WiTotal,
      EA,
      Np_stb: NpRb / Bo,
      qo_stbd: qo,
      qw_stbd: qw,
      WOR,
      fw_surface: fwSurf,
      fw_reservoir: state?.fw2 ?? 0,
    });

    prevNpRb = NpRb;

    if (breakthrough && Number.isFinite(WOR) && WOR >= worLimit) {
      stopped = 'wor-limit';
      break;
    }
    if (state?.exhausted) {
      stopped = 'displacement-exhausted';
      break;
    }
  }

  const last = series[series.length - 1];
  const ooipStb = (PV * (1 - Swc)) / Bo;
  const summary = last
    ? {
        M,
        EAbt,
        WiBT_bbl: WiBT,
        breakthrough_days: breakthrough?.t_days ?? null,
        Np_stb: last.Np_stb,
        recoveryFactorOfFloodedOOIP: ooipStb > 0 ? last.Np_stb / ooipStb : null,
        finalWOR: last.WOR,
        elapsed_days: last.t_days,
        stopped: stopped || 'horizon',
        ooip_flooded_stb: ooipStb,
      }
    : null;

  return { series, breakthrough, summary, displacement, warnings };
}

/** Sample five-spot case pairing the sample displacement data. */
export function samplePatternData() {
  return {
    pattern: {
      area_acres: 40,
      h_ft: 25,
      phi: 0.22,
      Bo: 1.25,
      Bw: 1.02,
      iw_bpd: 800,
      Sgi: 0,
      EV: 1,
      worLimit: 25,
      maxYears: 30,
    },
  };
}
