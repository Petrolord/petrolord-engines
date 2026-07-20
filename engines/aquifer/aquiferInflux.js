// Aquifer water-influx (We) calculator — standalone client-side engine.
//
// Given a reservoir-boundary pressure history and aquifer geometry/properties,
// computes cumulative water influx We(t) by the three canonical unsteady-state
// methods used across the industry:
//
//   1. van Everdingen-Hurst (vEH) — rigorous constant-terminal-pressure
//      superposition for a radial (edge-water) aquifer. The reference method.
//
//   2. Fetkovich — finite-aquifer pseudo-steady-state productivity-index
//      marching scheme. Cheap, stable, needs W (aquifer volume) and J.
//
//   3. Carter-Tracy — an approximation to vEH that avoids the superposition sum
//      by marching with the dimensionless pressure pD and its derivative. Good
//      for large / effectively-infinite aquifers.
//
// This is a screening engine. It mirrors the physics in the (server-side,
// benchmark-verified) MBAL aquifer models but stands alone so an engineer can
// get a We history from a pressure table without setting up a full material
// balance case. Confirm against simulation / MBAL history match before use in
// reserves work.
//
// FIELD UNITS
//   pressure          psia
//   time              days
//   permeability k    md
//   viscosity μw      cp
//   thickness h       ft
//   radius r          ft         (rR = reservoir/aquifer inner radius)
//   porosity φ        fraction
//   compressibility   1/psi      (ct = cw + cf)
//   angle θ           degrees    (encroachment angle, 360 = full radial)
//   We                reservoir barrels (rb)
//   W (Fetkovich)     reservoir barrels (initial aquifer water volume)
//   J (Fetkovich)     rb/day/psi
//
// Constants (t in days):
//   Aquifer influx constant  U = 1.119 · f · φ · ct · h · rR²      [rb/psi]
//   Dimensionless time       tD = 6.33e-3 · k · t / (φ · μw · ct · rR²)
//   where f = θ/360.

import { stehfestInvert } from '../../lib/welltest/numerics.js';
import { radialSandfaceLaplace } from '../../lib/welltest/models/radial.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

const TD_CONST = 6.33e-3; // tD = TD_CONST·k·t/(φ·μ·ct·rR²), t in days
const U_CONST = 1.119; // U = 1.119·f·φ·ct·h·rR²

// ---------------------------------------------------------------------------
// Aquifer constants
// ---------------------------------------------------------------------------

// Aquifer influx constant U (rb/psi). Shared by vEH and Carter-Tracy.
export function influxConstant({ theta, phi, ct, h, rR }) {
  const f = num(theta) / 360;
  const _phi = num(phi), _ct = num(ct), _h = num(h), _rR = num(rR);
  if ([f, _phi, _ct, _h, _rR].some((x) => !Number.isFinite(x))) return NaN;
  return U_CONST * f * _phi * _ct * _h * _rR * _rR;
}

// Dimensionless-time coefficient C such that tD = C·t (t in days).
export function tDCoefficient({ k, phi, muw, ct, rR }) {
  const _k = num(k), _phi = num(phi), _mu = num(muw), _ct = num(ct), _rR = num(rR);
  if ([_k, _phi, _mu, _ct, _rR].some((x) => !Number.isFinite(x))) return NaN;
  const denom = _phi * _mu * _ct * _rR * _rR;
  if (denom <= 0) return NaN;
  return (TD_CONST * _k) / denom;
}

// ---------------------------------------------------------------------------
// Dimensionless cumulative influx WD(tD) — van Everdingen-Hurst, infinite aquifer
// ---------------------------------------------------------------------------
// Edwardson et al. (1962) rational-polynomial fit, as tabulated in Dake
// "Fundamentals of Reservoir Engineering" and Ahmed "Reservoir Engineering
// Handbook". The pieces join smoothly at tD = 200 (verified numerically).
export function WD(tD) {
  const t = num(tD);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t < 0.01) {
    return 2 * Math.sqrt(t / Math.PI);
  }
  if (t <= 200) {
    const s = Math.sqrt(t);
    const numr =
      1.12838 * s + 1.19328 * t + 0.269872 * t * s + 0.00855294 * t * t;
    const den = 1 + 0.616599 * s + 0.0413008 * t;
    return numr / den;
  }
  return (2 * t) / Math.log(t);
}

// ---------------------------------------------------------------------------
// Dimensionless pressure pD(tD) and derivative — infinite radial aquifer
// ---------------------------------------------------------------------------
// Line-source (exponential-integral) solution: pD = ½·E1(1/(4tD)).
// Used by Carter-Tracy. Exact for the infinite-acting radial case; avoids the
// uncertainty of a low-order polynomial pD fit.

