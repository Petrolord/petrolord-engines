/**
 * Flowline thermal-hydraulics (Production P10).
 *
 * Flow assurance is a question about TEMPERATURE: where in the
 * production system does the fluid get cold enough to make hydrate or
 * drop wax, and how long after a shutdown do you have before it does.
 * Answering that needs the temperature everywhere, and this module is
 * where that comes from.
 *
 * EVERYTHING HERE IS DERIVED. There is no correlation in this file.
 *
 *   Steady state. An energy balance on a pipe element,
 *       m_dot Cp dT/dx = -U pi D (T - T_amb)
 *   integrates to an exponential approach to ambient,
 *       T(x) = T_amb + (T_in - T_amb) exp(-x / Lc),
 *       Lc = m_dot Cp / (U pi D)
 *   with Lc the relaxation length -- the distance over which the
 *   fluid loses 63 percent of its excess temperature. Reporting Lc
 *   alongside the profile is more useful than the profile alone,
 *   because it says immediately whether a line is short or long in the
 *   only sense that matters thermally.
 *
 *   Overall U. Series thermal resistances, which is all it is:
 *   the inside film, the pipe wall, every coating, the ground if the
 *   line is buried, and the outside film. Each is a closed form. The
 *   buried term is the classical conduction shape factor for a
 *   cylinder in a semi-infinite medium, acosh(2H/D) / (2 pi k), which
 *   comes out of the method of images.
 *
 *   Cooldown. Lumped capacitance after a shutdown,
 *       (M Cp)_total dT/dt = -U A (T - T_amb)
 *   so the time to fall from T0 to a target is
 *       t = (M Cp) / (U A) ln( (T0 - T_amb) / (T_target - T_amb) ).
 *   That is the no-touch time, and it is the number a flow assurance
 *   engineer is asked for more often than any other.
 *
 * WHAT IS NOT HERE. Hydrate and wax boundaries. Those are fluid
 * properties, they come from a lab or a compositional flash, and the
 * consumer supplies them. This module says where the fluid IS in
 * pressure and temperature; whether that is inside somebody's hydrate
 * envelope is a different question with a different owner.
 *
 * Field units: length ft, diameter in unless named ...Ft, temperature
 * degF, U Btu/(hr ft2 degF), k Btu/(hr ft degF), Cp Btu/(lb degF),
 * mass rate lb/hr, time hr.
 */

/**
 * Thermal conductivities, Btu/(hr ft degF). Material properties, not
 * anybody's product data: the same standing as the copper resistances
 * in the ESP catalog. Real projects use the manufacturer's number for
 * a specific insulation, so every layer takes its own k as an input
 * and these are only the defaults offered.
 */
export const CONDUCTIVITIES = [
  { id: 'steel', label: 'Carbon steel', k: 26 },
  { id: 'concrete', label: 'Concrete weight coat', k: 0.9 },
  { id: 'polypropylene', label: 'Solid polypropylene', k: 0.13 },
  { id: 'syntacticPP', label: 'Syntactic polypropylene foam', k: 0.09 },
  { id: 'polyurethane', label: 'Polyurethane foam', k: 0.07 },
  { id: 'aerogel', label: 'Aerogel blanket', k: 0.012 },
  { id: 'soilWet', label: 'Wet soil / seabed', k: 1.2 },
  { id: 'soilDry', label: 'Dry soil', k: 0.5 },
];

/**
 * Thermal conductivity, Btu/(hr ft degF), for a catalog id.
 *
 * Returns NaN for an id that is not in the catalog, and DELIBERATELY
 * does not fall back to anything. An earlier version returned the first
 * entry -- carbon steel -- for an unknown id, so a typo in an
 * insulation id quietly turned aerogel into steel and made a line look
 * two thousand times better insulated than it is. A NaN propagates into
 * a refusal; a plausible wrong number does not.
 */
export const conductivity = (id) => {
  const rec = CONDUCTIVITIES.find((c) => c.id === id);
  return rec ? rec.k : NaN;
};

/**
 * External film coefficients, Btu/(hr ft2 degF). These are the one
 * genuinely uncertain input in a U calculation and they are exposed
 * for that reason: still water and a swept seabed differ by an order
 * of magnitude, and no correlation here would be worth more than an
 * operator's own number.
 */
