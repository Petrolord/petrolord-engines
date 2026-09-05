/**
 * Continuous gas-lift installation design (Production P4): valve
 * spacing, valve settings, the unloading sequence and the deepest
 * point of gas injection.
 *
 * The design problem. A well that will not flow is full of kill fluid.
 * Injection gas is applied to the annulus and U-tubes that fluid down
 * and out through the tubing; each time the fluid level passes a valve
 * the well can be lifted from a little deeper. Spacing is the question
 * of where those valves go so the string unloads without the injection
 * pressure ever running out, and so the final valve sits as deep as the
 * available pressure allows, because injection depth is what sets how
 * much the well can produce.
 *
 * The method implemented here is the classic top-down pressure
 * traverse construction (Takacs, Gas Lift Manual; Brown, Technology of
 * Artificial Lift; API Gas Lift Manual Book 6). Three straight-line
 * ideas do the work:
 *
 *   injection line   the real-gas casing column from the surface
 *                    injection pressure (gasProperties.gasColumnPressure,
 *                    never a flat 0.02 psi/ft rule of thumb)
 *   unloading line   the kill-fluid gradient from the fluid level down
 *   transfer line    the production pressure the tubing shows during
 *                    unloading, wellhead pressure plus the lifted
 *                    gradient
 *
 * Valve 1 sits where the injection line first overcomes a full column
 * of kill fluid. Every valve after it sits where the injection line,
 * decremented by the design's surface pressure drop per valve, still
 * beats the transfer pressure at the valve above by the transfer
 * differential, with kill fluid in between.
 *
 * Two spacing conventions are supported and are the same recursion with
 * a different decrement: `surfaceClose` drops the surface injection
 * pressure a fixed amount per valve (the usual 20-50 psi, which is what
 * makes upper valves close as the point of injection moves down), and
 * `constantPressure` holds the surface pressure and relies on the
 * transfer differential alone.
 *
 * What this module does NOT do: it does not solve the well's inflow or
 * multiphase outflow. The flowing production traverse used to locate
 * the deepest injection point is passed in as a depth-pressure table,
 * so the caller can build it from a validated nodal model rather than
 * this module inventing a gradient.
 *
 * Pressures psia, depths ft TVD, temperatures degF, gradients psi/ft,
 * gas rates Mscf/d.
 *
 * DECISIONS THIS MODULE MAKES, stated here because a reader of the
 * numbers cannot see them in the numbers.
 *
 * 1. The closing test in the unloading walk uses `>=`, so a valve
 *    sitting EXACTLY at its closing pressure is treated as OPEN. The
 *    equality is a knife edge on which nothing physical can be decided,
 *    and the consequence of the two readings is not symmetric: calling
 *    such a valve shut hides a multipointing string, calling it open
 *    shows a design with no margin as the marginal design it is. A
 *    design that wants a verdict of shut has to earn it with a margin.
 *    See `unloadingSequence`.
 * 2. A valve with no closing pressure at all, which is the bottom
 *    orifice, is SKIPPED by that test rather than compared. It has no
 *    dome charge, so there is no pressure at which it closes, and a
 *    missing closing pressure is not a closing pressure of zero.
 * 3. THE CLOSING TEST IS TAKEN IN THE FLUID THAT ACTS ON THE BELLOWS.
 *    An injection-pressure-operated valve is closed by the casing and
 *    is tested against the casing column at its own depth; a
 *    production-pressure-operated valve is closed by the tubing and is
 *    tested against the tubing pressure at its own depth. The casing
 *    does not enter a PPO valve's closing test, so no casing surface
 *    closing pressure and no operating-pressure verdict is reported for
 *    one.
 *
 *    A consequence a PPO design has to be read with: the transfer
 *    production pressure this module carries is one unloading traverse,
 *    the same line at every stage, and each PPO valve is set to open at
 *    that line at its own depth. Its tubing-side margin is therefore its
 *    own spread at every stage, and a clean unloading verdict on a PPO
 *    string is a property of the setting rule rather than a measurement
 *    of the design. Warning `ppoClosingStageInvariant` says so on every
 *    such design. Resolving it needs the tubing traverse per stage,
 *    which is a flowing multiphase model and is out of this module's
 *    scope by the note above.
 * 4. This module reports NO RESIDUAL for the deepest injection point.
 *    A residual formed from what `deepestInjectionPoint` returns is
 *    evaluated against the module's own straight line between two
 *    tabulated traverse rows, so it measures whether two chords agree
 *    with each other and never how far the crossing is from the
 *    answer. See `deepestInjectionPoint`.
 */

