/**
 * Heat exchanger thermal design (Facilities F4).
 *
 * Rating and sizing at the level a facilities engineer actually works
 * before HTRI: duty and outlet temperatures from the energy balance,
 * LMTD with the correction factor COMPUTED from the published Bowman
 * closed form rather than read off a chart or typed, effectiveness-NTU
 * in both directions for the standard arrangements, the overall
 * coefficient built from its named resistances (film, wall, fouling,
 * with the tube-side film from Dittus-Boelter/Sieder-Tate), TEMA-style
 * tube count from a bundle-geometry fit, and air-cooler sizing with
 * the ambient derate that actually decides summer capacity.
 *
 * What this is NOT: a rigorous stream-analysis rating. Shell-side film
 * coefficients here are the Kern-method screening estimate, and the
 * studio says so. Bell-Delaware and beyond are HTRI's job.
 *
 * Units: field throughout (Btu/hr, F, lb/hr, ft2, Btu/hr.ft2.F).
 *
 * ERROR CONTRACT. Every export but `airDensityLbFt3` returns an object,
 * and returns `{ error }` rather than a NaN, an Infinity or a number
 * that moved the wrong way. `airDensityLbFt3` is a leaf correlation
 * with nowhere to put an error key and returns a bare number or NaN;
 * its one documented caller turns that NaN into a named refusal.
 *
 * TWO `overallU` EXPORTS USED TO EXIST IN THIS PACKAGE. This module's
 * coefficient is referred to the OUTSIDE tube surface and is now called
 * `overallUOutside`; `engines/production/flowlineThermal.js` keeps
 * `overallU`, which is referred to a stated bore. They were never
 * interchangeable and now cannot be confused by name. Both returns
 * carry `referenceArea` so a value in hand can be identified.
 *
 * WHAT THIS MODULE CANNOT SOURCE. Six things are recorded as stated
 * limits rather than validated, because no publication in this
 * repository settles them. They are in `HELD_FOR_LITERATURE` below and
 * the returns that depend on them say so. Nothing here invents a
 * citation for any of them.
 */

/* ------------------------------------------------------------------ *
 * Declared constants and bounds
 *
 * These are pinned by the gate BY VALUE. That is a pin and not a
 * validation: pinning 0.023 does not make 0.023 right, it makes
 * changing it a reviewed act instead of a silent one. Three of the
 * defects that used to leave the shipped suite green were changes to
 * numbers on this list.
 * ------------------------------------------------------------------ */

export const DECLARED_CONSTANTS = Object.freeze({
  /** Dittus-Boelter, turbulent tube side: Nu = a Re^m Pr^n. */
  dittusBoelterA: 0.023,
  dittusBoelterReExp: 0.8,
  dittusBoelterPrExpHeating: 0.4,
  /** Sieder-Tate viscosity ratio exponent. */
  siederTateExp: 0.14,
  /** Laminar constant-wall-temperature Nusselt number. */
  laminarNusselt: 3.66,
  /** Transition band, refused rather than interpolated. */
  transitionReLow: 2300,
  transitionReHigh: 10000,
  /** centipoise -> lb/(ft.hr). */
  cpToLbFtHr: 2.4191,
  /** Air: molecular weight, gas constant, standard barometric base. */
  airMolecularWeight: 28.9625,
  gasConstantPsiaFt3LbmolR: 10.7316,
  standardBarometricPsia: 14.7,
  /** Air specific heat used for the cooler's air-side balance. */
  airCpBtuLbF: 0.24,
  /** Fan power: bhp = ACFM * inH2O / (fanConstant * eta). */
  fanConstant: 6356,
  /** Default wall conductivity. No material is named by its source. */
  defaultKWallBtuHrFtF: 26,
  /** Air-cooler defaults. */
  defaultStaticPressureInH2O: 0.6,
  defaultFanEfficiency: 0.65,
  defaultMotorEfficiency: 0.92,
});

export const DECLARED_BOUNDS = Object.freeze({
  /**
   * Shells in series. This is a DECLARED DESIGN BOUND, not a published
   * limit: it exists because `shellPasses` was unbounded and any duty a
   * real exchanger cannot reach became reachable by typing a bigger
   * number (1000 shells returned F = 0.999998).
   */
  maxShellPasses: 6,
  /**
   * The relative gap, in percent, below which `controlling` is reported
   * as NOT clear. A one-word verdict decided by a two percent margin is
   * a coin toss wearing a result's clothes. Declared here, not published.
   */
  controllingMarginPct: 10,
});

export const HELD_FOR_LITERATURE = Object.freeze({
  bundleConstants:
    'BUNDLE_K carries eight layout/pass pairs. Their source is not '
    + 'established in this repository, and the 45 and 90 degree rows '
    + 'carried here are IDENTICAL in all four pass counts, so the layout '
    + 'input does nothing between those two. 30 against 45 moves the '
    + 'bundle diameter by about 9 percent, so the input is not '
    + 'decorative in general.',
  dittusBoelterBand:
    'The validity band of the Dittus-Boelter fit, in Reynolds and in '
    + 'Prandtl, is not established in this repository. Re and Pr are '
    + 'returned on every call so they can be checked against the source '
    + 'the caller trusts. Nothing here grades them.',
  dittusBoelterCoolingExponent:
    'Only the heating exponent (Pr^0.4) is carried. The cooling '
    + 'exponent is not established here, and it is not a detail: at a '
    + 'Prandtl of 15 the two forms differ by about 31 percent on hi. '
    + 'A cooled tube side is REFUSED rather than answered with the '
    + 'heating form.',
  siederTateExponent:
    'The 0.14 exponent and the band it was fitted over are not '
    + 'established in this repository.',
  crossFlowF:
    'An air cooler is cross-flow, and the closed form or chart for its '
    + 'F is not established in this repository. `airCooler` therefore '
    + 'sizes on the COUNTER-CURRENT log mean with F = 1 and says so in '
    + 'its return (`fCorrection: null`). The area it reports is a '
    + 'counter-current-basis area and a real cross-flow unit needs more '
    + 'surface. The hot-day rating does NOT depend on this, because it '
    + 'holds effectiveness rather than assuming an arrangement.',
  defaultsProvenance:
    'kWallBtuHrFtF = 26 names no material; staticPressureInH2O = 0.6, '
    + 'fanEfficiency = 0.65 and motorEfficiency = 0.92 name no machine. '
    + 'They are pinned in DECLARED_CONSTANTS so that moving one is a '
    + 'reviewed act, which is not the same as validating one.',
  fanConstantWaterDensity:
    'The fan constant 6356 is written against a density of water this '
    + 'module does not state. It can be MEASURED rather than cited: '
    + '33000 ft.lbf/min per hp divided by 6356 and by 12 in/ft implies '
    + '62.3033 lb/ft3, which is water at roughly 80 F. The gate asserts '
    + 'that implied density, so moving 6356 in the engine and in the '
    + 'oracle together still fails.',
});

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const show = (v) => {
  if (v === undefined) return 'not given';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : String(v);
  return JSON.stringify(v);
};

