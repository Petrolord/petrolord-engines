/**
 * ESP reference data (Production P5).
 *
 * What is here and what is deliberately not:
 *
 *  - REFERENCE_STAGES are MODEL stages, built by
 *    espPump.referenceStageCurve from four named parameters (rate and
 *    head at best efficiency, the shutoff head ratio, peak efficiency).
 *    They are shapes for sizing exercises, grouped by the housing sizes
 *    the industry standardised on. They are NOT any manufacturer's
 *    pump, they carry no part numbers, and a real design enters the
 *    vendor's own curve points instead. The predecessor app shipped
 *    invented curves under real-sounding vendor model names, which is
 *    exactly what this file refuses to do.
 *  - CABLE_SIZES are copper conductor resistances from the standard AWG
 *    tables — a property of the metal, not a vendor's product. The
 *    ampacity column is left for the manufacturer: it belongs to the
 *    insulation system and the well temperature, so it is an input.
 *  - MOTOR_FRAMES are the common submersible motor voltage and power
 *    combinations, present so a sizing run has somewhere to start. A
 *    real design types the nameplate off the motor being run.
 */

export const REFERENCE_STAGES = [
  {
    id: 'ref-400-1000',
    label: 'Reference stage, 400 series, 1000 bbl/d BEP',
    housingOdIn: 4.0,
    bepBpd: 1000,
    bepHeadFt: 33,
    shutoffRatio: 1.4,
    bepEfficiency: 0.63,
    qMin: 500,
    qMax: 1450,
  },
  {
    id: 'ref-540-2500',
    label: 'Reference stage, 540 series, 2500 bbl/d BEP',
    housingOdIn: 5.13,
    bepBpd: 2500,
    bepHeadFt: 28,
    shutoffRatio: 1.35,
    bepEfficiency: 0.70,
    qMin: 1250,
    qMax: 3500,
  },
  {
    id: 'ref-562-4000',
    label: 'Reference stage, 562 series, 4000 bbl/d BEP',
    housingOdIn: 5.62,
    bepBpd: 4000,
    bepHeadFt: 23,
    shutoffRatio: 1.32,
    bepEfficiency: 0.72,
    qMin: 2200,
    qMax: 5600,
  },
  {
    id: 'ref-675-7000',
    label: 'Reference stage, 675 series, 7000 bbl/d BEP',
    housingOdIn: 6.75,
    bepBpd: 7000,
    bepHeadFt: 18,
    shutoffRatio: 1.3,
    bepEfficiency: 0.74,
    qMin: 4000,
    qMax: 9800,
  },
];

export const referenceStage = (id) =>
  REFERENCE_STAGES.find((s) => s.id === id) || REFERENCE_STAGES[1];

/**
 * Copper conductor resistance, ohms per 1000 ft at 77 degF (standard
 * AWG table values for stranded copper). Ampacity is intentionally
 * absent: it is a manufacturer and temperature number.
 *
 * The consequence, stated here so it is not discovered downstream:
 * `espMotorCable.selectCable` treats a candidate with no `ampacityA` as
 * passing the ampacity check, so run against THIS table its
 * `ampacityOk` is true for every size and the pick is made on voltage
 * drop alone. Supply `ampacityA` from the manufacturer's chart at the
 * conductor temperature to get the second half of the check.
 */
export const CABLE_SIZES = [
  { awg: '6', label: '6 AWG', ohmsPer1000FtAt77F: 0.4028 },
  { awg: '4', label: '4 AWG', ohmsPer1000FtAt77F: 0.2533 },
  { awg: '2', label: '2 AWG', ohmsPer1000FtAt77F: 0.1593 },
  { awg: '1', label: '1 AWG', ohmsPer1000FtAt77F: 0.1264 },
  { awg: '1/0', label: '1/0 AWG', ohmsPer1000FtAt77F: 0.1002 },
];

/** Common submersible motor nameplates, as a starting point only. */
export const MOTOR_FRAMES = [
  { id: 'm-60-1000', hp: 60, volts: 1000, amps: 38, seriesOdIn: 4.56 },
  { id: 'm-100-1300', hp: 100, volts: 1300, amps: 49, seriesOdIn: 4.56 },
  { id: 'm-150-2000', hp: 150, volts: 2000, amps: 48, seriesOdIn: 5.43 },
  { id: 'm-250-2400', hp: 250, volts: 2400, amps: 67, seriesOdIn: 5.43 },
  { id: 'm-400-3300', hp: 400, volts: 3300, amps: 78, seriesOdIn: 5.62 },
];

export const motorFrame = (id) => MOTOR_FRAMES.find((m) => m.id === id) || MOTOR_FRAMES[1];
