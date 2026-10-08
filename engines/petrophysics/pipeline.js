// Single-well compute pipeline (Petrophysics Studio G2.3): input
// curves + one parameter set -> the preview interpretation curves the
// workstation displays and (G2.5) publishes. Pure function of its
// inputs — chaining exactly the validated engine modules, nothing
// else, so the pipeline is as trustworthy as the goldens.
//
// Curve keys are the registry mnemonics the explorer maps: DEPT (m),
// GR (API), RHOB (g/cc), NPHI (v/v), DT (us/m), RT (ohm.m). Missing
// optional inputs skip their products (never fabricate).

import { vshFromGr } from './vsh';
import { phiDensity, phiSonicWyllie, phiSonicRhg, phiNd, phiShaleCorrected, clampDisplay } from './porosity';
import { swArchie, swSimandoux, swIndonesia } from './sw';
import { swWaxmanSmits, swDualWater, swModSimandoux, bJuhasz } from './swClay';
import { tempCurve, rwAtTemp } from './temperature';
import { netPay, sampleThickness } from './netpay';
import { kTimur, kTixier, kCoates, kWyllieRose, bvw, swirrFromBuckles, kGeomMean } from './perm';

/** PETRO-U2-011: a Float64Array filled by index. Typed-array `from` with a
 *  map function walks the iterator protocol and is several times slower on
 *  the long wells the probabilistic run repeats the pipeline over. */
function mapF64(n, f) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}

/** Sw models defined on TOTAL porosity: they return total Swt on PHIT
 *  (Waxman & Smits 1968; Clavier, Coates & Dumanoir 1984). */
export const TOTAL_SW_MODELS = Object.freeze(['waxman-smits', 'dual-water']);
export const isTotalSwModel = (swMethod) => TOTAL_SW_MODELS.includes(swMethod);

/** The workstation's default parameter set — shown in the panel,
 *  never silently assumed by the engines themselves. */
export const DEFAULT_PARAMS = {
  grClean: 20, grClay: 120, vshMethod: 'larionov-tertiary',
  rhoMa: 2.65, rhoFl: 1.0,
  dtMa: 182, dtFl: 656, sonicMethod: 'wyllie',
  // Wyllie compaction factor Bcp (>= 1; 1 = none). Unconsolidated sands read
  // too slow for the time average; Bcp is commonly taken as the nearby
  // shale slowness / 100 us/ft (Hilchie 1978; Asquith & Krygowski 2004, ch. 4)
  sonicCp: 1,
  ndMethod: 'avg',
  phiSource: 'density',           // density | sonic | nd | mineral (PT11d: curves.PHI_MM from the mineral model, never a default)
  // PT9 effective porosity: PHIT is the selected source's porosity as
  // read (total); PHIE = PHIT - Vsh*phiShale, phiShale being the
  // selected tool's apparent porosity in 100 percent shale (read it in
  // a clean shale; 0.06 is a 2.55 g/cc shale on density with a 2.65
  // matrix). Sw (Archie family), cutoffs, k and BVW run on PHIE; the
  // total-porosity models (Waxman-Smits, dual-water) run on PHIT.
  phiShale: 0.06,
  swMethod: 'archie', a: 1, m: 2, n: 2, rw: 0.05, rsh: 2.0,
  // PS5 temperature model: 'none' keeps rw as entered at all depths;
  // 'linear' builds a TEMP curve and converts rw per sample via Arps
  tempMode: 'none', surfaceTempC: 25, bhtC: 90, bhtDepthM: 2100, rwRefTempC: 25,
  // PS5 shaly-sand parameters (waxman-smits / dual-water); for
  // waxman-smits the m and n fields carry m* and n* (shaly-rock
  // exponents — the UI labels them distinctly)
  qv: 0.1, bMode: 'juhasz', bValue: 3, rwb: 0.02, swb: 0.25,
  // PS6 permeability: 'none' computes no KPERM; PT9 made Timur the
  // default (owner decision 2026-09-07: permeability is never off by
  // default); constants are pinned to the cited forms in perm.js and
  // shown as formulas in the panel
  permMethod: 'timur',            // none | timur | tixier | coates | wyllie-rose
  swirrSource: 'buckles',         // buckles | manual
  bucklesConst: 0.04, swirrManual: 0.15,
  wrC: 79, wrQ: 3,                // Wyllie-Rose constants (Morris & Biggs gas preset)
  cutPhi: 0.08, cutVsh: 0.5, cutSw: 0.6,
};