import { gasColumnPressure, gasColumnSurfacePressure } from './gasProperties.js';
import {
  domePressureAt60, ipoDomeFromOpening, ppoDomeFromOpening, portToBellowsRatio,
  testRackOpening, thornhillCraver, valveSpread, selectPort, TC_DISCHARGE_COEFF,
} from './gasLiftValves.js';

/** Linear geothermal profile as a depth function. */
export const linearTemperature = ({ whtF, bhtF, refDepthFt }) => (tvdFt) => {
  if (!(refDepthFt > 0)) return whtF;
  return whtF + ((bhtF - whtF) * tvdFt) / refDepthFt;
};

const clampDepth = (d, maxDepthFt) => Math.min(Math.max(d, 0), maxDepthFt);

/**
 * Injection pressure at depth, sampled for plotting and interpolation.
 * returns { depths, pressures, at(tvdFt) }
 */
export const injectionPressureCurve = ({
  pSurfPsia, gasSg, tempAtDepthF, maxDepthFt, steps = 40,
}) => {
  const { profile } = gasColumnPressure({
    pSurfPsia, tvdFt: maxDepthFt, gasSg, tempAtDepthF, steps,
  });
  const depths = profile.map((r) => r.tvdFt);
  const pressures = profile.map((r) => r.pPsia);
  const at = (tvdFt) => {
    if (!(tvdFt > 0)) return pressures[0];
    if (tvdFt >= depths[depths.length - 1]) return pressures[pressures.length - 1];
    let i = 1;
    while (i < depths.length && depths[i] < tvdFt) i += 1;
    const f = (tvdFt - depths[i - 1]) / (depths[i] - depths[i - 1]);
    return pressures[i - 1] + f * (pressures[i] - pressures[i - 1]);
  };
  return { depths, pressures, at };
};

/**
 * Depth of the top valve: where a full column of kill fluid above the
 * unloading wellhead pressure is exactly balanced by the injection
 * pressure at that depth. Fixed-point on the (weak) depth dependence of
 * the gas column.
 */
export const topValveDepth = ({
  pKickoffPsia, pWhUnloadPsia, killGradPsiPerFt, gasSg, tempAtDepthF,
  maxDepthFt, tol = 0.01, maxIter = 50,
}) => {
  if (!(killGradPsiPerFt > 0)) return 0;
  let d = clampDepth((pKickoffPsia - pWhUnloadPsia) / killGradPsiPerFt, maxDepthFt);
  for (let i = 0; i < maxIter; i += 1) {
    const pInj = gasColumnPressure({
      pSurfPsia: pKickoffPsia, tvdFt: d, gasSg, tempAtDepthF, steps: 20,
    }).pBottomPsia;
    const next = clampDepth((pInj - pWhUnloadPsia) / killGradPsiPerFt, maxDepthFt);
    if (Math.abs(next - d) < tol) return next;
    d = next;
  }
  return d;
};

