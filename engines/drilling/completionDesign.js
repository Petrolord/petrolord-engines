// Completion string design engine (Drilling D7 — Completion Design Studio):
// API 5CT drift diameters, completion stack-up (tally), run-in clearance
// against the exposed casing program, through-bore (wireline access)
// restriction profile, completion volumes, and seal space-out.
//
// Published bases:
//   * Drift: the API 5CT standard drift mandrel diameters —
//       tubing:  d = ID − 2.38 mm (3/32")
//       casing:  d = ID − 3.18 mm (1/8")  for OD ≤ 8-5/8"
//                d = ID − 3.97 mm (5/32") for 9-5/8" ≤ OD ≤ 13-3/8"
//                d = ID − 4.76 mm (3/16") for OD ≥ 16"
//     (spot value: 9-5/8" 47# ID 8.681" → drift 8.525").
//   * Capacities: plain geometry, V = π/4·D²·L (the field bbl/ft identity
//     ID²/1029.4 is the same formula in oilfield units and is used as an
//     oracle spot check, e.g. 2-7/8" 6.5# → 0.00579 bbl/ft).
//
// UNITS: STRICT SI (metres, m³). No unit conversion happens here except
// the documented API drift constants above, defined in mm.
//
// The engine takes the casing program as EXPLICIT section arrays (built
// app-side from the D6 wp_ct_cases casing strings or entered manually) —
// no cross-domain imports, the same contract style as geomech.js.
//
// Validation: independent numpy oracle (oracle_completion.py) with
// self-asserted closed forms + goldens; jest gates in
// __tests__/drilling.completion.test.js.

const IN = 0.0254;

// API 5CT standard drift mandrel deductions — exact inch fractions (the
// mm values printed in tables are roundings of these).
export const DRIFT_DEDUCTION_TUBING_M = (3 / 32) * IN;
export const DRIFT_DEDUCTION_CASING_SMALL_M = (1 / 8) * IN; // OD ≤ 8-5/8"
export const DRIFT_DEDUCTION_CASING_MID_M = (5 / 32) * IN; // 9-5/8"–13-3/8"
export const DRIFT_DEDUCTION_CASING_LARGE_M = (3 / 16) * IN; // OD ≥ 16"

const OD_8_625 = 8.625 * IN;
const OD_13_375 = 13.375 * IN;

export function apiDriftM({ odM, idM, kind = 'casing' }) {
  if (!(odM > 0) || !(idM > 0) || idM >= odM) throw new Error('Invalid OD/ID.');
  if (kind === 'tubing') return idM - DRIFT_DEDUCTION_TUBING_M;
  if (kind !== 'casing') throw new Error(`Unknown tubular kind "${kind}".`);
  if (odM <= OD_8_625) return idM - DRIFT_DEDUCTION_CASING_SMALL_M;
  if (odM <= OD_13_375) return idM - DRIFT_DEDUCTION_CASING_MID_M;
  return idM - DRIFT_DEDUCTION_CASING_LARGE_M;
}

// ---- stack-up ---------------------------------------------------------------

// components: ordered TOP → BOTTOM, each { type, name, lengthM, odM, idM }.
// Returns the same rows with topMdM/bottomMdM stacked from hangerMdM.
export function buildStack({ hangerMdM = 0, components }) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('Stack needs at least one component.');
  }
  if (!(hangerMdM >= 0)) throw new Error('Hanger MD must be >= 0.');
  let md = hangerMdM;
  const rows = components.map((c, i) => {
    if (!(c.lengthM > 0)) throw new Error(`Component ${i + 1} (${c.name || c.type}) needs a positive length.`);
    if (!(c.odM > 0) || !(c.idM >= 0) || c.idM >= c.odM) {
      throw new Error(`Component ${i + 1} (${c.name || c.type}) has invalid OD/ID.`);
    }
    const topMdM = md;
    md += c.lengthM;
    return { ...c, topMdM, bottomMdM: md };
  });
  return {
    hangerMdM,
    components: rows,
    lengthM: md - hangerMdM,
    bottomMdM: md,
  };
}

// ---- exposed casing program -------------------------------------------------

