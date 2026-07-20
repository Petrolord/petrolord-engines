// Layered (vertical) sweep engine — Dykstra-Parsons and Stiles methods.
//
// Both are the classic piston-displacement, non-communicating-layer waterflood
// conformance methods (Dykstra & Parsons 1950; Stiles 1949; as presented in
// Willhite "Waterflooding" SPE Textbook Vol.3 and Ahmed "Reservoir
// Engineering Handbook" Ch.14):
//
//   * Layers are ordered by permeability, fastest first, and flood out in
//     that order. Displacement inside a layer is piston-like.
//   * Dykstra-Parsons moves each layer's front at the mobility-dependent
//     velocity, giving the frontal-position relation (M != 1):
//        x_j = [M - sqrt(M^2 + (k_j/k_i)(1 - M^2))] / (M - 1)
//     when layer i breaks through (x_j = k_j/k_i in the M = 1 limit), and
//     reservoir-condition WOR from the layer conductances (both in units of
//     endpoint water mobility, which cancels):
//        WOR_i = (sum_{j<=i} k_j*h_j)
//                / (sum_{j>i} k_j*h_j / (x_j + M*(1 - x_j)))
//     (a broken layer flows water at k*h; an unbroken layer with its front at
//     x flows oil through the two-bank series resistance k*h/(x + M(1-x))).
//   * Stiles assumes equal frontal velocity scaling with k only (unit
//     mobility ratio kinematics): at breakthrough of layer i, layer j > i is
//     swept to k_j/k_i. Producing surface water cut uses the capacity ratio
//        fws = A*Ci / (A*Ci + (Ct - Ci)),  Ci = sum_{j<=i} k_j*h_j,
//        A = (krw/muW)/(kro/muO) * (Bo/Bw).
//
//   * The Dykstra-Parsons permeability variation V = (k50 - k84.1)/k50 is
//     computed from a least-squares log-normal fit of the layer permeability
//     distribution, so V = 1 - exp(-sigma) with sigma the fitted stdev of
//     ln(k).
//
// Assumptions carried by both methods (surfaced as warnings): equal porosity
// and saturation change per layer, no crossflow, piston displacement.

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

// Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.15e-9).
export function inverseNormal(p) {
  if (!(p > 0) || !(p < 1)) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Dykstra-Parsons permeability variation from a set of layer permeabilities.
 * Least-squares fit of ln(k) against the standard-normal quantile of the
 * "portion of samples with larger k" plotting position (i - 0.5)/n, then
 * V = (k50 - k84.1)/k50 = 1 - exp(-sigma).
 * Returns { V, sigma, k50, n } or { error } for degenerate input.
 */
export function dykstraParsonsV(perms) {
  const ks = (Array.isArray(perms) ? perms : [])
    .map(num)
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => b - a);
  const n = ks.length;
  if (n < 3) return { error: 'Need at least 3 positive permeabilities.' };
  // x = z-quantile of cumulative "greater than" probability, y = ln k.
  // With k sorted descending, ln k decreases as probability increases, so the
  // slope is -sigma.
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n; // portion with k >= ks[i]
    const x = inverseNormal(p);
    const y = Math.log(ks[i]);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  let sigma = -slope;
  if (sigma < 0 && sigma > -1e-9) sigma = 0; // homogeneous set, floating noise
  const k50 = Math.exp(intercept);
  if (!(sigma >= 0)) return { error: 'Permeability distribution is not log-normally decreasing.' };
  return { V: 1 - Math.exp(-sigma), sigma, k50, n };
}

/** Clean and order a layer table [{ h, k }] by permeability, fastest first. */
export function normalizeLayers(layers) {
  return (Array.isArray(layers) ? layers : [])
    .map((l) => ({ h: num(l.h), k: num(l.k) }))
    .filter((l) => l.h > 0 && l.k > 0)
    .sort((a, b) => b.k - a.k);
}

// Dykstra-Parsons frontal position of layer j at breakthrough of layer i.
export function dpFrontPosition(kRatio, M) {
  if (kRatio >= 1) return 1;
  if (Math.abs(M - 1) < 1e-9) return kRatio;
  const disc = M * M + kRatio * (1 - M * M);
  return (M - Math.sqrt(disc)) / (M - 1);
}