/**
 * Deepest point of gas injection: the deepest depth at which the
 * injection line, less the transfer differential, still exceeds the
 * flowing production pressure.
 *
 * inputs: {
 *   prodTraverse [{ tvdFt, pPsia }] ascending in depth (from a nodal
 *     flowing traverse of the lifted well),
 *   pSurfPsia, gasSg, tempAtDepthF, dpTransferPsi, maxDepthFt,
 *   steps (injection curve samples, default 40) }
 *
 * The injection line is sampled `steps` times over the depth of interest
 * and read between samples by linear interpolation, so the answer is a
 * property of that sample count as much as of the traverse. It is an
 * input rather than a constant for that reason, and 40 is what the
 * published case is gated at.
 * returns { depthFt, pInjPsia, pProdPsia, limitedBy }
 *   limitedBy: 'pressure' (the lines cross above the target depth) |
 *              'depth' (gas still wins at the deepest traverse point)
 *
 * NO RESIDUAL IS REPORTED, and none should be formed from this return.
 * The crossing is located on the straight line drawn between the two
 * traverse rows the caller happened to tabulate, and `pProdPsia` is read
 * off that same line, so `pInjPsia - dpTransferPsi - pProdPsia` is zero
 * to rounding by construction whatever the tabulation. It stays small
 * while the crossing itself moves tens of feet with the row spacing, so
 * it is anti-correlated with accuracy and not monotone in it: no
 * threshold on it separates a good run from a bad one, and a caller
 * ranking runs by it ranks them close to backwards. Accuracy here is a
 * property of the TABULATION, so the honest measure of it is the
 * crossing under refinement, not any quantity read off one tabulation.
 */
export const deepestInjectionPoint = ({
  prodTraverse, pSurfPsia, gasSg, tempAtDepthF, dpTransferPsi = 0,
  maxDepthFt, steps = 40,
}) => {
  const rows = [...(prodTraverse || [])]
    .filter((r) => Number.isFinite(r.tvdFt) && Number.isFinite(r.pPsia))
    .sort((a, b) => a.tvdFt - b.tvdFt);
  if (rows.length < 2) return null;
  const deepest = Math.min(maxDepthFt ?? rows[rows.length - 1].tvdFt, rows[rows.length - 1].tvdFt);
  const inj = injectionPressureCurve({
    pSurfPsia, gasSg, tempAtDepthF, maxDepthFt: deepest, steps,
  });

  const margin = (tvdFt, pProd) => inj.at(tvdFt) - dpTransferPsi - pProd;

  let prev = { tvdFt: rows[0].tvdFt, pPsia: rows[0].pPsia, m: margin(rows[0].tvdFt, rows[0].pPsia) };
  let crossing = null;
  for (let i = 1; i < rows.length && rows[i].tvdFt <= deepest; i += 1) {
    const m = margin(rows[i].tvdFt, rows[i].pPsia);
    if (prev.m >= 0 && m < 0) {
      const f = prev.m / (prev.m - m);
      const depthFt = prev.tvdFt + f * (rows[i].tvdFt - prev.tvdFt);
      const pProdPsia = prev.pPsia + f * (rows[i].pPsia - prev.pPsia);
      crossing = { depthFt, pInjPsia: inj.at(depthFt), pProdPsia, limitedBy: 'pressure' };
      break;
    }
    prev = { tvdFt: rows[i].tvdFt, pPsia: rows[i].pPsia, m };
  }
  if (crossing) return crossing;
  if (prev.m < 0) return { depthFt: 0, pInjPsia: inj.at(0), pProdPsia: rows[0].pPsia, limitedBy: 'pressure' };
  return {
    depthFt: prev.tvdFt, pInjPsia: inj.at(prev.tvdFt), pProdPsia: prev.pPsia, limitedBy: 'depth',
  };
};

/** Passes allowed to the per-valve spacing fixed point, and the depth
 *  tolerance that counts as settled. */
export const SPACING_MAX_ITER = 50;
export const SPACING_TOL_FT = 0.01;

