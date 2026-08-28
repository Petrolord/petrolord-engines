/**
 * Bellows gas-lift valve mechanics (Production P4).
 *
 * A gas-lift valve is a nitrogen-charged bellows acting on a stem and
 * port. Everything a designer needs from it follows from one force
 * balance at the moment the stem lifts off the seat, plus the real-gas
 * behaviour of the dome charge between the 60 degF test rack and the
 * valve's own temperature downhole.
 *
 * Force balance, bellows area Ab, port area Ap, R = Ap/Ab:
 *
 *   injection-pressure-operated (IPO, casing operated)
 *     Pd*Ab = Pc*(Ab - Ap) + Pt*Ap      =>  Pc,open = (Pd - R*Pt)/(1 - R)
 *   production-pressure-operated (PPO, fluid operated)
 *     Pd*Ab = Pt*(Ab - Ap) + Pc*Ap      =>  Pt,open = (Pd - R*Pc)/(1 - R)
 *
 * Both are the same relation with the casing and tubing roles swapped,
 * which is why one pair of helpers covers both valve families. Closing
 * happens when the pressure acting on the full bellows area falls back
 * to the dome pressure, so the closing pressure IS the dome pressure at
 * valve temperature and the valve's spread is
 *
 *   spread = P,open - P,close = R/(1 - R) * (P,open - P,other side)
 *
 * On the test rack the far side is vented to atmosphere (Pt = 0) and
 * the dome is at 60 degF, so the tester's target reads
 *
 *   TRO = Pd60 / (1 - R)
 *
 * Dome pressure between the two temperatures is a fixed-volume real-gas
 * ratio, P/(z T) = constant, solved on the nitrogen z of
 * gasProperties.js — not the linear "1 + 0.00215 (T - 60)" rule of
 * thumb, which drifts several percent over a hot deep valve.
 *
 * Gas throughput of the port is the Thornhill-Craver equation, the
 * industry convention for what a valve or orifice will pass; the
 * subcritical branch is used down to the critical pressure ratio and
 * the ratio is clamped there beyond it.
 *
 * Pressures psia unless a name says gauge, temperatures degF, areas
 * in2, rates Mscf/d.
 */

import { nitrogenZ, toRankine } from './gasProperties.js';

/** Test-rack base temperature, degF. */
export const TEST_RACK_TEMP_F = 60;

/** Thornhill-Craver discharge coefficient, the value the equation was
 *  published with (a sharp-edged seat with a stem in the flow path). */
export const TC_DISCHARGE_COEFF = 0.865;

/** Gravitational constant used by the Thornhill-Craver constant. */
const G_FT_S2 = 32.17;

/** Port flow area, in2. */
export const portArea = (portIdIn) => (Math.PI / 4) * portIdIn * portIdIn;

/** R = Ap/Ab for a port in a given bellows. */
export const portToBellowsRatio = ({ portIdIn, bellowsAreaIn2 }) =>
  portArea(portIdIn) / bellowsAreaIn2;

/**
 * Dome pressure at valve temperature from its 60 degF charge.
 * Solves Pd_T / (z(Pd_T, T) * T_R) = Pd_60 / (z(Pd_60, 60) * 519.67).
 */
export const domePressureAtTemp = ({ pd60Psia, tF, tol = 1e-9, maxIter = 60 }) => {
  const base = pd60Psia / (nitrogenZ({ pPsia: pd60Psia, tF: TEST_RACK_TEMP_F }) * toRankine(TEST_RACK_TEMP_F));
  const tR = toRankine(tF);
  let p = pd60Psia * (tR / toRankine(TEST_RACK_TEMP_F)); // ideal-gas first guess
  for (let i = 0; i < maxIter; i += 1) {
    const next = base * nitrogenZ({ pPsia: p, tF }) * tR;
    if (Math.abs(next - p) < tol) return next;
    p = next;
  }
  return p;
};

/** The inverse: the 60 degF charge that gives `pdTPsia` at `tF`. */
export const domePressureAt60 = ({ pdTPsia, tF, tol = 1e-9, maxIter = 60 }) => {
  const base = pdTPsia / (nitrogenZ({ pPsia: pdTPsia, tF }) * toRankine(tF));
  const t60R = toRankine(TEST_RACK_TEMP_F);
  let p = pdTPsia * (t60R / toRankine(tF));
  for (let i = 0; i < maxIter; i += 1) {
    const next = base * nitrogenZ({ pPsia: p, tF: TEST_RACK_TEMP_F }) * t60R;
    if (Math.abs(next - p) < tol) return next;
    p = next;
  }
  return p;
};

/**
 * Temperature correction factor Ct = Pd60 / PdT for a dome that reads
 * `pdTPsia` at `tF`. Reported for the valve sheet; the design math uses
 * the pressures themselves, never a chart factor.
 */
