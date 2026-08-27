// P&A engine (Drilling D10), part 2: balanced cement plug placement
// arithmetic, NORSOK D-010-style permanent-barrier rule checks, and the
// phased abandonment program builder.
//
// Model
//   * Balanced plug (classic drilling arithmetic, exact closed forms):
//     the stinger shoe sits at the plug base; slurry is pumped down the
//     stinger and up the annulus, spacer ahead in the annulus balanced
//     by spacer behind inside the string, and displacement stops when
//     the inside and annulus slurry columns stand level:
//       V_slurry = c_hole·L·(1 + excess)
//       H        = V_slurry / (c_ann + c_in)          (balanced height)
//       V_behind = V_ahead · c_in / c_ann             (equal heights)
//       V_disp   = c_in·(base − H) − V_behind
//     After pulling the stinger the slurry settles across the full bore:
//       top_final = base − V_slurry / c_hole
//     (identity: zero excess → top_final equals the design plug top).
//   * Rule checks follow the commonly cited NORSOK D-010 rev 4
//     permanent-barrier conventions (defaults overridable; the standard
//     document governs — armed literature gate L19):
//       cement plug 100 m MD minimum, 50 m if set on a verified
//       mechanical foundation; the plug extends >= 50 m above the
//       source of inflow; surface plug 50 m; annular cement 30 m MD
//       with log verification, 100 m without.
//   * Abandonment program: every zone with flow potential needs TWO
//     independent permanent barriers — a PRIMARY plug that covers the
//     source (base at/below the source top, extends >= 50 m above it,
//     length rule) and a SECONDARY that backs it up from above (length
//     rule, set entirely above the source top; a second source-covering
//     plug also qualifies). Phases run reservoir -> intermediate ->
//     surface with a material takeoff. This is a PLANNING checklist in
//     the well programme tradition, not an operational procedure.
//
// Units STRICT SI: m, m², m³ (fractions unitless). UI converts.
// Validation: independent oracle (oracle_wellintegrity.py) goldens incl.
// a hand-computed balanced-plug fixture + rule truth tables in
// __tests__/drilling.wellintegrity.test.js.

export const D010_DEFAULT_RULES = {
  plugMinLengthM: 100,
  plugMinLengthOnFoundationM: 50,
  plugAboveSourceMinM: 50,
  surfacePlugMinLengthM: 50,
  annularCementVerifiedMinM: 30,
  annularCementUnverifiedMinM: 100,
};

const cap = (dM) => (Math.PI / 4) * dM * dM;

// ---- balanced plug ---------------------------------------------------------

export function balancedPlug({
  holeIdM, stingerOdM, stingerIdM, plugBaseMdM, plugTopMdM,
  excessFrac = 0, spacerAheadM3 = 0,
}) {
  if (!(holeIdM > 0)) throw new Error('Hole/casing ID must be positive.');
  if (!(stingerOdM > 0) || !(stingerIdM > 0) || stingerIdM >= stingerOdM) {
    throw new Error('Stinger needs 0 < ID < OD.');
  }
  if (stingerOdM >= holeIdM) throw new Error('Stinger OD must clear the hole ID.');
  if (!(plugBaseMdM > 0) || !(plugTopMdM >= 0) || plugTopMdM >= plugBaseMdM) {
    throw new Error('Need 0 <= plug top < plug base.');
  }
  if (!(excessFrac >= 0)) throw new Error('Excess must be >= 0.');
  if (!(spacerAheadM3 >= 0)) throw new Error('Spacer ahead must be >= 0.');

  const lengthM = plugBaseMdM - plugTopMdM;
  const cHoleM2 = cap(holeIdM);
  const cAnnM2 = cap(holeIdM) - cap(stingerOdM);
  const cInM2 = cap(stingerIdM);

  const slurryM3 = cHoleM2 * lengthM * (1 + excessFrac);
  const balancedHeightM = slurryM3 / (cAnnM2 + cInM2);
  const spacerBehindM3 = spacerAheadM3 * (cInM2 / cAnnM2);
  const displacementM3 = cInM2 * (plugBaseMdM - balancedHeightM) - spacerBehindM3;
  const asPumpedTopMdM = plugBaseMdM - balancedHeightM;
  const pluggedTopMdM = plugBaseMdM - slurryM3 / cHoleM2;

  const warnings = [];
  if (balancedHeightM > plugBaseMdM) {
    warnings.push('Balanced slurry column exceeds the stinger depth; the plug cannot balance.');
  }
  if (displacementM3 < 0) {
    warnings.push('Negative displacement: the spacer behind exceeds the inside column above the slurry.');
  }
  return {
    engine: 'plugAbandonment-1.0.0',
    lengthM,
    cHoleM2,
    cAnnM2,
    cInM2,
    slurryM3,
    balancedHeightM,
    spacerBehindM3,
    spacerAheadM3,
    displacementM3,
    asPumpedTopMdM,
    pluggedTopMdM,
    warnings,
  };
}