/**
 * @param {{DEPT: ArrayLike<number>, GR?: ArrayLike<number>,
 *          RHOB?: ArrayLike<number>, NPHI?: ArrayLike<number>,
 *          DT?: ArrayLike<number>, RT?: ArrayLike<number>}} curves
 * @param {typeof DEFAULT_PARAMS} params
 * @returns {{outputs: Object<string, Float64Array>, missing: string[]}}
 *   outputs: VSH, PHID, PHIS, PHIND, PHIT (the phiSource pick, as
 *   read), PHIE (PHIT shale-corrected through VSH), SW, KPERM, BVW,
 *   PAY (1/0/NaN display flags) — only those whose inputs exist.
 *   Without GR there is no VSH and no PHIE; Sw, cutoffs and k then run
 *   on PHIT and `missing` says so.
 */
export function computeWell(curves, params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const n = curves.DEPT.length;
  const outputs = {};
  const missing = [];

  if (curves.GR) {
    outputs.VSH = vshFromGr(curves.GR, { grClean: p.grClean, grClay: p.grClay, method: p.vshMethod });
  } else missing.push('GR (Vsh)');

  if (curves.RHOB) {
    outputs.PHID = mapF64(n, (i) => phiDensity(curves.RHOB[i], p.rhoMa, p.rhoFl));
  }
  if (curves.DT) {
    outputs.PHIS = p.sonicMethod === 'rhg'
      ? mapF64(n, (i) => phiSonicRhg(curves.DT[i], p.dtMa))
      : mapF64(n, (i) => phiSonicWyllie(curves.DT[i], p.dtMa, p.dtFl, p.sonicCp));
  }
  if (outputs.PHID && curves.NPHI) {
    outputs.PHIND = mapF64(n, (i) => phiNd(outputs.PHID[i], curves.NPHI[i], p.ndMethod));
  }

  // PT11d: 'mineral' reads the porosity the Studio solved from the mineral
  // model (curves.PHI_MM); an explicit choice, absent means missing
  const phiSources = { density: outputs.PHID, sonic: outputs.PHIS, nd: outputs.PHIND, mineral: curves.PHI_MM || null };
  // Own keys only: a phiSource of 'constructor' used to store a function as PHIT.
  const phiT = Object.prototype.hasOwnProperty.call(phiSources, p.phiSource) ? phiSources[p.phiSource] : undefined;
  if (phiT) outputs.PHIT = phiT;
  else missing.push(`${p.phiSource} porosity inputs`);
  if (phiT && outputs.VSH) {
    outputs.PHIE = mapF64(n, (i) => phiShaleCorrected(phiT[i], outputs.VSH[i], p.phiShale));
  } else if (phiT) {
    missing.push('GR (Vsh; no PHIE, so Sw, cutoffs and k use PHIT)');
  }
  // the porosity the Archie-family models, cutoffs, k and BVW consume
  const phiEff = outputs.PHIE || outputs.PHIT;

  if (p.tempMode === 'linear') outputs.TEMP = tempCurve(curves.DEPT, p);

  const needsVsh = p.swMethod === 'simandoux' || p.swMethod === 'indonesia' || p.swMethod === 'mod-simandoux';
  // total-porosity models take PHIT (their exponents and Swb / Qv are
  // defined on total porosity); the Archie family takes PHIE
  const totalPhiModel = isTotalSwModel(p.swMethod);
  if (curves.RT && phiEff && (!needsVsh || outputs.VSH)) {
    const rt = curves.RT;
    const phi = totalPhiModel ? outputs.PHIT : phiEff;
    const vsh = outputs.VSH;
    const temp = outputs.TEMP || null;
    const sw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const rwI = temp ? rwAtTemp(p.rw, p.rwRefTempC, temp[i]) : p.rw;
      switch (p.swMethod) {
        case 'simandoux':
          sw[i] = swSimandoux(rt[i], phi[i], rwI, vsh[i], p.rsh, p.a, p.m);
          break;
        case 'indonesia':
          sw[i] = swIndonesia(rt[i], phi[i], rwI, vsh[i], p.rsh, p.a, p.m, p.n);
          break;
        case 'waxman-smits': {
          const b = p.bMode === 'manual' ? p.bValue : bJuhasz(temp ? temp[i] : p.rwRefTempC);
          sw[i] = swWaxmanSmits(rt[i], phi[i], rwI, p.qv, b, p.a, p.m, p.n);
          break;
        }
        case 'dual-water':
          sw[i] = swDualWater(rt[i], phi[i], rwI, p.rwb, p.swb, p.a, p.m, p.n);
          break;
        case 'mod-simandoux':
          sw[i] = swModSimandoux(rt[i], phi[i], rwI, vsh[i], p.rsh, p.a, p.m, p.n);
          break;
        default:
          sw[i] = swArchie(rt[i], phi[i], rwI, p.a, p.m, p.n);
      }
    }
    outputs.SW = sw;
    // PETRO-U2-012 (PETRO-U1-020): a total-porosity model's saturation is
    // Swt; SWT names it (SW keeps the model's saturation for the cutoffs and
    // summaries, and the publish writes it as SWT, never as SW)
    if (totalPhiModel) outputs.SWT = sw;
  } else if (!curves.RT) missing.push('RT (Sw)');

  if (p.permMethod !== 'none' && phiEff) {
    const phi = phiEff;
    const kperm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const si = p.swirrSource === 'manual' ? p.swirrManual : swirrFromBuckles(phi[i], p.bucklesConst);
      switch (p.permMethod) {
        case 'tixier': kperm[i] = kTixier(phi[i], si); break;
        case 'coates': kperm[i] = kCoates(phi[i], si); break;
        case 'wyllie-rose': kperm[i] = kWyllieRose(phi[i], si, p.wrC, p.wrQ); break;
        default: kperm[i] = kTimur(phi[i], si);
      }
    }
    outputs.KPERM = kperm;
  }
  if (phiEff && outputs.SW) {
    // PETRO-U2-012 (PETRO-U1-019): BVW in ONE porosity system, the one the
    // saturation was solved on: PHIT x Swt for the total-porosity models,
    // PHIE x Sw for the Archie family (it was PHIE x Swt, mixing the two)
    const bvwPhi = totalPhiModel && outputs.PHIT ? outputs.PHIT : phiEff;
    outputs.BVW = mapF64(n, (i) => bvw(bvwPhi[i], clampDisplay(outputs.SW[i])));
  }

  if (outputs.PHIE && outputs.VSH && outputs.SW) {
    const swClamped = mapF64(n, (i) => clampDisplay(outputs.SW[i]));
    const { flags } = netPay(
      { depth: curves.DEPT, phi: outputs.PHIE, vsh: outputs.VSH, sw: swClamped },
      { cutPhi: p.cutPhi, cutVsh: p.cutVsh, cutSw: p.cutSw },
    );
    outputs.PAY = mapF64(n, (i) => (flags[i] === null ? NaN : (flags[i] ? 1 : 0)));
  }

  return { outputs, missing };
}