export const temperatureCorrectionFactor = ({ pdTPsia, tF }) =>
  domePressureAt60({ pdTPsia, tF }) / pdTPsia;

/** IPO: casing pressure at which the valve opens, at valve depth. */
export const ipoOpeningPressure = ({ pdTPsia, ptPsia, r }) =>
  (pdTPsia - r * ptPsia) / (1 - r);

/** IPO: the dome pressure at valve temperature that gives that opening. */
export const ipoDomeFromOpening = ({ pcoPsia, ptPsia, r }) =>
  pcoPsia * (1 - r) + r * ptPsia;

/** PPO: tubing pressure at which the valve opens, at valve depth. */
export const ppoOpeningPressure = ({ pdTPsia, pcPsia, r }) =>
  (pdTPsia - r * pcPsia) / (1 - r);

/** PPO: the dome pressure at valve temperature that gives that opening. */
export const ppoDomeFromOpening = ({ ptoPsia, pcPsia, r }) =>
  ptoPsia * (1 - r) + r * pcPsia;

/** Test-rack opening pressure from the 60 degF dome charge. */
export const testRackOpening = ({ pd60Psia, r }) => pd60Psia / (1 - r);

/** The 60 degF dome charge behind a test-rack setting. */
export const domeFromTestRack = ({ troPsia, r }) => troPsia * (1 - r);

/**
 * Valve spread: how far the operating pressure must fall from the
 * opening pressure before the valve closes. Large spread means a valve
 * that stays open through a wide casing swing, which is what makes an
 * unloading string multipoint.
 *
 * Closing happens at the dome pressure, so spread = P,open - Pd, and
 * substituting the force balance Pd = P,open (1 - R) + R P,other gives
 *
 *   spread = R * (P,open - P,other)
 *
 * which is the form used here; the equivalent dome form is
 * R/(1 - R) * (Pd - P,other).
 */
export const valveSpread = ({ pOpenPsia, pOtherSidePsia, r }) =>
  r * (pOpenPsia - pOtherSidePsia);

/** Critical (choked) downstream/upstream pressure ratio. */
export const criticalPressureRatio = (k) => Math.pow(2 / (k + 1), k / (k - 1));

/**
 * Thornhill-Craver gas throughput of a port, Mscf/d.
 *
 *   q = 155.5 * Cd * A * P1 * sqrt( 2 g k/(k-1) * (r^(2/k) - r^((k+1)/k))
 *                                   / (gammaG * T1) )
 *
 * r = P2/P1 clamped at the critical ratio, so the same expression
 * covers both branches continuously.
 * inputs: { pUpPsia, pDnPsia, portIdIn, gasSg, tF, cd, k }
 * returns { qMscfd, regime, ratio, criticalRatio, areaIn2 }
 */
export const thornhillCraver = ({
  pUpPsia, pDnPsia, portIdIn, gasSg, tF, cd = TC_DISCHARGE_COEFF, k = 1.27,
}) => {
  const areaIn2 = portArea(portIdIn);
  const rc = criticalPressureRatio(k);
  if (!(pUpPsia > 0) || !(portIdIn > 0)) {
    return { qMscfd: 0, regime: 'none', ratio: NaN, criticalRatio: rc, areaIn2 };
  }
  const raw = Math.max(pDnPsia, 0) / pUpPsia;
  if (raw >= 1) return { qMscfd: 0, regime: 'none', ratio: raw, criticalRatio: rc, areaIn2 };
  const r = Math.max(raw, rc);
  const bracket = Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k);
  const q = 155.5 * cd * areaIn2 * pUpPsia
    * Math.sqrt((2 * G_FT_S2 * k / (k - 1)) * bracket / (gasSg * toRankine(tF)));
  return {
    qMscfd: q,
    regime: raw <= rc ? 'critical' : 'subcritical',
    ratio: raw,
    criticalRatio: rc,
    areaIn2,
  };
};

/**
 * Smallest catalog port that passes `targetMscfd` at the given
 * differential, with the passed rate of every candidate. Returns
 * { port, qMscfd, candidates } — port null when none is large enough.
 */
export const selectPort = ({
  ports, targetMscfd, pUpPsia, pDnPsia, gasSg, tF, cd = TC_DISCHARGE_COEFF, k = 1.27,
}) => {
  const candidates = [...ports]
    .sort((a, b) => a.idIn - b.idIn)
    .map((port) => ({
      port,
      ...thornhillCraver({ pUpPsia, pDnPsia, portIdIn: port.idIn, gasSg, tF, cd, k }),
    }));
  const hit = candidates.find((c) => c.qMscfd >= targetMscfd);
  return {
    port: hit ? hit.port : null,
    qMscfd: hit ? hit.qMscfd : (candidates.length ? candidates[candidates.length - 1].qMscfd : 0),
    candidates,
  };
};
