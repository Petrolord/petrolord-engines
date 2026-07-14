// Bowers (1995) velocity–effective-stress relations. Parameters live
// in the PUBLISHED domain — V in ft/s, sigma' in psi, mudline velocity
// 5000 ft/s default — while the API edges are SI (m/s in, Pa out),
// matching the oracle sample-for-sample. Unloading uses
// V = V_ml + A*(sigma_max*(sigma'/sigma_max)^(1/U))^B; U = 1 reduces
// to the loading curve and sigma' = sigma_max rejoins it exactly.

import { M_PER_FT, PA_PER_PSI } from './constants';

function checkAB(A, B) {
  if (!(A > 0) || !(B > 0)) throw new Error('Bowers A and B must be positive.');
}

/** Loading-curve velocity [m/s] from effective stress [Pa]. */
export function bowersVLoading(sigmaPa, A, B, vMlFts = 5000.0) {
  checkAB(A, B);
  if (!(sigmaPa >= 0)) throw new Error('Effective stress must be >= 0.');
  const vFts = vMlFts + A * (sigmaPa / PA_PER_PSI) ** B;
  return vFts * M_PER_FT;
}

/** Effective stress [Pa] from velocity [m/s], Bowers loading. */
export function bowersSigmaLoading(vMs, A, B, vMlFts = 5000.0) {
  checkAB(A, B);
  const vFts = vMs / M_PER_FT;
  if (!(vFts > vMlFts)) {
    throw new Error('Velocity is at or below the mudline velocity — '
      + 'the loading curve cannot be inverted there.');
  }
  return ((vFts - vMlFts) / A) ** (1.0 / B) * PA_PER_PSI;
}

/** Unloading-curve velocity [m/s]; sigmaMax = max stress before unloading. */
export function bowersVUnloading(sigmaPa, sigmaMaxPa, A, B, U, vMlFts = 5000.0) {
  checkAB(A, B);
  if (!(sigmaPa >= 0) || !(sigmaPa <= sigmaMaxPa)) {
    throw new Error('Need 0 <= sigma <= sigma_max.');
  }
  if (!(U >= 1)) throw new Error('Bowers U must be >= 1.');
  const smaxPsi = sigmaMaxPa / PA_PER_PSI;
  const sPsi = sigmaPa / PA_PER_PSI;
  const vFts = vMlFts + A * (smaxPsi * (sPsi / smaxPsi) ** (1.0 / U)) ** B;
  return vFts * M_PER_FT;
}

/** Effective stress [Pa] from velocity [m/s], Bowers unloading. */
export function bowersSigmaUnloading(vMs, sigmaMaxPa, A, B, U, vMlFts = 5000.0) {
  checkAB(A, B);
  if (!(sigmaMaxPa > 0)) throw new Error('sigma_max must be positive.');
  if (!(U >= 1)) throw new Error('Bowers U must be >= 1.');
  const smaxPsi = sigmaMaxPa / PA_PER_PSI;
  const vFts = vMs / M_PER_FT;
  if (!(vFts > vMlFts)) {
    throw new Error('Velocity is at or below the mudline velocity — '
      + 'the unloading curve cannot be inverted there.');
  }
  const inner = ((vFts - vMlFts) / A) ** (1.0 / B) / smaxPsi;
  return smaxPsi * inner ** U * PA_PER_PSI;
}