/**
 * Zone-aware compute (PS3): per-zone parameter override patches merged
 * over the base set. zoneParamList = [{top, base, params}] in metres
 * MD; entries are sorted by top and the FIRST zone containing a sample
 * wins (overlaps are the caller's to warn about); samples outside
 * every zone use the base parameters. Implemented as contiguous
 * same-parameter runs sliced through computeWell itself, so the zoned
 * path inherits the validated pipeline verbatim — with an empty
 * zoneParamList the result is computeWell exactly (tested invariant).
 *
 * Outputs are the union across segments (a per-zone phiSource switch
 * can make a product exist in one zone only); absent stretches are
 * NaN. PAY inside each zone honours that zone's cutoffs.
 *
 * @param {Parameters<typeof computeWell>[0]} curves
 * @param {typeof DEFAULT_PARAMS} baseParams
 * @param {Array<{top: number, base: number, params: Object}>} zoneParamList
 * @returns {{outputs: Object<string, Float64Array>, missing: string[]}}
 */
export function computeWellZoned(curves, baseParams, zoneParamList = []) {
  const base = { ...DEFAULT_PARAMS, ...baseParams };
  const depth = curves.DEPT;
  const n = depth.length;
  const zonesSorted = [...zoneParamList].sort((a, b) => a.top - b.top);

  const zi = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < zonesSorted.length; k++) {
      if (depth[i] >= zonesSorted[k].top && depth[i] <= zonesSorted[k].base) { zi[i] = k; break; }
    }
  }

  const outputs = {};
  const missing = new Set();
  let i0 = 0;
  while (i0 < n) {
    let i1 = i0;
    while (i1 + 1 < n && zi[i1 + 1] === zi[i0]) i1 += 1;
    const p = zi[i0] < 0 ? base : { ...base, ...zonesSorted[zi[i0]].params };
    const seg = {};
    for (const [key, arr] of Object.entries(curves)) {
      if (arr) seg[key] = arr.slice(i0, i1 + 1);
    }
    const r = computeWell(seg, p);
    for (const [key, arr] of Object.entries(r.outputs)) {
      if (!outputs[key]) outputs[key] = new Float64Array(n).fill(NaN);
      outputs[key].set(arr, i0);
    }
    for (const m of r.missing) missing.add(m);
    i0 = i1 + 1;
  }
  return { outputs, missing: [...missing] };
}

