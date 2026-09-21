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
 * How a rejected input is quoted back to the user. A refusal that says
 * only "invalid" makes the user hunt for which slot was wrong; naming
 * the value that arrived ends the hunt. A refusal object arriving where
 * a number belongs is named as one, because `pipeMassLbPerFt` and
 * `contentsMassLbPerFt` now return refusals, and passing one straight
 * into a mass slot is the obvious way to get here.
 */
const show = (v) => {
  if (typeof v === 'string') return `"${v}"`;
  if (v && typeof v === 'object' && v.ok === false && v.code) {
    return `a refusal (${v.code})`;
  }
  return String(v);
};

/**
 * How close two diameters have to be to count as the same diameter
 * where one layer meets the next. Relative, because a stack is
 * specified in inches and the numbers carry the usual binary residue
 * of arithmetic done on them.
 */
const CONTIGUITY_REL_TOL = 1e-9;

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
 * THE STACK IS CHECKED BEFORE IT IS SUMMED. Series resistances only add
 * up if the layers really are in series: every layer has to start where
 * the one inside it stopped, and every layer has to grow outward. A
 * stack with a gap in it, or with two layers listed the wrong way
 * round, still sums to a perfectly plausible resistance and returns a U
 * that nothing downstream can tell apart from a real one, so the stack
 * is refused rather than summed.
 *
 * returns { uBtuHrFt2F, resistances, referenceIdIn, totalResistance }
 */