// ---- rule checks -----------------------------------------------------------

// One proposed plug against the D-010-style permanent-barrier rules.
//   plug: { name?, topMdM, bottomMdM, foundation: 'none'|'mechanical'|'tagged',
//           isSurfacePlug? }
//   sourceTopMdM: top of the source of inflow the plug must isolate
//   (null for a surface/environmental plug).
export function plugRuleCheck({ plug, sourceTopMdM = null, rules = D010_DEFAULT_RULES }) {
  const lengthM = plug.bottomMdM - plug.topMdM;
  if (!(lengthM > 0)) throw new Error('Plug needs bottom below top.');
  const onFoundation = plug.foundation === 'mechanical' || plug.foundation === 'tagged';
  const requiredLengthM = plug.isSurfacePlug
    ? rules.surfacePlugMinLengthM
    : (onFoundation ? rules.plugMinLengthOnFoundationM : rules.plugMinLengthM);

  const checks = [{
    id: 'min-length',
    label: `Plug length >= ${requiredLengthM} m MD${onFoundation ? ' (on verified foundation)' : ''}`,
    requiredM: requiredLengthM,
    actualM: lengthM,
    pass: lengthM >= requiredLengthM,
  }];
  if (!plug.isSurfacePlug && sourceTopMdM != null) {
    const aboveM = sourceTopMdM - plug.topMdM;
    checks.push({
      id: 'above-source',
      label: `Plug extends >= ${rules.plugAboveSourceMinM} m above the source`,
      requiredM: rules.plugAboveSourceMinM,
      actualM: aboveM,
      pass: aboveM >= rules.plugAboveSourceMinM,
    });
    checks.push({
      id: 'covers-source',
      label: 'Plug base at or below the source top',
      requiredM: sourceTopMdM,
      actualM: plug.bottomMdM,
      pass: plug.bottomMdM >= sourceTopMdM,
    });
  }
  return { checks, pass: checks.every((c) => c.pass) };
}

// Annular cement behind casing as the external barrier element beside a
// plug interval.
export function annularBarrierCheck({ topMdM, bottomMdM, verifiedByLog = false, rules = D010_DEFAULT_RULES }) {
  const lengthM = bottomMdM - topMdM;
  if (!(lengthM > 0)) throw new Error('Annular cement needs bottom below top.');
  const requiredM = verifiedByLog ? rules.annularCementVerifiedMinM : rules.annularCementUnverifiedMinM;
  return {
    requiredM,
    actualM: lengthM,
    verifiedByLog,
    pass: lengthM >= requiredM,
  };
}

// ---- abandonment program ---------------------------------------------------

