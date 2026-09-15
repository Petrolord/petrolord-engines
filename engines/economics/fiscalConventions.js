/**
 * Fiscal metric conventions (owner decision 2026-09-14, the naming wave that
 * follows EC2-1). ONE place for the names and definitions of the two take
 * metrics, imported by the Suite's Fiscal Regime Designer and by NextGen's
 * fiscal course, so the wording cannot drift between an app and the course
 * that teaches it.
 *
 * The headline metric is GOVERNMENT TAKE: government cash flow divided by the
 * project's pre-take net cash flow (revenue less opex less capex) over the
 * project life. It is what fiscal comparisons in the literature and in bid
 * rounds quote, and what a reader assumes when "government take" carries no
 * qualifier. The second metric is GOVERNMENT SHARE OF NET REVENUE: government
 * cash flow divided by revenue less opex, which adds capex back to the
 * contractor side. It is legitimate and useful, especially for regimes that
 * front-load royalties, and it is always shown second.
 *
 * Both used to be labelled "effective tax rate" on one screen. Neither name is
 * a tax rate: royalty and the government's profit oil are in the numerator.
 *
 * Every appearance states its basis. The default is undiscounted; a discounted
 * variant is labelled with its rate. Computations live in fiscalRegime.js
 * (`takeMetrics`, `classifyGovernmentShare`); this module holds words only.
 */

export const FISCAL_METRIC_KEYS = Object.freeze({
    GOVERNMENT_TAKE: 'governmentTake',
    GOVERNMENT_SHARE_OF_NET_REVENUE: 'governmentShareOfNetRevenue',
});

export const FISCAL_METRICS = Object.freeze({
    governmentTake: Object.freeze({
        key: 'governmentTake',
        role: 'headline',
        name: 'government take',
        title: 'Government take',
        definition:
            "Government cash flow divided by the project's pre-take net cash flow, which is revenue less opex less capex, over the project life.",
        formula: 'government cash flow / (revenue - opex - capex)',
    }),
    governmentShareOfNetRevenue: Object.freeze({
        key: 'governmentShareOfNetRevenue',
        role: 'secondary',
        name: 'government share of net revenue',
        title: 'Government share of net revenue',
        definition:
            'Government cash flow divided by revenue less opex over the project life, so capex is added back to the contractor side.',
        formula: 'government cash flow / (revenue - opex)',
    }),
});

/** The money quantity both ratios divide: royalty plus government profit oil plus tax. */
export const GOVERNMENT_CASH_FLOW = Object.freeze({
    name: 'government cash flow',
    title: 'Government cash flow',
    definition: 'Royalty plus the government share of profit oil plus tax.',
});

export const UNDISCOUNTED = 'undiscounted';

/** "undiscounted", or "discounted at 10 percent". */
export const basisLabel = (discountRatePct = null) => (
    discountRatePct === null || discountRatePct === undefined
        ? UNDISCOUNTED
        : `discounted at ${discountRatePct} percent`
);

const metric = (key) => {
    const m = FISCAL_METRICS[key];
    if (!m) throw new Error(`Unknown fiscal metric: ${key}`);
    return m;
};

/** "Government take (undiscounted)". */
export const metricLabel = (key, discountRatePct = null) =>
    `${metric(key).title} (${basisLabel(discountRatePct)})`;

/** "government take (undiscounted)", for use inside a sentence. */
export const metricPhrase = (key, discountRatePct = null) =>
    `${metric(key).name} (${basisLabel(discountRatePct)})`;

/**
 * The hover and export text: the name with its basis, then the definition,
 * then how a discounted variant is formed.
 */
export const metricDefinition = (key, discountRatePct = null) => {
    const m = metric(key);
    const basis = discountRatePct === null || discountRatePct === undefined
        ? 'Undiscounted: every year counts at face value.'
        : `Discounted at ${discountRatePct} percent: each year's cash flows are discounted at year end before the division.`;
    return `${metricLabel(key, discountRatePct)}: ${m.definition} ${basis}`;
};

/**
 * Header lines for any export that carries either metric. Pass the metrics the
 * export contains, each with its basis.
 * @param {{key: string, discountRatePct?: number|null}[]} items
 */
export const exportHeaderLines = (items) => items.map(({ key, discountRatePct = null }) =>
    metricDefinition(key, discountRatePct));

/**
 * Money in every user-facing fiscal sentence (EC2-11, owner decision
 * 2026-09-15): "1,339.3 million USD". One decimal, rounded as
 * Number.prototype.toFixed rounds, thousands separators on the whole part, and
 * never the "$..MM" shorthand. A value that rounds to zero prints without a
 * sign; a value that is not a finite number prints "n/a".
 * @param {number} valueMM an amount in millions of US dollars
 */
export const formatMillionUSD = (valueMM) => {
    if (typeof valueMM !== 'number' || !Number.isFinite(valueMM)) return 'n/a';
    let fixed = valueMM.toFixed(1);
    if (/^-0\.0$/.test(fixed)) fixed = '0.0';
    const negative = fixed.startsWith('-');
    const [whole, fraction] = (negative ? fixed.slice(1) : fixed).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}${grouped}.${fraction} million USD`;
};