// strings: [{ name, sections: [{ topMdM, bottomMdM, odM, idM }] }] — every
// casing/liner string covering the completion. Returns the innermost
// EXPOSED bore vs MD as a sorted interval list: at any MD the governing
// bore is the smallest ID among covering sections, with its API drift.
export function casingProgramProfile(strings) {
  const sections = [];
  (strings || []).forEach((s) => (s.sections || []).forEach((sec, i) => {
    if (!(sec.bottomMdM > sec.topMdM)) throw new Error(`Section ${i + 1} of ${s.name || 'string'} has non-positive length.`);
    if (!(sec.odM > sec.idM) || !(sec.idM > 0)) throw new Error(`Section ${i + 1} of ${s.name || 'string'} has invalid OD/ID.`);
    sections.push({ ...sec, label: s.name || 'casing' });
  }));
  if (sections.length === 0) return [];
  const cuts = [...new Set(sections.flatMap((s) => [s.topMdM, s.bottomMdM]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const top = cuts[i];
    const bottom = cuts[i + 1];
    const mid = (top + bottom) / 2;
    const covering = sections.filter((s) => s.topMdM <= mid && mid < s.bottomMdM);
    if (covering.length === 0) continue;
    const inner = covering.reduce((a, b) => (b.idM < a.idM ? b : a));
    const seg = {
      topMdM: top, bottomMdM: bottom, idM: inner.idM, odM: inner.odM,
      driftM: apiDriftM({ odM: inner.odM, idM: inner.idM, kind: 'casing' }),
      label: inner.label,
    };
    const prev = out[out.length - 1];
    if (prev && prev.bottomMdM === seg.topMdM && prev.idM === seg.idM && prev.label === seg.label) {
      prev.bottomMdM = seg.bottomMdM;
    } else {
      out.push(seg);
    }
  }
  return out;
}

// Governing (minimum) drift over the run-in path [0, mdM]; null when the
// profile does not reach mdM from surface without a gap.
export function governingDriftTo(profile, mdM) {
  if (!(mdM > 0)) throw new Error('Depth must be positive.');
  let best = null;
  let covered = 0;
  for (const seg of profile) {
    if (seg.topMdM > covered + 1e-9) break; // gap
    if (seg.topMdM >= mdM) break;
    if (best === null || seg.driftM < best.driftM) {
      best = { driftM: seg.driftM, label: seg.label, idM: seg.idM };
    }
    covered = Math.max(covered, seg.bottomMdM);
    if (covered >= mdM) return best;
  }
  return covered >= mdM ? best : null;
}

// ---- clearance checks -------------------------------------------------------

// Each component runs in through every casing interval above its final
// bottom depth: clearance = (min drift over [0, bottom]) − component OD.
// FAIL below zero, WARN below warnMarginM (default 3 mm diametral).
export function runInClearance({ stack, profile, warnMarginM = 0.003 }) {
  const rows = stack.components.map((c) => {
    const gov = governingDriftTo(profile, c.bottomMdM);
    if (!gov) {
      return {
        name: c.name || c.type, type: c.type, odM: c.odM, bottomMdM: c.bottomMdM,
        governingDriftM: null, controlling: null, clearanceM: null, status: 'UNKNOWN',
      };
    }
    const clearanceM = gov.driftM - c.odM;
    const status = clearanceM < 0 ? 'FAIL' : clearanceM < warnMarginM ? 'WARN' : 'PASS';
    return {
      name: c.name || c.type, type: c.type, odM: c.odM, bottomMdM: c.bottomMdM,
      governingDriftM: gov.driftM, controlling: gov.label, clearanceM, status,
    };
  });
  // The single row a reader is shown as "the worst". Rank by STATUS first,
  // because a FAIL anywhere outranks any PASS, and then by the TIGHTEST
  // clearance within that status. Ranking by status alone made `worst`
  // degenerate to rows[0] on a string where every row shares a status, which
  // is every string that passes: the golden completion reported the first
  // tubing joint at 102 mm where the production packer has 4.7 mm.
  const rank = (s) => ({ FAIL: 3, UNKNOWN: 2, WARN: 1, PASS: 0 }[s.status]);
  const worst = rows.reduce((a, b) => {
    if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
    if (b.clearanceM === null) return a;
    if (a.clearanceM === null) return b;
    return b.clearanceM < a.clearanceM ? b : a;
  }, rows[0]);
  return { rows, worst };
}

// Cumulative minimum through-bore from the top of the string down: the
// largest tool OD that can be run from surface to each component (and to
// below the string). The controlling restriction is named.
export function throughBoreProfile(stack) {
  let minIdM = Infinity;
  let controlling = null;
  const rows = stack.components.map((c) => {
    if (c.idM < minIdM) {
      minIdM = c.idM;
      controlling = c.name || c.type;
    }
    return {
      name: c.name || c.type, type: c.type, topMdM: c.topMdM, bottomMdM: c.bottomMdM,
      idM: c.idM, cumMinIdM: minIdM, controlling,
    };
  });
  return { rows, minIdM, controlling };
}

// ---- volumes ----------------------------------------------------------------

const area = (dM) => (Math.PI / 4) * dM * dM;

// Piecewise integration of π/4·(bore² − od²) over [aMdM, bMdM] with the
// component OD looked up per interval (0 where no component covers).
function integrate(profile, stack, aMdM, bMdM, term) {
  const cuts = new Set([aMdM, bMdM]);
  profile.forEach((s) => { cuts.add(s.topMdM); cuts.add(s.bottomMdM); });
  stack.components.forEach((c) => { cuts.add(c.topMdM); cuts.add(c.bottomMdM); });
  const xs = [...cuts].filter((x) => x >= aMdM - 1e-9 && x <= bMdM + 1e-9).sort((a, b) => a - b);
  let vol = 0;
  const warnings = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const top = xs[i];
    const bottom = xs[i + 1];
    if (!(bottom > top)) continue;
    const mid = (top + bottom) / 2;
    const seg = profile.find((s) => s.topMdM <= mid && mid < s.bottomMdM);
    const comp = stack.components.find((c) => c.topMdM <= mid && mid < c.bottomMdM);
    const v = term({ seg, comp, lengthM: bottom - top, top, bottom });
    if (v === null) {
      warnings.push(`No casing coverage over ${top.toFixed(1)}-${bottom.toFixed(1)} m; interval skipped.`);
    } else {
      vol += v;
    }
  }
  return { vol, warnings };
}

// Volumes (m³, MD basis — capacities use measured length, the tally
// convention; TVD matters for hydrostatics, not for steel volumes):
//   stringCapacityM3     Σ π/4·ID²·L over the completion components
//   annulusAbovePackerM3 π/4·(bore² − od²) hanger → packer
//   belowPackerM3        casing capacity packer → TD minus the closed-end
//                        displacement of the tail pipe (documented)
//   stringDisplacementM3 closed-end π/4·OD²·L (running the string)
export function completionVolumes({ stack, profile, packerMdM, tdMdM }) {
  if (!(packerMdM >= stack.hangerMdM) || !(packerMdM <= stack.bottomMdM)) {
    throw new Error('Packer must sit within the completion string.');
  }
  if (!(tdMdM >= stack.bottomMdM)) throw new Error('TD must be at or below the string bottom.');
  const stringCapacityM3 = stack.components.reduce((v, c) => v + area(c.idM) * c.lengthM, 0);
  const stringDisplacementM3 = stack.components.reduce((v, c) => v + area(c.odM) * c.lengthM, 0);
  const ann = integrate(profile, stack, stack.hangerMdM, packerMdM, ({ seg, comp, lengthM }) => {
    if (!seg) return null;
    const od = comp ? comp.odM : 0;
    return (area(seg.idM) - area(od)) * lengthM;
  });
  const below = integrate(profile, stack, packerMdM, tdMdM, ({ seg, comp, lengthM }) => {
    if (!seg) return null;
    const tail = comp ? area(comp.odM) * lengthM : 0;
    return area(seg.idM) * lengthM - tail;
  });
  return {
    stringCapacityM3,
    stringDisplacementM3,
    annulusAbovePackerM3: ann.vol,
    belowPackerM3: below.vol,
    warnings: [...ann.warnings, ...below.warnings],
  };
}

// ---- seal space-out ---------------------------------------------------------

// Remaining PBR stroke after insertion vs the expected thermal/pressure
// length change of the string (ΔL from the D6 tubingLoads analysis).
// Contraction (ΔL < 0) pulls seals OUT of the bore: available = insertion
// depth. Elongation pushes them IN: available = remaining bore.
export function sealSpaceOut({ pbrLengthM, insertLengthM, expectedDLM = 0, marginM = 0.5 }) {
  if (!(pbrLengthM > 0)) throw new Error('PBR length must be positive.');
  if (!(insertLengthM >= 0) || insertLengthM > pbrLengthM) {
    throw new Error('Insertion must be within the PBR bore.');
  }
  const availableM = expectedDLM >= 0 ? pbrLengthM - insertLengthM : insertLengthM;
  const usedM = Math.abs(expectedDLM);
  const remainingM = availableM - usedM;
  const status = remainingM < 0 ? 'FAIL' : remainingM < marginM ? 'WARN' : 'PASS';
  return { availableM, usedM, remainingM, status };
}