/**
 * Valve depths, top down.
 *
 * inputs: {
 *   pKickoffPsia          surface injection pressure available to unload
 *   pOperatingPsia        surface injection pressure once on the
 *                         operating valve (default pKickoff - 100)
 *   method                'surfaceClose' | 'constantPressure'
 *   dpPerValvePsi         surface decrement per valve (surfaceClose)
 *   dpTransferPsi         production-side differential at transfer
 *   killGradPsiPerFt      static kill-fluid gradient
 *   unloadGradPsiPerFt    lifted gradient above the point of injection
 *   pWhUnloadPsia         wellhead pressure while unloading
 *   gasSg, tempAtDepthF
 *   maxDepthFt            packer or perforation depth (spacing floor)
 *   targetDepthFt         deepest injection point, when one is known
 *   minSpacingFt, maxValves
 * }
 * returns { depths: [ft], stopReason, surfacePressures: [psia],
 *           warnings: [{ code, message, ... }] }
 *
 * Each valve below the first is placed by a fixed point on the weak
 * depth dependence of the injection gas column, run for at most
 * SPACING_MAX_ITER passes. When it does not settle the last iterate is
 * kept, because the checks below it still decide whether that depth is
 * usable, and a `spacingNotConverged` warning carrying the iteration
 * count says so rather than letting an unsettled depth pass as a
 * settled one.
 *
 * `minSpacingFt` stops the recursion when two valves come closer than it
 * (`stopReason: 'minSpacing'`), with ONE exception: the valve that lands
 * at or below the target depth is placed AT the target depth, and its
 * spacing from the valve above can be short of the minimum. That
 * placement is deliberate, a design that reaches target depth is worth
 * having, and it carries a `minSpacingViolated` warning naming the
 * spacing achieved and the minimum stated.
 */
export const spaceValves = ({
  pKickoffPsia, pOperatingPsia, method = 'surfaceClose', dpPerValvePsi = 25,
  dpTransferPsi = 50, killGradPsiPerFt = 0.45, unloadGradPsiPerFt = 0.1,
  pWhUnloadPsia, gasSg, tempAtDepthF, maxDepthFt, targetDepthFt,
  minSpacingFt = 200, maxValves = 12,
}) => {
  const floor = Math.min(maxDepthFt, targetDepthFt ?? maxDepthFt);
  const decrement = method === 'constantPressure' ? 0 : Math.max(dpPerValvePsi, 0);
  const depths = [];
  const surfacePressures = [];
  const warnings = [];
  let stopReason = 'maxValves';

  const d1 = topValveDepth({
    pKickoffPsia, pWhUnloadPsia, killGradPsiPerFt, gasSg, tempAtDepthF,
    maxDepthFt: floor,
  });
  depths.push(d1);
  surfacePressures.push(pKickoffPsia);
  if (d1 >= floor - 1e-6) {
    return { depths, surfacePressures, warnings, stopReason: 'targetDepth' };
  }

  for (let n = 2; n <= maxValves; n += 1) {
    const pSurfN = pKickoffPsia - (n - 1) * decrement;
    if (pSurfN <= pWhUnloadPsia) { stopReason = 'injectionPressure'; break; }
    const dPrev = depths[depths.length - 1];
    const pProdPrev = pWhUnloadPsia + unloadGradPsiPerFt * dPrev;

    let d = dPrev + minSpacingFt;
    let converged = false;
    let iterations = 0;
    for (let i = 0; i < SPACING_MAX_ITER; i += 1) {
      iterations = i + 1;
      const pInj = gasColumnPressure({
        pSurfPsia: pSurfN, tvdFt: d, gasSg, tempAtDepthF, steps: 20,
      }).pBottomPsia;
      const next = dPrev + (pInj - dpTransferPsi - pProdPrev) / killGradPsiPerFt;
      if (Math.abs(next - d) < SPACING_TOL_FT) { d = next; converged = true; break; }
      d = next;
    }
    if (!converged) {
      // The last iterate is kept, because the checks below still decide
      // whether it can be used, but it is an unsettled depth and the
      // caller is told so with the count of passes it was given.
      warnings.push({
        code: 'spacingNotConverged',
        valve: n,
        iterations,
        toleranceFt: SPACING_TOL_FT,
        message: `Valve ${n} depth did not settle within ${SPACING_TOL_FT} ft after ${iterations} passes of the spacing fixed point. The last pass was kept, so this depth and every depth below it are approximate.`,
      });
    }

    if (!(d > dPrev + 1e-6)) { stopReason = 'injectionPressure'; break; }
    const increment = d - dPrev;
    if (d >= floor) {
      // The solve wants this valve below the floor, so the mandrel goes ON
      // the floor. That placement is the one case the minimum spacing test
      // below never sees, because it breaks out first, and the achieved
      // spacing floor - dPrev can be a fraction of the stated minimum. The
      // mandrel is still placed, per item 9: a design that reaches target
      // depth with a tight last space is a real design and refusing it
      // would throw away the answer. It is placed and SAID.
      const achievedFt = floor - dPrev;
      depths.push(floor);
      surfacePressures.push(pSurfN);
      stopReason = 'targetDepth';
      if (achievedFt < minSpacingFt) {
        warnings.push({
          code: 'minSpacingViolated',
          valve: n,
          spacingFt: achievedFt,
          minSpacingFt,
          message: `Valve ${n} is placed at the target depth, ${achievedFt.toFixed(1)} ft below valve ${n - 1}, which is closer than the ${minSpacingFt} ft minimum spacing this design states. The mandrel is placed where it was asked for; the spacing is not what was asked for.`,
        });
      }
      break;
    }
    if (increment < minSpacingFt) { stopReason = 'minSpacing'; break; }
    depths.push(d);
    surfacePressures.push(pSurfN);
  }

  return { depths, surfacePressures, warnings, stopReason, pOperatingPsia };
};

