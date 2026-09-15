/**
 * The IRR contract shared by the screening engine (./screening.js) and the
 * fiscal regime sandbox (./fiscalRegime.js).
 *
 * EC6-1 (FINDINGS-fdp.md section 1) wrote this contract for the screening
 * engine; EC2-5 (owner decision 2026-09-15) adopts it for the fiscal regime
 * sandbox, whose bisection used to report its 102400 percent bracket as a
 * rate and returned 0 both for a flow that never changes sign and for one
 * whose only root is negative. It was lifted out of screening.js unchanged,
 * operation for operation, so the screening goldens did not move.
 *
 * An answer is only an answer if it is one: a rate is reported only when it
 * is a root strictly inside the band from -99 to 1000 percent and the net
 * present value there is zero to within a tolerance scaled by the size of
 * the cash flow. Otherwise `irr` is null and `irrStatus` says which of the
 * other things happened:
 *
 *   'ok'              a root, reported (a negative root inside the band is
 *                     reported too)
 *   'no-sign-change'  every period has the same sign, no IRR exists
 *   'above-clamp'     still positive at 1000 percent: the IRR is higher
 *                     than the band the engine searches
 *   'multiple-roots'  more than one rate zeroes the net present value: every
 *                     root inside the band is listed in `irrRoots`, and
 *                     `irrRootAboveBand` is true when another lies above it
 *   'no-root'         no rate in the band zeroes the net present value
 *
 * A ROOT ABOVE THE BAND (lead decision for the owner, 2026-09-15). As the rate
 * grows without bound every term vanishes faster than the earliest non-zero
 * flow, so the net present value takes that flow's sign. When its sign at the
 * top of the band differs, an odd number of roots lies above the band. One
 * root inside the band is then not "the" return: the result is null with
 * 'multiple-roots', the in-band roots listed and `irrRootAboveBand` true. With
 * no root inside the band the lone root above it is 'above-clamp' (flag true).
 * Every other result carries `irrRootAboveBand: false`, so the shape is stable.
 * The test reads the sign at infinity, so it holds for either discounting
 * convention; an EVEN number of roots above the band is invisible to it.
 *
 * DISCOUNTING IS THE CALLER'S. `times` gives the exponent of each flow: the
 * screening engine passes t + 0.5 (mid-year), the fiscal sandbox passes the
 * row's year (year-end). Nothing here assumes either.
 */

export const IRR_BAND_LOWER_PCT = -99;
export const IRR_BAND_UPPER_PCT = 1000;

export const IRR_STATUSES = Object.freeze({
    OK: 'ok',
    NO_SIGN_CHANGE: 'no-sign-change',
    ABOVE_CLAMP: 'above-clamp',
    MULTIPLE_ROOTS: 'multiple-roots',
    NO_ROOT: 'no-root',
});

const IRR_LOWER = -0.99;
const IRR_UPPER = 10; // 1000 percent

/**
 * @param {number[]} flows cash flow per period
 * @param {number[]} times discount exponent per period, same length
 * @returns {{irr: number|null, irrStatus: string, irrRoots: number[]|null,
 *            irrRootAboveBand: boolean}} irr and irrRoots in percent
 */