/**
 * Dykstra-Parsons layered performance at each layer-breakthrough stage.
 * inputs: { layers: [{h, k}], M } with M the endpoint mobility ratio.
 * Returns { stages: [{ layerIndex, coverage, WOR }], warnings } where
 * coverage is the vertical sweep (h-weighted swept fraction) and WOR is the
 * reservoir-condition water-oil ratio just after that layer breaks through.
 */
export function analyzeDykstraParsons({ layers, M }) {
  const L = normalizeLayers(layers);
  const m = num(M);
  if (L.length < 2) return { stages: [], warnings: ['Need at least 2 layers.'] };
  if (!(m > 0)) return { stages: [], warnings: ['Mobility ratio must be positive.'] };
  const totalH = L.reduce((s, l) => s + l.h, 0);
  const stages = [];
  for (let i = 0; i < L.length; i++) {
    let sweptH = 0;
    let waterCap = 0; // sum k*h over broken layers
    let oilCap = 0; // sum of oil-bank conductances (in water-mobility units)
    for (let j = 0; j < L.length; j++) {
      if (j <= i) {
        sweptH += L[j].h;
        waterCap += L[j].k * L[j].h;
      } else {
        const x = dpFrontPosition(L[j].k / L[i].k, m);
        sweptH += L[j].h * x;
        // Unbroken layer conductance with front at x, in endpoint-water-
        // mobility units (see header derivation).
        oilCap += (L[j].k * L[j].h) / (x + m * (1 - x));
      }
    }
    const coverage = sweptH / totalH;
    const WOR = i === L.length - 1 ? Infinity : waterCap / oilCap;
    stages.push({ layerIndex: i, kBroken: L[i].k, coverage, WOR });
  }
  return {
    stages,
    layers: L,
    warnings: ['Piston displacement, no crossflow, equal porosity and saturation change per layer (Dykstra-Parsons assumptions).'],
  };
}

/**
 * Stiles layered performance at each layer-breakthrough stage.
 * inputs: { layers: [{h, k}], A } with A the surface water-cut capacity
 * ratio A = (krw/muW)/(kro/muO) * (Bo/Bw).
 * Returns { stages: [{ layerIndex, coverage, waterCut }], warnings }.
 */
export function analyzeStiles({ layers, A }) {
  const L = normalizeLayers(layers);
  const a = num(A);
  if (L.length < 2) return { stages: [], warnings: ['Need at least 2 layers.'] };
  if (!(a > 0)) return { stages: [], warnings: ['Capacity ratio A must be positive.'] };
  const totalH = L.reduce((s, l) => s + l.h, 0);
  const totalCap = L.reduce((s, l) => s + l.k * l.h, 0);
  const stages = [];
  for (let i = 0; i < L.length; i++) {
    let sweptH = 0;
    let brokenCap = 0;
    for (let j = 0; j < L.length; j++) {
      if (j <= i) {
        sweptH += L[j].h;
        brokenCap += L[j].k * L[j].h;
      } else {
        sweptH += L[j].h * (L[j].k / L[i].k); // Stiles kinematics
      }
    }
    const coverage = sweptH / totalH;
    const waterCut = (a * brokenCap) / (a * brokenCap + (totalCap - brokenCap));
    stages.push({ layerIndex: i, kBroken: L[i].k, coverage, waterCut });
  }
  return {
    stages,
    layers: L,
    warnings: ['Stiles kinematics assume unit-mobility frontal velocities (fronts advance proportional to k).'],
  };
}

/**
 * Orchestrator: V from the layer permeabilities plus both methods' stage
 * tables. inputs = { layers: [{h, k}], M, A }.
 */
export function analyzeLayeredSweep({ layers, M, A }) {
  const L = normalizeLayers(layers);
  const v = dykstraParsonsV(L.map((l) => l.k));
  const dp = analyzeDykstraParsons({ layers: L, M });
  const stiles = analyzeStiles({ layers: L, A });
  const warnings = [...new Set([...(dp.warnings || []), ...(stiles.warnings || [])])];
  if (v.error) warnings.push(`Dykstra-Parsons V not computed: ${v.error}`);
  return { layers: L, V: v.error ? null : v, dykstraParsons: dp.stages, stiles: stiles.stages, warnings };
}

/** A five-layer teaching case (k in md, h in ft). */
export function sampleLayeredData() {
  return {
    layers: [
      { h: 10, k: 500 },
      { h: 8, k: 250 },
      { h: 12, k: 120 },
      { h: 6, k: 60 },
      { h: 9, k: 30 },
    ],
    M: 2.0,
    A: 1.5,
  };
}
