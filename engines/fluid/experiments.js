/**
 * PVT experiment simulations — FS7.
 *
 * Constant composition expansion (CCE) and differential liberation (DL)
 * at reservoir temperature, plus the separator-adjusted composite
 * black-oil table built from DL + the FS6 separator train. This is the
 * standard lab workflow reproduced with the validated FS3 flash:
 *
 *   CCE  the cell holds the full composition at every pressure; total
 *        volume is reported relative to the saturation-point volume,
 *        with the liquid fraction of the two-phase volume below Psat.
 *   DL   from Psat down, each pressure step flashes the remaining
 *        liquid and removes ALL equilibrium vapor; after the last step
 *        at reservoir T the cell cools to 60 °F / 14.696 psia and the
 *        remaining liquid is the residual oil. Bod and Rsd are relative
 *        to that residual-oil volume, per convention.
 *   Composite table (Amyx / McCain separator adjustment):
 *        Bo(P)  = Bod(P) · Bofb / Bodb
 *        Rs(P)  = Rsfb − (Rsdb − Rsd(P)) · Bofb / Bodb   (clamped ≥ 0)
 *        with Bofb / Rsfb from the FS6 separator train on the same feed
 *        and Bodb / Rsdb the DL values at Psat. Above Psat the oil is
 *        single phase and Bo scales exactly with the EOS molar volume.
 *
 * The saturation pressure is an input here (one envelope.saturationPressure
 * scan serves CCE, DL and the table; the caller owns that slow solve).
 * Basis 1 lb-mol feed, engine units (°R, psia, ft³/lb-mol) throughout;
 * rounding is the UI seam's job. CVD stays out of scope (program binding).
 */

import { flashPT } from './flash.js';
import { phaseProps } from './pr78.js';
import { lbcViscosity } from './transport.js';
import { separatorTrain, MW_AIR, SCF_PER_LBMOL, FT3_PER_BBL } from './separator.js';
import { PSC, TSC } from './units.js';

const MIN_MOLES = 1e-12;

/** Bg in rb/scf, matching the black-oil engine's 0.00504·zT/p convention. */
export const bgRbPerScf = (zGas, tR, pPsia) => ((zGas * tR) / pPsia) * (PSC / TSC) * (1 / FT3_PER_BBL);

/** Default CCE pressure grid around Psat (fractions chosen to show the kink). */
const ccePressures = (psat) => [1.4, 1.25, 1.1, 1.05, 1.02]
  .map((f) => f * psat)
  .concat([0.95, 0.85, 0.7, 0.55, 0.4, 0.25].map((f) => f * psat))
  .filter((p) => p > PSC);

/** Default DL pressure steps below Psat, ending at atmospheric. */
const dlPressures = (psat) => [0.85, 0.7, 0.55, 0.4, 0.25, 0.12]
  .map((f) => f * psat)
  .filter((p) => p > PSC * 2)
  .concat([PSC]);

/**
 * Constant composition expansion at tR. psatPsia anchors the relative
 * volume (V/Vsat); rows above Psat are single phase by construction.
 * Returns { vSat, rows: [{ pPsia, phases, beta, relVol, liquidVolFrac,
 * density, zFactor }] } sorted by descending pressure.
 */
export function cceExperiment(mix, z, tR, { psatPsia, pressures } = {}) {
  if (!(psatPsia > 0)) throw new Error('cceExperiment needs psatPsia (run saturationPressure first)');
  const grid = (pressures && pressures.length ? pressures.slice() : ccePressures(psatPsia))
    .filter((p) => p > 0)
    .sort((a, b) => b - a);

  const vSat = phaseProps(mix, z, tR, psatPsia).molarVolume;

  const rows = grid.map((pPsia) => {
    const res = flashPT(mix, z, tR, pPsia);
    if (res.phases === 2) {
      const vL = (1 - res.beta) * res.liquid.molarVolume;
      const vV = res.beta * res.vapor.molarVolume;
      return {
        pPsia,
        phases: 2,
        beta: res.beta,
        relVol: (vL + vV) / vSat,
        liquidVolFrac: vL / (vL + vV),
        density: null,
        zFactor: null,
      };
    }
    return {
      pPsia,
      phases: 1,
      beta: null,
      relVol: res.feed.molarVolume / vSat,
      liquidVolFrac: null,
      density: res.feed.density,
      zFactor: res.feed.zFactor,
    };
  });

  return { vSat, rows };
}