/** Bumped whenever a formula or the publish payload shape changes —
 *  recorded in every published curve's provenance so consumers can
 *  tell recipe generations apart. v2 (PS3): zoned compute; provenance
 *  gains zone_params and interpretation_name. v3 (PS5): temperature
 *  model + Waxman-Smits / dual-water / modified Simandoux. v4 (PS6):
 *  permeability (KPERM, mD) + BVW; zone summaries gain k_gm_md.
 *  v5 (PT9): the curve formerly published as PHIE (the source porosity
 *  as read) is now PHIT; PHIE is the shale-corrected effective
 *  porosity and feeds Sw, cutoffs, k and BVW; permeability defaults to
 *  Timur. v6 (PT11d): phiSource 'mineral'. v7 (PETRO-U2-012): with a
 *  total-porosity Sw model BVW is PHIT x Swt (was PHIE x Swt), the
 *  saturation is also output as SWT and published under that name. */
export const PIPELINE_VERSION = 7; // PT11d v6: phiSource 'mineral'; PETRO-U2-012 v7: BVW = PHIT x Swt and the SWT curve for total-porosity Sw models

/** Literature references for each selectable method, keyed the way the
 *  parameter set spells them — the same sources the validation oracle
 *  cites (tools/validation/petrophysics/oracle.py). Lives beside the
 *  math so reports and UI never carry their own citation copies. */
