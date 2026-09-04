// Well integrity engine (Drilling D10), part 1: barrier envelope
// verification in the NORSOK D-010 two-barrier convention with the
// Norwegian (Norsk olje og gass 117-style) traffic-light categorization,
// and annulus pressure limits — element-governed MAASP and API RP
// 90-style MAWOP — in the differential hydrostatic form.
//
// Model
//   * A well barrier is an ENVELOPE of well barrier elements (WBEs).
//     Wells with flow potential need TWO independent envelopes (primary
//     and secondary); an element serving both envelopes is a COMMON WBE
//     and is flagged (acceptable only by deliberate dispensation).
//     v1 verifies the STATUS roll-up and the envelope rules; geometric
//     envelope closure (that the elements form a sealed surface around
//     the source) is the engineer's drawing, not checked here (stated).
//   * Categorization is the published traffic-light decision table:
//       red     one envelope failed AND the other degraded/failed/missing
//       orange  one envelope failed with the other intact, or a
//               single-envelope well where two are required
//       yellow  degradation (or unverified elements) but no failure
//       green   both envelopes fully verified
//   * MAASP per annulus: each limiting element i (casing burst, inner
//     string collapse, wellhead/tree rating, shoe formation strength)
//     allows a surface pressure
//       P_i = f_i·limit_i − (ρ_ann − ρ_backup,i)·g·TVD_i
//     where limit_i is the element's pressure limit AT ITS DEPTH,
//     f_i ≤ 1 a design/wear factor, ρ_ann the annulus fluid and
//     ρ_backup,i the fluid gradient on the far side of the element.
//     MAASP is the minimum over elements, clamped at zero, with the
//     governing element named.
//   * MAWOP (API RP 90 convention for sustained casing pressure): the
//     same row arithmetic with the RP 90 default factors by element
//     role — 50% of the burst rating of the annulus' OUTER casing, 80%
//     of the burst rating of the INNER casing, 75% of the collapse
//     rating of inner TUBING. Factors are overridable; the standard
//     document governs (armed literature gate L20).
//
// Units STRICT SI: Pa, kg/m³, m. UI converts to psi/ppg.
// Validation: independent oracle (oracle_wellintegrity.py) goldens incl.
// the full categorization truth table + closed-form MAASP fixtures in
// __tests__/drilling.wellintegrity.test.js.

const G = 9.80665;

// ---- barrier elements ------------------------------------------------------

export const ELEMENT_STATUSES = ['verified', 'degraded', 'failed', 'not-verified'];

export const ELEMENT_KINDS = [
  { kind: 'formation', label: 'In-situ formation' },
  { kind: 'casing-cement', label: 'Casing cement' },
  { kind: 'casing', label: 'Casing' },
  { kind: 'wellhead', label: 'Wellhead' },
  { kind: 'tubing-hanger', label: 'Tubing hanger' },
  { kind: 'production-packer', label: 'Production packer' },
  { kind: 'completion-string', label: 'Completion string (tubing)' },
  { kind: 'dhsv', label: 'Downhole safety valve' },
  { kind: 'annulus-fluid', label: 'Annulus fluid column' },
  { kind: 'fluid-column', label: 'Kill-weight fluid column' },
  { kind: 'xmas-tree', label: 'Christmas tree' },
  { kind: 'bop', label: 'BOP / drilling control' },
  { kind: 'cement-plug', label: 'Cement plug' },
  { kind: 'mechanical-plug', label: 'Mechanical plug' },
];

// Roll one envelope's elements up to intact / degraded / failed / empty.
// 'not-verified' counts as degradation: an untested element is not a
// qualified barrier (NORSOK initial + periodic verification requirement).
export function envelopeStatus(elements) {
  if (!elements || elements.length === 0) return 'empty';
  let degraded = false;
  for (const el of elements) {
    if (!ELEMENT_STATUSES.includes(el.status)) {
      throw new Error(`Unknown element status "${el.status}" on "${el.name}".`);
    }
    if (el.status === 'failed') return 'failed';
    if (el.status === 'degraded' || el.status === 'not-verified') degraded = true;
  }
  return degraded ? 'degraded' : 'intact';
}

