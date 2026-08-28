/**
 * Line pipe geometry and fitting losses (Production Operations P11).
 *
 * A WORKING SUBSET of ANSI B36.10, not the whole standard. Every row
 * carries the outside diameter, the wall AND the published inside
 * diameter, even though the third is arithmetically the first two --
 * because that redundancy is the check. A transcription error in any
 * one of the three makes `od - 2*wall === id` fail, and the gate on
 * that runs over every row. A table that only carried two of the three
 * would be a table with no way of knowing it was wrong.
 *
 * The full standard is ARMED rather than guessed at. Reproducing a
 * hundred rows of a published table from memory is precisely the kind
 * of thing this package does not do, so what is here is what can be
 * stated with confidence, and a bore can always be typed directly.
 *
 * Fitting and valve resistances are velocity-head (K) coefficients in
 * the Crane TP-410 sense: the loss is K times one velocity head. They
 * are round numbers for a reason -- they are approximations to begin
 * with, they vary between manufacturers, and quoting them to three
 * decimals would suggest a precision that does not exist.
 */

/** Inch dimensions. `id` is the published bore, not a derived one. */
export const PIPE_SCHEDULE = [
  { nps: 2, schedule: '40', od: 2.375, wall: 0.154, id: 2.067 },
  { nps: 2, schedule: '80', od: 2.375, wall: 0.218, id: 1.939 },
  { nps: 3, schedule: '40', od: 3.5, wall: 0.216, id: 3.068 },
  { nps: 4, schedule: '40', od: 4.5, wall: 0.237, id: 4.026 },
  { nps: 4, schedule: '80', od: 4.5, wall: 0.337, id: 3.826 },
  { nps: 6, schedule: '40', od: 6.625, wall: 0.28, id: 6.065 },
  { nps: 6, schedule: '80', od: 6.625, wall: 0.432, id: 5.761 },
  { nps: 8, schedule: '40', od: 8.625, wall: 0.322, id: 7.981 },
  { nps: 8, schedule: '80', od: 8.625, wall: 0.5, id: 7.625 },
  { nps: 10, schedule: '40', od: 10.75, wall: 0.365, id: 10.02 },
  { nps: 12, schedule: '40', od: 12.75, wall: 0.406, id: 11.938 },
  { nps: 16, schedule: '40', od: 16, wall: 0.5, id: 15 },
];

/** Absolute roughness, inches. */
export const ROUGHNESS_IN = [
  { id: 'commercialSteel', label: 'Commercial steel, new', roughnessIn: 0.0018 },
  { id: 'steelUsed', label: 'Steel, in service', roughnessIn: 0.006 },
  { id: 'internallyCoated', label: 'Internally coated', roughnessIn: 0.0002 },
  { id: 'hdpe', label: 'HDPE', roughnessIn: 0.00006 },
];

export const roughnessOf = (id) => {
  const rec = ROUGHNESS_IN.find((r) => r.id === id);
  return rec ? rec.roughnessIn : NaN;
};

/** Velocity-head coefficients. */
export const FITTINGS = [
  { id: 'elbow90LR', label: '90 degree elbow, long radius', k: 0.3 },
  { id: 'elbow90Std', label: '90 degree elbow, standard', k: 0.75 },
  { id: 'elbow45', label: '45 degree elbow', k: 0.35 },
  { id: 'teeLine', label: 'Tee, straight through', k: 0.2 },
  { id: 'teeBranch', label: 'Tee, branch flow', k: 1.0 },
  { id: 'gateValve', label: 'Gate valve, fully open', k: 0.15 },
  { id: 'ballValve', label: 'Ball valve, fully open', k: 0.05 },
  { id: 'globeValve', label: 'Globe valve, fully open', k: 10.0 },
  { id: 'swingCheck', label: 'Swing check valve', k: 2.0 },
  { id: 'suddenExit', label: 'Exit into a vessel', k: 1.0 },
];

export const fittingK = (id) => {
  const rec = FITTINGS.find((f) => f.id === id);
  return rec ? rec.k : NaN;
};

/** Pick a schedule row. Returns null rather than a nearby size. */
export const scheduleRow = (nps, schedule = '40') =>
  PIPE_SCHEDULE.find((r) => r.nps === nps && r.schedule === schedule) || null;

/**
 * Equivalent length of a fitting count, in feet.
 *
 * L_eq = sum(K) * D / f. The friction factor belongs in it because
 * the equivalence is between a K loss and a length of PIPE, and a
 * length of pipe only knows what it costs once it knows its own
 * friction factor. Quoting an equivalent length without one -- as the
 * "30 diameters for an elbow" rule of thumb does -- hides an assumed
 * f of about 0.02, which is wrong by a factor of two on a smooth
 * high-Reynolds line.
 *
 * Returning it as a LENGTH is what lets a fitting count go straight
 * into a traverse that already knows how to march pipe, instead of
 * needing a separate loss model bolted onto the side.
 */
export const equivalentLengthFt = ({ fittings, idIn, frictionFactor }) => {
  const list = fittings || [];
  let sumK = 0;
  const unknown = [];
  for (const f of list) {
    const k = f.k != null ? Number(f.k) : fittingK(f.id);
    const count = Number(f.count ?? 1);
    if (!(k >= 0) || !Number.isFinite(k)) { unknown.push(f.id || 'unnamed fitting'); continue; }
    sumK += k * count;
  }
  if (unknown.length) {
    return { ok: false, error: `No resistance coefficient for ${unknown.join(', ')}.` };
  }
  if (!(idIn > 0) || !(frictionFactor > 0)) {
    return { ok: false, error: 'An equivalent length needs a bore and a friction factor.' };
  }
  return { ok: true, sumK, lengthFt: (sumK * (idIn / 12)) / frictionFactor };
};

/**
 * Barlow's thin-wall hoop stress, the pressure a wall can hold.
 *
 *   P = 2 S t / D    with D the OUTSIDE diameter
 *
 * Design factors are an INPUT and not defaulted, because they are the
 * whole regulatory content of the calculation and they differ by code,
 * by class location and by fluid. Burying one in here would be
 * pretending a jurisdiction.
 */
export const barlowPressurePsi = ({ odIn, wallIn, yieldPsi, designFactor }) => {
  if (!(odIn > 0) || !(wallIn > 0) || !(yieldPsi > 0)) return NaN;
  const f = designFactor > 0 ? designFactor : 1;
  return (2 * yieldPsi * wallIn * f) / odIn;
};

/** API 5L grades, minimum yield in psi. */
export const LINE_PIPE_GRADES = [
  { id: 'gradeB', label: 'API 5L Grade B', yieldPsi: 35000 },
  { id: 'x42', label: 'API 5L X42', yieldPsi: 42000 },
  { id: 'x52', label: 'API 5L X52', yieldPsi: 52000 },
  { id: 'x60', label: 'API 5L X60', yieldPsi: 60000 },
  { id: 'x65', label: 'API 5L X65', yieldPsi: 65000 },
];

export const gradeYield = (id) => {
  const rec = LINE_PIPE_GRADES.find((g) => g.id === id);
  return rec ? rec.yieldPsi : NaN;
};
