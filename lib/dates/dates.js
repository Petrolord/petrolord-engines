/**
 * lib/dates/dates.js: the subset of date-fns 4.1.0 that the Economics
 * engines import, vendored so the engines package keeps ZERO runtime
 * dependencies (EC0 Economics extraction wave, 2026-09-08).
 *
 * WHAT IS HERE. `parseISO`, `isValid`, `differenceInDays`, `addDays` and
 * `format`, each ported from the Suite's node_modules/date-fns 4.1.0 source
 * with the `options` argument (`in` context, `additionalDigits`, locale)
 * removed, because no caller in this package passes one. The semantics kept:
 *
 *   parseISO          the full date-fns ISO 8601 grammar: calendar dates
 *                     (2020-01-05, 20200105, 2020-01, 2020), ordinal dates
 *                     (2020-100), ISO week dates (2020-W10-3), extended years
 *                     (+002020, six digits with a sign), times with a T or a
 *                     space delimiter, fractional seconds with a point or a
 *                     comma, 24:00:00, and Z or +hh:mm / +hhmm / +hh offsets.
 *                     A string without an offset is LOCAL time. Anything
 *                     the grammar rejects is Invalid Date; a non-string
 *                     throws TypeError, as date-fns does.
 *   isValid           false for a non-Date non-number and for a NaN time
 *                     value; a string is NOT valid (it is never converted).
 *   differenceInDays  the number of FULL local days, truncated toward zero:
 *                     the calendar-day difference, reduced by one when the
 *                     last day is not complete. Negative when the first
 *                     argument is earlier. NaN in, NaN out. The DST handling
 *                     is date-fns's own (calendar days are counted on UTC
 *                     midnights after removing each date's own offset), which
 *                     under the timezone assumption below is exact.
 *   addDays           local calendar arithmetic through Date.setDate, so a
 *                     fractional amount truncates toward zero; 0 is a no-op
 *                     copy; NaN gives Invalid Date.
 *   format            the light tokens only: y, M, d, h, H, m, s, S and a,
 *                     with quoted literals and the two-quote escape. Those
 *                     are the tokens the pinned format strings use. Any
 *                     other date-fns token (locale words such as MMM or EEE,
 *                     week and quarter tokens, the ordinal `o` suffix and the
 *                     long P / p forms) throws a RangeError naming it, rather
 *                     than silently formatting differently from date-fns. An
 *                     invalid date throws RangeError('Invalid time value')
 *                     and an unescaped Latin letter that is not a token
 *                     throws the date-fns message, exactly as date-fns does.
 *
 * NONE OF THE IN-SCOPE ENGINES CALLS `format` OR `addDays`: scheduleCalculations
 * imports them without using them, and costControlCalculations uses only
 * parseISO, isValid and differenceInDays. They are vendored so the import
 * lines stay verbatim and so a future caller has them.
 *
 * TIMEZONE ASSUMPTION. Every helper works in the process's local timezone,
 * as date-fns does. The pins in test-data/dates/date_fns_pins.json were
 * emitted by the real date-fns on a machine whose `date` reports UTC and
 * whose Intl.DateTimeFormat().resolvedOptions().timeZone is "UTC", and the
 * gate in __tests__/dates.test.js asserts that it runs under the same
 * timezone before comparing. Under a DST timezone the local-time helpers
 * (differenceInDays across a clock change, addDays into a missing hour)
 * would legitimately give different millisecond answers, and the gate says
 * so rather than failing on a number.
 */

const millisecondsInHour = 3600000;
const millisecondsInMinute = 60000;
const millisecondsInDay = 86400000;

/** True for a Date (including an Invalid Date), false for anything else. */
export function isDate(value) {
  return (
    value instanceof Date ||
    (typeof value === 'object' && Object.prototype.toString.call(value) === '[object Date]')
  );
}

/** A fresh Date built from the argument (a clone for a Date, a timestamp for a number). */
export function toDate(argument) {
  if (argument instanceof Date) return new argument.constructor(argument);
  return new Date(argument);
}

/** date-fns isValid: not a Date and not a number is false; NaN time is false. */
export function isValid(date) {
  return !((!isDate(date) && typeof date !== 'number') || isNaN(+toDate(date)));
}

// ---------------------------------------------------------------------------
// parseISO
// ---------------------------------------------------------------------------

const patterns = {
  dateTimeDelimiter: /[T ]/,
  timeZoneDelimiter: /[Z ]/i,
  timezone: /([Z+-].*)$/,
};

const dateRegex = /^-?(?:(\d{3})|(\d{2})(?:-?(\d{2}))?|W(\d{2})(?:-?(\d{1}))?|)$/;
const timeRegex = /^(\d{2}(?:[.,]\d*)?)(?::?(\d{2}(?:[.,]\d*)?))?(?::?(\d{2}(?:[.,]\d*)?))?$/;
const timezoneRegex = /^([+-])(\d{2})(?::?(\d{2}))?$/;