// The vocabulary an ENVELOPE is described in, which is deliberately NOT the
// vocabulary an ELEMENT is described in. An element is verified, degraded,
// failed or not-verified; an envelope is intact, degraded, failed or empty.
export const ENVELOPE_STATUSES = ['intact', 'degraded', 'failed', 'empty'];

// Traffic-light category from the two envelope statuses (decision table
// above). A missing secondary envelope counts as 'empty'.
//
// THE INPUT IS VALIDATED, AND IT HAS TO BE. This function used to accept any
// string and fall through to GREEN for anything it did not recognise, which is
// the one direction an integrity function must never fail in. Passing an
// ELEMENT status here, which is an easy mistake because the two vocabularies
// are adjacent and both describe "how healthy is this", returned a clean bill
// of health: wellCategory({ primary: 'not-verified', secondary: 'intact' })
// answered GREEN for a well whose primary envelope nobody had checked.
// envelopeStatus already refused an unknown element status, so the two halves
// of the same boundary disagreed about whether to trust their caller.
export function wellCategory({ primary, secondary, flowPotential = true }) {
  for (const [label, s] of [['primary', primary], ['secondary', secondary]]) {
    if (!ENVELOPE_STATUSES.includes(s)) {
      throw new Error(
        `Unknown ${label} envelope status "${s}". Expected one of `
        + `${ENVELOPE_STATUSES.join(', ')}. Note that element statuses `
        + `(${ELEMENT_STATUSES.join(', ')}) are a DIFFERENT vocabulary; roll `
        + 'elements up with envelopeStatus() first.',
      );
    }
  }
  const bad = (s) => s === 'failed' || s === 'empty';
  if (!flowPotential) {
    // No pressure differential toward surface: one qualified envelope
    // suffices; failures still flag. But ONE is not NONE. This branch used to
    // fall through to green for an EMPTY primary, so a well with nothing
    // recorded in it at all came back clean, with the reason "Qualified
    // barrier" naming a barrier that did not exist. The flowing branch has
    // always treated empty as a finding; this one did not, and the two halves
    // of the same function disagreed about whether absence is a problem.
    if (primary === 'empty') return { category: 'orange', reason: 'No barrier envelope recorded, even on a well without flow potential.' };
    if (primary === 'failed') return { category: 'orange', reason: 'Barrier failure on a well without flow potential.' };
    if (primary === 'degraded') return { category: 'yellow', reason: 'Barrier degradation on a well without flow potential.' };
    return { category: 'green', reason: 'Qualified barrier; no flow potential.' };
  }
  const failures = [primary, secondary].filter((s) => s === 'failed').length;
  if (failures > 0) {
    const other = primary === 'failed' ? secondary : primary;
    if (failures === 2 || bad(other) || other === 'degraded') {
      return { category: 'red', reason: 'One barrier envelope failed and the other is degraded, failed or missing.' };
    }
    return { category: 'orange', reason: 'One barrier envelope failed; the other is intact.' };
  }
  if (primary === 'empty' || secondary === 'empty') {
    return { category: 'orange', reason: 'Single barrier envelope on a well that requires two.' };
  }
  if (primary === 'degraded' || secondary === 'degraded') {
    return { category: 'yellow', reason: 'Barrier degradation (or unverified elements); no failure.' };
  }
  return { category: 'green', reason: 'Both barrier envelopes verified intact.' };
}

