// Segment compiler (Well Design Studio WD0): turns a designer's segment
// list into minimum-curvature survey stations plus a survey table and QA.
//
// The unit rule that fixes the legacy app's ft/m defect: every length
// stays in the caller's depth unit ('m' | 'ft') end to end, and rates
// are degrees per 30 (metres) or per 100 (feet) OF THAT SAME UNIT.
// Nothing is silently converted. Cross-convention reporting uses the
// exact identity DLS[°/100ft] = DLS[°/30m] · 30.48/30 (surveyMath).
//
// Segment kinds:
//   hold        {length}
//   build       {rate, length | targetInc}       toolface 0/180 arc
//   turn        {rate, length | targetAzi}       constant-inc small
//                                                circle, subdivided
//   buildTurn   {buildRate, turnRate, length}    subdivided
//   toolfaceArc {dls, toolfaceDeg, length}       exact circular arc via
//                                                the spherical triangle
//
// A 'turn' at constant inclination and a simultaneous 'buildTurn' are
// NOT circular arcs, so they are emitted as stations every subdivideMd
// and the minimum-curvature discretization error stays O((κ·Δs)³). The
// toolfaceArc is a true circle: intermediate stations are sampled from
// the same closed form and are exact.
//
// Pure math, worker-safe, no I/O.

import {
  computeWellPath, computeSurveyTable, doglegSeverity, normalizeAzi,
} from './surveyMath.js';

const DEG = Math.PI / 180;

function ratePerUnit(rate, mdUnit) {
  return rate / (mdUnit === 'ft' ? 100 : 30);
}

/**
 * Attitude after travelling an arc angle betaRad from (incDeg, aziDeg)
 * with initial toolface tauDeg (clockwise from highside). Spherical
 * triangle closed form:
 *   cos I2 = cos I1·cos β − sin I1·sin β·cos τ
 *   ΔA    = atan2(sin β·sin τ, sin I1·cos β + cos I1·sin β·cos τ)
 * Limits: τ=0 → I2 = I1+β (pure build); I1=90°, τ=90° → ΔA = β (turn).
 * At I1 = 0 the highside is undefined; toolface is then measured from
 * north (the standard convention for kicking off a vertical hole).
 */
export function attitudeAfterArc(incDeg, aziDeg, betaRad, tauDeg) {
  const i1 = incDeg * DEG;
  const tau = tauDeg * DEG;
  const ci = Math.cos(i1) * Math.cos(betaRad)
    - Math.sin(i1) * Math.sin(betaRad) * Math.cos(tau);
  const inc2 = Math.acos(Math.max(-1, Math.min(1, ci))) / DEG;
  const dA = Math.atan2(
    Math.sin(betaRad) * Math.sin(tau),
    Math.sin(i1) * Math.cos(betaRad) + Math.cos(i1) * Math.sin(betaRad) * Math.cos(tau),
  ) / DEG;
  // At I1 = 0 the formula's ΔA is measured from north, which is exactly
  // the toolface-from-north convention; the azimuth becomes absolute.
  const azi2 = incDeg < 1e-9 ? normalizeAzi(dA) : normalizeAzi(aziDeg + dA);
  return { inc: inc2, azi: azi2 };
}

function emitSubdivided(out, start, length, subdivideMd, attitudeAt) {
  const n = Math.max(1, Math.ceil(length / subdivideMd));
  for (let k = 1; k <= n; k++) {
    const ds = (length * k) / n;
    const att = attitudeAt(ds);
    out.push({ md: start.md + ds, inc: att.inc, azi: att.azi });
  }
  return out[out.length - 1];
}

/**
 * Compile segments from a tie-on into survey stations + table + QA.
 *
 * @param {{
 *   tieOn?: {md?: number, inc?: number, azi?: number},
 *   segments: Array<object>,
 *   mdUnit?: 'm'|'ft',
 *   subdivideMd?: number,
 *   maxDls?: number|null,        // in the mdUnit's own convention
 *   surfaceX?: number, surfaceY?: number, kb?: number,
 *   vsAzimuthDeg?: number|null,
 * }} spec
 * @returns {{stations, path, table, qa}}
 */