export const METHOD_CITATIONS = {
  vsh: {
    linear: 'Linear gamma-ray index (Vsh = IGR), standard quicklook.',
    'larionov-tertiary': 'Larionov (1969), tertiary/unconsolidated rocks: Vsh = 0.083*(2^(3.7*IGR) - 1).',
    'larionov-older': 'Larionov (1969), older/consolidated rocks: Vsh = 0.33*(2^(2*IGR) - 1).',
    clavier: 'Clavier, Hoyle & Meunier (1971): Vsh = 1.7 - sqrt(3.38 - (IGR + 0.7)^2).',
    steiber: 'Steiber (1970): Vsh = IGR / (3 - 2*IGR).',
  },
  phi: {
    density: 'Density porosity: phi = (rho_ma - rho_b) / (rho_ma - rho_fl).',
    sonic: 'Sonic porosity, per the sonicMethod parameter (Wyllie or RHG).',
    nd: 'Neutron-density combination, per the ndMethod parameter (avg or rms gas form).',
    mineral: 'Porosity solved by the mineral model: density, neutron and U = Pe*rho_e with closure for three minerals plus porosity, fixed fluid (Doveton 1994, ch. 3, determined case); the endpoint table in play is in the published curves\' provenance.',
  },
  phie: {
    'shale-point': 'Effective porosity by the linear shale-point correction phi_e = phi_t - Vsh * phi_sh (Dresser Atlas 1979 log interpretation charts; Asquith & Krygowski 2004, ch. 4), phi_sh being the selected tool\'s apparent porosity in shale.',
  },
  sonic: {
    wyllie: 'Wyllie, Gregory & Gardner (1956) time-average equation, divided by the compaction factor Bcp for unconsolidated sands (Hilchie 1978).',
    rhg: 'Raymer, Hunt & Gardner (1980) field-observation form.',
  },
  sw: {
    archie: 'Archie (1942): Sw = ((a*Rw)/(phi^m * Rt))^(1/n).',
    simandoux: 'Simandoux (1963), classic quadratic form (n = 2); reduces to Archie at Vsh = 0.',
    indonesia: 'Poupon & Leveaux (1971) "Indonesia" equation; reduces to Archie at Vsh = 0.',
    'waxman-smits': 'Waxman & Smits (1968), SPE Journal 8(2); B(T) per Juhasz (1981, SPWLA 22nd) unless set manually. m* and n* are shaly-rock exponents.',
    'dual-water': 'Clavier, Coates & Dumanoir (1984), SPE Journal 24(2) dual-water model; returns total Swt.',
    'mod-simandoux': 'Bardon & Pied (1969) modified Simandoux; reduces to Archie at Vsh = 0.',
  },
  temp: {
    none: 'Rw used as entered at all depths.',
    linear: 'Linear geothermal profile from surface temperature and BHT; Rw converted per depth via Arps (degF inside the formula).',
  },
  perm: {
    timur: 'Timur (1968, SPWLA 9th): k = 8581*phi^4.4/Swirr^2 (fractions, mD).',
    tixier: 'Tixier (1949): k = (250*phi^3/Swirr)^2 (fractions, mD).',
    coates: 'Coates & Denoo (1981): k = (100*phi^2*(1-Swirr)/Swirr)^2 (fractions, mD).',
    'wyllie-rose': 'Wyllie & Rose (1950) generalized k = (c*phi^q/Swirr)^2; Morris & Biggs (1967) presets c = 250 (oil), 79 (gas), q = 3.',
  },
};

const PUBLISH_SPECS = {
  VSH: { unit: 'V/V', description: (p) => `Shale volume (${p.vshMethod})` },
  PHIT: { unit: 'V/V', description: (p) => `Total porosity (${p.phiSource}, as read)` },
  PHIE: { unit: 'V/V', description: (p) => `Effective porosity (${p.phiSource}, shale-corrected, phi_sh ${p.phiShale})` },
  SW: { unit: 'V/V', description: (p) => `Water saturation (${p.swMethod})` },
  SWT: { unit: 'V/V', description: (p) => `Total water saturation Swt on PHIT (${isTotalSwModel(p.swMethod) ? p.swMethod : 'total-porosity model in the zones that use one'})` },
  PAY: { unit: 'FLAG', description: () => 'Net-pay flag (1 = pay)' },
  // documented units exception (see perm.js): mD, never m^2
  KPERM: { unit: 'MD', description: (p) => `Permeability (${p.permMethod}, mD)` },
};

/**
 * Registry payloads for the publishable outputs (the wellsRegistry
 * saveLog shape): float32 samples, full parameter + input provenance.
 * The publish CONTRACT (plan decision 1): re-running a recipe
 * overwrites its own previous output — same well + mnemonic +
 * project_id — never anything else; backends enforce it in
 * publishCurves.
 *
 * @param {{curves: Object, inventory: Array<{key, log}>}} wellData
 * @param {Object<string, Float64Array>} outputs computeWell outputs
 * @param {typeof DEFAULT_PARAMS} params
 * @param {{projectId: string, interpretationName?: string,
 *          zoneParams?: Object, sourceFile?: string}} meta
 */
