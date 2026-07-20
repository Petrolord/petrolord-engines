// Fractional flow / Buckley-Leverett engine.
//
// Relative permeability (Corey model or a tabular curve set) -> water
// fractional flow fw(Sw), optionally with the gravity/dip term -> Welge
// tangent construction -> front saturation, breakthrough, and oil recovery vs
// pore volumes injected. Immiscible, capillary pressure neglected (the
// classic 1-D Buckley-Leverett displacement, Dake "Fundamentals of Reservoir
// Engineering" Ch.10 / Willhite "Waterflooding" Ch.3).
//
// Corey model on normalized saturation Swn = (Sw - Swc)/(1 - Swc - Sor):
//   krw = krwMax * Swn^nw
//   kro = kroMax * (1 - Swn)^no
// Fractional flow (horizontal):
//   fw = 1 / (1 + (kro * muW) / (krw * muO))
// With the dip/gravity term, field units (k md, A ft2, qt rb/d, mu cp,
// gamma = specific gravity, alpha = dip angle, displacement updip positive):
//   fw = [1 - 0.001127*0.433 * k*kro*A*(gw-go)*sin(alpha) / (muO*qt)]
//        / [1 + (kro*muW)/(krw*muO)]
// (0.001127 = field-unit Darcy constant, 0.433 psi/ft per unit specific
// gravity; water denser than oil moving updip reduces fw.)

const GRAV_CONST = 0.001127 * 0.433; // 4.880e-4, see header

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function coreyKr(Sw, p) {
  const { Swc, Sor, krwMax, kroMax, nw, no } = p;
  const denom = 1 - Swc - Sor;
  const Swn = denom > 0 ? clamp01((Sw - Swc) / denom) : 0;
  return {
    Swn,
    krw: krwMax * Math.pow(Swn, nw),
    kro: kroMax * Math.pow(1 - Swn, no),
  };
}

export function fractionalFlow(Sw, p, muW, muO) {
  const { krw, kro } = coreyKr(Sw, p);
  if (krw <= 0) return 0;
  if (kro <= 0) return 1;
  return 1 / (1 + (kro * muW) / (krw * muO));
}

// Endpoint mobility ratio M = (krw@Sor / muW) / (kro@Swc / muO). M > 1 is unfavorable.
export function mobilityRatio(p, muW, muO) {
  return (p.krwMax / muW) / (p.kroMax / muO);
}

// Sampled kr + fw curves across the mobile saturation range [Swc, 1-Sor].
export function buildCurves(p, muW, muO, n = 101) {
  const lo = p.Swc;
  const hi = 1 - p.Sor;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const { krw, kro } = coreyKr(Sw, p);
    pts.push({ Sw, krw, kro, fw: fractionalFlow(Sw, p, muW, muO) });
  }
  return pts;
}

// Numerical dfw/dSw (central difference).
function dfwdSw(Sw, p, muW, muO, h = 1e-4) {
  return (fractionalFlow(Sw + h, p, muW, muO) - fractionalFlow(Sw - h, p, muW, muO)) / (2 * h);
}

// Welge tangent from (Swc, 0): the front saturation Swf is where the secant slope
// fw/(Sw - Swc) is maximal (= tangency). That slope is fw'(Swf).
export function welgeTangent(p, muW, muO, n = 1000) {
  const { Swc, Sor } = p;
  const lo = Swc;
  const hi = 1 - Sor;
  let Swf = null;
  let fwf = 0;
  let best = -Infinity;
  for (let i = 1; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const d = Sw - Swc;
    if (d <= 1e-6) continue;
    const f = fractionalFlow(Sw, p, muW, muO);
    const slope = f / d;
    if (slope > best) {
      best = slope;
      Swf = Sw;
      fwf = f;
    }
  }
  const fwPrimeF = best > 0 ? best : null; // secant slope == tangent slope at the front
  const QiBt = fwPrimeF ? 1 / fwPrimeF : null; // pore volumes injected at breakthrough
  const SwAvgBt = fwPrimeF ? Swc + 1 / fwPrimeF : null; // avg Sw behind front at BT
  const EDbt = SwAvgBt != null ? (SwAvgBt - Swc) / (1 - Swc) : null; // displacement eff. at BT
  const EDmax = (1 - Sor - Swc) / (1 - Swc); // ultimate displacement efficiency
  return { Swf, fwf, fwPrimeF, QiBt, SwAvgBt, EDbt, EDmax };
}

