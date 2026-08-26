// Drilling-fluid rheology: model fits from Fann VG-meter dial readings and
// shear-stress evaluation (Drilling D2).
//
// Conventions (API RP 13D lineage):
//   dial angle θ [Fann degrees] → wall shear stress τ = 0.5104·θ [Pa]
//     (1 dial deg = 1.066 lbf/100ft², 1 lbf/100ft² = 0.47880 Pa)
//   rotor speed N [rpm] → Newtonian shear rate γ̇ = 1.7023·N [1/s]
//     (600 → 1021.4, 300 → 510.7, 6 → 10.21, 3 → 5.11)
//   Bingham:          τ = τy + μp·γ̇
//   Power law:        τ = K·γ̇ⁿ
//   Herschel-Bulkley: τ = τy + K·γ̇ⁿ  (τy from the low-shear readings,
//     the RP 13D 2·θ3 − θ6 estimate, clamped ≥ 0; θ3 fallback; 0 if
//     neither low-shear reading is given, which degrades HB to PL)
//
// Units are STRICT SI on the way out: Pa, Pa·s, Pa·sⁿ, 1/s. Dial degrees
// enter ONLY through fitModels — nothing else converts units.
//
// Validation: tools/validation/drilling/oracle_hydraulics.py goldens +
// closed-form identities in __tests__/drilling.rheology.test.js.

export const TAU_PER_DEG_PA = 1.066 * 0.47880259; // 0.51040 Pa per dial degree
export const GAMMA_PER_RPM = 1.70233;             // 1/s per rpm

const RATE_600 = 600 * GAMMA_PER_RPM;
const RATE_300 = 300 * GAMMA_PER_RPM;

export function fitModels({ theta600, theta300, theta6 = null, theta3 = null }) {
  if (!(theta600 > 0) || !(theta300 > 0)) throw new Error('Need positive theta600 and theta300.');
  if (theta600 <= theta300) throw new Error('theta600 must exceed theta300.');
  const tau600 = TAU_PER_DEG_PA * theta600;
  const tau300 = TAU_PER_DEG_PA * theta300;

  // Bingham plastic.
  const pvPaS = (tau600 - tau300) / (RATE_600 - RATE_300);
  const ypPa = Math.max(0, tau300 - pvPaS * RATE_300);

  // Power law.
  const nPl = Math.log(tau600 / tau300) / Math.log(2);
  const kPl = tau300 / RATE_300 ** nPl;

  // Herschel-Bulkley: low-shear yield estimate.
  let tauYPa = 0;
  if (theta3 != null && theta6 != null) tauYPa = Math.max(0, TAU_PER_DEG_PA * (2 * theta3 - theta6));
  else if (theta3 != null) tauYPa = Math.max(0, TAU_PER_DEG_PA * theta3);
  // Guard: the yield estimate must sit below the flowing readings.
  tauYPa = Math.min(tauYPa, 0.99 * tau300);
  const nHb = Math.log((tau600 - tauYPa) / (tau300 - tauYPa)) / Math.log(2);
  const kHb = (tau300 - tauYPa) / RATE_300 ** nHb;

  return {
    bingham: { type: 'bingham', pvPaS, ypPa },
    powerLaw: { type: 'powerLaw', n: nPl, kPaSn: kPl },
    herschelBulkley: { type: 'herschelBulkley', tauYPa, n: nHb, kPaSn: kHb },
  };
}

export function stressAtRate(model, gammaDot) {
  if (!(gammaDot >= 0)) throw new Error('Shear rate must be >= 0.');
  switch (model.type) {
    case 'bingham': return model.ypPa + model.pvPaS * gammaDot;
    case 'powerLaw': return model.kPaSn * gammaDot ** model.n;
    case 'herschelBulkley': return model.tauYPa + model.kPaSn * gammaDot ** model.n;
    default: throw new Error(`Unknown rheology model '${model.type}'.`);
  }
}

// Local power-law linearization at a shear rate: n' = d ln τ / d ln γ̇,
// K' = τ/γ̇^n'. Exact analytic slope per model (no finite differences).
export function localPowerLaw(model, gammaDot) {
  const gd = Math.max(gammaDot, 1e-6);
  const tau = stressAtRate(model, gd);
  let slope;
  switch (model.type) {
    case 'bingham': slope = (model.pvPaS * gd) / tau; break;
    case 'powerLaw': slope = model.n; break;
    case 'herschelBulkley': slope = (model.n * model.kPaSn * gd ** model.n) / tau; break;
    default: throw new Error(`Unknown rheology model '${model.type}'.`);
  }
  const nPrime = Math.min(Math.max(slope, 0.05), 1);
  return { nPrime, kPrime: tau / gd ** nPrime, tau };
}

// Apparent (effective) Newtonian viscosity at a shear rate.
export function apparentViscosity(model, gammaDot) {
  const gd = Math.max(gammaDot, 1e-6);
  return stressAtRate(model, gd) / gd;
}