const LMTD_ARRANGEMENTS = ['counter', 'parallel', 'shell1'];
const EPS_ARRANGEMENTS = ['counter', 'parallel', 'shell1'];

/**
 * Arrangement matching. It used to be `===` against one lowercase
 * string in three functions, so 'Parallel' silently became
 * counter-current, which is a 40 percent error on the driving force
 * delivered with no warning at all. Case and surrounding space no
 * longer matter; an unknown string is REFUSED rather than defaulted.
 */
const readArrangement = (value, allowed) => {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      error: `the arrangement must be one of ${allowed.join(', ')}; it was ${show(value)}`,
    };
  }
  const key = value.trim().toLowerCase();
  if (!allowed.includes(key)) {
    return {
      error: `unknown arrangement ${JSON.stringify(value)}: this module carries ${allowed.join(', ')} and will not fall back to one of them`,
    };
  }
  return { arrangement: key };
};

/* ------------------------------------------------------------------ *
 * Energy balance
 * ------------------------------------------------------------------ */

/**
 * Capacity rate C = m cp, Btu/hr.F.
 *
 * Returns an object. It used to return a bare NaN, which every
 * `if (result.error)` guard downstream sailed straight past.
 */
export const capacityRate = ({ mLbHr, cpBtuLbF }) => {
  if (!(mLbHr > 0)) {
    return { error: `the mass flow must be a positive number of lb/hr; it was ${show(mLbHr)}` };
  }
  if (!(cpBtuLbF > 0)) {
    return { error: `the specific heat must be a positive number of Btu/lb.F; it was ${show(cpBtuLbF)}` };
  }
  return { cBtuHrF: mLbHr * cpBtuLbF };
};

/**
 * Close the energy balance from whatever three of the four terminal
 * temperatures are known, or from a stated duty.
 *
 * THREE THINGS THIS USED TO GET WRONG.
 *
 * 1. It accepted an outlet that moved the WRONG WAY. A hot outlet of
 *    320 F against a 300 F hot inlet returned a duty of -550,000
 *    Btu/hr and a cold stream leaving 6.9 F COLDER than it entered,
 *    with no error key, because the cross guard cannot fire when both
 *    temperatures move away from the cross. Both directions are now
 *    tested against the inlet they came from.
 * 2. The cross test was the COUNTER-CURRENT one whatever the
 *    arrangement, so a duty no parallel exchanger can deliver passed
 *    here and was caught two functions later by `lmtd` with a generic
 *    message. The arrangement is an input now and the test matches it.
 * 3. A stated duty silently discarded a stated outlet beside it. They
 *    are now checked against each other and a disagreement is refused
 *    with both numbers named.
 */
export const energyBalance = ({
  cHot, cCold, thIn, thOut, tcIn, tcOut, qBtuHr, arrangement = 'counter',
}) => {
  const arr = readArrangement(arrangement, LMTD_ARRANGEMENTS);
  if (arr.error) return { error: arr.error };
  if (!(cHot > 0)) {
    return { error: `the hot capacity rate must be positive Btu/hr.F; it was ${show(cHot)}` };
  }
  if (!(cCold > 0)) {
    return { error: `the cold capacity rate must be positive Btu/hr.F; it was ${show(cCold)}` };
  }
  if (!Number.isFinite(thIn) || !Number.isFinite(tcIn)) {
    return { error: `both inlet temperatures are needed: the hot inlet was ${show(thIn)} F and the cold inlet ${show(tcIn)} F` };
  }
  if (!(thIn > tcIn)) {
    return { error: `the hot inlet must be hotter than the cold inlet: ${thIn} F against ${tcIn} F` };
  }

  // Outlets that move the wrong way are refused before anything is
  // computed from them.
  if (Number.isFinite(thOut) && thOut > thIn) {
    return {
      error: `the hot stream cannot leave hotter than it entered: a hot outlet of ${thOut} F against a hot inlet of ${thIn} F. An exchanger takes heat out of this stream.`,
    };
  }
  if (Number.isFinite(tcOut) && tcOut < tcIn) {
    return {
      error: `the cold stream cannot leave colder than it entered: a cold outlet of ${tcOut} F against a cold inlet of ${tcIn} F. An exchanger puts heat into this stream.`,
    };
  }
  if (qBtuHr !== undefined && qBtuHr !== null && !(qBtuHr > 0)) {
    return {
      error: `a stated duty must be positive Btu/hr; it was ${show(qBtuHr)}. A zero or negative duty is not an exchanger, and it used to fall through to the outlet branch unremarked.`,
    };
  }

  let q;
  let basis;
  if (qBtuHr > 0) {
    q = qBtuHr;
    basis = 'stated duty';
    // A stated outlet beside a stated duty is CHECKED, not discarded.
    const tol = 1e-6;
    if (Number.isFinite(thOut)) {
      const implied = thIn - q / cHot;
      if (Math.abs(implied - thOut) > tol * Math.max(1, Math.abs(thOut))) {
        return {
          error: `the stated duty and the stated hot outlet disagree: ${q} Btu/hr on this hot stream leaves it at ${implied.toFixed(4)} F, but ${thOut} F was given. State one of them.`,
        };
      }
    }
    if (Number.isFinite(tcOut)) {
      const implied = tcIn + q / cCold;
      if (Math.abs(implied - tcOut) > tol * Math.max(1, Math.abs(tcOut))) {
        return {
          error: `the stated duty and the stated cold outlet disagree: ${q} Btu/hr on this cold stream leaves it at ${implied.toFixed(4)} F, but ${tcOut} F was given. State one of them.`,
        };
      }
    }
  } else if (Number.isFinite(thOut)) {
    q = cHot * (thIn - thOut);
    basis = 'hot outlet';
  } else if (Number.isFinite(tcOut)) {
    q = cCold * (tcOut - tcIn);
    basis = 'cold outlet';
  } else {
    return { error: 'give a duty or one outlet temperature' };
  }

  if (!(q > 0)) {
    return {
      error: `this case exchanges no heat: the duty works out at ${show(q)} Btu/hr. An outlet equal to its own inlet is not a duty.`,
    };
  }

  const hOut = thIn - q / cHot;
  const cOut = tcIn + q / cCold;

  // The feasibility test now matches the arrangement.
  if (arr.arrangement === 'parallel') {
    // Parallel flow: both streams start at the closed end, so the only
    // end that can lose its driving force is the outlet end.
    if (!(hOut > cOut)) {
      return {
        error: `no PARALLEL-flow exchanger delivers this duty: the two streams would leave at ${hOut.toFixed(2)} F hot and ${cOut.toFixed(2)} F cold, so they must have crossed inside. Parallel flow cannot take the hot outlet below the cold outlet at any area. A counter-current unit can.`,
        thOutIfReached: hOut,
        tcOutIfReached: cOut,
      };
    }
  } else if (!(hOut > tcIn) || !(cOut < thIn)) {
    return {
      error: `this duty crosses the streams: the hot outlet would be ${hOut.toFixed(2)} F against a cold inlet of ${tcIn} F, and the cold outlet ${cOut.toFixed(2)} F against a hot inlet of ${thIn} F. No exchanger of any size does that.`,
      thOutIfReached: hOut,
      tcOutIfReached: cOut,
    };
  }

  return {
    qBtuHr: q, thOut: hOut, tcOut: cOut, basis, arrangement: arr.arrangement,
  };
};

