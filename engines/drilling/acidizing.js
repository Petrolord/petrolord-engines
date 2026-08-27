// Matrix acidizing engine (Drilling D9 — Stimulation Designer): Hawkins
// damage skin, sandstone damage-removal planning volume, carbonate
// wormhole skin, and the maximum matrix injection rate.
//
// Published bases:
//   * Hawkins (1956):  s = (k/ks - 1) ln(rs/rw).
//   * Sandstone removal: the acid front is tracked VOLUMETRICALLY as
//     pore volumes of the treated annulus,
//       V = PV_factor * pi (ra^2 - rw^2) h phi
//     (an explicitly-labeled planning rule; HF/HCl stoichiometry,
//     preflush chemistry and mineralogy are OUT OF SCOPE and live with
//     the lab). Skin after treatment: permeability restored inside ra,
//       s_after = (k/ks - 1) ln(rs/ra)  for ra < rs,  0 for ra >= rs.
//   * Carbonate wormholes: volumetric with a LAB-CALIBRATED
//     pore-volumes-to-breakthrough PV_bt,
//       rWh = sqrt(rw^2 + V / (pi h phi PVbt)),  s = -ln(rWh/rw)
//     (Buijse-Glasbergen-style optimum rate/PVbt selection is a lab
//     input, not computed here).
//   * Max matrix rate: steady-state Darcy radial with p_wf held just
//     below the fracturing pressure,
//       q = 2 pi k h (pFrac - pRes) / (mu (ln(re/rw) + s)).
//
// UNITS: STRICT SI. Screening grade by construction; every card that
// uses these prints it.
//
// Validation: oracle_stim.py self-asserted closed forms + goldens;
// jest in __tests__/drilling.stim.test.js; runner gates A28-A29.

export function hawkinsSkin({ kOverKs, rsM, rwM }) {
  if (!(kOverKs >= 1)) throw new Error('k/ks must be >= 1 (ks is the damaged permeability).');
  if (!(rsM > rwM) || !(rwM > 0)) throw new Error('Need rs > rw > 0.');
  return (kOverKs - 1) * Math.log(rsM / rwM);
}

/** Planning acid volume to move the front to ra, plus the skin after. */
export function sandstoneAcid({
  rwM, raM, hM, porosity, pvFactor = 1.5, kOverKs, rsM,
}) {
  if (!(raM > rwM)) throw new Error('Acid radius must exceed the wellbore radius.');
  if (!(hM > 0) || !(porosity > 0 && porosity < 1)) throw new Error('Invalid interval/porosity.');
  if (!(pvFactor > 0)) throw new Error('Pore-volume factor must be positive.');
  const volumeM3 = pvFactor * Math.PI * (raM * raM - rwM * rwM) * hM * porosity;
  const sBefore = hawkinsSkin({ kOverKs, rsM, rwM });
  const sAfter = raM >= rsM ? 0 : (kOverKs - 1) * Math.log(rsM / raM);
  return { volumeM3, sBefore, sAfter, removed: raM >= rsM };
}

/** Carbonate wormhole radius and skin from the pumped volume. */
export function carbonateAcid({ rwM, hM, porosity, volumeM3, pvBt = 1.0 }) {
  if (!(volumeM3 > 0)) throw new Error('Acid volume must be positive.');
  if (!(hM > 0) || !(porosity > 0 && porosity < 1)) throw new Error('Invalid interval/porosity.');
  if (!(pvBt > 0)) throw new Error('PV_bt must be positive (lab-calibrated).');
  if (!(rwM > 0)) throw new Error('Wellbore radius must be positive.');
  const rWhM = Math.sqrt(rwM * rwM + volumeM3 / (Math.PI * hM * porosity * pvBt));
  const skin = -Math.log(rWhM / rwM);
  return { rWhM, skin };
}

/** Steady-state Darcy ceiling on matrix injection below frac pressure. */
export function maxMatrixRate({
  kM2, hM, pFracPa, pResPa, muPaS, reM, rwM, sSkin = 0,
}) {
  if (!(kM2 > 0) || !(hM > 0) || !(muPaS > 0)) throw new Error('Invalid rock/fluid inputs.');
  if (!(pFracPa > pResPa)) throw new Error('Frac pressure must exceed reservoir pressure.');
  if (!(reM > rwM) || !(rwM > 0)) throw new Error('Need re > rw > 0.');
  const denom = Math.log(reM / rwM) + sSkin;
  if (!(denom > 0)) throw new Error('ln(re/rw) + s must be positive.');
  const qM3s = (2 * Math.PI * kM2 * hM * (pFracPa - pResPa)) / (muPaS * denom);
  return { qM3s };
}