export const FILM_COEFFICIENTS = [
  { id: 'seawaterCurrent', label: 'Seabed with current', h: 200 },
  { id: 'seawaterStill', label: 'Still water', h: 50 },
  { id: 'airWindy', label: 'Air, exposed and windy', h: 6 },
  { id: 'airStill', label: 'Air, sheltered', h: 2 },
];

/**
 * Bore-side film coefficients, Btu/(hr ft2 degF).
 *
 * Kept in their OWN catalog rather than mixed into the outside list,
 * because they are an order of magnitude apart and offering a seabed
 * coefficient for the inside of a pipe is an invitation to pick one.
 *
 * For a flowing liquid the inside film is so large that it is very
 * nearly a short circuit -- it is in the stack for completeness and
 * because it stops mattering only while the line is flowing. A shut-in
 * line has a stagnant bore, and then it matters.
 */
export const INSIDE_FILMS = [
  { id: 'liquidFlowing', label: 'Flowing liquid', h: 300 },
  { id: 'multiphaseFlowing', label: 'Flowing multiphase', h: 200 },
  { id: 'gasFlowing', label: 'Flowing gas', h: 25 },
  { id: 'stagnant', label: 'Shut in / stagnant', h: 5 },
];

/**
 * Film coefficient, Btu/(hr ft2 degF), for a catalog id. Looks in both
 * the outside and the inside catalogs, and returns NaN for an id in
 * neither -- same reasoning as conductivity: no silent fallback.
 */
export const filmCoefficient = (id) => {
  const rec = FILM_COEFFICIENTS.find((f) => f.id === id)
    || INSIDE_FILMS.find((f) => f.id === id);
  return rec ? rec.h : NaN;
};

const inToFt = (v) => v / 12;

/**
 * Conduction resistance of an annular layer, per foot of pipe:
 *   R = ln(Do/Di) / (2 pi k)
 */
export const layerResistance = ({ idIn, odIn, k }) => {
  if (!(idIn > 0) || !(odIn > idIn) || !(k > 0)) return NaN;
  return Math.log(odIn / idIn) / (2 * Math.PI * k);
};

/**
 * Conduction resistance of the ground above a buried pipe, per foot:
 *   R = acosh(2H/D) / (2 pi k_soil)
 *
 * The classical shape factor for an isothermal cylinder in a
 * semi-infinite medium, from the method of images. `burialFt` is to the
 * pipe CENTRELINE; a pipe lying on the seabed is the H = D/2 limit,
 * where acosh(1) = 0 and the ground adds nothing, which is the right
 * answer and a useful check that the formula is the right one.
 */
export const burialResistance = ({ odIn, burialFt, kSoil }) => {
  const d = inToFt(odIn);
  if (!(d > 0) || !(kSoil > 0)) return NaN;
  const ratio = (2 * burialFt) / d;
  if (!(ratio >= 1)) return NaN;
  return Math.acosh(ratio) / (2 * Math.PI * kSoil);
};

/**
 * Overall heat transfer coefficient, referred to a stated diameter.
 *
 * U is meaningless without saying which area it is referred to, and
 * the commonest mistake in a flow assurance hand calculation is mixing
 * two. Everything here is referred to `referenceIdIn`, which defaults
 * to the pipe inside diameter, and the reference is reported back.
 *
 * `layers`: [{ idIn, odIn, k }] outward from the pipe bore.
 *
 * returns { uBtuHrFt2F, resistances, referenceIdIn, totalResistance }
 */