/* ------------------------------------------------------------------ *
 * LMTD and the correction factor
 * ------------------------------------------------------------------ */

export const lmtd = ({ thIn, thOut, tcIn, tcOut, arrangement = 'counter' }) => {
  const arr = readArrangement(arrangement, LMTD_ARRANGEMENTS);
  if (arr.error) return { error: arr.error };
  const temps = { thIn, thOut, tcIn, tcOut };
  const missing = Object.keys(temps).filter((k) => !Number.isFinite(temps[k]));
  if (missing.length) {
    return {
      error: `the log mean needs all four terminal temperatures; ${missing.map((k) => `${k} was ${show(temps[k])}`).join(', ')}`,
    };
  }
  const parallel = arr.arrangement === 'parallel';
  const dt1 = parallel ? thIn - tcIn : thIn - tcOut;
  const dt2 = parallel ? thOut - tcOut : thOut - tcIn;
  if (!(dt1 > 0) || !(dt2 > 0)) {
    return {
      error: `temperature cross: in ${arr.arrangement} flow the two ends of this exchanger have driving forces of ${dt1.toFixed(2)} and ${dt2.toFixed(2)} F, and one of them is not positive.`,
      dt1,
      dt2,
    };
  }
  const base = Math.abs(dt1 - dt2) < 1e-9
    ? { lmtdF: dt1, dt1, dt2, equalEnds: true }
    : { lmtdF: (dt1 - dt2) / Math.log(dt1 / dt2), dt1, dt2, equalEnds: false };
  if (arr.arrangement === 'shell1') {
    return {
      ...base,
      basis: 'counter',
      note: 'a 1-2 shell exchanger is rated on the counter-current log mean multiplied by F; this is the uncorrected log mean, before F is applied',
    };
  }
  return { ...base, basis: arr.arrangement };
};

/** P and R, the dimensionless groups the F correction is written in. */
export const lmtdGroups = ({ thIn, thOut, tcIn, tcOut }) => {
  const temps = { thIn, thOut, tcIn, tcOut };
  const missing = Object.keys(temps).filter((k) => !Number.isFinite(temps[k]));
  if (missing.length) {
    return {
      error: `P and R need all four terminal temperatures; ${missing.map((k) => `${k} was ${show(temps[k])}`).join(', ')}`,
    };
  }
  const span = thIn - tcIn;
  if (!(span > 0)) {
    return { error: `no temperature span between the inlets: the hot inlet is ${thIn} F and the cold inlet ${tcIn} F` };
  }
  const rise = tcOut - tcIn;
  if (Math.abs(rise) < 1e-12) {
    return {
      error: `the cold stream does not change temperature (${tcIn} F in, ${tcOut} F out), so R is undefined and no number of shell passes changes that. R used to come back as Infinity here and the F correction then blamed the shell count.`,
    };
  }
  return { p: rise / span, r: (thIn - thOut) / rise };
};

/**
 * Bowman's closed form for the LMTD correction factor of a 1 shell
 * pass / 2 tube pass exchanger (and, by the standard substitution, of
 * N shell passes). This is an EQUATION in the literature, not a chart,
 * so it is computed rather than typed. The predecessor Suite app made
 * the user type an Ft, which is exactly where a design goes quietly
 * wrong.
 *
 * F below about 0.8 means the configuration is fighting the duty: the
 * curve is steep there and small errors in the terminal temperatures
 * swing the area badly, which is why the standards say to add shells
 * instead. The result carries that warning.
 *
 * `shellPasses` used to be unbounded and silently rounded: 2.4 and 2.6
 * were quietly taken as 2 and 3, which differ by 6.6 percent on F, and
 * 1000 shells returned F = 0.999998, so any unreachable duty became
 * reachable by typing a bigger number. It is now a whole number
 * between 1 and DECLARED_BOUNDS.maxShellPasses or it is refused.
 */
