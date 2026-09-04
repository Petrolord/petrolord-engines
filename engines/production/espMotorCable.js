/**
 * ESP motor, cable and surface power (Production P5).
 *
 * The electrical half of an installation. Three questions:
 *
 *   what current does the motor draw at this load
 *   what does the cable lose carrying it down the hole
 *   what has to be present at surface for the motor to see its plate
 *
 * Cable resistance is the published copper conductor data (ohms per
 * 1000 ft at 77 degF, from the standard AWG tables) with the usual
 * temperature correction alpha = 0.00393 per degF referenced to 77
 * degF, applied at the average cable temperature. Nothing here is a
 * vendor table: conductor resistance is a property of copper, and
 * ampacity limits belong to the cable's insulation system and must come
 * from the manufacturer, which is why they are inputs with the
 * published copper values only as a default.
 *
 * The three-phase voltage drop is the standard
 *
 *   dV = sqrt(3) * I * R_total * (cable length in thousands of feet)
 *
 * with R in ohms per 1000 ft. Power factor enters the kVA, not the
 * resistive drop.
 *
 * Field units: length ft, temperature degF, current A, voltage V,
 * power hp and kW.
 */

/** Copper temperature coefficient per degF, referenced to 77 degF. */
export const COPPER_ALPHA_PER_F = 0.00393 / 1.8;
export const COPPER_REF_TEMP_F = 77;

/** Resistance of a copper conductor at temperature, ohms/1000 ft. */
export const conductorResistance = ({ ohmsPer1000FtAt77F, tempF }) =>
  ohmsPer1000FtAt77F * (1 + COPPER_ALPHA_PER_F * (tempF - COPPER_REF_TEMP_F));

/**
 * Motor current at a shaft load.
 *
 * A submersible motor's nameplate is (hp, volts, amps) at full load, so
 * the honest way to get current at part load is to scale the nameplate
 * by the load fraction rather than to invent an efficiency and power
 * factor curve. Below about half load the real current flattens out
 * toward the magnetising current, so the estimate is flagged there
 * rather than quietly extrapolated to zero.
 *
 * `loadFraction` here is the ELECTRICAL load fraction, shaft hp over
 * NAMEPLATE hp, and it deliberately carries no derate. A derate for
 * heat, for low fluid velocity past the motor, for voltage unbalance or
 * for a thrust rating cuts the shaft power the motor may legally carry;
 * it does not change the current the machine draws at a shaft load it
 * is actually carrying, and the published relation for reading load off
 * measured amps is against the plate (PetroWiki, ESP motors: the motor
 * current is nearly linear with HP loading, which is why amps are the
 * usual measure of actual loading).
 *
 * `espDesign.sizePump` returns a field of the same name that answers
 * the OTHER question: shaft hp over the DERATED rating, which is the
 * selection check. The two are different quantities and can sit many
 * points apart (12.2 points on a 12 percent derate). Read the field
 * name with the module it came from.
 */
export const motorCurrent = ({ shaftHp, nameplateHp, nameplateAmps }) => {
  if (!(nameplateHp > 0) || !(nameplateAmps > 0)) return { amps: NaN, loadFraction: NaN };
  const loadFraction = shaftHp / nameplateHp;
  return {
    amps: nameplateAmps * loadFraction,
    loadFraction,
    estimateWeakBelowHalfLoad: loadFraction < 0.5,
  };
};

/**
 * Three-phase voltage drop down the cable.
 * inputs: { amps, lengthFt, ohmsPer1000FtAt77F, cableTempF }
 */
export const cableVoltageDrop = ({
  amps, lengthFt, ohmsPer1000FtAt77F, cableTempF = COPPER_REF_TEMP_F,
}) => {
  const r = conductorResistance({ ohmsPer1000FtAt77F, tempF: cableTempF });
  const dropV = Math.sqrt(3) * amps * r * (lengthFt / 1000);
  return { dropV, resistanceOhmsPer1000Ft: r };
};