// Full verification: split elements into envelopes, flag common WBEs,
// run the rule checks and categorize.
//   elements: [{ id?, name, kind, envelope: 'primary'|'secondary'|'both',
//                status, notes? }]
export function verifyBarriers({ elements, flowPotential = true }) {
  const primaryEls = [];
  const secondaryEls = [];
  const shared = [];
  for (const el of elements || []) {
    if (!['primary', 'secondary', 'both'].includes(el.envelope)) {
      throw new Error(`Element "${el.name}" needs envelope primary|secondary|both.`);
    }
    if (el.envelope === 'primary' || el.envelope === 'both') primaryEls.push(el);
    if (el.envelope === 'secondary' || el.envelope === 'both') secondaryEls.push(el);
    if (el.envelope === 'both') shared.push(el.name);
  }
  const primary = envelopeStatus(primaryEls);
  const secondary = envelopeStatus(secondaryEls);
  const unverified = (elements || []).filter((el) => el.status === 'not-verified').map((el) => el.name);
  const failedEls = (elements || []).filter((el) => el.status === 'failed').map((el) => el.name);

  const checks = [
    {
      id: 'two-envelopes',
      label: 'Two independent well barrier envelopes',
      pass: !flowPotential || (primaryEls.length > 0 && secondaryEls.length > 0),
      level: 'fail',
    },
    {
      id: 'no-common-elements',
      label: 'No element shared between envelopes (common WBE)',
      pass: shared.length === 0,
      level: 'warn',
      detail: shared.length ? `Common WBE: ${shared.join(', ')}. Requires explicit acceptance.` : null,
    },
    {
      id: 'all-verified',
      label: 'Every element verified (initial + periodic test)',
      pass: unverified.length === 0,
      level: 'warn',
      detail: unverified.length ? `Not verified: ${unverified.join(', ')}.` : null,
    },
    {
      id: 'no-failed-elements',
      label: 'No failed element in either envelope',
      pass: failedEls.length === 0,
      level: 'fail',
      detail: failedEls.length ? `Failed: ${failedEls.join(', ')}.` : null,
    },
  ];

  return {
    engine: 'wellIntegrity-1.0.0',
    primary: { status: primary, count: primaryEls.length },
    secondary: { status: secondary, count: secondaryEls.length },
    shared,
    checks,
    ...wellCategory({ primary, secondary, flowPotential }),
  };
}

// ---- annulus pressure limits ----------------------------------------------

// Element-governed MAASP rows in the differential form (header note).
//   elements: [{ name, kind?, limitPa, factor?, tvdM, backupDensityKgM3 }]
export function maaspRows({ annulusFluidDensityKgM3, elements }) {
  if (!(annulusFluidDensityKgM3 > 0)) throw new Error('Annulus fluid density must be positive.');
  if (!elements?.length) throw new Error('Need at least one limiting element.');
  const rows = elements.map((el) => {
    if (!(el.limitPa > 0)) throw new Error(`Element "${el.name}" needs a positive pressure limit.`);
    if (!(el.tvdM >= 0)) throw new Error(`Element "${el.name}" needs TVD >= 0.`);
    const factor = el.factor ?? 1;
    if (!(factor > 0) || factor > 1) throw new Error(`Element "${el.name}" factor must sit in (0, 1].`);
    const backup = el.backupDensityKgM3 ?? 0;
    const allowSurfacePa = factor * el.limitPa
      - (annulusFluidDensityKgM3 - backup) * G * el.tvdM;
    return {
      name: el.name,
      kind: el.kind ?? null,
      factor,
      limitPa: el.limitPa,
      tvdM: el.tvdM,
      backupDensityKgM3: backup,
      allowSurfacePa,
    };
  });
  let governing = rows[0];
  for (const r of rows) if (r.allowSurfacePa < governing.allowSurfacePa) governing = r;
  return {
    engine: 'wellIntegrity-1.0.0',
    rows,
    governing: governing.name,
    maaspPa: Math.max(0, governing.allowSurfacePa),
    negative: governing.allowSurfacePa < 0,
  };
}

// API RP 90 convention MAWOP factors by element role (overridable).
export const RP90_MAWOP_FACTORS = {
  'outer-casing-burst': 0.5,
  'inner-casing-burst': 0.8,
  'inner-tubing-collapse': 0.75,
  'shoe-formation': 1.0,
  rating: 1.0,
};

// MAWOP for one annulus: RP 90 default factors by role, then the same
// row arithmetic as maaspRows.
//   candidates: [{ name, role, limitPa, tvdM, backupDensityKgM3, factor? }]
export function mawop({ annulusFluidDensityKgM3, candidates, factors = RP90_MAWOP_FACTORS }) {
  const elements = (candidates || []).map((c) => {
    const factor = c.factor ?? factors[c.role];
    if (factor == null) throw new Error(`Candidate "${c.name}": unknown MAWOP role "${c.role}".`);
    return { ...c, kind: c.role, factor };
  });
  const out = maaspRows({ annulusFluidDensityKgM3, elements });
  return { ...out, mawopPa: out.maaspPa };
}
