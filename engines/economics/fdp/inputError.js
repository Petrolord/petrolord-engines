/**
 * Shared refusal type and numeric guards for the FDP Accelerator engines (EC6-0).
 *
 * Added in the EC6 repair wave. Before it, every FDP module silently
 * substituted a default for a missing input: a concept with no capex was
 * priced at $100MM, a scenario with no oil price at $70/bbl, a concept with
 * no peak rate at 50 kbpd. The app never asked for those fields on the
 * screen that used them, so the substitution was invisible and the cards
 * showed a full set of economics for a plan that carried none of it. The
 * rule here is EC4's and EC5's: a missing figure is refused by name, a zero
 * a user actually typed is honoured.
 */

export class FdpInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FdpInputError';
  }
}

/** True for a value a user left blank: undefined, null, '' or whitespace. */
export const isBlank = (value) => value === undefined || value === null
  || (typeof value === 'string' && value.trim() === '');

/**
 * A required number. Blank is refused by field name, so is anything that
 * does not parse; 0 is a value, not a miss.
 *
 * @param {*} value
 * @param {string} field what to call it in the refusal
 * @returns {number}
 */
export const requireNumber = (value, field) => {
  if (isBlank(value)) throw new FdpInputError(`${field} is missing`);
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new FdpInputError(`${field} is not a number: ${String(value)}`);
  return n;
};

/** A required number that may not be negative. */
export const requireNonNegative = (value, field) => {
  const n = requireNumber(value, field);
  if (n < 0) throw new FdpInputError(`${field} may not be negative: ${n}`);
  return n;
};