// Zone compliance + phased program steps + material takeoff.
//   zones: [{ name, topMdM, bottomMdM, flowPotential }]
//   plugs: [{ name, topMdM, bottomMdM, foundation, isSurfacePlug?,
//             geometry?: balancedPlug inputs sans top/base }]
export function abandonmentProgram({ zones, plugs, rules = D010_DEFAULT_RULES }) {
  const flowZones = (zones || []).filter((z) => z.flowPotential)
    .slice().sort((a, b) => b.topMdM - a.topMdM); // deepest first
  const surfacePlugs = (plugs || []).filter((p) => p.isSurfacePlug);
  const barrierPlugs = (plugs || []).filter((p) => !p.isSurfacePlug);

  // Per-plug balanced volumes where geometry is given.
  const designs = (plugs || []).map((p) => {
    let placement = null;
    if (p.geometry) {
      placement = balancedPlug({
        ...p.geometry, plugBaseMdM: p.bottomMdM, plugTopMdM: p.topMdM,
      });
    }
    return { ...p, placement };
  });

  const zoneCompliance = flowZones.map((z) => {
    const primaryQualifying = barrierPlugs.filter(
      (p) => plugRuleCheck({ plug: p, sourceTopMdM: z.topMdM, rules }).pass,
    ).map((p) => p.name);
    const secondaryQualifying = barrierPlugs.filter(
      (p) => !primaryQualifying.includes(p.name)
        && p.bottomMdM <= z.topMdM
        && plugRuleCheck({ plug: p, rules }).pass,
    ).map((p) => p.name);
    return {
      zone: z.name,
      topMdM: z.topMdM,
      primaryQualifying,
      secondaryQualifying,
      required: 2,
      pass: primaryQualifying.length >= 1
        && primaryQualifying.length + secondaryQualifying.length >= 2,
    };
  });

  const surfaceCheck = surfacePlugs.length
    ? plugRuleCheck({ plug: surfacePlugs[0], rules })
    : null;
  const surfacePass = surfacePlugs.length > 0 && surfaceCheck.pass;

  // Program steps: set barrier plugs deepest first, then the surface
  // phase (cut/retrieve + environmental plug + wellhead removal).
  const steps = [];
  const orderedPlugs = designs.filter((p) => !p.isSurfacePlug)
    .slice().sort((a, b) => b.bottomMdM - a.bottomMdM);
  orderedPlugs.forEach((p, i) => {
    steps.push({
      phase: 1,
      step: i + 1,
      plugName: p.name,
      description: `Set ${p.name} (${Math.round(p.topMdM)}-${Math.round(p.bottomMdM)} m MD)`
        + (p.placement ? `, slurry ${p.placement.slurryM3.toFixed(1)} m3 balanced` : '')
        + (p.foundation !== 'none' ? `, on ${p.foundation} foundation` : '')
        + '; verify by tag and pressure test.',
    });
  });
  steps.push({
    phase: 2,
    step: steps.length + 1,
    plugName: null,
    description: 'Cut and retrieve casing above the deepest intermediate barrier where annular cement is absent.',
  });
  designs.filter((p) => p.isSurfacePlug).forEach((p) => {
    steps.push({
      phase: 3,
      step: steps.length + 1,
      plugName: p.name,
      description: `Set surface plug ${p.name} (${Math.round(p.topMdM)}-${Math.round(p.bottomMdM)} m MD)`
        + (p.placement ? `, slurry ${p.placement.slurryM3.toFixed(1)} m3` : '')
        + '.',
    });
  });
  steps.push({
    phase: 3,
    step: steps.length + 1,
    plugName: null,
    description: 'Remove wellhead and cut casings below surface/mudline per the regulatory depth.',
  });

  const takeoff = {
    plugCount: designs.length,
    slurryM3: designs.reduce((s, p) => s + (p.placement ? p.placement.slurryM3 : 0), 0),
    undesignedPlugs: designs.filter((p) => !p.placement).map((p) => p.name),
  };

  return {
    engine: 'plugAbandonment-1.0.0',
    zoneCompliance,
    surfacePlug: surfacePlugs.length
      ? { name: surfacePlugs[0].name, pass: surfacePass }
      : { name: null, pass: false },
    designs,
    steps,
    takeoff,
    pass: zoneCompliance.every((c) => c.pass) && surfacePass,
  };
}
