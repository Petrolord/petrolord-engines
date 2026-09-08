/**
 * Fiscal regime templates for the regime sandbox in ./fiscalRegime.js
 * (Economics, extracted VERBATIM from the Suite's src/utils/fiscalTemplates.js
 * in the EC0 extraction wave, 2026-09-08). No imports, no edits. Templates
 * carry no `id`; the Suite assigns one when a template is loaded into a
 * comparison, and the fiscal goldens use the slug of the name.
 */
export const fiscalTemplates = [
      {
        name: "Nigeria - PIA (2021)",
        description: "Deepwater Production Sharing Contract under the Petroleum Industry Act.",
        regime: {
          royalty: { type: 'sliding_price', tiers: [{ threshold: 0, rate: 7.5 }, { threshold: 50, rate: 10 }] },
          tax: { cit: 30, rrt: 0, minTax: 0 },
          costRecoveryLimit: 80,
          profitSplit: { type: 'tiered_r_factor', tiers: [{ threshold: 1.0, split: 60 }, { threshold: 1.6, split: 40 }, { threshold: 2.5, split: 30 }] },
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
