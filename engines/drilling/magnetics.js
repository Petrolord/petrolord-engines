// Geomagnetics for Well Design Studio (WD3): WMM2025 spherical-harmonic
// synthesis of the main field and its secular variation, from the NOAA
// public-domain coefficient set (data/wmm2025.js). Implements the
// standard World Magnetic Model equations (NOAA/NCEI & BGS, WMM2025
// Technical Report): geodetic (WGS84) to geocentric transformation,
// Schmidt semi-normalized associated Legendre recursion, field
// synthesis in the geocentric frame, rotation back to the geodetic
// frame, and the derived elements D, I, H, F plus their rates.
//
// Conventions: latitude/longitude in degrees (north/east positive),
// height in kilometres above the WGS84 ellipsoid, time as a decimal
// year. Output field components in nT: X north, Y east, Z down.
// Declination D is positive east (magnetic north east of true north),
// dip I positive down.
//
// Gated on the official NOAA WMM2025 test-value table from day 1
// (test-data/drilling/goldens/wmm2025_noaa_testvalues.json).
//
// Pure math, worker-safe, no I/O.

import { WMM2025 } from './data/wmm2025.js';

const DEG = Math.PI / 180;

// WGS84 ellipsoid (km) and the geomagnetic reference radius (km).
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const GEOMAG_RE = 6371.2;

const NMAX = WMM2025.nMax;

// Coefficient lookup tables indexed [n][m], built once at import.
const g0 = [];
const h0 = [];
const gDot = [];
const hDot = [];
for (let n = 0; n <= NMAX; n++) {
  g0.push(new Float64Array(n + 1));
  h0.push(new Float64Array(n + 1));
  gDot.push(new Float64Array(n + 1));
  hDot.push(new Float64Array(n + 1));
}
for (const [n, m, g, h, dg, dh] of WMM2025.coefficients) {
  g0[n][m] = g;
  h0[n][m] = h;
  gDot[n][m] = dg;
  hDot[n][m] = dh;
}

/**
 * Schmidt semi-normalized associated Legendre functions P̄n,m(sin φ)
 * and their derivatives dP̄n,m/dφ at geocentric latitude φ (radians).
 * Recursions (s = sin φ, c = cos φ):
 *   P̄n,n = c·sqrt((2n−1)/(2n))·P̄n−1,n−1            (n ≥ 2; P̄1,1 = c)
 *   P̄n,m = [(2n−1)·s·P̄n−1,m − K·P̄n−2,m] / sqrt(n²−m²),
 *          K = sqrt((n−1)² − m²)
 * with the same recursions differentiated for dP̄/dφ.
 */
function legendre(phi) {
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const P = [];
  const dP = [];
  for (let n = 0; n <= NMAX; n++) {
    P.push(new Float64Array(n + 1));
    dP.push(new Float64Array(n + 1));
  }
  P[0][0] = 1;
  dP[0][0] = 0;
  P[1][0] = s;
  dP[1][0] = c;
  P[1][1] = c;
  dP[1][1] = -s;
  for (let n = 2; n <= NMAX; n++) {
    const kd = Math.sqrt((2 * n - 1) / (2 * n));
    P[n][n] = kd * c * P[n - 1][n - 1];
    dP[n][n] = kd * (c * dP[n - 1][n - 1] - s * P[n - 1][n - 1]);
    for (let m = 0; m < n; m++) {
      const denom = Math.sqrt(n * n - m * m);
      const K = Math.sqrt((n - 1) * (n - 1) - m * m);
      const p2 = n - 2 >= m ? P[n - 2][m] : 0;
      const dp2 = n - 2 >= m ? dP[n - 2][m] : 0;
      P[n][m] = ((2 * n - 1) * s * P[n - 1][m] - K * p2) / denom;
      dP[n][m] = ((2 * n - 1) * (s * dP[n - 1][m] + c * P[n - 1][m]) - K * dp2) / denom;
    }
  }
  return { P, dP };
}

/**
 * Magnetic field at a geodetic position and time.
 *
 * @param {{latDeg: number, lonDeg: number, heightKm?: number,
 *          decimalYear: number}} p
 * @returns {{x, y, z, h, f, declinationDeg, inclinationDeg,
 *            xDot, yDot, zDot, hDot, fDot, declinationDotDeg,
 *            inclinationDotDeg, gridVariationDeg,
 *            decimalYear, inModelRange}}
 */