// Exponential integral E1(x), x > 0 (Abramowitz & Stegun 5.1.53 / 5.1.56).
function E1(x) {
  if (!(x > 0)) return Infinity;
  if (x <= 1) {
    return (
      -Math.log(x) -
      0.57721566 +
      0.99999193 * x -
      0.24991055 * x * x +
      0.05519968 * x * x * x -
      0.00976004 * x * x * x * x +
      0.00107857 * x * x * x * x * x
    );
  }
  const numr = x * x + 2.334733 * x + 0.250621;
  const den = x * x + 3.330657 * x + 1.681534;
  return (Math.exp(-x) / x) * (numr / den);
}

export function pD(tD) {
  const t = num(tD);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return 0.5 * E1(1 / (4 * t));
}

// dpD/dtD = exp(-1/(4tD)) / (2·tD)
export function pDprime(tD) {
  const t = num(tD);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.exp(-1 / (4 * t)) / (2 * t);
}

// ---------------------------------------------------------------------------
// Finite-aquifer pD(tD, reD) — bounded circle, no-flow outer boundary (MB2)
// ---------------------------------------------------------------------------
// The exact van Everdingen-Hurst constant-terminal-RATE solution for a
// bounded radial aquifer, evaluated by Stehfest inversion of the Well Test
// engine's scaled-Bessel Laplace form (src/utils/welltest/models/radial.js,
// closed-circle boundary — the same solution family validated in WT3 harness
// CASE 8 against the exact PSS line). This is what Carter-Tracy needs for a
// finite aquifer: at late time pD approaches the pseudo-steady state
// 2·tD/(reD² - 1) + ln(reD) - 3/4 exactly, with the true transient
// transition rather than an empirical blend.
//
// Cost: one Stehfest inversion = 12 Laplace evaluations of 4 scaled Bessel
// functions; the Carter-Tracy march does 2 inversions per timestep, which is
// negligible for screening-size tables (hundreds of rows).
export function pDFinite(tD, reD) {
  const t = num(tD);
  const r = num(reD);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(r) || r <= 1) return pD(t);
  return stehfestInvert(
    (u) => radialSandfaceLaplace(u, { boundary: { type: 'closed-circle', reD: r } }),
    t,
  );
}