export const solveIrrInBand = (flows, times) => {
    const npvAtRate = (rate) => flows.reduce(
        (sum, cf, k) => sum + cf / Math.pow(1 + rate, times[k]), 0,
    );
    // The tolerance has to scale: a $100,000MM case and a $1MM case cannot
    // share an absolute one. Undiscounted gross movement is the scale.
    const flowScale = flows.reduce((sum, cf) => sum + Math.abs(cf), 0) || 1;
    const IRR_TOL = 1e-9 * flowScale;

    let irr = null;
    let irrStatus = IRR_STATUSES.NO_SIGN_CHANGE;
    let irrRoots = null;
    let irrRootAboveBand = false;
    const hasNeg = flows.some((c) => c < 0);
    const hasPos = flows.some((c) => c > 0);

    // How many times the cash flow changes sign. By Descartes' rule a flow
    // that changes sign once has at most one rate that zeroes it, so Newton's
    // answer is the answer. A flow that changes sign more than once can have
    // several, and no single one of them is "the" return, so those are swept
    // properly rather than trusted.
    let signChanges = 0;
    let lastSign = 0;
    flows.forEach((c) => {
        const sign = Math.sign(c);
        if (sign === 0) return;
        if (lastSign !== 0 && sign !== lastSign) signChanges += 1;
        lastSign = sign;
    });

    if (hasNeg && hasPos) {
        let guess = 0.1;
        for (let iter = 0; iter < 100; iter++) {
            let npvIter = 0;
            let dNpv = 0;
            for (let k = 0; k < flows.length; k++) {
                const df = Math.pow(1 + guess, times[k]);
                npvIter += flows[k] / df;
                dNpv -= times[k] * flows[k] / (df * (1 + guess));
            }
            if (Math.abs(dNpv) < 1e-5) break;
            const newGuess = guess - npvIter / dNpv;
            if (!isFinite(newGuess)) break;
            if (Math.abs(newGuess - guess) < 1e-7) { guess = newGuess; break; }
            guess = Math.max(IRR_LOWER, Math.min(newGuess, IRR_UPPER));
        }

        const converged = signChanges <= 1
            && isFinite(guess)
            && guess > IRR_LOWER && guess < IRR_UPPER
            && Math.abs(npvAtRate(guess)) <= IRR_TOL;

        if (converged) {
            irr = guess * 100;
            irrStatus = IRR_STATUSES.OK;
        } else {
            // Newton did not land on a root, or the flow changes sign more
            // than once so its answer cannot be trusted to be the only one.
            // Rather than report where it stopped, look for the roots that
            // are actually there: sweep the band, bisect every sign change.
            // This path is only taken when Newton has already failed, so a
            // Monte Carlo loop (which converges) does not pay for it.
            const STEPS = 1000;
            const roots = [];
            let prevRate = IRR_LOWER;
            let prevNpv = npvAtRate(prevRate);
            for (let k = 1; k <= STEPS; k += 1) {
                const rate = IRR_LOWER + ((IRR_UPPER - IRR_LOWER) * k) / STEPS;
                const value = npvAtRate(rate);
                if (value === 0) {
                    roots.push(rate);
                } else if ((prevNpv < 0 && value > 0) || (prevNpv > 0 && value < 0)) {
                    let lo = prevRate;
                    let hi = rate;
                    let loNpv = prevNpv;
                    for (let b = 0; b < 200; b += 1) {
                        const mid = (lo + hi) / 2;
                        const midNpv = npvAtRate(mid);
                        if (midNpv === 0 || (hi - lo) < 1e-12) { lo = mid; break; }
                        if ((loNpv < 0) === (midNpv < 0)) { lo = mid; loNpv = midNpv; } else { hi = mid; }
                    }
                    roots.push((lo + hi) / 2);
                }
                prevRate = rate;
                prevNpv = value;
            }

            // The sign the NPV tends to as the rate grows without bound is the
            // sign of the earliest non-zero flow. A different sign at the top
            // of the band means a root lies above it.
            let earliest = -1;
            flows.forEach((cf, k) => {
                if (cf !== 0 && (earliest < 0 || times[k] < times[earliest])) earliest = k;
            });
            const atUpper = npvAtRate(IRR_UPPER);
            irrRootAboveBand = atUpper !== 0 && Math.sign(atUpper) !== Math.sign(flows[earliest]);

            if (roots.length === 1 && !irrRootAboveBand) {
                irr = roots[0] * 100;
                irrStatus = IRR_STATUSES.OK;
            } else if (roots.length >= 1) {
                irrStatus = IRR_STATUSES.MULTIPLE_ROOTS;
                irrRoots = roots.map((r) => r * 100);
            } else if (irrRootAboveBand) {
                // No crossing inside the band, but the sign at the top of it
                // is not the sign it ends on: the rate that would zero it is
                // higher than the engine looks.
                irrStatus = IRR_STATUSES.ABOVE_CLAMP;
            } else {
                // Negative at both ends and no crossing between them. For an
                // ordinary spend-then-earn flow that means the project does
                // not return its money at any rate at all.
                irrStatus = IRR_STATUSES.NO_ROOT;
            }
        }
    }
    return { irr, irrStatus, irrRoots, irrRootAboveBand };
};