export function preparePublishLogs(wellData, outputs, params, meta) {
  const depth = wellData.curves.DEPT;
  const depthLog = wellData.inventory.find((e) => e.key === 'DEPT')?.log;
  const inputLogIds = wellData.inventory.filter((e) => e.log).map((e) => e.log.id);
  const logs = [];
  // PETRO-U2-012: SW rows carry effective-system saturation only; where a
  // total-porosity model ran (the whole well or a zone with its own model)
  // the saturation is SWT, and SW is null there
  const sources = { ...outputs };
  if (outputs.SWT && outputs.SW) {
    const sw = Float64Array.from(outputs.SW, (v, i) => (Number.isFinite(outputs.SWT[i]) ? NaN : v));
    sources.SW = sw.some(Number.isFinite) ? sw : null;
  }
  for (const [mnemonic, spec] of Object.entries(PUBLISH_SPECS)) {
    const src = sources[mnemonic];
    if (!src) continue;
    let nullCount = 0;
    const data = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      data[i] = src[i];
      if (!Number.isFinite(src[i])) nullCount += 1;
    }
    logs.push({
      mnemonic,
      description: spec.description(params),
      unit: spec.unit,
      data,
      startMdM: depth[0],
      stopMdM: depth[depth.length - 1],
      stepM: depthLog?.step_m ?? null,
      nSamples: data.length,
      nullCount,
      provenance: {
        computed: true,
        engine: 'petrophysics-studio',
        pipeline_version: PIPELINE_VERSION,
        project_id: meta.projectId,
        interpretation_name: meta.interpretationName ?? null,
        params: { ...params },
        zone_params: meta.zoneParams ? { ...meta.zoneParams } : {},
        input_log_ids: inputLogIds,
      },
    });
  }
  return logs;
}

/** The PUBLISHED zone summary jsonb (plan decision 1: written only by
 *  an explicit publish action). Snapshot of the current numbers plus
 *  everything needed to reproduce them. */
export function zonePropertiesSnapshot(summary, params, meta) {
  return {
    ...summary,
    cutoffs: { phi_min: params.cutPhi, vsh_max: params.cutVsh, sw_max: params.cutSw },
    methods: { vsh: params.vshMethod, phi: params.phiSource, phi_shale: params.phiShale, sw: params.swMethod, perm: params.permMethod },
    pipeline_version: PIPELINE_VERSION,
    project_id: meta.projectId,
    interpretation_name: meta.interpretationName ?? null,
    published_at: meta.publishedAt,
  };
}

/** Zone summary on the CURRENT preview curves (display path; the G2.5
 *  publish action snapshots the same numbers into zone.properties). */
export function zoneSummary(curves, outputs, params, zone) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!outputs.PHIE || !outputs.VSH || !outputs.SW) return null;
  const swClamped = Float64Array.from(outputs.SW, (s) => clampDisplay(s));
  const { flags, summary } = netPay(
    { depth: curves.DEPT, phi: outputs.PHIE, vsh: outputs.VSH, sw: swClamped },
    { cutPhi: p.cutPhi, cutVsh: p.cutVsh, cutSw: p.cutSw, top: zone.top_md_m, base: zone.base_md_m },
  );
  if (outputs.KPERM) {
    summary.k_gm_md = kGeomMean(outputs.KPERM, flags, sampleThickness(curves.DEPT));
  }
  return summary;
}

/**
 * PETRO-U2-012 (PETRO-U1-021): the zone's hydrocarbon pore thickness and
 * its pore-volume weighted Sw, in the porosity system each sample's Sw was
 * solved on. Over the pay samples (the zone's own cutoffs):
 *   HCPV = sum h phi_hc (1 - Sw), phi_hc = PHIT for a total-porosity model
 *   (Sw is Swt there), else PHIE;
 *   sw_avg = 1 - HCPV / sum h PHIE, so net x phi_avg x (1 - sw_avg) = HCPV
 * exactly (phi_avg being the net-weighted PHIE). For the Archie family this
 * is sum(phi Sw h) / sum(phi h), the volumetric convention (Crain; AAPG
 * thickness for volumetrics); zoneSummary's sw_avg stays the
 * net-thickness-weighted figure for traceability.
 * @returns {?{hcpv_m: number, pore_m: number, sw_avg: ?number, sw_system: 'total'|'effective'}}
 */