const ADDITIONAL_DIGITS = 2;

function splitDateString(dateString) {
  const dateStrings = {};
  const array = dateString.split(patterns.dateTimeDelimiter);
  let timeString;

  if (array.length > 2) {
    return dateStrings;
  }

  if (/:/.test(array[0])) {
    timeString = array[0];
  } else {
    dateStrings.date = array[0];
    timeString = array[1];
    if (patterns.timeZoneDelimiter.test(dateStrings.date)) {
      dateStrings.date = dateString.split(patterns.timeZoneDelimiter)[0];
      timeString = dateString.substr(dateStrings.date.length, dateString.length);
    }
  }

  if (timeString) {
    const token = patterns.timezone.exec(timeString);
    if (token) {
      dateStrings.time = timeString.replace(token[1], '');
      dateStrings.timezone = token[1];
    } else {
      dateStrings.time = timeString;
    }
  }

  return dateStrings;
}

function parseYear(dateString, additionalDigits) {
  const regex = new RegExp(
    '^(?:(\\d{4}|[+-]\\d{' + (4 + additionalDigits) + '})|(\\d{2}|[+-]\\d{' + (2 + additionalDigits) + '})$)',
  );

  const captures = dateString.match(regex);
  if (!captures) return { year: NaN, restDateString: '' };

  const year = captures[1] ? parseInt(captures[1]) : null;
  const century = captures[2] ? parseInt(captures[2]) : null;

  return {
    year: century === null ? year : century * 100,
    restDateString: dateString.slice((captures[1] || captures[2]).length),
  };
}