/**
 * Settings for one valve at a spaced depth.
 *
 * Every valve is set to open on the injection pressure its own stage
 * shows at its own depth, with the transfer production pressure on the
 * other side, and the resulting dome charge is reported both at valve
 * temperature and as the 60 degF test-rack figure the shop will dial.
 */
export const valveSetting = ({
  depthFt, pSurfOpenPsia, pProdPsia, valveType = 'IPO', bellowsAreaIn2,
  portIdIn, gasSg, tempAtDepthF, qgiTargetMscfd, pOperatingSurfPsia,
  cd = TC_DISCHARGE_COEFF, k = 1.27,
}) => {
  const tF = tempAtDepthF(depthFt);
  const r = portToBellowsRatio({ portIdIn, bellowsAreaIn2 });
  const pInjAtDepth = gasColumnPressure({
    pSurfPsia: pSurfOpenPsia, tvdFt: depthFt, gasSg, tempAtDepthF, steps: 20,
  }).pBottomPsia;

  const pdT = valveType === 'PPO'
    ? ppoDomeFromOpening({ ptoPsia: pProdPsia, pcPsia: pInjAtDepth, r })
    : ipoDomeFromOpening({ pcoPsia: pInjAtDepth, ptPsia: pProdPsia, r });
  const pd60 = domePressureAt60({ pdTPsia: pdT, tF });
  const tro = testRackOpening({ pd60Psia: pd60, r });
  const spread = valveSpread({
    pOpenPsia: valveType === 'PPO' ? pProdPsia : pInjAtDepth,
    pOtherSidePsia: valveType === 'PPO' ? pInjAtDepth : pProdPsia,
    r,
  });

  // The valve closes when the pressure acting on the FULL bellows area
  // falls back to the dome pressure at valve temperature. WHICH pressure
  // that is follows from the family: an injection-pressure-operated
  // valve is held open by the casing, a production-pressure-operated
  // valve by the tubing. The closing pressure at valve depth is pdT for
  // both; it is read in a different fluid.
  const isPpo = valveType === 'PPO';
  const closingActsOn = isPpo ? 'production' : 'injection';
  // Only a casing-operated valve has a casing SURFACE pressure that
  // closes it. Inverting the injection gas column for a tubing-operated
  // valve returns a casing pressure the valve is not closed by, so none
  // is reported for it.
  const pCloseSurfPsia = isPpo ? null : gasColumnSurfacePressure({
    pAtDepthPsia: pdT, tvdFt: depthFt, gasSg, tempAtDepthF, steps: 20,
  });

  const throughput = thornhillCraver({
    pUpPsia: pInjAtDepth, pDnPsia: pProdPsia, portIdIn, gasSg, tF, cd, k,
  });

  const pOperAtDepth = pOperatingSurfPsia === undefined ? null : gasColumnPressure({
    pSurfPsia: pOperatingSurfPsia, tvdFt: depthFt, gasSg, tempAtDepthF, steps: 20,
  }).pBottomPsia;

  return {
    depthFt,
    tempF: tF,
    valveType,
    portIdIn,
    bellowsAreaIn2,
    r,
    pSurfOpenPsia,
    pInjAtDepthPsia: pInjAtDepth,
    pProdAtDepthPsia: pProdPsia,
    domeAtTempPsia: pdT,
    dome60Psia: pd60,
    testRackOpeningPsia: tro,
    spreadPsi: spread,
    closingActsOn,
    closingPressureAtDepthPsia: pdT,
    closingSurfacePressurePsia: pCloseSurfPsia,
    // `pOperatingSurfPsia` is a CASING pressure, so it can only answer
    // this question for a casing-operated valve. The tubing pressure at
    // depth once the well is on its operating point comes from a flowing
    // traverse, which this module does not model, so a production
    // operated valve gets no operating verdict rather than one taken on
    // the wrong fluid.
    closesAtOperating: (isPpo || pOperAtDepth === null) ? null : pOperAtDepth < pdT,
    throughputMscfd: throughput.qMscfd,
    throughputRegime: throughput.regime,
    passesTarget: qgiTargetMscfd === undefined ? null : throughput.qMscfd >= qgiTargetMscfd,
  };
};