/**
 * Differential liberation at tR from Psat down. The first row is the
 * saturation point itself (all liquid, nothing removed). After the last
 * reservoir-temperature step the remaining liquid cools to stock
 * conditions; vapor evolved on cooling counts as liberated gas and the
 * liquid left is the residual oil that normalizes Bod / Rsd.
 *
 * Returns { stages, residual, cooldownGasScf, totals } where stages
 * carry the removed-gas increment properties (zFactor, gravity, Bg) and
 * the after-the-fact Bod / Rsd columns.
 */
export function differentialLiberation(mix, z, tR, { psatPsia, pressures } = {}) {
  if (!(psatPsia > 0)) throw new Error('differentialLiberation needs psatPsia');
  const grid = (pressures && pressures.length ? pressures.slice() : dlPressures(psatPsia))
    .filter((p) => p > 0 && p < psatPsia)
    .sort((a, b) => b - a);
  const warnings = [];

  const satProps = phaseProps(mix, z, tR, psatPsia);
  const stages = [{
    pPsia: psatPsia,
    isSaturation: true,
    oilMoles: 1,
    x: z,
    vOil: satProps.molarVolume,
    vOilMolar: satProps.molarVolume,
    oilDensity: satProps.density,
    gasMolesRemoved: 0,
    y: null,
    gasZ: null,
    vGasMolar: null,
    gasGravity: null,
    gasScf: 0,
    bg: null,
  }];

  let comp = z;
  let moles = 1;
  for (const pPsia of grid) {
    if (moles < MIN_MOLES) break;
    const res = flashPT(mix, comp, tR, pPsia);
    if (res.phases !== 2) {
      // inside a DL sweep this only happens right below Psat where the
      // split is numerically marginal; carry the liquid through unchanged
      const props = phaseProps(mix, comp, tR, pPsia);
      stages.push({
        pPsia,
        isSaturation: false,
        oilMoles: moles,
        x: comp,
        vOil: moles * props.molarVolume,
        vOilMolar: props.molarVolume,
        oilDensity: props.density,
        gasMolesRemoved: 0,
        y: null,
        gasZ: null,
        vGasMolar: null,
        gasGravity: null,
        gasScf: 0,
        bg: null,
      });
      warnings.push(`No gas evolved at ${pPsia.toFixed(0)} psia (single-phase step).`);
      continue;
    }
    const gasMoles = moles * res.beta;
    stages.push({
      pPsia,
      isSaturation: false,
      oilMoles: moles * (1 - res.beta),
      x: res.x,
      vOil: moles * (1 - res.beta) * res.liquid.molarVolume,
      vOilMolar: res.liquid.molarVolume,
      oilDensity: res.liquid.density,
      gasMolesRemoved: gasMoles,
      y: res.y,
      gasZ: res.vapor.zFactor,
      vGasMolar: res.vapor.molarVolume,
      gasGravity: res.vapor.apparentMw / MW_AIR,
      gasScf: gasMoles * SCF_PER_LBMOL,
      bg: bgRbPerScf(res.vapor.zFactor, tR, pPsia),
    });
    comp = res.x;
    moles *= (1 - res.beta);
  }

  // cool the last-stage liquid to stock conditions -> residual oil
  let residual = null;
  let cooldownGasScf = 0;
  if (moles >= MIN_MOLES) {
    const cool = flashPT(mix, comp, TSC, PSC);
    if (cool.phases === 2) {
      cooldownGasScf = moles * cool.beta * SCF_PER_LBMOL;
      residual = {
        moles: moles * (1 - cool.beta),
        x: cool.x,
        volFt3: moles * (1 - cool.beta) * cool.liquid.molarVolume,
        density: cool.liquid.density,
      };
    } else {
      const props = phaseProps(mix, comp, TSC, PSC);
      residual = { moles, x: comp, volFt3: moles * props.molarVolume, density: props.density };
    }
  } else {
    warnings.push('The oil fully vaporized during liberation; no residual oil.');
  }

  if (residual) {
    const resBbl = residual.volFt3 / FT3_PER_BBL;
    // gas still in solution at stage k = everything liberated after it
    let below = cooldownGasScf;
    for (let i = stages.length - 1; i >= 0; i -= 1) {
      stages[i].rsd = below / resBbl;
      stages[i].bod = stages[i].vOil / residual.volFt3;
      below += stages[i].gasScf;
    }
  }

  return {
    stages,
    residual,
    cooldownGasScf,
    totals: residual
      ? { bodb: stages[0].bod, rsdb: stages[0].rsd }
      : null,
    warnings,
  };
}

