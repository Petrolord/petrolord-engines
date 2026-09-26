/**
 * Fiscal regime templates for the regime sandbox in ./fiscalRegime.js
 * (Economics, extracted VERBATIM from the Suite's src/utils/fiscalTemplates.js
 * in the EC0 extraction wave, 2026-09-08). No imports, no edits. Templates
 * carry no `id`; the Suite assigns one when a template is loaded into a
 * comparison, and the fiscal goldens use the slug of the name.
 *
 * EC7 repair 12 (engines 3.12.0): "Nigeria - PIA (2021)" is re-based on the
 * Act (see its description). The pre-audit template, which carried no PIA
 * value, is kept as LEGACY_PRE_AUDIT_PIA_TEMPLATE for reproducing past
 * comparisons; it is not in the template list.
 */
export const fiscalTemplates = [
      {
        name: "Nigeria - PIA (2021)",
        description: "Deep offshore production sharing contract on the Petroleum Industry Act 2021 base terms for new acreage: royalty 5% on the first 50,000 bopd and 7.5% above (Seventh Schedule para 10(3)), royalty by price on the Petroleum Royalty Regulations 2022 benchmarks with project year 1 in 2027 (para 11), 5% on gas and NGL (para 10(6)), a cost limit of 70% of the crude and NGL value (para 14(4)), the government's minimum profit oil by cumulative production (para 14(4)), CIT 30% and no hydrocarbon tax in deep offshore (s.260(3)). These are the Act's minimum terms; a licensing round can bid them up (s.303(2)).",
        regime: {
          royalty: { type: 'pia_2021', terrain: 'deep_offshore', firstCalendarYear: 2027, gasInCountrySharePct: 0, priceRoyaltyBase: 'regulations_2021' },
          tax: { cit: 30, rrt: 0, minTax: 0 },
          costRecoveryLimit: 70,
          costRecoveryBase: 'liquids_gross',
          profitSplit: { type: 'pia_cumulative_production', tiers: [
            { upToMMbbl: 50, governmentPct: 5 }, { upToMMbbl: 100, governmentPct: 10 }, { upToMMbbl: 350, governmentPct: 15 },
            { upToMMbbl: 750, governmentPct: 25 }, { upToMMbbl: 1500, governmentPct: 35 }, { upToMMbbl: null, governmentPct: 45 },
          ] },
        },
      },
      {
        name: "Ghana - Deepwater",
        description: "Typical terms for a deepwater block in Ghana, featuring royalty and additional oil entitlement.",
        regime: {
          royalty: { type: 'flat', rate: 5 },
          tax: { cit: 35, rrt: 0, minTax: 0 },
          costRecoveryLimit: 90,
          profitSplit: { type: 'tiered_r_factor', tiers: [{ threshold: 1.0, split: 70 }, { threshold: 1.25, split: 50 }, { threshold: 2.0, split: 35 }] },
        },
      },
      {
        name: "Brazil - Concession",
        description: "Standard concession agreement with special participation tax (windfall tax).",
        regime: {
          royalty: { type: 'flat', rate: 10 },
          tax: { cit: 34, rrt: 40, minTax: 0 }, // RRT represents Special Participation
          costRecoveryLimit: 100,
          profitSplit: { type: 'flat', split: 100 },
        },
      },
      {
        name: "USA - Gulf of Mexico",
        description: "Federal deepwater lease terms for the Gulf of Mexico.",
        regime: {
          royalty: { type: 'flat', rate: 18.75 },
          tax: { cit: 21, rrt: 0, minTax: 0 },
          costRecoveryLimit: 100,
          profitSplit: { type: 'flat', split: 100 },
        },
      },
      {
        name: "Angola - Deepwater PSC",
        description: "Production Sharing Contract for deepwater blocks in Angola.",
        regime: {
          royalty: { type: 'flat', rate: 0 }, // Royalty is often zero, embedded in profit oil
          tax: { cit: 25, rrt: 50, minTax: 0 }, // RRT represents Petroleum Production Tax
          costRecoveryLimit: 50,
          profitSplit: { type: 'tiered_r_factor', tiers: [{ threshold: 1.0, split: 70 }, { threshold: 1.5, split: 50 }, { threshold: 2.0, split: 30 }] },
        },
      },
      {
        name: "Generic Royalty/Tax",
        description: "A simple, generic concessionary system with a flat royalty and corporate income tax.",
        regime: {
          royalty: { type: 'flat', rate: 12.5 },
          tax: { cit: 30, rrt: 0, minTax: 0 },
          costRecoveryLimit: 100,
          profitSplit: { type: 'flat', split: 100 },
        },
      },
    ];

/** The pre-audit "Nigeria - PIA (2021)" template (engines 3.11.0), kept only to reproduce past comparisons. */
export const LEGACY_PRE_AUDIT_PIA_TEMPLATE = Object.freeze({
  name: "Nigeria - PIA (2021), pre-audit",
  description: "Pre-audit sandbox template (engines 3.11.0). Its royalty tiers, 80% cost recovery and R-factor splits are not PIA 2021 values (tools/validation/economics/AUDIT-PIA-2021.md rows S01-S03).",
  regime: {
    royalty: { type: 'sliding_price', tiers: [{ threshold: 0, rate: 7.5 }, { threshold: 50, rate: 10 }] },
    tax: { cit: 30, rrt: 0, minTax: 0 },
    costRecoveryLimit: 80,
    profitSplit: { type: 'tiered_r_factor', tiers: [{ threshold: 1.0, split: 60 }, { threshold: 1.6, split: 40 }, { threshold: 2.5, split: 30 }] },
  },
});
