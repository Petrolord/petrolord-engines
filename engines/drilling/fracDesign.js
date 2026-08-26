// Hydraulic fracture design engine (Drilling D9 — Stimulation Designer):
// 2D frac geometry (PKN / KGD), Nolte material balance and pump
// schedule, propped conductivity, and Cinco-Ley-Samaniego fracture
// productivity.
//
// Published bases (ONE consistent formula set — Economides et al.,
// Petroleum Production Systems; Valko & Economides, Hydraulic Fracture
// Mechanics; Nolte 1986):
//   * Plane strain modulus  E' = E / (1 - nu^2).
//   * PKN max wellbore width (Newtonian, no leakoff), consistent units:
//       w_max = 2.31 [ qi mu xf / E' ]^(1/4),   w_avg = (pi/5) w_max
//     net pressure from the PKN vertical plane-strain compliance
//       p_net = E' w_max / (2 hf).
//   * KGD width:
//       w_max = 3.22 [ qi mu xf^2 / (E' hf) ]^(1/4), w_avg = (pi/4) w_max
//     net pressure from the Griffith through-crack compliance
//       p_net = E' w_max / (4 xf).
//   * Nolte material balance:  Vi = qi ti = Vf + VL,
//       Vf = 2 xf hf w_avg (two wings),
//       VL = KL CL (2 Af) sqrt(ti),  Af = 2 xf hf (both faces),
//       KL(eta) = (8/3 eta + pi (1 - eta)) / 2   (Nolte approximation)
//     solved as a fixed point in eta with the quadratic in sqrt(ti).
//   * Nolte pad + ramp:  f_pad = eps = (1 - eta)/(1 + eta),
//       c(tau) = c_EOJ tau^eps,  M = c_EOJ qi (ti - t_pad)/(1 + eps).
//   * Cinco-Ley & Samaniego pseudo-skin correlation (u = ln C_fD):
//       f(u) = (1.65 - 0.328 u + 0.116 u^2)
//              / (1 + 0.18 u + 0.064 u^2 + 0.005 u^3)
//       s_f = f - ln(xf/rw),  r'_w = rw e^(-s_f);  valid for
//       0.1 <= C_fD <= 1000 (flagged outside);  UFD optimum C_fD = 1.6.
//
// UNITS: STRICT SI (m, Pa, Pa.s, m3/s, kg). qi is the TOTAL slurry
// injection rate (both wings); xf is the half-length of one wing.
// Bottomhole treating pressure = closure + p_net when closure is
// supplied; slurry hydrostatic and pipe/perforation friction are
// EXPLICITLY out of scope (surface pressure lives with the rig
// hydraulics, not here).
//
// Validation: independent numpy oracle (oracle_stim.py) with
// self-asserted hand arithmetic + goldens; jest gates in
// __tests__/drilling.stim.test.js; runner gates A28-A29.

export const FRAC_MODELS = ['pkn', 'kgd'];
export const CFD_RANGE = [0.1, 1000];
export const CFD_OPTIMUM = 1.6; // unified fracture design optimum

export function planeStrainModulus({ ePa, nu }) {
  if (!(ePa > 0)) throw new Error('Young modulus must be positive.');
  if (!(nu > 0 && nu < 0.5)) throw new Error('Poisson ratio must be in (0, 0.5).');
  return ePa / (1 - nu * nu);
}

/** 2D width + net pressure at the target half-length. */
export function fracGeometry({
  model, qiM3s, muPaS, xfM, hfM, ePrimePa, closurePa = null,
}) {
  if (!FRAC_MODELS.includes(model)) throw new Error(`Unknown frac model "${model}".`);
  if (!(qiM3s > 0)) throw new Error('Injection rate must be positive.');
  if (!(muPaS > 0)) throw new Error('Fluid viscosity must be positive.');
  if (!(xfM > 0)) throw new Error('Half-length must be positive.');
  if (!(hfM > 0)) throw new Error('Fracture height must be positive.');
  if (!(ePrimePa > 0)) throw new Error('Plane-strain modulus must be positive.');

  let wMaxM;
  let wAvgM;
  let pNetPa;
  if (model === 'pkn') {
    wMaxM = 2.31 * ((qiM3s * muPaS * xfM) / ePrimePa) ** 0.25;
    wAvgM = (Math.PI / 5) * wMaxM;
    pNetPa = (ePrimePa * wMaxM) / (2 * hfM);
  } else {
    wMaxM = 3.22 * ((qiM3s * muPaS * xfM * xfM) / (ePrimePa * hfM)) ** 0.25;
    wAvgM = (Math.PI / 4) * wMaxM;
    pNetPa = (ePrimePa * wMaxM) / (4 * xfM);
  }
  const bhtpPa = closurePa != null ? closurePa + pNetPa : null;
  return { model, wMaxM, wAvgM, pNetPa, closurePa, bhtpPa };
}

export function noltekL(eta) {
  return ((8 / 3) * eta + Math.PI * (1 - eta)) / 2;
}

/**
 * Nolte material balance: pump time and fluid efficiency to place the
 * target geometry against Carter leakoff (spurt neglected, stated).
 */