export const overallU = ({
  layers, insideFilmH, outsideFilmH, burialFt, kSoil, referenceIdIn,
}) => {
  const list = layers || [];
  if (!list.length) return { ok: false, error: 'A pipe needs at least one layer: its own wall.' };
  const bore = referenceIdIn ?? list[0].idIn;
  const outerOd = list[list.length - 1].odIn;
  const resistances = [];

  if (insideFilmH > 0) {
    resistances.push({ id: 'insideFilm', r: 1 / (insideFilmH * Math.PI * inToFt(list[0].idIn)) });
  }
  list.forEach((layer, i) => {
    resistances.push({ id: `layer${i}`, label: layer.label, r: layerResistance(layer) });
  });
  if (burialFt > 0 && kSoil > 0) {
    const r = burialResistance({ odIn: outerOd, burialFt, kSoil });
    if (Number.isFinite(r)) resistances.push({ id: 'burial', r });
  }
  if (outsideFilmH > 0) {
    resistances.push({ id: 'outsideFilm', r: 1 / (outsideFilmH * Math.PI * inToFt(outerOd)) });
  }

  if (resistances.some((x) => !Number.isFinite(x.r))) {
    return { ok: false, error: 'A layer could not be resolved: every layer needs an inside diameter, a larger outside diameter and a positive conductivity.' };
  }
  const totalResistance = resistances.reduce((a, x) => a + x.r, 0);
  const refArea = Math.PI * inToFt(bore); // ft2 per ft of pipe
  return {
    ok: true,
    uBtuHrFt2F: 1 / (totalResistance * refArea),
    totalResistance,
    resistances: resistances.map((x) => ({
      ...x,
      sharePct: (x.r / totalResistance) * 100,
    })),
    referenceIdIn: bore,
  };
};

/**
 * The relaxation length: the distance over which the fluid gives up
 * 63 percent of its excess temperature over ambient.
 *
 *   Lc = m_dot Cp / (U pi D)
 *
 * A line much shorter than Lc arrives hot whatever the ambient; a line
 * much longer than it arrives at ambient whatever it started at. It is
 * the single most informative number about a flowline's thermal
 * behaviour and it costs nothing to report.
 */
export const relaxationLengthFt = ({ massRateLbHr, cpBtuLbF, uBtuHrFt2F, idIn }) => {
  const denom = uBtuHrFt2F * Math.PI * inToFt(idIn);
  if (!(denom > 0) || !(massRateLbHr > 0) || !(cpBtuLbF > 0)) return NaN;
  return (massRateLbHr * cpBtuLbF) / denom;
};

/**
 * Steady-state temperature down a flowline.
 *
 * The exponential approach to ambient, with an optional
 * Joule-Thomson term for gas: expanding gas cools as it loses
 * pressure, and on a long gas line that term is not small. The JT
 * coefficient is an INPUT because it is a fluid property that comes
 * from an equation of state, not from anything this module knows.
 *
 * returns { ok, stations: [{ xFt, tempF, pPsia }], arrivalTempF,
 *           relaxationLengthFt, ntu }
 */
export const steadyStateProfile = ({
  lengthFt, inletTempF, ambientTempF, massRateLbHr, cpBtuLbF, uBtuHrFt2F,
  idIn, inletPsia, outletPsia, jtCoeffFPerPsi = 0, nStations = 21,
}) => {
  const lc = relaxationLengthFt({ massRateLbHr, cpBtuLbF, uBtuHrFt2F, idIn });
  if (!Number.isFinite(lc) || !(lengthFt > 0)) {
    return { ok: false, error: 'The profile needs a length, a mass rate, a heat capacity and a heat transfer coefficient.' };
  }
  const n = Math.max(2, Math.round(nStations));
  const dp = Number.isFinite(inletPsia) && Number.isFinite(outletPsia)
    ? inletPsia - outletPsia
    : 0;
  const stations = [];
  for (let i = 0; i < n; i += 1) {
    const xFt = (lengthFt * i) / (n - 1);
    const frac = xFt / lengthFt;
    // Heat loss to ambient, plus the cooling the pressure drop causes.
    // The JT term is carried linearly along the line, which is what a
    // linear pressure profile implies; a consumer with a real pressure
    // traverse passes its own stations instead.
    const jtDrop = jtCoeffFPerPsi * dp * frac;
    const tempF = ambientTempF + (inletTempF - ambientTempF) * Math.exp(-xFt / lc) - jtDrop;
    stations.push({
      xFt,
      tempF,
      pPsia: Number.isFinite(inletPsia) ? inletPsia - dp * frac : NaN,
    });
  }
  return {
    ok: true,
    stations,
    arrivalTempF: stations[stations.length - 1].tempF,
    relaxationLengthFt: lc,
    // Number of transfer units: length measured in relaxation lengths.
    ntu: lengthFt / lc,
  };
};

