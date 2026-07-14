// Porosity transforms (Petrophysics Studio G2.1) — density, sonic
// (Wyllie + Raymer-Hunt-Gardner), neutron-density combinations, shale
// correction. Cores UNCLAMPED (see vsh.js header for the shared engine
// conventions); use clampDisplay for track/crossplot rendering.
// Matrix/fluid constants are ALWAYS explicit parameters — defaults
// live in the UI parameter panel, never silently in here. Sonic in any
// consistent slowness unit (registry curves are us/m, SI rule).

/** Density porosity: (rho_ma - rho_b)/(rho_ma - rho_fl). */
export function phiDensity(rhob, rhoMa, rhoFl) {
  if (!(rhoMa > rhoFl)) throw new Error('Matrix density must exceed fluid density.');
  return Number.isFinite(rhob) ? (rhoMa - rhob) / (rhoMa - rhoFl) : NaN;
}

/** Wyllie, Gregory & Gardner (1956) time average, cp = compaction
 *  factor (>= 1, 1 = none). */
export function phiSonicWyllie(dt, dtMa, dtFl, cp = 1) {
  if (!(dtFl > dtMa)) throw new Error('Fluid slowness must exceed matrix slowness.');
  if (!(cp >= 1)) throw new Error('Compaction factor must be >= 1.');
  return Number.isFinite(dt) ? (dt - dtMa) / (dtFl - dtMa) / cp : NaN;
}

/** Raymer, Hunt & Gardner (1980): C*(dt-dt_ma)/dt, C typically 0.67. */
export function phiSonicRhg(dt, dtMa, c = 0.67) {
  return Number.isFinite(dt) && dt !== 0 ? (c * (dt - dtMa)) / dt : NaN;
}

/** Neutron-density combination. 'avg' = (phiN+phiD)/2 (oil/water);
 *  'rms' = sqrt((phiN^2+phiD^2)/2) (gas form). NPHI must already be
 *  v/v — the import layer owns percent handling, not the math. */
export function phiNd(phiD, phiN, method = 'avg') {
  if (!Number.isFinite(phiD) || !Number.isFinite(phiN)) return NaN;
  if (method === 'rms') return Math.sqrt((phiD * phiD + phiN * phiN) / 2);
  if (method === 'avg') return (phiD + phiN) / 2;
  throw new Error(`Unknown neutron-density method "${method}".`);
}

/** Linear shale-point correction: phi_e = phi - Vsh*phiShaleApparent. */
export function phiShaleCorrected(phi, vsh, phiShale) {
  return Number.isFinite(phi) && Number.isFinite(vsh) ? phi - vsh * phiShale : NaN;
}

/** Display clamp for tracks/crossplots — NEVER applied before golden
 *  comparison or cutoff logic other than where the contract says so. */
export const clampDisplay = (v, lo = 0, hi = 1) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : NaN);
