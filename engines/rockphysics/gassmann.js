// Gassmann (1951) fluid substitution (Rock Physics Studio G6.1) —
// RPH ch. 6 form, validated against the rockphysics oracle goldens.
// SI throughout (Pa, kg/m3, m/s). Unphysical inputs THROW with the
// reason — never a silent NaN (a wrong K_sat is worse than no K_sat).

function check(kdry, kmin, kfl, phi) {
  if (!(phi > 0 && phi < 1)) throw new Error('Porosity must be in (0, 1).');
  if (!(kmin > 0) || !(kfl > 0)) throw new Error('Moduli must be positive.');
  if (!(kdry > 0)) throw new Error('Dry-rock modulus must be positive.');
  if (kdry >= kmin) {
    throw new Error('K_dry must be below the mineral modulus K_min.');
  }
}

/** Saturated bulk modulus from dry rock. */
export function ksat(kdry, kmin, kfl, phi) {
  check(kdry, kmin, kfl, phi);
  const num = (1 - kdry / kmin) ** 2;
  const den = phi / kfl + (1 - phi) / kmin - kdry / (kmin * kmin);
  return kdry + num / den;
}

/** Inverse Gassmann: dry-rock modulus from saturated. */
export function kdry(ksatVal, kmin, kfl, phi) {
  if (!(phi > 0 && phi < 1)) throw new Error('Porosity must be in (0, 1).');
  if (!(kmin > 0) || !(kfl > 0)) throw new Error('Moduli must be positive.');
  const num = ksatVal * ((phi * kmin) / kfl + 1 - phi) - kmin;
  const den = (phi * kmin) / kfl + ksatVal / kmin - 1 - phi;
  const out = num / den;
  if (!(out > 0)) {
    throw new Error('Inverse Gassmann produced a non-positive K_dry — '
      + 'inputs are inconsistent (check K_min, K_fluid and porosity).');
  }
  return out;
}

/** Substitute fluid A -> fluid B via the dry rock. */
export function substitute(ksatA, kmin, kflA, kflB, phi) {
  return ksat(kdry(ksatA, kmin, kflA, phi), kmin, kflB, phi);
}

/** Log-domain substitution: (vp, vs, rho) with fluid A -> fluid B.
 *  mu is Gassmann-invariant; bulk density swaps the pore fluid.
 *  flA/flB are {k, rho} (SI). Returns {vp, vs, rho, ksat, mu}. */
export function substituteVels(vp, vs, rho, kmin, phi, flA, flB) {
  if (!(vp > 0 && vs > 0 && rho > 0)) {
    throw new Error('vp, vs and rho must be positive.');
  }
  const mu = rho * vs * vs;
  const ksatA = rho * vp * vp - (4 * mu) / 3;
  if (!(ksatA > 0)) {
    throw new Error('Implied K_sat is non-positive — vp/vs ratio too low.');
  }
  const ksatB = substitute(ksatA, kmin, flA.k, flB.k, phi);
  const rhoB = rho + phi * (flB.rho - flA.rho);
  return {
    vp: Math.sqrt((ksatB + (4 * mu) / 3) / rhoB),
    vs: Math.sqrt(mu / rhoB),
    rho: rhoB,
    ksat: ksatB,
    mu,
  };
}