// dpD/dtD for the bounded circle: L{pD'} = u·L{pD} since pD(0) = 0.
export function pDprimeFinite(tD, reD) {
  const t = num(tD);
  const r = num(reD);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(r) || r <= 1) return pDprime(t);
  return stehfestInvert(
    (u) => u * radialSandfaceLaplace(u, { boundary: { type: 'closed-circle', reD: r } }),
    t,
  );
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------
// pressureHistory: array of { t (days), p (psia) }. The first row defines the
// initial pressure pi at t0 (should be pi, We = 0). Returns cleaned, sorted,
// deduped rows or throws for degenerate input.
export function normalizeHistory(pressureHistory) {
  if (!Array.isArray(pressureHistory)) return [];
  const rows = pressureHistory
    .map((r) => ({ t: num(r.t), p: num(r.p) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.p) && r.t >= 0 && r.p > 0)
    .sort((a, b) => a.t - b.t);
  // Dedupe identical times (keep last).
  const out = [];
  for (const r of rows) {
    if (out.length && Math.abs(out[out.length - 1].t - r.t) < 1e-9) {
      out[out.length - 1] = r;
    } else {
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. van Everdingen-Hurst
// ---------------------------------------------------------------------------
// We(tN) = U · Σ_{j=0}^{N-1} ΔP_j · WD(tD_N − tD_j)
// with the standard centred pressure-drop superposition:
//   ΔP_0 = (pi − p1)/2
//   ΔP_j = (p_{j-1} − p_{j+1})/2      (interior)
//   ΔP_{last-visible} handled by the running index.
export function vanEverdingenHurst(history, params) {
  const rows = normalizeHistory(history);
  if (rows.length < 2) return { series: [], cumulativeWe: 0, method: 'veh' };

  const U = influxConstant(params);
  const C = tDCoefficient(params);
  if (!Number.isFinite(U) || !Number.isFinite(C) || U <= 0 || C <= 0) {
    return { series: [], cumulativeWe: 0, method: 'veh', error: 'Invalid aquifer parameters.' };
  }

  const pi = rows[0].p;
  const t0 = rows[0].t;
  const tD = rows.map((r) => C * (r.t - t0));

  // Centred pressure-drop increments ΔP_j applied at time index j.
  // ΔP_0 = (pi − p1)/2 ; ΔP_j = (p_{j-1} − p_{j+1})/2.
  const dP = [];
  for (let j = 0; j < rows.length; j++) {
    if (j === 0) {
      dP[0] = (pi - rows[1].p) / 2;
    } else if (j < rows.length - 1) {
      dP[j] = (rows[j - 1].p - rows[j + 1].p) / 2;
    } else {
      dP[j] = 0; // last point contributes no forward-looking increment
    }
  }

  const series = [{ t: rows[0].t, p: pi, tD: 0, We: 0 }];
  for (let n = 1; n < rows.length; n++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const dt = tD[n] - tD[j];
      if (dt > 0) sum += dP[j] * WD(dt);
    }
    const We = U * sum;
    series.push({ t: rows[n].t, p: rows[n].p, tD: tD[n], We });
  }

  return {
    method: 'veh',
    series,
    cumulativeWe: series[series.length - 1].We,
    U,
    tDCoefficient: C,
  };
}

// ---------------------------------------------------------------------------
// 2. Fetkovich finite-aquifer
// ---------------------------------------------------------------------------
// Wei = ct · W · pi                       (max encroachable water, rb)
// ΔWe_n = (Wei/pi)·(p_aq,n-1 − p̄_res,n)·(1 − exp(−J·pi·Δt_n/Wei))
// p_aq,n = pi·(1 − We_n/Wei)
// If J is not supplied it is estimated from radial geometry:
//   J = 0.00708·k·h·f / [ μw·(ln(reD) − 0.75) ],  reD = re/rR (no-flow outer bdy)
export function fetkovich(history, params) {
  const rows = normalizeHistory(history);
  if (rows.length < 2) return { series: [], cumulativeWe: 0, method: 'fetkovich' };

  const pi = rows[0].p;
  const ct = num(params.ct);
  let W = num(params.W); // aquifer water volume, rb
  let J = num(params.J);

  // Derive W from geometry if not given: W = π(re² − rR²)·h·φ·f / 5.615  (rb)
  if (!Number.isFinite(W)) {
    const f = num(params.theta) / 360;
    const re = num(params.re);
    const rR = num(params.rR);
    const phi = num(params.phi);
    const h = num(params.h);
    if ([f, re, rR, phi, h].every(Number.isFinite) && re > rR) {
      W = (Math.PI * (re * re - rR * rR) * h * phi * f) / 5.615;
    }
  }
  // Derive J from geometry if not given (no-flow outer boundary).
  if (!Number.isFinite(J)) {
    const f = num(params.theta) / 360;
    const k = num(params.k);
    const h = num(params.h);
    const mu = num(params.muw);
    const re = num(params.re);
    const rR = num(params.rR);
    if ([f, k, h, mu, re, rR].every(Number.isFinite) && re > rR && mu > 0) {
      const reD = re / rR;
      J = (0.00708 * k * h * f) / (mu * (Math.log(reD) - 0.75));
    }
  }

  if (![ct, W, J, pi].every(Number.isFinite) || W <= 0 || J <= 0 || ct <= 0) {
    return { series: [], cumulativeWe: 0, method: 'fetkovich', error: 'Need ct and either W & J or full geometry.' };
  }

  const Wei = ct * W * pi;
  const series = [{ t: rows[0].t, p: pi, We: 0 }];
  let We = 0;
  let pAq = pi;

  for (let n = 1; n < rows.length; n++) {
    const dt = rows[n].t - rows[n - 1].t;
    const pResBar = (rows[n - 1].p + rows[n].p) / 2;
    const dWe = (Wei / pi) * (pAq - pResBar) * (1 - Math.exp((-J * pi * dt) / Wei));
    We += dWe;
    pAq = pi * (1 - We / Wei);
    series.push({ t: rows[n].t, p: rows[n].p, We });
  }

  return { method: 'fetkovich', series, cumulativeWe: We, Wei, W, J };
}

// ---------------------------------------------------------------------------
// 3. Carter-Tracy
// ---------------------------------------------------------------------------
// We_n = We_{n-1} + (tD_n − tD_{n-1})·[ (U·Δp_n − We_{n-1}·pD'_n) / (pD_n − tD_{n-1}·pD'_n) ]
// Δp_n = pi − p_n  (total drawdown to date, NOT incremental).
//
// Finite aquifer (MB2): pass params.reD = ra/rR (> 1) to march with the exact
// bounded-circle pD(tD, reD) instead of the infinite-acting line source.
// Required to reproduce finite-aquifer benchmarks (Dake Exercise 9.2 is
// reD = 5); leave unset for an effectively infinite aquifer.
export function carterTracy(history, params) {
  const rows = normalizeHistory(history);
  if (rows.length < 2) return { series: [], cumulativeWe: 0, method: 'carter-tracy' };

  const U = influxConstant(params);
  const C = tDCoefficient(params);
  if (!Number.isFinite(U) || !Number.isFinite(C) || U <= 0 || C <= 0) {
    return { series: [], cumulativeWe: 0, method: 'carter-tracy', error: 'Invalid aquifer parameters.' };
  }

  const reD = num(params.reD);
  const finite = Number.isFinite(reD) && reD > 1;

  const pi = rows[0].p;
  const t0 = rows[0].t;
  const series = [{ t: rows[0].t, p: pi, tD: 0, We: 0 }];
  let We = 0;
  let tDprev = 0;

  for (let n = 1; n < rows.length; n++) {
    const tDn = C * (rows[n].t - t0);
    const dpTotal = pi - rows[n].p;
    const pDn = finite ? pDFinite(tDn, reD) : pD(tDn);
    const pDpn = finite ? pDprimeFinite(tDn, reD) : pDprime(tDn);
    const denom = pDn - tDprev * pDpn;
    if (Math.abs(denom) > 1e-12) {
      We += (tDn - tDprev) * ((U * dpTotal - We * pDpn) / denom);
    }
    if (We < 0) We = 0;
    series.push({ t: rows[n].t, p: rows[n].p, tD: tDn, We });
    tDprev = tDn;
  }

  return { method: 'carter-tracy', series, cumulativeWe: We, U, tDCoefficient: C, reD: finite ? reD : undefined };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
// Qualitative aquifer strength from cumulative influx vs reservoir voidage
// support. We express We relative to the aquifer's own encroachable water when
// available, else just report magnitude. Kept intentionally simple / honest.
export function classifyInflux({ cumulativeWe, Wei }) {
  if (!Number.isFinite(cumulativeWe) || cumulativeWe <= 0) {
    return { level: 'none', label: 'No influx', note: 'No water influx computed for this history.' };
  }
  if (Number.isFinite(Wei) && Wei > 0) {
    const frac = cumulativeWe / Wei;
    if (frac < 0.02) return { level: 'weak', label: 'Weak aquifer', note: 'Cumulative influx is a small fraction of encroachable water — limited pressure support.' };
    if (frac < 0.1) return { level: 'moderate', label: 'Moderate aquifer', note: 'Meaningful influx; the aquifer contributes noticeable pressure support.' };
    return { level: 'strong', label: 'Strong aquifer', note: 'Large fraction of encroachable water has flowed in — active water drive.' };
  }
  return { level: 'active', label: 'Water influx present', note: 'Set aquifer volume (W) to gauge strength relative to encroachable water.' };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
// state = { method: 'veh'|'fetkovich'|'carter-tracy', params:{...}, history:[{t,p}] }
export function computeInflux(state) {
  const { method = 'veh', params = {}, history = [] } = state || {};
  let result;
  switch (method) {
    case 'fetkovich':
      result = fetkovich(history, params);
      break;
    case 'carter-tracy':
      result = carterTracy(history, params);
      break;
    case 'veh':
    default:
      result = vanEverdingenHurst(history, params);
  }

  const series = result.series || [];
  // Instantaneous influx rate over the final step (rb/day).
  let rate = null;
  if (series.length >= 2) {
    const a = series[series.length - 2];
    const b = series[series.length - 1];
    const dt = b.t - a.t;
    if (dt > 0) rate = (b.We - a.We) / dt;
  }

  const classification = classifyInflux({
    cumulativeWe: result.cumulativeWe,
    Wei: result.Wei,
  });

  return { ...result, rate, classification };
}

// ---------------------------------------------------------------------------
// Sample case
// ---------------------------------------------------------------------------
// An edge-water-drive oil reservoir declining over ~5 years of monthly-ish data.
export function sampleAquiferData() {
  const history = [
    { t: 0, p: 3793 },
    { t: 182, p: 3774 },
    { t: 365, p: 3709 },
    { t: 547, p: 3643 },
    { t: 730, p: 3547 },
    { t: 912, p: 3448 },
    { t: 1095, p: 3360 },
    { t: 1277, p: 3275 },
    { t: 1460, p: 3188 },
  ];
  return {
    method: 'veh',
    history,
    params: {
      // radial-aquifer geometry / properties
      k: 200, // md
      muw: 0.55, // cp
      phi: 0.209, // fraction
      ct: 6.9e-6, // 1/psi (cw + cf)
      h: 19.65, // ft
      rR: 2000, // ft  (reservoir radius)
      re: 20000, // ft  (aquifer outer radius, for Fetkovich geometry)
      theta: 180, // degrees (edge aquifer)
      // Fetkovich direct inputs (optional; else derived from geometry)
      W: undefined,
      J: undefined,
    },
  };
}