// Oil recovery (displacement efficiency) vs pore volumes injected, from
// breakthrough to residual. For an outlet saturation Sw2 > Swf:
//   Qi = 1 / fw'(Sw2);  SwAvg = Sw2 + (1 - fw(Sw2)) / fw'(Sw2);  ED = (SwAvg - Swc)/(1 - Swc)
export function recoveryProfile(p, muW, muO, bl, n = 40) {
  const { Swc, Sor } = p;
  const hi = 1 - Sor;
  const pts = [];
  if (bl.QiBt != null) {
    pts.push({ Sw2: bl.Swf, Qi: bl.QiBt, SwAvg: bl.SwAvgBt, ED: bl.EDbt, fw: bl.fwf, breakthrough: true });
  }
  for (let i = 1; i <= n; i++) {
    const Sw2 = bl.Swf + ((hi - bl.Swf) * i) / n;
    const d = dfwdSw(Sw2, p, muW, muO);
    if (!(d > 0)) continue;
    const f = fractionalFlow(Sw2, p, muW, muO);
    const Qi = 1 / d;
    const SwAvg = Sw2 + (1 - f) / d;
    const ED = (SwAvg - Swc) / (1 - Swc);
    pts.push({ Sw2, Qi, SwAvg, ED, fw: f });
  }
  return pts;
}

export function analyzeFractionalFlow(p, muW, muO) {
  const curves = buildCurves(p, muW, muO);
  const bl = welgeTangent(p, muW, muO);
  const recovery = recoveryProfile(p, muW, muO, bl);
  const M = mobilityRatio(p, muW, muO);
  return { curves, bl, recovery, M };
}

export function sampleFractionalFlowData() {
  return {
    params: { Swc: 0.2, Sor: 0.2, krwMax: 0.4, kroMax: 1.0, nw: 2, no: 2 },
    muW: 0.5, // cp
    muO: 5.0, // cp
  };
}

// ---------------------------------------------------------------------------
// Generalized displacement API (Waterflood Design Studio, W2)
// ---------------------------------------------------------------------------
// Everything below layers on the classic engine above without changing it:
// tabular rel-perm input, endpoint normalization, the gravity/dip fw term,
// polymer (viscosified water) screening, and PV<->time conversion.

/**
 * Validate and clean a tabular rel-perm curve set.
 * rows: [{ Sw, krw, kro }] in any order. Returns { ok, errors, table } where
 * table is sorted by Sw. Physics checks: Sw strictly increasing after sort,
 * all values in [0,1], krw non-decreasing, kro non-increasing, krw starts at
 * 0 (connate water immobile) and kro ends at 0 (residual oil immobile).
 */
export function validateKrTable(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length < 3) {
    return { ok: false, errors: ['A rel-perm table needs at least 3 rows.'], table: [] };
  }
  const table = rows
    .map((r) => ({ Sw: Number(r.Sw), krw: Number(r.krw), kro: Number(r.kro) }))
    .filter((r) => [r.Sw, r.krw, r.kro].every(Number.isFinite))
    .sort((a, b) => a.Sw - b.Sw);
  if (table.length < 3) errors.push('Fewer than 3 numeric rows.');
  for (let i = 0; i < table.length; i++) {
    const r = table[i];
    if (r.Sw < 0 || r.Sw > 1 || r.krw < 0 || r.krw > 1 || r.kro < 0 || r.kro > 1) {
      errors.push(`Row ${i + 1}: Sw/krw/kro must be within [0, 1].`);
      break;
    }
  }
  for (let i = 1; i < table.length; i++) {
    if (table[i].Sw - table[i - 1].Sw < 1e-9) { errors.push('Duplicate Sw values.'); break; }
  }
  for (let i = 1; i < table.length; i++) {
    if (table[i].krw < table[i - 1].krw - 1e-9) { errors.push('krw must be non-decreasing in Sw.'); break; }
    if (table[i].kro > table[i - 1].kro + 1e-9) { errors.push('kro must be non-increasing in Sw.'); break; }
  }
  if (table.length >= 3) {
    if (table[0].krw > 1e-6) errors.push('krw at the lowest Sw should be 0 (connate water immobile).');
    if (table[table.length - 1].kro > 1e-6) errors.push('kro at the highest Sw should be 0 (residual oil immobile).');
  }
  return { ok: errors.length === 0, errors, table };
}

/** Endpoints implied by a (validated) kr table: Swc = first Sw, Sor = 1 - last Sw. */
export function krTableEndpoints(table) {
  return { Swc: table[0].Sw, Sor: 1 - table[table.length - 1].Sw };
}