export function compileSegments({
  tieOn = {}, segments = [], mdUnit = 'm', subdivideMd = 10,
  maxDls = null, surfaceX = 0, surfaceY = 0, kb = 0, vsAzimuthDeg = null,
} = {}) {
  if (mdUnit !== 'm' && mdUnit !== 'ft') {
    throw new Error(`Unknown depth unit "${mdUnit}" (use 'm' or 'ft').`);
  }
  const start = {
    md: Number.isFinite(tieOn.md) ? tieOn.md : 0,
    inc: Number.isFinite(tieOn.inc) ? tieOn.inc : 0,
    azi: normalizeAzi(Number.isFinite(tieOn.azi) ? tieOn.azi : 0),
  };
  const stations = [{ ...start }];
  const segReports = [];
  let cur = { ...start };

  segments.forEach((seg, idx) => {
    const kind = seg.kind || seg.type;
    const report = { index: idx, kind, fromMd: cur.md };
    const fail = (msg) => { throw new Error(`Segment ${idx + 1} (${kind}): ${msg}`); };

    if (kind === 'hold') {
      const L = seg.length;
      if (!(L > 0)) fail('length must be positive.');
      // A hold is exact with the endpoint alone, but emit intermediate
      // stations so MD-axis strip charts stay dense across long holds
      // (WD3 polish; the trajectory itself is unchanged).
      const inc0 = cur.inc;
      const azi0 = cur.azi;
      cur = emitSubdivided(stations, cur, L, subdivideMd, () => ({
        inc: inc0, azi: azi0,
      }));
    } else if (kind === 'build') {
      const rate = seg.rate;
      if (!(Math.abs(rate) > 0)) fail('rate must be nonzero.');
      const rpu = ratePerUnit(rate, mdUnit);
      let L = seg.length;
      if (!(L > 0)) {
        if (!Number.isFinite(seg.targetInc)) fail('needs length or targetInc.');
        L = (seg.targetInc - cur.inc) / rpu;
        if (!(L > 0)) fail('targetInc is not reachable with this rate sign.');
      }
      const endInc = cur.inc + rpu * L;
      if (endInc < 0 || endInc > 180) fail(`end inclination ${endInc.toFixed(2)}° is outside 0–180°.`);
      // A pure build is a vertical-plane circular arc (toolface 0/180):
      // exact with endpoints only, but subdivide for listing smoothness.
      const inc0 = cur.inc;
      cur = emitSubdivided(stations, cur, L, subdivideMd, (ds) => ({
        inc: inc0 + rpu * ds, azi: cur.azi,
      }));
    } else if (kind === 'turn') {
      const rate = seg.rate;
      if (!(Math.abs(rate) > 0)) fail('rate must be nonzero.');
      if (cur.inc < 1e-6) fail('cannot turn a vertical hole; build first (azimuth is undefined at 0° inclination).');
      const rpu = ratePerUnit(rate, mdUnit);
      let L = seg.length;
      if (!(L > 0)) {
        if (!Number.isFinite(seg.targetAzi)) fail('needs length or targetAzi.');
        let dAzi = normalizeAzi(seg.targetAzi) - cur.azi;
        dAzi = ((dAzi % 360) + 360) % 360;
        if (rpu < 0) dAzi -= 360;
        L = dAzi / rpu;
        if (!(L > 0)) fail('targetAzi is not reachable with this rate sign.');
      }
      const azi0 = cur.azi;
      const inc0 = cur.inc;
      cur = emitSubdivided(stations, cur, L, subdivideMd, (ds) => ({
        inc: inc0, azi: normalizeAzi(azi0 + rpu * ds),
      }));
    } else if (kind === 'buildTurn') {
      const { buildRate = 0, turnRate = 0, length: L } = seg;
      if (!(L > 0)) fail('length must be positive.');
      if (cur.inc < 1e-6 && Math.abs(turnRate) > 0) {
        fail('cannot turn a vertical hole; build first.');
      }
      const bpu = ratePerUnit(buildRate, mdUnit);
      const tpu = ratePerUnit(turnRate, mdUnit);
      const inc0 = cur.inc;
      const azi0 = cur.azi;
      const endInc = inc0 + bpu * L;
      if (endInc < 0 || endInc > 180) fail(`end inclination ${endInc.toFixed(2)}° is outside 0–180°.`);
      cur = emitSubdivided(stations, cur, L, subdivideMd, (ds) => ({
        inc: inc0 + bpu * ds, azi: normalizeAzi(azi0 + tpu * ds),
      }));
    } else if (kind === 'toolfaceArc') {
      const { dls, toolfaceDeg, length: L } = seg;
      if (!(L > 0)) fail('length must be positive.');
      if (!(dls > 0)) fail('dls must be positive.');
      if (!Number.isFinite(toolfaceDeg)) fail('toolfaceDeg is required.');
      const betaTotal = ratePerUnit(dls, mdUnit) * L * DEG;
      const inc0 = cur.inc;
      const azi0 = cur.azi;
      cur = emitSubdivided(stations, cur, L, subdivideMd, (ds) => (
        attitudeAfterArc(inc0, azi0, betaTotal * (ds / L), toolfaceDeg)
      ));
    } else {
      fail('unknown segment kind.');
    }

    report.toMd = cur.md;
    segReports.push(report);
  });

  const path = computeWellPath(stations, { surfaceX, surfaceY, kb });
  const table = computeSurveyTable(stations, {
    surfaceX, surfaceY, kb, mdUnit, vsAzimuthDeg,
  });

  // QA: honest, physically meaningful checks only.
  const dlsKey = mdUnit === 'ft' ? 'dls100ft' : 'dls30m';
  let worstDls = 0;
  for (let i = 1; i < stations.length; i++) {
    const d = doglegSeverity(stations[i - 1], stations[i], { mdUnit })[dlsKey];
    if (d > worstDls) worstDls = d;
  }
  const dlsExceeded = maxDls != null && worstDls > maxDls + 1e-9;
  let physical = true;
  for (let i = 1; i < path.length; i++) {
    if (path[i].tvd - path[i - 1].tvd > (stations[i].md - stations[i - 1].md) + 1e-9) {
      physical = false;
      break;
    }
  }
  const qa = {
    ok: physical && !dlsExceeded,
    physicalBound: physical,
    worstDls,
    dlsConvention: mdUnit === 'ft' ? 'deg/100ft' : 'deg/30m',
    dlsExceeded,
    maxDls,
  };

  return { stations, path, table, qa, segments: segReports };
}
