/**
 * Compositional separator train — FS6.
 *
 * Sequentially flashes the wellstream through the user's separator stages
 * with the FS3 stability-gated PT flash: each stage's equilibrium vapor is
 * taken off as sales/flare gas, the equilibrium liquid feeds the next
 * stage, and the train always terminates at stock-tank conditions
 * (14.696 psia / 60 °F). This replaces, in EOS mode, the black-oil
 * staged-liberation GOR partition and its "staging benefit" multistage-Bo
 * approximation in fluidStudioCalculations.js (which stays untouched and
 * snapshot-pinned as the default path).
 *
 * Basis: 1 lb-mol of feed. Engine units throughout (°R, psia,
 * ft³/lb-mol, lb/ft³); the UI seam (eosAnalysis.js) converts.
 *
 * Definitions (standard separator-test conventions):
 *   stage GOR    = stage vapor at sc (ideal-gas scf/lb-mol) per stock-tank
 *                  barrel from the SAME feed basis, scf/STB
 *   gas gravity  = stage-vapor apparent MW / MW(air)
 *   stock-tank oil API from the Peneloux-translated liquid density at
 *                  (60 °F, 14.696 psia) relative to water at 60 °F
 *   Bo (multistage) = feed molar volume at reservoir (T, P) per stock-tank
 *                  oil volume; reported only when the feed is single-phase
 *                  at reservoir conditions (a two-phase reservoir state has
 *                  no well-defined wellstream Bo)
 *   Bo (single-stage) = same numerator over the stock-tank volume from ONE
 *                  direct flash to stock tank — the rigorous version of the
 *                  black-oil card's single-flash comparison.
 *
 * Single-phase stage outcomes are classified liquid- vs vapor-like with the
 * v/b < 1.75 heuristic already used by pr78.purePsat (v/b == Z/B).
 */

import { flashPT } from './flash.js';
import { PSC, TSC, R_PSIA } from './units.js';

/** Ideal-gas molar volume at standard conditions, scf/lb-mol (~379.48). */
export const SCF_PER_LBMOL = (R_PSIA * TSC) / PSC;

/** Apparent molecular weight of air, lb/lb-mol (GPSA). */
export const MW_AIR = 28.9647;

/** Density of water at 60 °F, lb/ft³ (SG 60/60 reference). */
export const RHO_WATER_60F = 62.3664;

export const FT3_PER_BBL = 5.614583;

/** The implicit terminal stage every train ends at. */
export const STOCK_TANK_STAGE = { tR: TSC, pPsia: PSC };

const MIN_MOLES = 1e-12;

const liquidLike = (props) => props.zFactor / props.B < 1.75;

/**
 * Flash one stage feed and split it into vapor/liquid streams.
 * Returns { vaporMoles, liquidMoles, x, y, K, beta, vaporProps,
 * liquidProps, phases, reason } on the given feed-mole basis.
 */
function flashStage(mix, comp, moles, tR, pPsia) {
  const res = flashPT(mix, comp, tR, pPsia);
  if (res.phases === 2) {
    return {
      phases: 2,
      beta: res.beta,
      K: res.K,
      x: res.x,
      y: res.y,
      vaporMoles: moles * res.beta,
      liquidMoles: moles * (1 - res.beta),
      vaporProps: res.vapor,
      liquidProps: res.liquid,
    };
  }
  const isLiquid = res.reason === 'negative-flash-liquid'
    || (res.reason !== 'negative-flash-vapor' && liquidLike(res.feed));
  return {
    phases: 1,
    reason: res.reason,
    x: isLiquid ? comp : null,
    y: isLiquid ? null : comp,
    vaporMoles: isLiquid ? 0 : moles,
    liquidMoles: isLiquid ? moles : 0,
    vaporProps: isLiquid ? null : res.feed,
    liquidProps: isLiquid ? res.feed : null,
  };
}

/**
 * Normalize/complete the stage list: positive pressures, sorted
 * high-to-low, stock tank appended unless the last stage already is one.
 */
export function normalizeStages(stages) {
  const train = (stages || [])
    .filter((s) => s && Number(s.pPsia) > 0)
    .map((s) => ({ tR: Number(s.tR), pPsia: Number(s.pPsia) }))
    .sort((a, b) => b.pPsia - a.pPsia);
  const last = train[train.length - 1];
  if (!last || last.pPsia > PSC + 1e-6) train.push({ ...STOCK_TANK_STAGE });
  return train;
}

/**
 * Run the compositional separator train.
 *
 * mix/z per pr78 conventions (pseudo last, from mixtureWithPlusFraction or
 * mixtureFromKeys). stages = [{ tR, pPsia }] (stock tank auto-appended).
 * opts.resTR/opts.resPPsia enable the Bo block.
 *
 * All numbers are full precision; rounding is the UI seam's job.
 */