export function fieldAt({ latDeg, lonDeg, heightKm = 0, decimalYear }) {
  if (!Number.isFinite(latDeg) || Math.abs(latDeg) > 90) {
    throw new Error('Latitude must be a number in [-90, 90] degrees.');
  }
  if (!Number.isFinite(lonDeg)) throw new Error('Longitude must be a number.');
  if (!Number.isFinite(decimalYear)) throw new Error('decimalYear is required (use decimalYearOf).');
  const inModelRange = decimalYear >= WMM2025.epoch && decimalYear <= WMM2025.validUntil;
  const dt = decimalYear - WMM2025.epoch;

  // Geodetic -> geocentric (spherical) coordinates.
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const Rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const p = (Rc + heightKm) * cosPhi;
  const zc = (Rc * (1 - WGS84_E2) + heightKm) * sinPhi;
  const r = Math.hypot(p, zc);
  const phiC = Math.atan2(zc, p);

  const { P, dP } = legendre(phiC);
  const cosPhiC = Math.cos(phiC);
  const sinM = new Float64Array(NMAX + 1);
  const cosM = new Float64Array(NMAX + 1);
  for (let m = 0; m <= NMAX; m++) {
    sinM[m] = Math.sin(m * lam);
    cosM[m] = Math.cos(m * lam);
  }

  // Field and secular variation in the geocentric frame
  // (xp north, yp east, zp down at geocentric latitude phiC).
  let xp = 0; let yp = 0; let zp = 0;
  let xpDot = 0; let ypDot = 0; let zpDot = 0;
  let ratio = (GEOMAG_RE / r) * (GEOMAG_RE / r);
  for (let n = 1; n <= NMAX; n++) {
    ratio *= GEOMAG_RE / r; // (Re/r)^(n+2)
    for (let m = 0; m <= n; m++) {
      const gt = g0[n][m] + dt * gDot[n][m];
      const ht = h0[n][m] + dt * hDot[n][m];
      const cosTerm = gt * cosM[m] + ht * sinM[m];
      const sinTerm = gt * sinM[m] - ht * cosM[m];
      xp -= ratio * cosTerm * dP[n][m];
      yp += ratio * m * sinTerm * P[n][m];
      zp -= ratio * (n + 1) * cosTerm * P[n][m];
      const cosTermDot = gDot[n][m] * cosM[m] + hDot[n][m] * sinM[m];
      const sinTermDot = gDot[n][m] * sinM[m] - hDot[n][m] * cosM[m];
      xpDot -= ratio * cosTermDot * dP[n][m];
      ypDot += ratio * m * sinTermDot * P[n][m];
      zpDot -= ratio * (n + 1) * cosTermDot * P[n][m];
    }
  }
  // The 1/cos(phiC) of the east component; the two test latitudes are
  // ±80°, and drilling locations never sit numerically at the pole,
  // but guard the division anyway.
  const cp = Math.abs(cosPhiC) < 1e-12 ? 1e-12 : cosPhiC;
  yp /= cp;
  ypDot /= cp;

  // Rotate geocentric-frame components to the geodetic frame.
  const psi = phiC - phi;
  const cosPsi = Math.cos(psi);
  const sinPsi = Math.sin(psi);
  const x = xp * cosPsi - zp * sinPsi;
  const z = xp * sinPsi + zp * cosPsi;
  const y = yp;
  const xDot = xpDot * cosPsi - zpDot * sinPsi;
  const zDot = xpDot * sinPsi + zpDot * cosPsi;
  const yDot = ypDot;

  const h = Math.hypot(x, y);
  const f = Math.hypot(h, z);
  const declinationDeg = Math.atan2(y, x) / DEG;
  const inclinationDeg = Math.atan2(z, h) / DEG;
  const hDotOut = h > 0 ? (x * xDot + y * yDot) / h : 0;
  const fDot = f > 0 ? (x * xDot + y * yDot + z * zDot) / f : 0;
  const declinationDotDeg = h > 0 ? ((x * yDot - y * xDot) / (h * h)) / DEG : 0;
  const inclinationDotDeg = f > 0 ? ((h * zDot - z * hDotOut) / (f * f)) / DEG : 0;

  // Grid variation w.r.t. Universal Polar Stereographic grid north
  // (defined by the WMM for |lat| > 55°; null elsewhere).
  let gridVariationDeg = null;
  if (latDeg > 55) gridVariationDeg = wrapTo180(declinationDeg - lonDeg);
  else if (latDeg < -55) gridVariationDeg = wrapTo180(declinationDeg + lonDeg);

  return {
    x, y, z, h, f, declinationDeg, inclinationDeg,
    xDot, yDot, zDot, hDot: hDotOut, fDot,
    declinationDotDeg, inclinationDotDeg,
    gridVariationDeg, decimalYear, inModelRange,
  };
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapTo180(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Declination convenience for the planning UI: declination, dip and
 * total field at a wellhead. Height defaults to the ellipsoid surface;
 * the sub-0.01° effect of rig elevation is far below MWD accuracy.
 */
export function declinationAt({ latDeg, lonDeg, heightKm = 0, decimalYear }) {
  const fld = fieldAt({ latDeg, lonDeg, heightKm, decimalYear });
  return {
    declinationDeg: fld.declinationDeg,
    dipDeg: fld.inclinationDeg,
    totalFieldNt: fld.f,
    declinationDotDegPerYr: fld.declinationDotDeg,
    inModelRange: fld.inModelRange,
    model: WMM2025.model,
    epoch: WMM2025.epoch,
    validUntil: WMM2025.validUntil,
  };
}

/** Decimal year of a calendar date (UTC), e.g. 2026-08-25 -> 2026.649. */
export function decimalYearOf(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error('decimalYearOf needs numeric year, month (1-12), day.');
  }
  const start = Date.UTC(year, 0, 1);
  const next = Date.UTC(year + 1, 0, 1);
  const t = Date.UTC(year, month - 1, day);
  return year + (t - start) / (next - start);
}

export { WMM2025 };