/**
 * Separator-adjusted composite black-oil table (the export target for
 * MB Studio's lab-table schema and the EOS backbone). separatorStages
 * uses the FS6 engine convention [{ tR, pPsia }]. Undersaturated rows
 * come from undersatPressures (defaults to a short ladder above Psat).
 *
 * Row shape mirrors the black-oil engine's table: { pressure, Rs, Bo,
 * Bg, Z, mu_o, mu_g, phase }, pressure descending, full precision.
 */
export function eosBlackOilTable(mix, z, tR, separatorStages, opts = {}) {
  const { psatPsia, dlPressures: dlGrid, undersatPressures } = opts;
  if (!(psatPsia > 0)) throw new Error('eosBlackOilTable needs psatPsia');

  const dl = differentialLiberation(mix, z, tR, { psatPsia, pressures: dlGrid });
  if (!dl.residual || !dl.totals) {
    return { ok: false, warnings: dl.warnings, dl };
  }

  const sep = separatorTrain(mix, z, separatorStages);
  if (!sep.stockTank) {
    return { ok: false, warnings: [...dl.warnings, ...sep.warnings], dl, sep };
  }
  const vSat = dl.stages[0].vOil; // 1 lb-mol feed at (Psat, T)
  const bofb = vSat / sep.totals.stoVolFt3PerFeedMol;
  const rsfb = sep.totals.totalGor;
  const { bodb, rsdb } = dl.totals;
  const adjust = bofb / bodb;

  const saturatedRows = dl.stages.map((st) => ({
    pressure: st.pPsia,
    phase: st.isSaturation ? 'saturated' : 'two-phase',
    Rs: Math.max(0, rsfb - (rsdb - st.rsd) * adjust),
    Bo: st.bod * adjust,
    Bg: st.bg,
    Z: st.gasZ,
    mu_o: lbcViscosity(mix, st.x, tR, { molarVolume: st.vOilMolar }).viscosityCp,
    mu_g: st.y ? lbcViscosity(mix, st.y, tR, { molarVolume: st.vGasMolar }).viscosityCp : null,
  }));

  const undersat = (undersatPressures && undersatPressures.length
    ? undersatPressures
    : [1.05, 1.15, 1.3].map((f) => f * psatPsia))
    .filter((p) => p > psatPsia)
    .sort((a, b) => b - a)
    .map((pPsia) => {
      const props = phaseProps(mix, z, tR, pPsia);
      return {
        pressure: pPsia,
        phase: 'undersaturated',
        Rs: rsfb,
        Bo: bofb * (props.molarVolume / vSat),
        Bg: null,
        Z: null,
        mu_o: lbcViscosity(mix, z, tR, props).viscosityCp,
        mu_g: null,
      };
    });

  const rows = [...undersat, ...saturatedRows].sort((a, b) => b.pressure - a.pressure);

  return {
    ok: true,
    pb: psatPsia,
    rows,
    kpis: {
      rsfb,
      bofb,
      bodb,
      rsdb,
      stoApi: sep.stockTank.api,
      stoDensity: sep.stockTank.density,
      surfaceGasGravity: sep.totals.surfaceGasGravity,
      residualOilDensity: dl.residual.density,
    },
    warnings: [...dl.warnings, ...sep.warnings],
    dl,
    sep,
  };
}