/**
 * Unloading, stage by stage. Stage i is the moment the point of
 * injection transfers to valve i: the casing is on that valve's opening
 * pressure, the fluid level has been pushed to that valve, and every
 * valve above it should already be shut.
 *
 * A valve above that does not shut is the classic multipointing fault:
 * gas splits between two depths, the lift gas is wasted and the well
 * never reaches its design injection depth. It is reported per stage,
 * never silently smoothed over.
 *
 * A bellows valve closes when the pressure acting on the FULL bellows
 * area falls back to its dome charge at valve temperature, so the test
 * is a comparison at valve depth, in the fluid that acts on that
 * valve's bellows:
 *
 *   IPO   the casing column at that valve's depth, taken from THIS
 *         stage's surface injection pressure, against its dome
 *   PPO   the tubing pressure at that valve's depth against its dome;
 *         the casing does not enter the test at all
 *
 * `closingMargins` publishes that comparison per upper valve: the fluid
 * it was taken in, the acting pressure, the dome, the margin, and for a
 * casing-operated valve the casing drop the stage has achieved at that
 * depth. The margin is the valve's own spread less that drop, which is
 * why a design decrements the surface pressure per valve at all.
 */
export const unloadingSequence = ({ valves, gasSg, tempAtDepthF, qgiTargetMscfd }) => {
  const stages = [];
  for (let i = 0; i < valves.length; i += 1) {
    const v = valves[i];
    const pSurf = v.pSurfOpenPsia;
    const upperOpen = [];
    const closingMargins = [];
    for (let j = 0; j < i; j += 1) {
      const u = valves[j];
      // A valve with no dome charge has no pressure at which it shuts,
      // so the test cannot be evaluated on it and it is SKIPPED; see
      // decision 2 in the module header. Its row is still published, so
      // a reader can see that it was not tested rather than infer a
      // verdict from a valve missing out of the list.
      if (!Number.isFinite(u.domeAtTempPsia)) {
        closingMargins.push({
          valve: j + 1,
          family: u.valveType,
          actingOn: 'none',
          actingPressurePsia: null,
          domeAtTempPsia: null,
          marginPsi: null,
          spreadPsi: null,
          casingDropPsi: null,
          open: null,
        });
        continue;
      }
      // The closing test, in the fluid that acts on the bellows of THIS
      // valve, at ITS depth, against ITS dome charge. See decision 4.
      const isPpo = u.valveType === 'PPO';
      let actingPsia;
      let casingDropPsi = null;
      if (isPpo) {
        actingPsia = u.pProdAtDepthPsia;
      } else {
        actingPsia = gasColumnPressure({
          pSurfPsia: pSurf, tvdFt: u.depthFt, gasSg, tempAtDepthF, steps: 20,
        }).pBottomPsia;
        // how far this stage has taken the casing off the pressure the
        // valve was set to open on, the quantity a decrement per valve
        // is chosen to make bigger than the spread
        casingDropPsi = u.pInjAtDepthPsia - actingPsia;
      }
      const marginPsi = actingPsia - u.domeAtTempPsia;
      // `>=`, so a valve exactly at its closing pressure is treated as
      // OPEN; see decision 1 in the module header.
      const open = marginPsi >= 0;
      closingMargins.push({
        valve: j + 1,
        family: u.valveType,
        actingOn: isPpo ? 'production' : 'injection',
        actingPressurePsia: actingPsia,
        domeAtTempPsia: u.domeAtTempPsia,
        marginPsi,
        spreadPsi: u.spreadPsi,
        casingDropPsi,
        open,
      });
      if (open) upperOpen.push(j + 1);
    }
    stages.push({
      stage: i + 1,
      valve: i + 1,
      depthFt: v.depthFt,
      surfaceInjectionPsia: pSurf,
      injectionAtDepthPsia: v.pInjAtDepthPsia,
      productionAtDepthPsia: v.pProdAtDepthPsia,
      fluidLevelFt: v.depthFt,
      gasRateMscfd: v.throughputMscfd,
      passesTarget: qgiTargetMscfd === undefined ? null : v.throughputMscfd >= qgiTargetMscfd,
      upperValvesOpen: upperOpen,
      multipointing: upperOpen.length > 0,
      // the number every verdict above turns on, published so a reader
      // can see how much margin a clean stage had
      closingMargins,
    });
  }
  return stages;
};