export const lmtdCorrectionF = ({ p, r, shellPasses = 1 }) => {
  if (!Number.isFinite(shellPasses)) {
    return { error: `the number of shell passes must be a number; it was ${show(shellPasses)}` };
  }
  if (!Number.isInteger(shellPasses)) {
    return {
      error: `shells come in whole numbers and ${shellPasses} is not one. The engine will not round for you: ${Math.floor(shellPasses)} and ${Math.ceil(shellPasses)} shells give materially different F. State one.`,
    };
  }
  if (shellPasses < 1 || shellPasses > DECLARED_BOUNDS.maxShellPasses) {
    return {
      error: `${shellPasses} shell passes in series is outside the declared bound of 1 to ${DECLARED_BOUNDS.maxShellPasses}. This bound is a design limit this module declares for itself, and no publication sets it. It exists because F approaches 1 as the shell count grows, so an unbounded box makes any duty reachable by typing.`,
    };
  }
  if (!Number.isFinite(p) || !(p >= 0) || p >= 1) {
    return { error: `F needs 0 <= P < 1; P was ${show(p)}` };
  }
  if (!Number.isFinite(r) || !(r > 0)) {
    return { error: `F needs R > 0; R was ${show(r)}` };
  }
  // N shell passes: convert P to the equivalent single-shell P1.
  let p1 = p;
  const n = shellPasses;
  if (n > 1) {
    if (Math.abs(r - 1) < 1e-9) {
      p1 = p / (n - p * (n - 1));
    } else {
      const s = ((1 - p * r) / (1 - p)) ** (1 / n);
      p1 = (s - 1) / (s - r);
    }
  }
  if (!(p1 >= 0) || p1 >= 1) {
    return { error: `this duty is unreachable with ${n} shell pass${n === 1 ? '' : 'es'}: the equivalent single-shell P works out at ${show(p1)}` };
  }
  const root = Math.sqrt(r * r + 1);
  let f;
  if (Math.abs(r - 1) < 1e-9) {
    // R = 1 limit: ln((1-P)/(1-PR))/(R-1) -> P/(1-P), and the
    // logarithm's arguments carry -1-R = -2. (Writing -1 there instead
    // of -2 is a silent 20 percent error at P = 0.5; the oracle caught
    // exactly that.)
    const num = (p1 * root) / (1 - p1);
    const a = 2 / p1 - 2 + root;
    const b = 2 / p1 - 2 - root;
    if (!(b > 0)) {
      return { error: `F is undefined at P = ${p} and R = ${r} with ${n} shell pass${n === 1 ? '' : 'es'}: the configuration cannot reach this duty. Add a shell pass.` };
    }
    f = num / Math.log(a / b);
  } else {
    const num = (root / (r - 1)) * Math.log((1 - p1) / (1 - p1 * r));
    const a = 2 / p1 - 1 - r + root;
    const b = 2 / p1 - 1 - r - root;
    if (!(b > 0)) {
      return { error: `F is undefined at P = ${p} and R = ${r} with ${n} shell pass${n === 1 ? '' : 'es'}: the configuration cannot reach this duty. Add a shell pass.` };
    }
    f = num / Math.log(a / b);
  }
  if (!Number.isFinite(f) || f <= 0 || f > 1.0001) {
    return { error: `F is undefined at P = ${p} and R = ${r} with ${n} shell pass${n === 1 ? '' : 'es'}: the configuration cannot reach this duty. Add a shell pass.` };
  }
  return {
    f: Math.min(f, 1),
    shellPasses: n,
    p1,
    warning: f < 0.8
      ? 'F below 0.8: the correction curve is steep here, so a small error in the terminal temperatures swings the area badly. Add a shell pass rather than accepting this.'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Overall coefficient from named resistances
 * ------------------------------------------------------------------ */

/**
 * U referred to the OUTSIDE area, assembled from its parts so the
 * controlling resistance is visible instead of buried:
 *   1/Uo = 1/ho + Rfo + (do ln(do/di))/(2 kw) + (do/di)(Rfi + 1/hi)
 *
 * NAMED `overallUOutside`, NOT `overallU`. This package carried two
 * exports called `overallU` with different reference areas and
 * different error contracts, and a U is meaningless without saying
 * which area it is referred to. `engines/production/flowlineThermal.js`
 * keeps the name `overallU` for its bore-referred coefficient.
 *
 * Every coefficient the caller can expose is validated now. A fouling
 * factor of -0.01 used to return a DIRTY U of 393.6 against a clean
 * 98.8 and a fouling penalty of -298 percent; a wall conductivity of
 * zero returned U = 0 with `controlling: 'wall'`; neither carried an
 * error key.
 */
export const overallUOutside = ({
  hoBtuHrFt2F, hiBtuHrFt2F, doIn, diIn,
  kWallBtuHrFtF = DECLARED_CONSTANTS.defaultKWallBtuHrFtF,
  foulingOut = 0, foulingIn = 0,
}) => {
  if (!(hoBtuHrFt2F > 0)) {
    return { error: `the outside film coefficient must be positive Btu/hr.ft2.F; it was ${show(hoBtuHrFt2F)}` };
  }
  if (!(hiBtuHrFt2F > 0)) {
    return { error: `the inside film coefficient must be positive Btu/hr.ft2.F; it was ${show(hiBtuHrFt2F)}` };
  }
  if (!(diIn > 0)) {
    return { error: `the tube inside diameter must be positive inches; it was ${show(diIn)}` };
  }
  if (!(doIn > diIn)) {
    return { error: `the tube outside diameter must exceed the inside diameter: ${show(doIn)} in against ${show(diIn)} in` };
  }
  if (!(kWallBtuHrFtF > 0)) {
    return {
      error: `the wall conductivity must be positive Btu/hr.ft.F; it was ${show(kWallBtuHrFtF)}. Zero used to return a U of zero with the wall named as the controlling resistance, and a negative value used to raise U above its own clean value.`,
    };
  }
  if (!(foulingOut >= 0)) {
    return {
      error: `the outside fouling factor must be zero or positive hr.ft2.F/Btu; it was ${show(foulingOut)}. A negative fouling allowance is surface that cleans itself: it used to raise the dirty U above the clean one and report a fouling penalty of -298 percent.`,
    };
  }
  if (!(foulingIn >= 0)) {
    return {
      error: `the inside fouling factor must be zero or positive hr.ft2.F/Btu; it was ${show(foulingIn)}. A negative fouling allowance is surface that cleans itself.`,
    };
  }

  const ratio = doIn / diIn;
  const rOut = 1 / hoBtuHrFt2F;
  const rWall = (doIn / 12) * Math.log(ratio) / (2 * kWallBtuHrFtF);
  const rIn = ratio / hiBtuHrFt2F;
  const rFoulIn = ratio * foulingIn;
  const total = rOut + foulingOut + rWall + rIn + rFoulIn;
  const clean = rOut + rWall + rIn;
  const resistances = {
    outsideFilm: rOut, outsideFouling: foulingOut, wall: rWall,
    insideFilm: rIn, insideFouling: rFoulIn,
  };
  const sharePct = {};
  Object.keys(resistances).forEach((k) => { sharePct[k] = (resistances[k] / total) * 100; });

  // The controlling resistance with the MARGIN that decided it. At the
  // studio's own shipped defaults this verdict rested on a 2.20 percent
  // gap and the screen reported one word and no margin.
  const ranked = Object.entries(resistances).sort((a, b) => b[1] - a[1]);
  const [topName, topValue] = ranked[0];
  const [runnerUpName, runnerUpValue] = ranked[1];
  const marginPct = topValue > 0 ? ((topValue - runnerUpValue) / topValue) * 100 : 0;
  const clear = marginPct >= DECLARED_BOUNDS.controllingMarginPct;

  return {
    uCleanBtuHrFt2F: 1 / clean,
    uDirtyBtuHrFt2F: 1 / total,
    resistances,
    resistanceSharePct: sharePct,
    totalResistance: total,
    controlling: topName,
    controllingSharePct: sharePct[topName],
    runnerUp: runnerUpName,
    controllingMarginPct: marginPct,
    controllingClear: clear,
    controllingNote: clear
      ? null
      : `${topName} leads ${runnerUpName} by only ${marginPct.toFixed(1)} percent of itself, under the ${DECLARED_BOUNDS.controllingMarginPct} percent this module calls clear. Treat the two as jointly controlling rather than acting on the word.`,
    referenceArea: 'outside tube surface (do)',
    foulingPenaltyPct: (1 - (1 / total) / (1 / clean)) * 100,
  };
};

/**
 * Tube-side film coefficient. Dittus-Boelter in fully turbulent flow;
 * the Sieder-Tate viscosity ratio applied when a wall viscosity is
 * given. Below Re 2300 the laminar constant-wall-temperature Nusselt
 * of 3.66 is used, and the transition band is REFUSED rather than
 * interpolated, because no correlation there is trustworthy and
 * pretending otherwise is how a design gets sized on a fiction.
 *
 * THE COOLING EXPONENT IS NOT CARRIED. The Prandtl exponent here is
 * the heating one and always was; nothing used to let a caller say the
 * tube fluid is being cooled, and at a Prandtl of 15 the two forms
 * differ by about 31 percent on hi. `service` is an input now and
 * 'cooling' is REFUSED, because answering it with the heating exponent
 * would be a confident wrong number and inventing the cooling exponent
 * here would be worse. See HELD_FOR_LITERATURE.
 *
 * The tube count and the pass count are whole numbers or they are
 * refused: `Math.max(1, nTubes / passes)` used to floor silently, so
 * one tube in four passes returned the same Reynolds number as four
 * tubes in four passes.
 */
export const tubeSideFilm = ({
  mLbHr, diIn, muCp, kBtuHrFtF, cpBtuLbF, muWallCp,
  nTubes = 1, passes = 1, service = 'heating',
}) => {
  if (service !== 'heating') {
    if (service === 'cooling') {
      return {
        error: 'this module carries only the HEATING form of Dittus-Boelter (Pr^0.4). The cooling exponent is not established in this repository, and at a Prandtl around 15 the two forms differ by about 31 percent on hi, so it is not a detail to shrug at. Type the tube-side film instead of computing it.',
      };
    }
    return { error: `service must be 'heating'; it was ${show(service)}` };
  }
  if (!(mLbHr > 0)) return { error: `the tube-side flow must be positive lb/hr; it was ${show(mLbHr)}` };
  if (!(diIn > 0)) return { error: `the tube bore must be positive inches; it was ${show(diIn)}` };
  if (!(muCp > 0)) return { error: `the tube-fluid viscosity must be positive cp; it was ${show(muCp)}` };
  if (!(kBtuHrFtF > 0)) return { error: `the tube-fluid conductivity must be positive Btu/hr.ft.F; it was ${show(kBtuHrFtF)}` };
  if (!(cpBtuLbF > 0)) return { error: `the tube-fluid specific heat must be positive Btu/lb.F; it was ${show(cpBtuLbF)}` };
  if (!Number.isInteger(nTubes) || nTubes < 1) {
    return { error: `the tube count must be a whole number of at least 1; it was ${show(nTubes)}` };
  }
  if (!Number.isInteger(passes) || passes < 1) {
    return { error: `the pass count must be a whole number of at least 1; it was ${show(passes)}` };
  }
  if (nTubes < passes || nTubes % passes !== 0) {
    return { error: `${nTubes} tube${nTubes === 1 ? '' : 's'} cannot be divided equally into ${passes} passes. A multi-pass bundle puts the same number of tubes in every pass; the engine used to floor this at one tube per pass, so one tube in four passes returned exactly the same Reynolds number as four tubes in four passes.` };
  }
  if (muWallCp !== undefined && muWallCp !== null && muWallCp !== 0 && !(muWallCp > 0)) {
    return { error: `the wall viscosity must be positive cp when it is given; it was ${show(muWallCp)}` };
  }

  const tubesPerPass = nTubes / passes;
  const dFt = diIn / 12;
  const areaFt2 = (Math.PI * dFt * dFt) / 4 * tubesPerPass;
  const gLbHrFt2 = mLbHr / areaFt2;             // mass velocity
  const muLbFtHr = muCp * DECLARED_CONSTANTS.cpToLbFtHr;
  const re = (dFt * gLbHrFt2) / muLbFtHr;
  const pr = (cpBtuLbF * muLbFtHr) / kBtuHrFtF;
  const band = {
    prandtl: pr,
    reynolds: re,
    validityBand: null,
    note: HELD_FOR_LITERATURE.dittusBoelterBand,
  };

  if (re < DECLARED_CONSTANTS.transitionReLow) {
    return {
      re,
      pr,
      regime: 'laminar',
      hBtuHrFt2F: DECLARED_CONSTANTS.laminarNusselt * kBtuHrFtF / dFt,
      siederTate: false,
      tubesPerPass,
      service: 'heating',
      correlation: band,
      warning: 'laminar tube side: the constant-wall-temperature limit is used, so this film coefficient does NOT move with the flow rate and does NOT take the Sieder-Tate correction. Entrance effects are ignored.',
    };
  }
  if (re < DECLARED_CONSTANTS.transitionReHigh) {
    return {
      error: `tube-side Reynolds ${Math.round(re)} is in the transition band (${DECLARED_CONSTANTS.transitionReLow} to ${DECLARED_CONSTANTS.transitionReHigh}): no film correlation is trustworthy here. Change the tube count, the passes or the bore to leave it.`,
      re,
      pr,
      tubesPerPass,
    };
  }
  const nu0 = DECLARED_CONSTANTS.dittusBoelterA
    * re ** DECLARED_CONSTANTS.dittusBoelterReExp
    * pr ** DECLARED_CONSTANTS.dittusBoelterPrExpHeating;
  const phi = muWallCp > 0 ? (muCp / muWallCp) ** DECLARED_CONSTANTS.siederTateExp : 1;
  return {
    re,
    pr,
    regime: 'turbulent',
    hBtuHrFt2F: (nu0 * phi * kBtuHrFtF) / dFt,
    siederTate: phi !== 1,
    siederTateFactor: phi,
    tubesPerPass,
    service: 'heating',
    correlation: band,
    warning: null,
  };
};

/* ------------------------------------------------------------------ *
 * Sizing and rating
 * ------------------------------------------------------------------ */

/** Area from Q = U A F dTlm. */
export const areaRequired = ({ qBtuHr, uBtuHrFt2F, lmtdF, f = 1 }) => {
  if (!(qBtuHr > 0)) return { error: `the area needs a positive duty; it was ${show(qBtuHr)} Btu/hr` };
  if (!(uBtuHrFt2F > 0)) return { error: `the area needs a positive overall coefficient; it was ${show(uBtuHrFt2F)} Btu/hr.ft2.F` };
  if (!(lmtdF > 0)) return { error: `the area needs a positive log-mean driving force; it was ${show(lmtdF)} F` };
  if (!(f > 0) || f > 1) return { error: `the F correction must be greater than 0 and at most 1; it was ${show(f)}` };
  return { areaFt2: qBtuHr / (uBtuHrFt2F * f * lmtdF) };
};

/**
 * Tube count and bundle diameter for a stated area. The bundle fit is
 * the standard D_b = do (N/K1)^(1/n1) form; the shell is the bundle
 * plus a clearance that is an input, since it depends on the TEMA head
 * type.
 *
 * The constants' source is HELD FOR LITERATURE, and so is the question
 * of whether a published table really groups 45 and 90 degree pitch as
 * one row: the two rows carried here are identical in all four pass
 * counts, so the layout input does nothing between them. The return
 * says so rather than letting the box look live.
 *
 * `actualAreaFt2` is a whole number of tubes and therefore always at
 * or above the requirement. The overshoot is returned now instead of
 * being left for the reader to notice.
 */
const BUNDLE_K = {
  '30': { 1: { k: 0.319, n: 2.142 }, 2: { k: 0.249, n: 2.207 }, 4: { k: 0.175, n: 2.285 }, 6: { k: 0.0743, n: 2.499 } },
  '45': { 1: { k: 0.215, n: 2.207 }, 2: { k: 0.156, n: 2.291 }, 4: { k: 0.158, n: 2.263 }, 6: { k: 0.0402, n: 2.617 } },
  '90': { 1: { k: 0.215, n: 2.207 }, 2: { k: 0.156, n: 2.291 }, 4: { k: 0.158, n: 2.263 }, 6: { k: 0.0402, n: 2.617 } },
};

export const bundleConstants = () => JSON.parse(JSON.stringify(BUNDLE_K));

export const tubeCount = ({
  areaFt2, doIn, tubeLengthFt, layoutDeg = 30, passes = 2, bundleClearanceIn = 2.5,
}) => {
  if (!(areaFt2 > 0)) return { error: `the tube count needs a positive area; it was ${show(areaFt2)} ft2` };
  if (!(doIn > 0)) return { error: `the tube count needs a positive tube OD; it was ${show(doIn)} in` };
  if (!(tubeLengthFt > 0)) return { error: `the tube count needs a positive tube length; it was ${show(tubeLengthFt)} ft` };
  if (!(bundleClearanceIn >= 0)) {
    return { error: `the bundle-to-shell clearance must be zero or positive inches; it was ${show(bundleClearanceIn)}` };
  }
  const layout = BUNDLE_K[String(layoutDeg)];
  if (!layout) {
    return { error: `this module carries bundle constants for 30, 45 and 90 degree layouts only; ${show(layoutDeg)} was given` };
  }
  const passKey = [1, 2, 4, 6].includes(passes) ? passes : null;
  if (!passKey) {
    return { error: `this module carries bundle constants for 1, 2, 4 and 6 tube passes only; ${show(passes)} was given` };
  }
  const perTube = Math.PI * (doIn / 12) * tubeLengthFt;
  // A multi-pass bundle divides its tubes equally between the passes, so
  // the count is rounded UP to a multiple of the pass count. Without
  // this the count this function returns could not be fed back into
  // `tubeSideFilm`, which is the loop the Suite studio never closed.
  const nCover = Math.ceil(areaFt2 / perTube);
  const n = Math.ceil(nCover / passKey) * passKey;
  const { k, n: n1 } = layout[passKey];
  const bundleIn = doIn * (n / k) ** (1 / n1);
  const actual = n * perTube;
  return {
    nTubes: n,
    tubesPerPass: n / passKey,
    areaPerTubeFt2: perTube,
    actualAreaFt2: actual,
    areaMarginPct: ((actual - areaFt2) / areaFt2) * 100,
    bundleDiameterIn: bundleIn,
    shellDiameterIn: bundleIn + bundleClearanceIn,
    layoutDeg: Number(layoutDeg),
    layoutNote: String(layoutDeg) === '45' || String(layoutDeg) === '90'
      ? 'the 45 and 90 degree constants carried here are identical, so the layout choice changes nothing between those two. 30 degrees does move the bundle.'
      : null,
    constantsNote: HELD_FOR_LITERATURE.bundleConstants,
  };
};

/**
 * Effectiveness-NTU, both directions, for the arrangements whose
 * closed forms are published.
 *
 * Returns an OBJECT. It used to return a bare NaN for a capacity ratio
 * above 1, a negative one, or any NaN input, so every `if (r.error)`
 * guard downstream passed and the studio rendered a card of dashes.
 *
 * `ceiling` is the effectiveness this arrangement cannot pass at any
 * area. Counter-current has NONE, and the help text that said every
 * arrangement has one was wrong: counter-current at Cr = 0.5 returns
 * an NTU for an effectiveness of 0.99999 and never refuses.
 */
export const effectivenessFromNtu = ({ ntu, cr, arrangement = 'counter' }) => {
  const arr = readArrangement(arrangement, EPS_ARRANGEMENTS);
  if (arr.error) return { error: arr.error };
  if (!Number.isFinite(ntu) || !(ntu >= 0)) {
    return { error: `NTU must be a finite number of at least zero; it was ${show(ntu)}` };
  }
  if (!Number.isFinite(cr) || !(cr >= 0) || cr > 1) {
    return {
      error: `the capacity ratio must be between 0 and 1 inclusive; it was ${show(cr)}. Cr is Cmin over Cmax by definition, so a value above 1 means the two capacity rates were passed the wrong way round.`,
    };
  }
  const a = arr.arrangement;
  const ceiling = (() => {
    if (cr === 0) return 1;
    if (a === 'parallel') return 1 / (1 + cr);
    if (a === 'shell1') return 2 / (1 + cr + Math.sqrt(1 + cr * cr));
    return null; // counter-current has no ceiling below 1
  })();
  let eff;
  if (cr === 0) {
    eff = 1 - Math.exp(-ntu);
  } else if (a === 'parallel') {
    eff = (1 - Math.exp(-ntu * (1 + cr))) / (1 + cr);
  } else if (a === 'shell1') {
    const root = Math.sqrt(1 + cr * cr);
    const e = Math.exp(-ntu * root);
    eff = 2 / (1 + cr + root * (1 + e) / (1 - e));
  } else if (Math.abs(cr - 1) < 1e-9) {
    eff = ntu / (1 + ntu);
  } else {
    const e = Math.exp(-ntu * (1 - cr));
    eff = (1 - e) / (1 - cr * e);
  }
  if (!Number.isFinite(eff)) {
    return { error: `the effectiveness came out non-finite at NTU ${ntu} and Cr ${cr} for ${a} flow` };
  }
  return { effectiveness: eff, arrangement: a, ceiling };
};

export const ntuFromEffectiveness = ({ effectiveness: eff, cr, arrangement = 'counter' }) => {
  const arr = readArrangement(arrangement, EPS_ARRANGEMENTS);
  if (arr.error) return { error: arr.error };
  if (!Number.isFinite(eff) || !(eff > 0) || eff >= 1) {
    return { error: `the effectiveness must be between 0 and 1; it was ${show(eff)}` };
  }
  if (!Number.isFinite(cr) || !(cr >= 0) || cr > 1) {
    return { error: `the capacity ratio must be between 0 and 1 inclusive; it was ${show(cr)}` };
  }
  const a = arr.arrangement;
  if (cr === 0) return { ntu: -Math.log(1 - eff), arrangement: a, ceiling: 1 };
  if (a === 'parallel') {
    const ceiling = 1 / (1 + cr);
    const inner = 1 - eff * (1 + cr);
    if (!(inner > 0)) {
      return { error: `a parallel-flow exchanger cannot exceed an effectiveness of ${ceiling.toFixed(3)} at this capacity ratio, whatever its area`, ceiling };
    }
    return { ntu: -Math.log(inner) / (1 + cr), arrangement: a, ceiling };
  }
  if (a === 'shell1') {
    const root = Math.sqrt(1 + cr * cr);
    const ceiling = 2 / (1 + cr + root);
    if (eff >= ceiling) {
      return { error: `a 1-2 shell exchanger cannot exceed an effectiveness of ${ceiling.toFixed(3)} at this capacity ratio, whatever its area`, ceiling };
    }
    const e = (2 / eff - (1 + cr)) / root;
    return { ntu: (1 / root) * Math.log((e + 1) / (e - 1)), arrangement: a, ceiling };
  }
  // Counter-current: no ceiling below 1. NTU grows without bound as the
  // effectiveness approaches 1, and that is the honest answer.
  if (Math.abs(cr - 1) < 1e-9) return { ntu: eff / (1 - eff), arrangement: a, ceiling: null };
  return { ntu: (1 / (cr - 1)) * Math.log((eff - 1) / (eff * cr - 1)), arrangement: a, ceiling: null };
};

/* ------------------------------------------------------------------ *
 * Air coolers
 * ------------------------------------------------------------------ */

/**
 * Air density, ideal gas, at a stated temperature and barometric
 * pressure. A leaf correlation: a bare number, or NaN below absolute
 * zero, documented here because it has nowhere to put an error key.
 * Its caller turns the NaN into a named refusal.
 */
export const airDensityLbFt3 = (tF, psia = DECLARED_CONSTANTS.standardBarometricPsia) => {
  const rankine = tF + 459.67;
  if (!Number.isFinite(rankine) || !(rankine > 0) || !(psia > 0)) return NaN;
  return (psia * DECLARED_CONSTANTS.airMolecularWeight)
    / (DECLARED_CONSTANTS.gasConstantPsiaFt3LbmolR * rankine);
};

/**
 * Air cooler sizing, plus the hot-day rating that decides summer
 * capacity.
 *
 * THE HOT DAY IS RATED, NOT SCALED. It used to hold the process outlet
 * temperature FIXED and scale the duty by the ratio of the two log
 * means, and those two things cannot both be true: if the duty falls,
 * the outlet rises. At this studio's own shipped defaults it reported
 * 81.2 percent capacity retained where the honest answer is 90.3, and
 * its own 16.23 MMBtu/hr at the same air mass implies a 24.4 F air
 * rise while it kept the design 30 F.
 *
 * What is held is what the machine actually holds on a hot afternoon:
 * the SURFACE (UA) and the AIR MASS (so both capacity rates). Those fix
 * NTU and Cr, which fix the effectiveness, whatever the arrangement is
 * -- which is why this rating needs no cross-flow F and is unaffected
 * by the one this module cannot source. The duty then follows from the
 * inlet temperature difference alone, and the NEW process outlet and
 * the NEW air rise are returned beside it.
 *
 * THE AIR DENSITY HAS A DRAFT TYPE NOW. It used to be taken at the MEAN
 * of the inlet and the outlet air, which is neither machine's fan
 * inlet: across the two real choices the fan power moves by 5.3
 * percent. `draftType` is an input, 'forced' (the fan handles ambient
 * air) or 'induced' (it handles the heated air leaving the bundle), and
 * the fan inlet temperature is returned. `barometricPsia` is an input
 * too, because the duty of this machine is set by air density and it
 * used to be hard-wired at sea level.
 */
export const airCooler = ({
  qBtuHr, processInF, processOutF, ambientF, airRiseF,
  uBtuHrFt2F,
  staticPressureInH2O = DECLARED_CONSTANTS.defaultStaticPressureInH2O,
  fanEfficiency = DECLARED_CONSTANTS.defaultFanEfficiency,
  motorEfficiency = DECLARED_CONSTANTS.defaultMotorEfficiency,
  checkAmbientF,
  draftType = 'forced',
  barometricPsia = DECLARED_CONSTANTS.standardBarometricPsia,
}) => {
  const draft = typeof draftType === 'string' ? draftType.trim().toLowerCase() : draftType;
  if (draft !== 'forced' && draft !== 'induced') {
    return { error: `the draft type must be 'forced' or 'induced'; it was ${show(draftType)}. The fan inlet density depends on it and the two differ by about 5 percent on fan power, so this module will not pick one for you.` };
  }
  if (!(qBtuHr > 0)) return { error: `an air cooler needs a positive duty; it was ${show(qBtuHr)} Btu/hr` };
  if (!(uBtuHrFt2F > 0)) return { error: `an air cooler needs a positive U; it was ${show(uBtuHrFt2F)} Btu/hr.ft2.F` };
  if (!(airRiseF > 0)) return { error: `an air cooler needs a positive air temperature rise; it was ${show(airRiseF)} F` };
  if (!Number.isFinite(ambientF)) return { error: `the design ambient temperature is empty or not a number; it was ${show(ambientF)} F` };
  if (!Number.isFinite(processInF)) return { error: `the process inlet temperature is empty or not a number; it was ${show(processInF)} F` };
  if (!Number.isFinite(processOutF)) return { error: `the process outlet temperature is empty or not a number; it was ${show(processOutF)} F` };
  if (!(processInF > processOutF)) {
    return { error: `a cooler takes the process DOWN: the inlet is ${processInF} F and the outlet ${processOutF} F` };
  }
  if (!(staticPressureInH2O > 0)) {
    return { error: `the fan static pressure must be positive inches of water; it was ${show(staticPressureInH2O)}. A negative one used to return a negative horsepower.` };
  }
  if (!(fanEfficiency > 0) || fanEfficiency > 1) {
    return { error: `the fan efficiency must be greater than 0 and at most 1; it was ${show(fanEfficiency)}. Zero used to return Infinity bhp and a negative value a negative one, neither with an error key.` };
  }
  if (!(motorEfficiency > 0) || motorEfficiency > 1) {
    return { error: `the motor efficiency must be greater than 0 and at most 1; it was ${show(motorEfficiency)}. A value above 1 is a motor drawing less than the shaft it turns.` };
  }
  if (!(barometricPsia > 0)) {
    return { error: `the barometric pressure must be positive psia; it was ${show(barometricPsia)}` };
  }

  const airOutF = ambientF + airRiseF;
  const l = lmtd({ thIn: processInF, thOut: processOutF, tcIn: ambientF, tcOut: airOutF });
  if (l.error) {
    return { error: `${l.error} An air cooler cannot take the process to ${processOutF} F against ${ambientF} F air rising ${airRiseF} F.` };
  }
  const areaFt2 = qBtuHr / (uBtuHrFt2F * l.lmtdF);
  const cpAir = DECLARED_CONSTANTS.airCpBtuLbF;
  const airLbHr = qBtuHr / (cpAir * airRiseF);
  const fanInletF = draft === 'forced' ? ambientF : airOutF;
  const rho = airDensityLbFt3(fanInletF, barometricPsia);
  if (!(rho > 0)) {
    return { error: `the air density came out ${show(rho)} lb/ft3 at ${fanInletF} F and ${barometricPsia} psia` };
  }
  const acfm = airLbHr / rho / 60;
  // fan bhp = ACFM * static inches of water / (6356 * eta)
  const fanBhp = (acfm * staticPressureInH2O) / (DECLARED_CONSTANTS.fanConstant * fanEfficiency);
  const out = {
    airOutF,
    lmtdF: l.lmtdF,
    areaFt2,
    airLbHr,
    acfm,
    airDensityLbFt3: rho,
    fanInletF,
    draftType: draft,
    barometricPsia,
    fanBhp,
    motorHp: fanBhp / motorEfficiency,
    fCorrection: null,
    fNote: HELD_FOR_LITERATURE.crossFlowF,
  };

  if (checkAmbientF !== undefined && checkAmbientF !== null) {
    out.hotDay = (() => {
      if (!Number.isFinite(checkAmbientF)) {
        return { error: `the ambient to check is empty or not a number; it was ${show(checkAmbientF)} F` };
      }
      if (!(checkAmbientF < processInF)) {
        return {
          error: `at ${checkAmbientF} F the air is not colder than the ${processInF} F process inlet, so this cooler has no driving force at all and its duty is zero.`,
        };
      }
      const cProcess = qBtuHr / (processInF - processOutF);
      const cAir = qBtuHr / airRiseF;
      const cMin = Math.min(cProcess, cAir);
      const cMax = Math.max(cProcess, cAir);
      const cr = cMin / cMax;
      const ua = qBtuHr / l.lmtdF;
      // Effectiveness at the design point, taken from its DEFINITION,
      // so no arrangement and no F is assumed anywhere in this block.
      const effectiveness = qBtuHr / (cMin * (processInF - ambientF));
      const q2 = effectiveness * cMin * (processInF - checkAmbientF);
      const newProcessOutF = processInF - q2 / cProcess;
      const newAirRiseF = q2 / cAir;
      const l2 = lmtd({
        thIn: processInF,
        thOut: newProcessOutF,
        tcIn: checkAmbientF,
        tcOut: checkAmbientF + newAirRiseF,
      });
      const hotter = checkAmbientF > ambientF;
      const colder = checkAmbientF < ambientF;
      return {
        ambientF: checkAmbientF,
        regime: hotter ? 'hotter than design' : (colder ? 'colder than design' : 'the design ambient'),
        dutyFraction: q2 / qBtuHr,
        qBtuHr: q2,
        processOutF: newProcessOutF,
        airRiseF: newAirRiseF,
        airOutF: checkAmbientF + newAirRiseF,
        effectiveness,
        ntu: ua / cMin,
        cr,
        uaBtuHrF: ua,
        lmtdF: l2.error ? null : l2.lmtdF,
        designOutletReached: newProcessOutF <= processOutF + 1e-9,
        basis: 'effectiveness-NTU at fixed UA and fixed air mass; no arrangement and no F correction is assumed',
        note: colder
          ? `colder than the design ambient, so the SURFACE can do more than the design duty. This is a capability that the plant may never draw on: a plant holding the process at ${processOutF} F will throttle or stage the air instead, and the outlet shown is what the bundle would reach wide open.`
          : (newProcessOutF > processOutF + 1e-9
            ? `the design outlet of ${processOutF} F is no longer reachable at ${checkAmbientF} F ambient: the process leaves at ${newProcessOutF.toFixed(1)} F instead, and the air rise falls from ${airRiseF} to ${newAirRiseF.toFixed(1)} F.`
            : null),
      };
    })();
  }
  return out;
};