/**
 * Rescale a kr curve shape onto new endpoints (the standard normalized-Sw
 * scaling used to move lab curves between rock types): the source table is
 * read as shape vs Swn = (Sw - Swc)/(1 - Swc - Sor) and re-sampled onto the
 * target { Swc, Sor, krwMax, kroMax }.
 */
export function scaleKrTable(table, target, n = 25) {
  const src = krTableEndpoints(table);
  const srcSpan = 1 - src.Swc - src.Sor;
  const tgtSpan = 1 - target.Swc - target.Sor;
  const srcKrwMax = table[table.length - 1].krw;
  const srcKroMax = table[0].kro;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const Swn = i / n;
    const SwSrc = src.Swc + Swn * srcSpan;
    const { krw, kro } = interpKr(table, SwSrc);
    out.push({
      Sw: target.Swc + Swn * tgtSpan,
      krw: srcKrwMax > 0 ? (krw / srcKrwMax) * target.krwMax : 0,
      kro: srcKroMax > 0 ? (kro / srcKroMax) * target.kroMax : 0,
    });
  }
  return out;
}

function interpKr(table, Sw) {
  if (Sw <= table[0].Sw) return { krw: table[0].krw, kro: table[0].kro };
  const last = table[table.length - 1];
  if (Sw >= last.Sw) return { krw: last.krw, kro: last.kro };
  let i = 1;
  while (table[i].Sw < Sw) i++;
  const a = table[i - 1];
  const b = table[i];
  const t = (Sw - a.Sw) / (b.Sw - a.Sw);
  return { krw: a.krw + t * (b.krw - a.krw), kro: a.kro + t * (b.kro - a.kro) };
}

/**
 * Build kr(Sw) -> { krw, kro } plus endpoints from a spec:
 *   { type: 'corey', Swc, Sor, krwMax, kroMax, nw, no }
 *   { type: 'table', rows: [{Sw, krw, kro}] }   (validated internally)
 * Throws on an invalid table.
 */
export function makeKrFunction(krSpec) {
  if (!krSpec || krSpec.type === 'corey' || krSpec.type === undefined) {
    const p = krSpec?.type === 'corey' ? krSpec : krSpec || {};
    return {
      kr: (Sw) => coreyKr(Sw, p),
      Swc: p.Swc,
      Sor: p.Sor,
      krwMax: p.krwMax,
      kroMax: p.kroMax,
    };
  }
  if (krSpec.type === 'table') {
    const { ok, errors, table } = validateKrTable(krSpec.rows);
    if (!ok) throw new Error(`Invalid rel-perm table: ${errors[0]}`);
    const { Swc, Sor } = krTableEndpoints(table);
    return {
      kr: (Sw) => interpKr(table, Sw),
      Swc,
      Sor,
      krwMax: table[table.length - 1].krw,
      kroMax: table[0].kro,
      table,
    };
  }
  throw new Error(`Unknown kr spec type: ${krSpec.type}`);
}

/**
 * Dimensionless gravity number for the fw dip term (field units; see header):
 * Ng(kro) = GRAV_CONST * k * kro * A * (gammaW - gammaO) * sin(alpha) / (muO * qt).
 * gravity = { k_md, A_ft2, qt_rbd, dipDeg, gammaW, gammaO }.
 */
function gravityCoefficient(gravity, muO) {
  if (!gravity) return 0;
  const { k_md, A_ft2, qt_rbd, dipDeg, gammaW, gammaO } = gravity;
  if (![k_md, A_ft2, qt_rbd, dipDeg, gammaW, gammaO].every(Number.isFinite)) return 0;
  if (!(qt_rbd > 0) || !(muO > 0)) return 0;
  return (GRAV_CONST * k_md * A_ft2 * (gammaW - gammaO) * Math.sin((dipDeg * Math.PI) / 180)) / (muO * qt_rbd);
}

/**
 * Generalized fractional flow at Sw for a displacement spec:
 *   { krSpec, muW, muO, gravity?, polymerMuMult? }
 * Result clamped to [0, 1] (a strong gravity assist can drive raw fw
 * negative; physically water then does not flow).
 */
export function makeFwFunction(spec) {
  const { muO, gravity, polymerMuMult } = spec;
  const muW = spec.muW * (polymerMuMult > 0 ? polymerMuMult : 1);
  const krFn = makeKrFunction(spec.krSpec);
  const gCoef = gravityCoefficient(gravity, muO);
  const fw = (Sw) => {
    const { krw, kro } = krFn.kr(Sw);
    if (krw <= 0) return 0;
    if (kro <= 0) return 1;
    const numer = 1 - gCoef * kro;
    const denom = 1 + (kro * muW) / (krw * muO);
    return clamp01(numer / denom);
  };
  return { fw, krFn, muWeff: muW, gravityCoefficient: gCoef };
}