export function zoneHydrocarbon(curves, outputs, params, zone) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!outputs.PHIE || !outputs.VSH || !outputs.SW) return null;
  const total = isTotalSwModel(p.swMethod) && !!outputs.PHIT;
  const phiE = outputs.PHIE;
  const phiHc = total ? outputs.PHIT : phiE;
  const sw = Float64Array.from(outputs.SW, (v) => clampDisplay(v));
  const { flags } = netPay(
    { depth: curves.DEPT, phi: phiE, vsh: outputs.VSH, sw },
    { cutPhi: p.cutPhi, cutVsh: p.cutVsh, cutSw: p.cutSw, top: zone.top_md_m, base: zone.base_md_m },
  );
  const th = sampleThickness(curves.DEPT);
  let hc = 0;
  let pore = 0;
  for (let i = 0; i < th.length; i++) {
    if (!flags[i]) continue;
    const hcI = phiHc[i] * (1 - sw[i]);
    if (Number.isFinite(hcI)) hc += th[i] * hcI;
    pore += th[i] * phiE[i];
  }
  return { hcpv_m: hc, pore_m: pore, sw_avg: pore > 0 ? 1 - hc / pore : null, sw_system: total ? 'total' : 'effective' };
}

/**
 * PETRO-U2-011: the raw sums behind a zone summary over part of a well, so a
 * zone can be summed chunk by chunk in one pass (the probabilistic run).
 * Same pay rule, thickness and porosity systems as zoneSummary (netPay) and
 * zoneHydrocarbon: over samples [from, to] of `curves` whose depth is inside
 * the zone, with midpoint thickness from the full slice (pass one sample of
 * margin either side of [from, to] for the whole-array midpoints).
 * @returns {?{gross, net, sPhi, sVsh, sSw, kS, kW, hc, pore, hasK: boolean}} null without PHIE, VSH or SW
 */
export function zoneSums(curves, outputs, params, zone, from = 0, to = curves.DEPT.length - 1) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!outputs.PHIE || !outputs.VSH || !outputs.SW) return null;
  const depth = curves.DEPT;
  const th = sampleThickness(depth);
  const total = isTotalSwModel(p.swMethod) && !!outputs.PHIT;
  const phiE = outputs.PHIE; const vsh = outputs.VSH; const swRaw = outputs.SW; const k = outputs.KPERM || null;
  const phiHc = total ? outputs.PHIT : phiE;
  const top = zone.top_md_m; const base = zone.base_md_m;
  const r = { gross: 0, net: 0, sPhi: 0, sVsh: 0, sSw: 0, kS: 0, kW: 0, hc: 0, pore: 0, hasK: !!k };
  for (let i = from; i <= to; i++) {
    const d = depth[i];
    if (d < top || d > base) continue;
    const t = th[i];
    r.gross += t;
    const sw = clampDisplay(swRaw[i]);
    const ph = phiE[i]; const v = vsh[i];
    if (!(Number.isFinite(ph) && Number.isFinite(v) && Number.isFinite(sw))) continue;
    if (!(ph >= p.cutPhi && v <= p.cutVsh && sw <= p.cutSw)) continue;
    r.net += t; r.sPhi += ph * t; r.sVsh += v * t; r.sSw += sw * t;
    if (k && k[i] > 0) { r.kS += Math.log(k[i]) * t; r.kW += t; }
    const hcI = phiHc[i] * (1 - sw);
    if (Number.isFinite(hcI)) r.hc += t * hcI;
    r.pore += t * ph;
  }
  return r;
}

/** Add one partial zoneSums into another (in place). */
export function addZoneSums(acc, part) {
  for (const key of ['gross', 'net', 'sPhi', 'sVsh', 'sSw', 'kS', 'kW', 'hc', 'pore']) acc[key] += part[key];
  acc.hasK = acc.hasK || part.hasK;
  return acc;
}

/** Zone numbers from sums: zoneSummary's fields (sw_avg pore-volume weighted, as zoneHydrocarbon) plus hcpv_m. */
export function summaryFromSums(r) {
  const net = r.net;
  return {
    gross_m: r.gross,
    net_m: net,
    ntg: r.gross > 0 ? net / r.gross : null,
    phi_avg: net > 0 ? r.sPhi / net : null,
    vsh_avg: net > 0 ? r.sVsh / net : null,
    sw_avg_h: net > 0 ? r.sSw / net : null,
    sw_avg: r.pore > 0 ? 1 - r.hc / r.pore : null,
    hcpv_m: r.hc,
    ...(r.hasK ? { k_gm_md: r.kW > 0 ? Math.exp(r.kS / r.kW) : NaN } : {}),
  };
}