/**
 * Whole-installation design: space the valves, set each one, and walk
 * the unloading. Warnings are collected rather than thrown, because a
 * design that cannot reach the target depth is still worth showing with
 * the reason attached.
 *
 * inputs: everything spaceValves takes, plus
 *   valveType, bellowsAreaIn2, ports [{ idIn, label }],
 *   qgiTargetMscfd, bottomOrifice (default true), orificeIdIn
 * returns { depths, valves, unloading, injectionCurve, warnings, stopReason }
 */
export const designGasLift = (inputs) => {
  const {
    gasSg, tempAtDepthF, maxDepthFt, valveType = 'IPO', bellowsAreaIn2,
    ports, qgiTargetMscfd, pWhUnloadPsia, unloadGradPsiPerFt = 0.1,
    pKickoffPsia, bottomOrifice = true, orificeIdIn,
    cd = TC_DISCHARGE_COEFF, k = 1.27,
  } = inputs;
  const pOperatingPsia = inputs.pOperatingPsia ?? pKickoffPsia - 100;

  const spacing = spaceValves(inputs);
  // The spacing solve's own warnings are the design's warnings; a depth
  // that did not settle is not a detail of a sub-call.
  const warnings = [...(spacing.warnings || [])];
  if (spacing.stopReason === 'injectionPressure') {
    warnings.push({
      code: 'shallowTarget',
      message: 'The injection pressure runs out above the target depth; the last valve is as deep as this surface pressure reaches.',
    });
  }
  if (spacing.stopReason === 'maxValves') {
    warnings.push({
      code: 'valveLimit',
      message: 'The valve limit was reached before the target depth. Raise the valve count, the injection pressure, or the pressure drop per valve.',
    });
  }
  if (spacing.stopReason === 'minSpacing') {
    warnings.push({
      code: 'minSpacing',
      message: 'Valve spacing collapsed below the minimum before the target depth was reached.',
    });
  }

  const valves = spacing.depths.map((depthFt, i) => {
    const pProdPsia = pWhUnloadPsia + unloadGradPsiPerFt * depthFt;
    const pSurfOpenPsia = spacing.surfacePressures[i];
    const isBottom = i === spacing.depths.length - 1;
    const pInjAtDepth = gasColumnPressure({
      pSurfPsia: pSurfOpenPsia, tvdFt: depthFt, gasSg, tempAtDepthF, steps: 20,
    }).pBottomPsia;
    const pick = selectPort({
      ports, targetMscfd: qgiTargetMscfd, pUpPsia: pInjAtDepth, pDnPsia: pProdPsia,
      gasSg, tF: tempAtDepthF(depthFt), cd, k,
    });
    if (!pick.port) {
      warnings.push({
        code: 'portTooSmall',
        // `selectPort` returns no port only when every candidate passes
        // STRICTLY less than the target, and the target is printed in
        // the same sentence, so rounding the port rate whole let the two
        // render equal: "passes 1000 Mscf/d, short of the 1000 Mscf/d
        // target". The depth stays whole; it is a location, not a
        // quantity being compared with anything.
        message: `Valve ${i + 1} at ${Math.round(depthFt)} ft: the largest port in the catalog passes ${pick.qMscfd.toFixed(1)} Mscf/d, short of the ${qgiTargetMscfd} Mscf/d target.`,
      });
    }
    const portIdIn = (isBottom && bottomOrifice && orificeIdIn)
      ? orificeIdIn
      : (pick.port ? pick.port.idIn : ports[ports.length - 1].idIn);

    if (isBottom && bottomOrifice) {
      const tF = tempAtDepthF(depthFt);
      const throughput = thornhillCraver({
        pUpPsia: pInjAtDepth, pDnPsia: pProdPsia, portIdIn, gasSg, tF, cd, k,
      });
      return {
        depthFt,
        tempF: tF,
        valveType: 'orifice',
        portIdIn,
        bellowsAreaIn2: null,
        r: null,
        pSurfOpenPsia,
        pInjAtDepthPsia: pInjAtDepth,
        pProdAtDepthPsia: pProdPsia,
        domeAtTempPsia: null,
        dome60Psia: null,
        testRackOpeningPsia: null,
        spreadPsi: null,
        // No bellows and no dome charge, so there is no pressure at which
        // it closes and no fluid the closing test acts in.
        closingActsOn: null,
        closingPressureAtDepthPsia: null,
        closingSurfacePressurePsia: null,
        // An orifice has no dome charge, so there is no operating
        // pressure at which it closes and the question does not apply.
        // `false` here read as "it stays open", which is a different
        // claim and one this record cannot make.
        closesAtOperating: null,
        throughputMscfd: throughput.qMscfd,
        throughputRegime: throughput.regime,
        passesTarget: throughput.qMscfd >= qgiTargetMscfd,
      };
    }

    return valveSetting({
      depthFt, pSurfOpenPsia, pProdPsia, valveType, bellowsAreaIn2, portIdIn,
      gasSg, tempAtDepthF, qgiTargetMscfd, pOperatingSurfPsia: pOperatingPsia, cd, k,
    });
  });

  const unloading = unloadingSequence({ valves, gasSg, tempAtDepthF, qgiTargetMscfd });
  if (valves.some((v) => v.valveType === 'PPO')) {
    warnings.push({
      code: 'ppoClosingStageInvariant',
      message: 'Production operated valves close on the tubing pressure, and this module carries a single unloading production traverse, so each upper valve is compared with the same tubing pressure at every stage and its closing margin is its own spread throughout. The unloading verdict on this design is therefore a property of the setting rule and not a measurement of the design. Testing a production operated string for multipointing needs the tubing traverse stage by stage, from a flowing model this module does not solve.',
    });
  }
  unloading.filter((s) => s.multipointing).forEach((s) => {
    warnings.push({
      code: 'multipointing',
      message: `At stage ${s.stage} valve(s) ${s.upperValvesOpen.join(', ')} are still open: the string will inject at two depths.`,
    });
  });

  const injectionCurve = injectionPressureCurve({
    pSurfPsia: pOperatingPsia, gasSg, tempAtDepthF, maxDepthFt,
  });

  return {
    depths: spacing.depths,
    surfacePressures: spacing.surfacePressures,
    stopReason: spacing.stopReason,
    valves,
    unloading,
    injectionCurve,
    pOperatingPsia,
    warnings,
  };
};