/**
 * The overall U that would land the fluid at a target arrival
 * temperature, inverted from the same exponential.
 *
 *   U = m_dot Cp / (pi D L) ln( (T_in - T_amb) / (T_target - T_amb) )
 *
 * Returns null when the target is unreachable, which happens for two
 * quite different reasons and they are worth separating: a target at
 * or below ambient can never be held whatever the insulation, and a
 * target above the inlet is not a cooling problem at all.
 */
export const uForArrivalTemp = ({
  lengthFt, inletTempF, ambientTempF, targetTempF, massRateLbHr, cpBtuLbF, idIn,
}) => {
  if (!(targetTempF > ambientTempF)) {
    return { ok: false, reason: `A line cannot arrive above ambient (${Math.round(ambientTempF)} F) no matter how well it is insulated. The target has to be above it.` };
  }
  if (!(inletTempF > targetTempF)) {
    return { ok: false, reason: 'The fluid already enters below the target, so insulation is not the problem.' };
  }
  const ratio = Math.log((inletTempF - ambientTempF) / (targetTempF - ambientTempF));
  const u = (massRateLbHr * cpBtuLbF * ratio) / (Math.PI * inToFt(idIn) * lengthFt);
  return { ok: true, uBtuHrFt2F: u, ntu: ratio };
};

/**
 * Cooldown after a shutdown: the no-touch time.
 *
 * Lumped capacitance on everything that has to cool -- the fluid in
 * the line and the steel and coatings around it. Leaving the pipe's own
 * heat capacity out is a common and optimistic error: on an insulated
 * small-bore line the steel can hold as much heat as the oil in it.
 *
 * `contents` and `shell` each { massLbPerFt, cpBtuLbF }.
 *
 * returns { ok, hours, timeConstantHr, stations }
 */
export const cooldownTime = ({
  contents, shell, uBtuHrFt2F, idIn, startTempF, ambientTempF, targetTempF,
  nStations = 25,
}) => {
  const mcp = (contents?.massLbPerFt || 0) * (contents?.cpBtuLbF || 0)
    + (shell?.massLbPerFt || 0) * (shell?.cpBtuLbF || 0);
  const ua = uBtuHrFt2F * Math.PI * inToFt(idIn); // per ft of pipe
  if (!(mcp > 0) || !(ua > 0)) {
    return { ok: false, error: 'Cooldown needs a heat capacity for what is cooling and a heat transfer coefficient.' };
  }
  const tau = mcp / ua;
  if (!(startTempF > ambientTempF)) {
    return { ok: false, error: 'The fluid is already at or below ambient, so there is nothing to cool.' };
  }
  if (!(targetTempF > ambientTempF)) {
    return {
      ok: true,
      hours: Infinity,
      timeConstantHr: tau,
      stations: [],
      note: `The line settles at ambient (${Math.round(ambientTempF)} F), which is above the target, so it never reaches it. There is no cooldown limit here.`,
    };
  }
  const hours = tau * Math.log((startTempF - ambientTempF) / (targetTempF - ambientTempF));
  const n = Math.max(2, Math.round(nStations));
  const stations = Array.from({ length: n }, (_, i) => {
    const t = (hours * 1.5 * i) / (n - 1);
    return { hours: t, tempF: ambientTempF + (startTempF - ambientTempF) * Math.exp(-t / tau) };
  });
  return { ok: true, hours, timeConstantHr: tau, stations };
};

/** Steel mass per foot of pipe, lb/ft, from the wall it actually has. */
export const STEEL_DENSITY_LB_FT3 = 490;

export const pipeMassLbPerFt = ({ idIn, odIn, densityLbFt3 = STEEL_DENSITY_LB_FT3 }) => {
  if (!(odIn > idIn)) return NaN;
  const areaFt2 = (Math.PI / 4) * (inToFt(odIn) ** 2 - inToFt(idIn) ** 2);
  return areaFt2 * densityLbFt3;
};

/** Contents mass per foot, lb/ft, for a fluid of a given density. */
export const contentsMassLbPerFt = ({ idIn, densityLbFt3 }) => {
  if (!(idIn > 0) || !(densityLbFt3 > 0)) return NaN;
  return (Math.PI / 4) * inToFt(idIn) ** 2 * densityLbFt3;
};
