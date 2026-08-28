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
 *   pSurfPsia, gasSg, tempAtDepthF, dpTransferPsi, maxDepthFt }
 * returns { depthFt, pInjPsia, pProdPsia, limitedBy }
 *   limitedBy: 'pressure' (the lines cross above the target depth) |
 *              'depth' (gas still wins at the deepest traverse point)
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
 * returns { depths: [ft], stopReason, surfacePressures: [psia] }
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
  let stopReason = 'maxValves';

  const d1 = topValveDepth({
    pKickoffPsia, pWhUnloadPsia, killGradPsiPerFt, gasSg, tempAtDepthF,
    maxDepthFt: floor,
  });
  depths.push(d1);
  surfacePressures.push(pKickoffPsia);
  if (d1 >= floor - 1e-6) {
    return { depths, surfacePressures, stopReason: 'targetDepth' };
  }

  for (let n = 2; n <= maxValves; n += 1) {
    const pSurfN = pKickoffPsia - (n - 1) * decrement;
    if (pSurfN <= pWhUnloadPsia) { stopReason = 'injectionPressure'; break; }
    const dPrev = depths[depths.length - 1];
    const pProdPrev = pWhUnloadPsia + unloadGradPsiPerFt * dPrev;

    let d = dPrev + minSpacingFt;
    let converged = false;
    for (let i = 0; i < 50; i += 1) {
      const pInj = gasColumnPressure({
        pSurfPsia: pSurfN, tvdFt: d, gasSg, tempAtDepthF, steps: 20,
      }).pBottomPsia;
      const next = dPrev + (pInj - dpTransferPsi - pProdPrev) / killGradPsiPerFt;
      if (Math.abs(next - d) < 0.01) { d = next; converged = true; break; }
      d = next;
    }
    if (!converged) { /* keep the last iterate; the checks below still apply */ }

    if (!(d > dPrev + 1e-6)) { stopReason = 'injectionPressure'; break; }
    const increment = d - dPrev;
    if (d >= floor) {
      depths.push(floor);
      surfacePressures.push(pSurfN);
      stopReason = 'targetDepth';
      break;
    }
    if (increment < minSpacingFt) { stopReason = 'minSpacing'; break; }
    depths.push(d);
    surfacePressures.push(pSurfN);
  }

  return { depths, surfacePressures, stopReason, pOperatingPsia };
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

  // The valve closes when the pressure on its bellows falls back to the
  // dome pressure; expressed at surface that is the casing pressure
  // whose column reads pdT at this depth.
  const pCloseSurfPsia = gasColumnSurfacePressure({
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
    closingSurfacePressurePsia: pCloseSurfPsia,
    closesAtOperating: pOperAtDepth === null ? null : pOperAtDepth < pdT,
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
 */
export const unloadingSequence = ({ valves, gasSg, tempAtDepthF, qgiTargetMscfd }) => {
  const stages = [];
  for (let i = 0; i < valves.length; i += 1) {
    const v = valves[i];
    const pSurf = v.pSurfOpenPsia;
    const upperOpen = [];
    for (let j = 0; j < i; j += 1) {
      const u = valves[j];
      // upper valve j is still open if the casing pressure at this stage
      // is above the pressure that closes it
      if (pSurf >= u.closingSurfacePressurePsia) upperOpen.push(j + 1);
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
  const warnings = [];
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
        message: `Valve ${i + 1} at ${Math.round(depthFt)} ft: the largest port in the catalog passes ${Math.round(pick.qMscfd)} Mscf/d, short of the ${qgiTargetMscfd} Mscf/d target.`,
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
        closingSurfacePressurePsia: null,
        closesAtOperating: false,
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