export function separatorTrain(mix, z, stages, opts = {}) {
  const train = normalizeStages(stages);
  const warnings = [];

  const stageRows = [];
  let feedComp = z;
  let feedMoles = 1;
  for (let i = 0; i < train.length; i += 1) {
    const isStockTank = i === train.length - 1;
    const { tR, pPsia } = train[i];
    if (feedMoles < MIN_MOLES) {
      stageRows.push({
        index: i, isStockTank, tR, pPsia, feedMoles: 0, vaporMoles: 0, liquidMoles: 0,
        phases: 0, x: null, y: null, K: null, beta: null, gasGravity: null,
        gasScfPerFeedMol: 0, vaporProps: null, liquidProps: null,
      });
      continue;
    }
    const st = flashStage(mix, feedComp, feedMoles, tR, pPsia);
    if (st.reason === 'not-converged') {
      warnings.push(`Stage ${i + 1} flash did not converge; treated as single-phase.`);
    }
    stageRows.push({
      index: i,
      isStockTank,
      tR,
      pPsia,
      feedMoles,
      vaporMoles: st.vaporMoles,
      liquidMoles: st.liquidMoles,
      phases: st.phases,
      x: st.x,
      y: st.y,
      K: st.K ?? null,
      beta: st.beta ?? null,
      gasGravity: st.vaporProps ? st.vaporProps.apparentMw / MW_AIR : null,
      gasScfPerFeedMol: st.vaporMoles * SCF_PER_LBMOL,
      vaporProps: st.vaporProps,
      liquidProps: st.liquidProps,
    });
    if (st.liquidMoles < MIN_MOLES && !isStockTank) {
      warnings.push(`The stream is fully vapor after stage ${i + 1}; no liquid reaches the stock tank.`);
    }
    feedComp = st.x ?? feedComp;
    feedMoles = st.liquidMoles;
  }

  // ---- stock-tank oil -----------------------------------------------------
  const stStage = stageRows[stageRows.length - 1];
  let stockTank = null;
  let stoVolFt3 = null;
  if (stStage.liquidMoles >= MIN_MOLES && stStage.liquidProps) {
    const props = stStage.liquidProps;
    const sg = props.density / RHO_WATER_60F;
    stockTank = {
      moles: stStage.liquidMoles,
      x: stStage.x,
      density: props.density,
      molarVolume: props.molarVolume,
      apparentMw: props.apparentMw,
      sg,
      api: 141.5 / sg - 131.5,
    };
    stoVolFt3 = stStage.liquidMoles * props.molarVolume;
  } else {
    warnings.push('No stock-tank liquid: GOR, API and Bo are undefined for this wellstream.');
  }

  // ---- totals -------------------------------------------------------------
  const stoBbl = stoVolFt3 !== null ? stoVolFt3 / FT3_PER_BBL : null;
  const gor = (row) => (stoBbl ? row.gasScfPerFeedMol / stoBbl : null);
  stageRows.forEach((row) => { row.gorScfPerStb = row.vaporMoles > 0 ? gor(row) : 0; });

  const sepRows = stageRows.filter((r) => !r.isStockTank);
  const totalVaporMoles = stageRows.reduce((s, r) => s + r.vaporMoles, 0);
  const totalVaporMass = stageRows.reduce(
    (s, r) => s + (r.vaporProps ? r.vaporMoles * r.vaporProps.apparentMw : 0), 0);
  const totals = {
    separatorGor: stoBbl ? sepRows.reduce((s, r) => s + r.gasScfPerFeedMol, 0) / stoBbl : null,
    stockTankGor: stoBbl ? stStage.gasScfPerFeedMol / stoBbl : null,
    totalGor: stoBbl ? (totalVaporMoles * SCF_PER_LBMOL) / stoBbl : null,
    surfaceGasGravity: totalVaporMoles > MIN_MOLES
      ? totalVaporMass / totalVaporMoles / MW_AIR : null,
    stoVolFt3PerFeedMol: stoVolFt3,
    gasScfPerFeedMol: totalVaporMoles * SCF_PER_LBMOL,
  };

  // ---- Bo block (needs reservoir conditions) ------------------------------
  let bo = null;
  const { resTR, resPPsia } = opts;
  if (Number.isFinite(resTR) && Number.isFinite(resPPsia) && resPPsia > 0) {
    const resFlash = flashPT(mix, z, resTR, resPPsia);
    if (resFlash.phases === 2) {
      bo = { reservoirPhases: 2, vResFt3PerFeedMol: null, multistage: null, singleStage: null };
      warnings.push('The feed is two-phase at reservoir conditions; wellstream Bo is not reported.');
    } else {
      const vRes = resFlash.feed.molarVolume; // per lb-mol feed
      // one direct flash to stock tank for the single-stage comparison
      const single = flashStage(mix, z, 1, TSC, PSC);
      const singleVol = single.liquidMoles >= MIN_MOLES && single.liquidProps
        ? single.liquidMoles * single.liquidProps.molarVolume : null;
      bo = {
        reservoirPhases: 1,
        vResFt3PerFeedMol: vRes,
        multistage: stoVolFt3 ? vRes / stoVolFt3 : null,
        singleStage: singleVol ? vRes / singleVol : null,
        singleStageGor: singleVol
          ? (single.vaporMoles * SCF_PER_LBMOL) / (singleVol / FT3_PER_BBL) : null,
      };
    }
  }

  return { stages: stageRows, stockTank, totals, bo, warnings };
}

/**
 * Material-balance check used by the gates: per-component moles in
 * (1 lb-mol of z) vs summed vapor draws + stock-tank liquid. Returns the
 * max absolute component imbalance.
 */
export function materialBalanceError(result, z) {
  const n = z.length;
  const out = new Array(n).fill(0);
  result.stages.forEach((row) => {
    if (row.vaporMoles > 0 && row.y) {
      for (let i = 0; i < n; i += 1) out[i] += row.vaporMoles * row.y[i];
    }
  });
  const st = result.stages[result.stages.length - 1];
  if (st.liquidMoles > 0 && st.x) {
    for (let i = 0; i < n; i += 1) out[i] += st.liquidMoles * st.x[i];
  }
  let worst = 0;
  for (let i = 0; i < n; i += 1) worst = Math.max(worst, Math.abs(out[i] - z[i]));
  return worst;
}