const daysInMonths = [31, null, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYearIndex(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function validateDate(year, month, date) {
  return (
    month >= 0 &&
    month <= 11 &&
    date >= 1 &&
    date <= (daysInMonths[month] || (isLeapYearIndex(year) ? 29 : 28))
  );
}

function validateDayOfYearDate(year, dayOfYear) {
  return dayOfYear >= 1 && dayOfYear <= (isLeapYearIndex(year) ? 366 : 365);
}

function validateWeekDate(_year, week, day) {
  return week >= 1 && week <= 53 && day >= 0 && day <= 6;
}

function validateTime(hours, minutes, seconds) {
  if (hours === 24) {
    return minutes === 0 && seconds === 0;
  }
  return seconds >= 0 && seconds < 60 && minutes >= 0 && minutes < 60 && hours >= 0 && hours < 25;
}

function validateTimezone(_hours, minutes) {
  return minutes >= 0 && minutes <= 59;
}

function parseDateUnit(value) {
  return value ? parseInt(value) : 1;
}

function dayOfISOWeekYear(isoWeekYear, week, day) {
  const date = new Date(0);
  date.setUTCFullYear(isoWeekYear, 0, 4);
  const fourthOfJanuaryDay = date.getUTCDay() || 7;
  const diff = (week - 1) * 7 + day + 1 - fourthOfJanuaryDay;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

function parseDate(dateString, year) {
  if (year === null) return new Date(NaN);

  const captures = dateString.match(dateRegex);
  if (!captures) return new Date(NaN);

  const isWeekDate = !!captures[4];
  const dayOfYear = parseDateUnit(captures[1]);
  const month = parseDateUnit(captures[2]) - 1;
  const day = parseDateUnit(captures[3]);
  const week = parseDateUnit(captures[4]);
  const dayOfWeek = parseDateUnit(captures[5]) - 1;

  if (isWeekDate) {
    if (!validateWeekDate(year, week, dayOfWeek)) {
      return new Date(NaN);
    }
    return dayOfISOWeekYear(year, week, dayOfWeek);
  }
  const date = new Date(0);
  if (!validateDate(year, month, day) || !validateDayOfYearDate(year, dayOfYear)) {
    return new Date(NaN);
  }
  date.setUTCFullYear(year, month, Math.max(dayOfYear, day));
  return date;
}

function parseTimeUnit(value) {
  return (value && parseFloat(value.replace(',', '.'))) || 0;
}

function parseTime(timeString) {
  const captures = timeString.match(timeRegex);
  if (!captures) return NaN;

  const hours = parseTimeUnit(captures[1]);
  const minutes = parseTimeUnit(captures[2]);
  const seconds = parseTimeUnit(captures[3]);

  if (!validateTime(hours, minutes, seconds)) {
    return NaN;
  }

  return hours * millisecondsInHour + minutes * millisecondsInMinute + seconds * 1000;
}

function parseTimezone(timezoneString) {
  if (timezoneString === 'Z') return 0;

  const captures = timezoneString.match(timezoneRegex);
  if (!captures) return 0;

  const sign = captures[1] === '+' ? -1 : 1;
  const hours = parseInt(captures[2]);
  const minutes = (captures[3] && parseInt(captures[3])) || 0;

  if (!validateTimezone(hours, minutes)) {
    return NaN;
  }

  return sign * (hours * millisecondsInHour + minutes * millisecondsInMinute);
}

/**
 * Parse an ISO 8601 string into a local Date. Invalid Date when the string
 * does not fit the grammar; TypeError when the argument is not a string.
 */
export function parseISO(argument) {
  const invalidDate = () => new Date(NaN);

  const dateStrings = splitDateString(argument);

  let date;
  if (dateStrings.date) {
    const parseYearResult = parseYear(dateStrings.date, ADDITIONAL_DIGITS);
    date = parseDate(parseYearResult.restDateString, parseYearResult.year);
  }

  if (!date || isNaN(+date)) return invalidDate();

  const timestamp = +date;
  let time = 0;
  let offset;

  if (dateStrings.time) {
    time = parseTime(dateStrings.time);
    if (isNaN(time)) return invalidDate();
  }

  if (dateStrings.timezone) {
    offset = parseTimezone(dateStrings.timezone);
    if (isNaN(offset)) return invalidDate();
  } else {
    const tmpDate = new Date(timestamp + time);
    const result = new Date(0);
    result.setFullYear(tmpDate.getUTCFullYear(), tmpDate.getUTCMonth(), tmpDate.getUTCDate());
    result.setHours(
      tmpDate.getUTCHours(),
      tmpDate.getUTCMinutes(),
      tmpDate.getUTCSeconds(),
      tmpDate.getUTCMilliseconds(),
    );
    return result;
  }

  return new Date(timestamp + time + offset);
}

// ---------------------------------------------------------------------------
// differenceInDays
// ---------------------------------------------------------------------------

/** Local midnight of the given date, as a new Date. */
export function startOfDay(date) {
  const _date = toDate(date);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

/**
 * The local offset in milliseconds, computed from the calendar fields so a
 * historical offset with seconds in it is honoured.
 */
function getTimezoneOffsetInMilliseconds(date) {
  const _date = toDate(date);
  const utcDate = new Date(
    Date.UTC(
      _date.getFullYear(),
      _date.getMonth(),
      _date.getDate(),
      _date.getHours(),
      _date.getMinutes(),
      _date.getSeconds(),
      _date.getMilliseconds(),
    ),
  );
  utcDate.setUTCFullYear(_date.getFullYear());
  return +date - +utcDate;
}

/** Calendar days between the two local dates, times removed, rounded. */
export function differenceInCalendarDays(laterDate, earlierDate) {
  const laterStartOfDay = startOfDay(toDate(laterDate));
  const earlierStartOfDay = startOfDay(toDate(earlierDate));

  const laterTimestamp = +laterStartOfDay - getTimezoneOffsetInMilliseconds(laterStartOfDay);
  const earlierTimestamp = +earlierStartOfDay - getTimezoneOffsetInMilliseconds(earlierStartOfDay);

  return Math.round((laterTimestamp - earlierTimestamp) / millisecondsInDay);
}

function compareLocalAsc(laterDate, earlierDate) {
  const diff =
    laterDate.getFullYear() - earlierDate.getFullYear() ||
    laterDate.getMonth() - earlierDate.getMonth() ||
    laterDate.getDate() - earlierDate.getDate() ||
    laterDate.getHours() - earlierDate.getHours() ||
    laterDate.getMinutes() - earlierDate.getMinutes() ||
    laterDate.getSeconds() - earlierDate.getSeconds() ||
    laterDate.getMilliseconds() - earlierDate.getMilliseconds();

  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return diff;
}

/**
 * Full local days between the dates, truncated toward zero; negative when
 * `laterDate` is the earlier one; NaN when either is invalid.
 */
export function differenceInDays(laterDate, earlierDate) {
  const laterDate_ = toDate(laterDate);
  const earlierDate_ = toDate(earlierDate);

  const sign = compareLocalAsc(laterDate_, earlierDate_);
  const difference = Math.abs(differenceInCalendarDays(laterDate_, earlierDate_));

  laterDate_.setDate(laterDate_.getDate() - sign * difference);

  const isLastDayNotFull = Number(compareLocalAsc(laterDate_, earlierDate_) === -sign);

  const result = sign * (difference - isLastDayNotFull);
  return result === 0 ? 0 : result;
}

// ---------------------------------------------------------------------------
// addDays
// ---------------------------------------------------------------------------

/** The date plus `amount` local calendar days (fractions truncate; NaN gives Invalid Date). */
export function addDays(date, amount) {
  const _date = toDate(date);
  if (isNaN(amount)) return new Date(NaN);

  if (!amount) return _date;

  _date.setDate(_date.getDate() + amount);
  return _date;
}

// ---------------------------------------------------------------------------
// format (light tokens only)
// ---------------------------------------------------------------------------

const formattingTokensRegExp = /[yYQqMLwIdDecihHKkms]o|(\w)\1*|''|'(''|[^'])+('|$)|./g;
const longFormattingTokensRegExp = /P+p+|P+|p+|''|'(''|[^'])+('|$)|./g;
const escapedStringRegExp = /^'([^]*?)'?$/;
const doubleQuoteRegExp = /''/g;
const unescapedLatinCharacterRegExp = /[a-zA-Z]/;

function addLeadingZeros(number, targetLength) {
  const sign = number < 0 ? '-' : '';
  const output = Math.abs(number).toString().padStart(targetLength, '0');
  return sign + output;
}

const lightFormatters = {
  y(date, token) {
    const signedYear = date.getFullYear();
    const year = signedYear > 0 ? signedYear : 1 - signedYear;
    return addLeadingZeros(token === 'yy' ? year % 100 : year, token.length);
  },
  M(date, token) {
    const month = date.getMonth();
    return token === 'M' ? String(month + 1) : addLeadingZeros(month + 1, 2);
  },
  d(date, token) {
    return addLeadingZeros(date.getDate(), token.length);
  },
  a(date, token) {
    const dayPeriodEnumValue = date.getHours() / 12 >= 1 ? 'pm' : 'am';
    switch (token) {
      case 'a':
      case 'aa':
        return dayPeriodEnumValue.toUpperCase();
      case 'aaa':
        return dayPeriodEnumValue;
      case 'aaaaa':
        return dayPeriodEnumValue[0];
      case 'aaaa':
      default:
        return dayPeriodEnumValue === 'am' ? 'a.m.' : 'p.m.';
    }
  },
  h(date, token) {
    return addLeadingZeros(date.getHours() % 12 || 12, token.length);
  },
  H(date, token) {
    return addLeadingZeros(date.getHours(), token.length);
  },
  m(date, token) {
    return addLeadingZeros(date.getMinutes(), token.length);
  },
  s(date, token) {
    return addLeadingZeros(date.getSeconds(), token.length);
  },
  S(date, token) {
    const numberOfDigits = token.length;
    const milliseconds = date.getMilliseconds();
    const fractionalSeconds = Math.trunc(milliseconds * Math.pow(10, numberOfDigits - 3));
    return addLeadingZeros(fractionalSeconds, token.length);
  },
};

/** Token letters date-fns formats that this vendored subset does not. */
const NOT_VENDORED = 'GYRuQqLwIDEecibBKkXxOztTPp';

const notVendored = (token) =>
  new RangeError(
    'date-fns format token `' + token + '` is not vendored in lib/dates/dates.js; only y, M, d, h, H, m, s, S and a are.',
  );

function cleanEscapedString(input) {
  const matched = input.match(escapedStringRegExp);
  if (!matched) {
    return input;
  }
  return matched[1].replace(doubleQuoteRegExp, "'");
}

/**
 * Format a date with the light tokens (y, M, d, h, H, m, s, S, a) and quoted
 * literals. Throws RangeError for an invalid date, for an unescaped Latin
 * letter that is no token, and for a date-fns token this subset does not
 * carry.
 */
export function format(date, formatStr) {
  const originalDate = toDate(date);

  if (!isValid(originalDate)) {
    throw new RangeError('Invalid time value');
  }

  const parts = formatStr
    .match(longFormattingTokensRegExp)
    .map((substring) => {
      const firstCharacter = substring[0];
      if (firstCharacter === 'p' || firstCharacter === 'P') {
        throw notVendored(substring);
      }
      return substring;
    })
    .join('')
    .match(formattingTokensRegExp)
    .map((substring) => {
      if (substring === "''") {
        return { isToken: false, value: "'" };
      }

      const firstCharacter = substring[0];
      if (firstCharacter === "'") {
        return { isToken: false, value: cleanEscapedString(substring) };
      }

      if (lightFormatters[firstCharacter]) {
        if (substring.length === 2 && substring[1] === 'o') throw notVendored(substring);
        if (firstCharacter === 'M' && substring.length > 2) throw notVendored(substring);
        return { isToken: true, value: substring };
      }

      if (NOT_VENDORED.includes(firstCharacter)) {
        throw notVendored(substring);
      }

      if (firstCharacter.match(unescapedLatinCharacterRegExp)) {
        throw new RangeError(
          'Format string contains an unescaped latin alphabet character `' + firstCharacter + '`',
        );
      }

      return { isToken: false, value: substring };
    });

  return parts
    .map((part) => {
      if (!part.isToken) return part.value;
      const token = part.value;
      return lightFormatters[token[0]](originalDate, token);
    })
    .join('');
}