export const overallU = ({
  layers, insideFilmH, outsideFilmH, burialFt, kSoil, referenceIdIn,
}) => {
  const list = layers || [];
  if (!list.length) {
    return {
      ok: false,
      code: 'noLayers',
      error: 'A pipe needs at least one layer: its own wall.',
    };
  }
  for (let i = 0; i < list.length; i += 1) {
    const layer = list[i] || {};
    if (!Number.isFinite(layer.idIn) || !Number.isFinite(layer.odIn)) {
      return {
        ok: false,
        code: 'layerNotNumeric',
        error: `Layer ${i} needs a numeric inside and outside diameter in inches. Its inside diameter was ${show(layer.idIn)} and its outside diameter was ${show(layer.odIn)}.`,
      };
    }
    if (!(layer.odIn > layer.idIn)) {
      return {
        ok: false,
        code: 'layerNotOrdered',
        error: `Layer ${i} runs from an inside diameter of ${layer.idIn} in to an outside diameter of ${layer.odIn} in, so it does not grow outward. Layers are listed from the bore outward and each one has to be larger outside than in.`,
      };
    }
    if (i > 0) {
      const prev = list[i - 1];
      const gap = layer.idIn - prev.odIn;
      if (Math.abs(gap) > CONTIGUITY_REL_TOL * Math.max(1, prev.odIn)) {
        return {
          ok: false,
          code: 'layersNotContiguous',
          error: `Layer ${i} starts at an inside diameter of ${layer.idIn} in but layer ${i - 1} ends at an outside diameter of ${prev.odIn} in, so there is a ${gap > 0 ? 'gap' : 'overlap'} between them. Series resistances only add up for a contiguous stack, so each layer has to start where the one inside it stopped.`,
        };
      }
    }
  }
  const bore = referenceIdIn ?? list[0].idIn;
  if (!Number.isFinite(bore) || !(bore > 0)) {
    return {
      ok: false,
      code: 'referenceNotNumeric',
      error: `U is referred to a diameter, and the one given was ${show(referenceIdIn)}. It has to be a positive number of inches.`,
    };
  }
  const outerOd = list[list.length - 1].odIn;
  const resistances = [];

  // A FILM OR A BURIAL TERM THAT CANNOT BE READ IS NOT AN OMITTED ONE.
  // The convention here is that zero means omit, which is fine, but
  // `> 0` cannot tell an omission from a NaN: a film coefficient that
  // came through as NaN was dropped exactly the way item 51's masses
  // were coalesced away, and the U that came back was too high with
  // nothing in the return countable. A value that was GIVEN and cannot
  // be read refuses; an absent one still omits the term.
  const filmSlots = [['insideFilm', insideFilmH], ['outsideFilm', outsideFilmH]];
  for (let i = 0; i < filmSlots.length; i += 1) {
    const [name, h] = filmSlots[i];
    if (h !== undefined && h !== null && !Number.isFinite(h)) {
      return {
        ok: false,
        code: 'filmNotNumeric',
        error: `The ${name === 'insideFilm' ? 'inside' : 'outside'} film coefficient was given as ${show(h)}, which is not a number, so the resistance it contributes cannot be formed. Leave it out to omit the film, or hand a number in Btu/(hr ft2 F). A film that cannot be read is not a film of zero resistance.`,
      };
    }
  }
  if (insideFilmH > 0) {
    resistances.push({ id: 'insideFilm', r: 1 / (insideFilmH * Math.PI * inToFt(list[0].idIn)) });
  }
  list.forEach((layer, i) => {
    resistances.push({ id: `layer${i}`, label: layer.label, r: layerResistance(layer) });
  });
  const burialGiven = (burialFt !== undefined && burialFt !== null)
    || (kSoil !== undefined && kSoil !== null);
  if (burialGiven && (!Number.isFinite(burialFt) || !Number.isFinite(kSoil))) {
    return {
      ok: false,
      code: 'burialNotNumeric',
      error: `A buried line needs both a burial depth and a soil conductivity, and both have to be numbers. The depth was ${show(burialFt)} ft and the soil conductivity was ${show(kSoil)} Btu/(hr ft F). Leave both out for a line on the seabed.`,
    };
  }
  if (burialFt > 0 && kSoil > 0) {
    const r = burialResistance({ odIn: outerOd, burialFt, kSoil });
    if (!Number.isFinite(r)) {
      // Item 48. The soil term used to be dropped when it came out
      // unreadable, which is the largest resistance in a buried line
      // going missing without a word.
      return {
        ok: false,
        code: 'burialNotResolved',
        error: `The soil resistance could not be formed from a burial depth of ${burialFt} ft, a soil conductivity of ${kSoil} Btu/(hr ft F) and an outside diameter of ${outerOd} in. On a buried line that is the largest resistance in the stack, so it is refused rather than left out.`,
      };
    }
    resistances.push({ id: 'burial', r });
  }
  if (outsideFilmH > 0) {
    resistances.push({ id: 'outsideFilm', r: 1 / (outsideFilmH * Math.PI * inToFt(outerOd)) });
  }

  if (resistances.some((x) => !Number.isFinite(x.r))) {
    return {
      ok: false,
      code: 'unresolvableLayer',
      error: 'A layer could not be resolved: every layer needs an inside diameter, a larger outside diameter and a positive conductivity.',
    };
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
 * THE PRESSURE COLUMN AND THE JT TERM STAND OR FALL TOGETHER. Both are
 * built from the same dp, so both need an inlet AND an outlet pressure.
 * A half specified pressure used to return a pressure column flat at
 * the inlet with the JT term silently zero, which is the one case where
 * an engineer most needs to be told: the column looked like an answer,
 * the cooling that a gas line's expansion actually causes was simply
 * missing from the temperatures, and nothing in the return said so. Now
 * an unformable dp gives a NaN pressure column and a note.
 *
 * returns { ok, stations: [{ xFt, tempF, pPsia }], arrivalTempF,
 *           relaxationLengthFt, ntu, note }
 */
export const steadyStateProfile = ({
  lengthFt, inletTempF, ambientTempF, massRateLbHr, cpBtuLbF, uBtuHrFt2F,
  idIn, inletPsia, outletPsia, jtCoeffFPerPsi = 0, nStations = 21,
}) => {
  const lc = relaxationLengthFt({ massRateLbHr, cpBtuLbF, uBtuHrFt2F, idIn });
  if (!Number.isFinite(lc) || !(lengthFt > 0)) {
    return {
      ok: false,
      code: 'profileInputsMissing',
      error: 'The profile needs a length, a mass rate, a heat capacity and a heat transfer coefficient.',
    };
  }
  const n = Math.max(2, Math.round(nStations));
  const dpKnown = Number.isFinite(inletPsia) && Number.isFinite(outletPsia);
  const dp = dpKnown ? inletPsia - outletPsia : 0;
  const ntu = lengthFt / lc;
  const stations = [];
  for (let i = 0; i < n; i += 1) {
    const xFt = (lengthFt * i) / (n - 1);
    const frac = xFt / lengthFt;
    // Heat loss to ambient, plus the cooling the pressure drop causes.
    //
    // THE JOULE-THOMSON TERM IS DAMPED BY THE SAME HEAT TRANSFER THAT
    // PULLS THE LINE BACK TO AMBIENT. Carried linearly, as it was, the
    // JT cooling generated at the inlet end is still on the fluid at the
    // outlet, which is only true for a perfectly insulated line. What
    // the energy balance says is
    //
    //   dT/dx = -(T - Ta)/Lc - jt (dp/L)
    //
    // and its solution carries the JT drop with the same exponential
    // memory the inlet temperature has:
    //
    //   jtDrop(x) = jt dp (1 - exp(-x/Lc)) / NTU,  NTU = L/Lc
    //
    // At the arrival end that is the `(1 - exp(-ntu))/ntu` factor: a
    // short line (NTU small) recovers none of it and the factor goes to
    // 1, which is the old linear form, and a long line recovers most of
    // it. On a line ten relaxation lengths long the undamped form
    // over-cools the arrival by a factor of ten. Item 48.
    const jtDrop = ntu > 0
      ? (jtCoeffFPerPsi * dp * (1 - Math.exp(-ntu * frac))) / ntu
      : jtCoeffFPerPsi * dp * frac;
    const tempF = ambientTempF + (inletTempF - ambientTempF) * Math.exp(-xFt / lc) - jtDrop;
    stations.push({
      xFt,
      tempF,
      // The column is built from dp, so it is available exactly when dp
      // is. Falling back to a flat column at the inlet would hide the
      // fact that no JT cooling was applied.
      pPsia: dpKnown ? inletPsia - dp * frac : NaN,
    });
  }
  return {
    ok: true,
    stations,
    arrivalTempF: stations[stations.length - 1].tempF,
    relaxationLengthFt: lc,
    // Number of transfer units: length measured in relaxation lengths.
    ntu,
    // How much of the Joule-Thomson cooling survives to the arrival end
    // after the line has traded heat with ambient. 1 on a short line,
    // small on a long one.
    jtDampingFactor: ntu > 0 ? (1 - Math.exp(-ntu)) / ntu : 1,
    note: dpKnown ? null : `The pressure drop could not be formed, so the Joule-Thomson term was not applied and the pressure column is not available. It needs both an inlet pressure and an outlet pressure: the inlet was ${show(inletPsia)} and the outlet was ${show(outletPsia)}.`,
  };
};

/**
 * The overall U that would land the fluid at a target arrival
 * temperature, inverted from the same exponential.
 *
 *   U = m_dot Cp / (pi D L) ln( (T_in - T_amb) / (T_target - T_amb) )
 *
 * Returns a refusal when the target is unreachable, which happens for
 * two quite different reasons and they are worth separating: a target
 * at or below ambient can never be held whatever the insulation, and a
 * target above the inlet is not a cooling problem at all.
 */
export const uForArrivalTemp = ({
  lengthFt, inletTempF, ambientTempF, targetTempF, massRateLbHr, cpBtuLbF, idIn,
}) => {
  if (!(targetTempF > ambientTempF)) {
    return {
      ok: false,
      code: 'targetBelowAmbient',
      reason: `A line cannot arrive below ambient (${ambientTempF} F) no matter how well it is insulated. The target has to be above it.`,
    };
  }
  if (!(inletTempF > targetTempF)) {
    return {
      ok: false,
      code: 'inletBelowTarget',
      reason: 'The fluid already enters below the target, so insulation is not the problem.',
    };
  }
  const ratio = Math.log((inletTempF - ambientTempF) / (targetTempF - ambientTempF));
  const u = (massRateLbHr * cpBtuLbF * ratio) / (Math.PI * inToFt(idIn) * lengthFt);
  return { ok: true, uBtuHrFt2F: u, ntu: ratio };
};

/**
 * Cooldown after a shutdown: the no-touch time.
 *
 * Lumped capacitance on everything that has to cool: the fluid in the
 * line and the steel and coatings around it. Leaving the pipe's own
 * heat capacity out is a common and optimistic error, because on an
 * insulated small-bore line the steel can carry a significant share of
 * the heat.
 *
 * `contents` and `shell` each { massLbPerFt, cpBtuLbF }. BOTH ARE
 * REQUIRED AND BOTH ARE CHECKED. The mass slots used to be read as
 * `(x?.massLbPerFt || 0)`, and NaN is falsy, so one unreadable mass
 * quietly became a zero mass: the call still returned ok with a full
 * station table, short by exactly that slot's share of M Cp, and
 * nothing in the return was countable, so the loss could not be
 * detected at any effort. A slot that cannot be read is refused.
 *
 * returns { ok, hours, timeConstantHr, stations }
 */
export const cooldownTime = ({
  contents, shell, uBtuHrFt2F, idIn, startTempF, ambientTempF, targetTempF,
  nStations = 25,
}) => {
  let mcp = 0;
  const slots = [['contents', contents], ['shell', shell]];
  for (let i = 0; i < slots.length; i += 1) {
    const [name, slot] = slots[i];
    const mass = slot ? slot.massLbPerFt : undefined;
    const cp = slot ? slot.cpBtuLbF : undefined;
    if (!Number.isFinite(mass) || !Number.isFinite(cp)) {
      return {
        ok: false,
        code: 'massNotNumeric',
        error: `Cooldown needs a mass per foot and a heat capacity for the ${name}, and both have to be numbers. The ${name} mass was ${show(mass)} lb/ft and its heat capacity was ${show(cp)} Btu/(lb F). A slot that cannot be read is refused rather than counted as no mass, because a missing slot lands as a cooldown time that is too short and nothing in the answer shows it.`,
      };
    }
    mcp += mass * cp;
  }
  const ua = uBtuHrFt2F * Math.PI * inToFt(idIn); // per ft of pipe
  if (!(mcp > 0) || !(ua > 0)) {
    return {
      ok: false,
      code: 'nothingToCool',
      error: 'Cooldown needs a heat capacity for what is cooling and a heat transfer coefficient.',
    };
  }
  const tau = mcp / ua;
  if (!(startTempF > ambientTempF)) {
    return {
      ok: false,
      code: 'alreadyAtAmbient',
      error: 'The fluid is already at or below ambient, so there is nothing to cool.',
    };
  }
  // Item 48. A line that is already at or below the touch temperature
  // has no cooldown time: the log below goes to zero or negative and
  // came back as an answer of 0 hours or less, which reads as "cool
  // now" and is a different statement from "already there".
  if (!(startTempF > targetTempF)) {
    return {
      ok: false,
      code: 'startBelowTarget',
      error: `The line starts at ${startTempF} F and the target is ${targetTempF} F, so it is already at or below the temperature the cooldown is measured to. There is no time to report. Check which of the two is the start.`,
    };
  }
  if (!(targetTempF > ambientTempF)) {
    return {
      ok: true,
      hours: Infinity,
      timeConstantHr: tau,
      stations: [],
      note: `The line settles at ambient (${ambientTempF} F), which is above the target, so it never reaches it. There is no cooldown limit here.`,
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

/**
 * Steel mass per foot, lb/ft. A number when the geometry is readable
 * and a refusal object when it is not.
 *
 * These two used to return NaN, and NaN was what `cooldownTime` then
 * read through `|| 0` into a zero mass. Returning a refusal instead
 * means the bad geometry announces itself at the point it is made,
 * rather than arriving downstream as a mass that is merely small.
 */
export const pipeMassLbPerFt = ({ idIn, odIn, densityLbFt3 = STEEL_DENSITY_LB_FT3 }) => {
  if (!Number.isFinite(idIn) || !Number.isFinite(odIn) || !(odIn > idIn)) {
    return {
      ok: false,
      code: 'pipeGeometryInvalid',
      error: `A pipe mass per foot needs an inside diameter and a larger outside diameter, both in inches. The inside diameter was ${show(idIn)} and the outside diameter was ${show(odIn)}.`,
    };
  }
  if (!Number.isFinite(densityLbFt3) || !(densityLbFt3 > 0)) {
    return {
      ok: false,
      code: 'densityInvalid',
      error: `A pipe mass per foot needs a positive density in lb/ft3. It was ${show(densityLbFt3)}.`,
    };
  }
  const areaFt2 = (Math.PI / 4) * (inToFt(odIn) ** 2 - inToFt(idIn) ** 2);
  return areaFt2 * densityLbFt3;
};

/**
 * Contents mass per foot, lb/ft, for a fluid of a given density. A
 * number when the inputs are readable and a refusal object when they
 * are not, for the same reason as `pipeMassLbPerFt`.
 */
export const contentsMassLbPerFt = ({ idIn, densityLbFt3 }) => {
  if (!Number.isFinite(idIn) || !(idIn > 0)
    || !Number.isFinite(densityLbFt3) || !(densityLbFt3 > 0)) {
    return {
      ok: false,
      code: 'contentsGeometryInvalid',
      error: `A contents mass per foot needs a positive inside diameter in inches and a positive density in lb/ft3. The inside diameter was ${show(idIn)} and the density was ${show(densityLbFt3)}.`,
    };
  }
  return (Math.PI / 4) * inToFt(idIn) ** 2 * densityLbFt3;
};
