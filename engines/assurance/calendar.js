/**
 * engines/assurance/calendar.js: calendar dates for the Assurance rules.
 *
 * Every Assurance rule that falls due does so on a CALENDAR DATE (a
 * review date, a permit expiry, a due date), stored as a Postgres `date`
 * and read as `YYYY-MM-DD`. The rule for such a value is the one AS3
 * found the hard way: `new Date('2026-09-17')` is UTC midnight, which is
 * 16 September for every user west of Greenwich, so a permit expiring
 * today read as expired yesterday. A calendar date is therefore parsed at
 * LOCAL midnight, and "today" is taken at local midnight too, so a whole
 * number of days separates any two of them in every time zone.
 *
 * Extracted at AS12 from the Suite, where five modules (complianceStatus,
 * documentControl, peerReview, managementOfChange, qualityAssurance) each
 * carried a byte-identical copy of these five definitions. One copy now.
 *
 * Deliberately NOT lib/dates: that is the date-fns subset the Economics
 * engines use, where a bare ISO date string is also local but where
 * differenceInDays truncates partial days. These helpers round over whole
 * local days, which is exact across a daylight saving change (a 23 or 25
 * hour day rounds to one day).
 */

export const MS_PER_DAY = 86400000;

/**
 * A calendar date at local midnight, from a Date or a string beginning
 * YYYY-MM-DD. Anything else, including an out-of-range date string's
 * Invalid Date, is null: an unreadable date is no date, never today.
 */
export const parseDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const da = Number(m[3]);
  // setFullYear, because the Date constructor reads a year below 100 as
  // 19xx (CAL-2), and a round-trip check, because the constructor rolls
  // an impossible day or month over into a real date: 2026-02-30 became
  // 2 March and 2026-13-01 became 1 January 2027 (CAL-1, AS12 oracle).
  const d = new Date(2000, 0, 1);
  d.setFullYear(y, mo, da);
  d.setHours(0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
  return d;
};

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole days from today to the date: negative when it has passed, null when there is none. */
export const daysUntil = (date, today = new Date()) => {
  const target = parseDateOnly(date);
  if (!target) return null;
  return Math.round((target - startOfDay(today)) / MS_PER_DAY);
};

/** YYYY-MM-DD for a local calendar date, or null. */
export const toDateOnlyString = (date) => {
  const d = parseDateOnly(date);
  if (!d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  // Four-digit year always (CAL-2): '0100-01-01' printed as '100-01-01'.
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