export function pumpTime({ qiM3s, hfM, xfM, wAvgM, clMSqrtS }) {
  if (!(qiM3s > 0) || !(hfM > 0) || !(xfM > 0) || !(wAvgM > 0)) {
    throw new Error('pumpTime needs positive rate and geometry.');
  }
  if (!(clMSqrtS >= 0)) throw new Error('Leakoff coefficient must be >= 0.');
  const vfM3 = 2 * xfM * hfM * wAvgM;
  if (clMSqrtS === 0) {
    const tiS = vfM3 / qiM3s;
    return { tiS, etaFrac: 1, viM3: vfM3, vfM3, vlM3: 0, iterations: 0 };
  }
  const leakArea = 2 * (2 * xfM * hfM); // both faces of both wings
  let eta = 0.5;
  let tiS = 0;
  let iterations = 0;
  for (; iterations < 200; iterations += 1) {
    const b = noltekL(eta) * clMSqrtS * leakArea;
    // qi t - b sqrt(t) - Vf = 0  ->  sqrt(t) = (b + sqrt(b^2 + 4 qi Vf)) / (2 qi)
    const s = (b + Math.sqrt(b * b + 4 * qiM3s * vfM3)) / (2 * qiM3s);
    tiS = s * s;
    const next = vfM3 / (qiM3s * tiS);
    if (Math.abs(next - eta) < 1e-12) { eta = next; break; }
    eta = next;
  }
  const viM3 = qiM3s * tiS;
  return { tiS, etaFrac: eta, viM3, vfM3, vlM3: viM3 - vfM3, iterations };
}

/** Nolte pad + power-law proppant ramp, stepped for the blender. */
export function pumpSchedule({ tiS, etaFrac, qiM3s, cEojKgM3, nSteps = 8 }) {
  if (!(tiS > 0)) throw new Error('Pump time must be positive.');
  if (!(etaFrac > 0 && etaFrac <= 1)) throw new Error('Efficiency must be in (0, 1].');
  if (!(cEojKgM3 > 0)) throw new Error('End-of-job concentration must be positive.');
  if (!(Number.isInteger(nSteps) && nSteps >= 1)) throw new Error('Steps must be a positive integer.');
  const eps = (1 - etaFrac) / (1 + etaFrac);
  const padFrac = eps;
  const tPadS = padFrac * tiS;
  const rampS = tiS - tPadS;
  const steps = [];
  for (let j = 0; j < nSteps; j += 1) {
    const tauMid = (j + 0.5) / nSteps;
    steps.push({
      tStartS: tPadS + (j / nSteps) * rampS,
      tEndS: tPadS + ((j + 1) / nSteps) * rampS,
      cKgM3: cEojKgM3 * tauMid ** eps,
      slurryM3: qiM3s * (rampS / nSteps),
    });
  }
  const massKg = (cEojKgM3 * qiM3s * rampS) / (1 + eps);
  return { eps, padFrac, tPadS, rampS, padM3: qiM3s * tPadS, steps, massKg };
}

/** Propped width and retained conductivity from the placed mass. */
export function proppedFrac({
  massKg, xfM, hfM, rhoKgM3, packPorosity, kfM2, damageFactor = 0.5,
}) {
  if (!(massKg > 0)) throw new Error('Proppant mass must be positive.');
  if (!(rhoKgM3 > 0) || !(packPorosity > 0 && packPorosity < 1)) {
    throw new Error('Proppant density/porosity invalid.');
  }
  if (!(damageFactor > 0 && damageFactor <= 1)) throw new Error('Damage factor must be in (0, 1].');
  const arealKgM2 = massKg / (2 * xfM * hfM);
  const wpM = arealKgM2 / (rhoKgM3 * (1 - packPorosity));
  const kfwM3 = kfM2 * wpM * damageFactor;
  return { arealKgM2, wpM, kfwM3, retainedKfM2: kfM2 * damageFactor };
}

/** Cinco-Ley-Samaniego finite-conductivity fracture pseudo-skin. */
export function fracProductivity({ kfwM3, kM2, xfM, rwM }) {
  if (!(kfwM3 > 0)) throw new Error('Fracture conductivity must be positive.');
  if (!(kM2 > 0)) throw new Error('Formation permeability must be positive.');
  if (!(xfM > rwM) || !(rwM > 0)) throw new Error('Need xf > rw > 0.');
  const cfd = kfwM3 / (kM2 * xfM);
  const warnings = [];
  if (cfd < CFD_RANGE[0] || cfd > CFD_RANGE[1]) {
    warnings.push(`C_fD ${cfd.toFixed(3)} outside the correlation range [${CFD_RANGE.join(', ')}].`);
  }
  const u = Math.log(cfd);
  const f = (1.65 - 0.328 * u + 0.116 * u * u)
    / (1 + 0.18 * u + 0.064 * u * u + 0.005 * u * u * u);
  const sF = f - Math.log(xfM / rwM);
  const rwPrimeM = rwM * Math.exp(-sF);
  return { cfd, cfdOptimum: CFD_OPTIMUM, f, sF, rwPrimeM, warnings };
}