/** Power lost as heat in the cable, kW. */
export const cablePowerLossKw = ({ amps, lengthFt, ohmsPer1000FtAt77F, cableTempF }) => {
  const r = conductorResistance({ ohmsPer1000FtAt77F, tempF: cableTempF });
  return (3 * amps * amps * r * (lengthFt / 1000)) / 1000;
};

/**
 * Surface requirement for a motor at load: the voltage the switchboard
 * must present, the kVA behind it, and the drop as a percentage, which
 * is the number a cable is actually selected on.
 */
export const surfaceRequirement = ({
  shaftHp, nameplateHp, nameplateAmps, nameplateVolts, powerFactor = 0.85,
  lengthFt, ohmsPer1000FtAt77F, cableTempF,
}) => {
  const current = motorCurrent({ shaftHp, nameplateHp, nameplateAmps });
  const { dropV, resistanceOhmsPer1000Ft } = cableVoltageDrop({
    amps: current.amps, lengthFt, ohmsPer1000FtAt77F, cableTempF,
  });
  const surfaceVolts = nameplateVolts + dropV;
  const kva = (Math.sqrt(3) * surfaceVolts * current.amps) / 1000;
  return {
    ...current,
    dropV,
    dropPct: nameplateVolts > 0 ? (dropV / nameplateVolts) * 100 : NaN,
    surfaceVolts,
    kva,
    kw: kva * powerFactor,
    resistanceOhmsPer1000Ft,
    lossKw: cablePowerLossKw({
      amps: current.amps, lengthFt, ohmsPer1000FtAt77F, cableTempF,
    }),
  };
};

/**
 * Pick a cable: the smallest conductor whose voltage drop stays inside
 * `maxDropPct` and whose ampacity (a manufacturer number, passed in
 * with the candidate) covers the current.
 *
 * Returns { cable, requirement, candidates } with `cable` null when
 * none qualifies, rather than returning the least bad one silently.
 *
 * WHAT `ampacityOk` MEANS. It is true when the candidate carries no
 * `ampacityA` at all, because ampacity belongs to the insulation system
 * and the well temperature and this package refuses to invent one (see
 * data/espCatalog.js). The shipped CABLE_SIZES carry conductor
 * resistance only, so on that table `ampacityOk` is true by
 * construction for every candidate and the selection runs on voltage
 * drop alone. That is a real half of the published method going
 * unchecked: PetroWiki, ESP power cable, selects on voltage drop AND on
 * the ampacity chart at the conductor temperature. A caller that wants
 * both halves must pass `ampacityA` on each candidate, and a caller
 * that does not should not describe the result as a cable that carries
 * the current, only as one that keeps the drop inside the limit.
 */
export const selectCable = ({
  cables, maxDropPct = 5, shaftHp, nameplateHp, nameplateAmps, nameplateVolts,
  powerFactor, lengthFt, cableTempF,
}) => {
  const candidates = [...(cables || [])]
    .sort((a, b) => a.ohmsPer1000FtAt77F - b.ohmsPer1000FtAt77F) // biggest conductor first
    .reverse() // smallest conductor first: try the cheapest that works
    .map((cable) => {
      const requirement = surfaceRequirement({
        shaftHp, nameplateHp, nameplateAmps, nameplateVolts, powerFactor,
        lengthFt, ohmsPer1000FtAt77F: cable.ohmsPer1000FtAt77F, cableTempF,
      });
      const ampacityOk = !(cable.ampacityA > 0) || requirement.amps <= cable.ampacityA;
      return {
        cable,
        requirement,
        ampacityOk,
        dropOk: requirement.dropPct <= maxDropPct,
        ok: ampacityOk && requirement.dropPct <= maxDropPct,
      };
    });
  const hit = candidates.find((c) => c.ok) || null;
  return {
    cable: hit ? hit.cable : null,
    requirement: hit ? hit.requirement : null,
    candidates,
    maxDropPct,
  };
};