// Welge tangent from (Swc, 0) for an arbitrary fw(Sw) function.
export function welgeTangentGeneral(fw, Swc, Sor, n = 1000) {
  const lo = Swc;
  const hi = 1 - Sor;
  let Swf = null;
  let fwf = 0;
  let best = -Infinity;
  for (let i = 1; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const d = Sw - Swc;
    if (d <= 1e-6) continue;
    const f = fw(Sw);
    const slope = f / d;
    if (slope > best) {
      best = slope;
      Swf = Sw;
      fwf = f;
    }
  }
  const fwPrimeF = best > 0 ? best : null;
  const QiBt = fwPrimeF ? 1 / fwPrimeF : null;
  const SwAvgBt = fwPrimeF ? Swc + 1 / fwPrimeF : null;
  const EDbt = SwAvgBt != null ? (SwAvgBt - Swc) / (1 - Swc) : null;
  const EDmax = (1 - Sor - Swc) / (1 - Swc);
  return { Swf, fwf, fwPrimeF, QiBt, SwAvgBt, EDbt, EDmax };
}

// Post-breakthrough recovery for an arbitrary fw(Sw): same Welge relations
// as recoveryProfile above, numeric derivative on the supplied fw.
export function recoveryProfileGeneral(fw, Swc, Sor, bl, n = 40) {
  const hi = 1 - Sor;
  const h = 1e-4;
  const pts = [];
  if (bl.QiBt != null) {
    pts.push({ Sw2: bl.Swf, Qi: bl.QiBt, SwAvg: bl.SwAvgBt, ED: bl.EDbt, fw: bl.fwf, breakthrough: true });
  }
  for (let i = 1; i <= n; i++) {
    const Sw2 = bl.Swf + ((hi - bl.Swf) * i) / n;
    const d = (fw(Sw2 + h) - fw(Sw2 - h)) / (2 * h);
    if (!(d > 0)) continue;
    const f = fw(Sw2);
    const Qi = 1 / d;
    const SwAvg = Sw2 + (1 - f) / d;
    const ED = (SwAvg - Swc) / (1 - Swc);
    pts.push({ Sw2, Qi, SwAvg, ED, fw: f });
  }
  return pts;
}

/**
 * Full generalized displacement analysis.
 * spec = { krSpec, muW, muO, gravity?, polymerMuMult? }
 * Returns { curves, bl, recovery, M, warnings, muWeff }.
 */
export function analyzeDisplacement(spec, n = 101) {
  const warnings = [];
  const { fw, krFn, muWeff, gravityCoefficient: gCoef } = makeFwFunction(spec);
  const { Swc, Sor, krwMax, kroMax } = krFn;
  const lo = Swc;
  const hi = 1 - Sor;
  const curves = [];
  for (let i = 0; i <= n; i++) {
    const Sw = lo + ((hi - lo) * i) / n;
    const { krw, kro } = krFn.kr(Sw);
    curves.push({ Sw, krw, kro, fw: fw(Sw) });
  }
  const bl = welgeTangentGeneral(fw, Swc, Sor);
  const recovery = recoveryProfileGeneral(fw, Swc, Sor, bl);
  const M = (krwMax / muWeff) / (kroMax / spec.muO);
  if (gCoef !== 0 && curves.some((c) => c.fw === 0 && c.Sw > Swc + 1e-6)) {
    warnings.push('Gravity assist is strong enough to hold fw at zero over part of the saturation range (gravity-stable displacement).');
  }
  if (spec.polymerMuMult > 1) {
    warnings.push('Polymer case: water viscosity multiplied for screening only; no adsorption, permeability reduction, or rheology effects.');
  }
  return { curves, bl, recovery, M, warnings, muWeff };
}

// PV <-> time conversion for a flood element: Qi (pore volumes injected)
// against days at constant injection rate. pvBbl = pore volume in barrels.
export function pvToDays(Qi, { pvBbl, iw_bpd }) {
  if (!(pvBbl > 0) || !(iw_bpd > 0)) return null;
  return (Qi * pvBbl) / iw_bpd;
}
export function daysToPv(days, { pvBbl, iw_bpd }) {
  if (!(pvBbl > 0) || !(iw_bpd > 0)) return null;
  return (days * iw_bpd) / pvBbl;
}
