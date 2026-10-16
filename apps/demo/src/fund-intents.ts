/**
 * Deterministic reading of plain chat instructions ("book a flight from Delhi
 * to Goa on Dec 1 to Dec 5 for 3 people", "find a gift for a coffee lover
 * under $40") into search requests, before and without any model. It only
 * ever produces searches (no money moves); anything it cannot pin down
 * exactly becomes a clarifying question instead of a guess, and anything that
 * is not an instruction is left to the model.
 *
 * Dates resolve against `today` (YYYY-MM-DD in the assistant's stated time
 * zone). Month/day without a year means the next such day after today;
 * numeric dates are only read when unambiguous (13/12 or 12/13), otherwise we
 * ask which one was meant.
 */

export type Cabin = 'economy' | 'premium_economy' | 'business' | 'first';

export type FlightRequest = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  travelers: number;
  originLabel: string | null;
  destinationLabel: string | null;
  cabin: Cabin | null;
};

export type GiftRequest = { query: string; maxPrice: string };

export type ParsedInstruction =
  | { kind: 'NONE' }
  | { kind: 'CLARIFY'; topic: 'FLIGHT' | 'GIFT'; question: string }
  | { kind: 'FLIGHT'; request: FlightRequest }
  | { kind: 'GIFT'; request: GiftRequest; budgetDefaulted: boolean };

export const MAX_TRAVELERS = 4;
export const DEFAULT_GIFT_BUDGET = '50';
/** Duffel takes offer requests up to about a year out. */
const MAX_DAYS_AHEAD = 360;

/**
 * Vetted city → main airport table. Multi-airport cities map to their main
 * international airport. Ambiguous English words that are also cities
 * (Nice, Split, Male, Reading…) are deliberately left out.
 */
const AIRPORTS: [code: string, label: string, aliases: string[]][] = [
  // India
  ['DEL', 'Delhi', ['delhi', 'new delhi']],
  ['BOM', 'Mumbai', ['mumbai', 'bombay']],
  ['BLR', 'Bengaluru', ['bangalore', 'bengaluru', 'bengalooru']],
  ['GOI', 'Goa', ['goa', 'dabolim']],
  ['MAA', 'Chennai', ['chennai', 'madras']],
  ['CCU', 'Kolkata', ['kolkata', 'calcutta']],
  ['HYD', 'Hyderabad', ['hyderabad']],
  ['PNQ', 'Pune', ['pune', 'poona']],
  ['JAI', 'Jaipur', ['jaipur']],
  ['COK', 'Kochi', ['kochi', 'cochin']],
  ['AMD', 'Ahmedabad', ['ahmedabad']],
  ['LKO', 'Lucknow', ['lucknow']],
  ['IXC', 'Chandigarh', ['chandigarh']],
  ['ATQ', 'Amritsar', ['amritsar']],
  ['VNS', 'Varanasi', ['varanasi', 'banaras', 'benares']],
  ['SXR', 'Srinagar', ['srinagar']],
  ['IXL', 'Leh', ['leh', 'ladakh']],
  ['GAU', 'Guwahati', ['guwahati']],
  ['BBI', 'Bhubaneswar', ['bhubaneswar']],
  ['PAT', 'Patna', ['patna']],
  ['IDR', 'Indore', ['indore']],
  ['NAG', 'Nagpur', ['nagpur']],
  ['CJB', 'Coimbatore', ['coimbatore']],
  ['IXM', 'Madurai', ['madurai']],
  ['IXE', 'Mangaluru', ['mangalore', 'mangaluru']],
  ['UDR', 'Udaipur', ['udaipur']],
  ['IXZ', 'Port Blair', ['port blair', 'andaman', 'andamans']],
  ['VTZ', 'Visakhapatnam', ['visakhapatnam', 'vizag']],
  ['TRV', 'Thiruvananthapuram', ['thiruvananthapuram', 'trivandrum']],
  ['IXB', 'Bagdogra', ['bagdogra', 'siliguri', 'darjeeling']],
  ['DED', 'Dehradun', ['dehradun']],
  ['BHO', 'Bhopal', ['bhopal']],
  ['BDQ', 'Vadodara', ['vadodara', 'baroda']],
  ['STV', 'Surat', ['surat']],
  ['RPR', 'Raipur', ['raipur']],
  ['IXR', 'Ranchi', ['ranchi']],
  // Rest of the world
  ['LHR', 'London', ['london', 'heathrow']],
  ['CDG', 'Paris', ['paris']],
  ['JFK', 'New York', ['new york', 'new york city', 'nyc']],
  ['DXB', 'Dubai', ['dubai']],
  ['AUH', 'Abu Dhabi', ['abu dhabi']],
  ['DOH', 'Doha', ['doha']],
  ['SIN', 'Singapore', ['singapore']],
  ['BKK', 'Bangkok', ['bangkok']],
  ['HKT', 'Phuket', ['phuket']],
  ['KUL', 'Kuala Lumpur', ['kuala lumpur']],
  ['DPS', 'Bali', ['bali', 'denpasar']],
  ['CGK', 'Jakarta', ['jakarta']],
  ['HND', 'Tokyo', ['tokyo']],
  ['KIX', 'Osaka', ['osaka']],
  ['ICN', 'Seoul', ['seoul']],
  ['HKG', 'Hong Kong', ['hong kong']],
  ['PVG', 'Shanghai', ['shanghai']],
  ['PEK', 'Beijing', ['beijing']],
  ['TPE', 'Taipei', ['taipei']],
  ['MNL', 'Manila', ['manila']],
  ['HAN', 'Hanoi', ['hanoi']],
  ['SGN', 'Ho Chi Minh City', ['ho chi minh city', 'saigon']],
  ['SYD', 'Sydney', ['sydney']],
  ['MEL', 'Melbourne', ['melbourne']],
  ['AKL', 'Auckland', ['auckland']],
  ['SFO', 'San Francisco', ['san francisco', 'sf']],
  ['LAX', 'Los Angeles', ['los angeles', 'la']],
  ['ORD', 'Chicago', ['chicago']],
  ['BOS', 'Boston', ['boston']],
  ['SEA', 'Seattle', ['seattle']],
  ['IAD', 'Washington', ['washington dc', 'washington d.c.']],
  ['MIA', 'Miami', ['miami']],
  ['LAS', 'Las Vegas', ['las vegas', 'vegas']],
  ['MCO', 'Orlando', ['orlando']],
  ['HNL', 'Honolulu', ['honolulu']],
  ['DEN', 'Denver', ['denver']],
  ['DFW', 'Dallas', ['dallas']],
  ['IAH', 'Houston', ['houston']],
  ['ATL', 'Atlanta', ['atlanta']],
  ['YYZ', 'Toronto', ['toronto']],
  ['YVR', 'Vancouver', ['vancouver']],
  ['MEX', 'Mexico City', ['mexico city']],
  ['GRU', 'São Paulo', ['sao paulo', 'são paulo']],
  ['FRA', 'Frankfurt', ['frankfurt']],
  ['MUC', 'Munich', ['munich']],
  ['BER', 'Berlin', ['berlin']],
  ['AMS', 'Amsterdam', ['amsterdam']],
  ['MAD', 'Madrid', ['madrid']],
  ['BCN', 'Barcelona', ['barcelona']],
  ['LIS', 'Lisbon', ['lisbon', 'lisboa']],
  ['FCO', 'Rome', ['rome']],
  ['MXP', 'Milan', ['milan']],
  ['ZRH', 'Zurich', ['zurich']],
  ['VIE', 'Vienna', ['vienna']],
  ['PRG', 'Prague', ['prague']],
  ['CPH', 'Copenhagen', ['copenhagen']],
  ['ARN', 'Stockholm', ['stockholm']],
  ['DUB', 'Dublin', ['dublin']],
  ['EDI', 'Edinburgh', ['edinburgh']],
  ['MAN', 'Manchester', ['manchester']],
  ['ATH', 'Athens', ['athens']],
  ['IST', 'Istanbul', ['istanbul']],
  ['CAI', 'Cairo', ['cairo']],
  ['NBO', 'Nairobi', ['nairobi']],
  ['JNB', 'Johannesburg', ['johannesburg']],
  ['CPT', 'Cape Town', ['cape town']],
  ['KTM', 'Kathmandu', ['kathmandu']],
  ['CMB', 'Colombo', ['colombo', 'sri lanka']],
  ['MLE', 'Malé', ['maldives']],
  ['DAC', 'Dhaka', ['dhaka']],
];

const BY_CODE = new Map(AIRPORTS.map(([code, label]) => [code, label]));
const BY_NAME = new Map<string, string>();
for (const [code, , aliases] of AIRPORTS)
  for (const a of aliases) BY_NAME.set(a, code);
/** Longest names first so "new york city" beats "new york". */
const NAMES = [...BY_NAME.keys()].sort((a, b) => b.length - a.length);

/** City label for a known airport code; null for codes outside the table. */
export const airportLabel = (code: string): string | null =>
  BY_CODE.get(code) ?? null;
export const isKnownAirport = (code: string) => BY_CODE.has(code);
export const AIRPORT_CODES: readonly string[] = [...BY_CODE.keys()];

// ---------------------------------------------------------------- dates

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const MONTH_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const ORD = '(?:st|nd|rd|th)?';
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNumber = (s: string) => NUMBER_WORDS[s] ?? Number(s);

const monthIndex = (m: string) => MONTHS.indexOf(m.slice(0, 3));
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parts = (day: string) =>
  day.split('-').map(Number) as [number, number, number];
const utc = (day: string) => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d));
};
export const addDays = (day: string, n: number) =>
  new Date(utc(day).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (day: string) => utc(day).getUTCDay();
const validDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m, d));
  return (
    d >= 1 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m &&
    date.getUTCDate() === d
  );
};
/** Next calendar day with this month/day on or after `from` (or null for Feb 30). */
function nextMonthDay(from: string, m: number, d: number): string | null {
  const [y] = parts(from);
  for (const year of [y, y + 1, y + 2, y + 3, y + 4])
    if (validDay(year, m, d) && iso(year, m, d) >= from) return iso(year, m, d);
  return null;
}
/** Day-of-month only ("the 5th"): this month if still ahead of `after`, else next. */
function nextDayOfMonth(after: string, d: number): string | null {
  let [y, m] = parts(after);
  m -= 1;
  for (let i = 0; i < 3; i++) {
    if (validDay(y, m, d) && iso(y, m, d) > after) return iso(y, m, d);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return null;
}

/** Today's calendar day in a time zone, e.g. todayIn('Asia/Kolkata', now). */
export function todayIn(timeZone: string, nowSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowSeconds * 1000));
}

type DateMention = {
  start: number;
  end: number;
  /** Resolved day, or null when it needs `anchor` (return legs resolve after departure). */
  resolve: (anchor: string) => string | null;
  /** Second day of a range ("1–5 Dec", "Dec 1 to 5"). */
  rangeEnd?: (departure: string) => string | null;
  ambiguous?: string;
  weekend?: boolean;
};

function findDates(text: string, today: string): DateMention[] {
  const found: DateMention[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) =>
    taken.every(([a, b]) => e <= a || s >= b);
  const add = (
    re: RegExp,
    make: (m: RegExpExecArray) => DateMention | null,
  ) => {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const mention = make(m as RegExpExecArray);
      if (!mention) continue;
      taken.push([start, end]);
      found.push({ ...mention, start, end });
    }
  };
  const notCount =
    '(?!\\s*(?:people|persons|adults|travell?ers|passengers|pax|of us|guests|friends|seats|tickets|nights?|days?|weeks?))';
  const at = { start: 0, end: 0 };

  // 2026-12-01
  add(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const day = validDay(y, mo, d) ? iso(y, mo, d) : null;
    return { ...at, resolve: () => day };
  });
  // 1-5 dec, 1st to 5th of december
  add(
    new RegExp(
      `\\b(\\d{1,2})${ORD}\\s*(?:-|to|until|till)\\s*(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s*(\\d{4}))?`,
      'g',
    ),
    (m) => {
      const mo = monthIndex(m[3]!);
      const year = m[4] ? Number(m[4]) : null;
      const d1 = Number(m[1]);
      const d2 = Number(m[2]);
      const dep = (from: string) =>
        year
          ? validDay(year, mo, d1)
            ? iso(year, mo, d1)
            : null
          : nextMonthDay(from, mo, d1);
      return {
        ...at,
        resolve: dep,
        rangeEnd: (departure) => nextMonthDay(departure, mo, d2),
      };
    },
  );
  // dec 1-5, december 1 to 5
  add(
    new RegExp(
      `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})${ORD}\\s*(?:-|to|until|till)\\s*(\\d{1,2})${ORD}\\b${notCount}(?!\\s*(?:${MONTH_RE}))`,
      'g',
    ),
    (m) => {
      const mo = monthIndex(m[1]!);
      const d1 = Number(m[2]);
      const d2 = Number(m[3]);
      return {
        ...at,
        resolve: (from) => nextMonthDay(from, mo, d1),
        rangeEnd: (departure) => nextMonthDay(departure, mo, d2),
      };
    },
  );
  // dec 1, december 1st 2026
  add(
    new RegExp(
      `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})${ORD}\\b${notCount}(?:,?\\s*(\\d{4}))?`,
      'g',
    ),
    (m) => {
      const mo = monthIndex(m[1]!);
      const d = Number(m[2]);
      const year = m[3] ? Number(m[3]) : null;
      return {
        ...at,
        resolve: (from) =>
          year
            ? validDay(year, mo, d)
              ? iso(year, mo, d)
              : null
            : nextMonthDay(from, mo, d),
      };
    },
  );
  // 1 dec, 1st of december, the 1st of dec 2026
  add(
    new RegExp(
      `\\b(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:,?\\s*(\\d{4}))?`,
      'g',
    ),
    (m) => {
      const mo = monthIndex(m[2]!);
      const d = Number(m[1]);
      const year = m[3] ? Number(m[3]) : null;
      return {
        ...at,
        resolve: (from) =>
          year
            ? validDay(year, mo, d)
              ? iso(year, mo, d)
              : null
            : nextMonthDay(from, mo, d),
      };
    },
  );
  // 12/01, 13/12/2026: only when day and month cannot be swapped
  add(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\b/g, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3]
      ? m[3].length === 2
        ? 2000 + Number(m[3])
        : Number(m[3])
      : null;
    let d: number;
    let mo: number;
    if (a > 12 && b <= 12) [d, mo] = [a, b - 1];
    else if (b > 12 && a <= 12) [d, mo] = [b, a - 1];
    else if (a === b && a <= 12) [d, mo] = [a, a - 1];
    else if (a <= 12 && b <= 12)
      return {
        ...at,
        resolve: () => null,
        ambiguous: `Is ${m[0]} the ${a} ${MONTH_LABEL[b - 1]} or the ${b} ${MONTH_LABEL[a - 1]}? Write it like "${b} ${MONTH_LABEL[a - 1]}" so I get it right.`,
      };
    else return null;
    return {
      ...at,
      resolve: (from) =>
        year
          ? validDay(year, mo, d)
            ? iso(year, mo, d)
            : null
          : nextMonthDay(from, mo, d),
    };
  });
  add(/\bday after tomorrow\b/g, () => ({
    ...at,
    resolve: () => addDays(today, 2),
  }));
  add(/\btomorrow\b/g, () => ({ ...at, resolve: () => addDays(today, 1) }));
  add(/\btoday\b|\btonight\b/g, () => ({ ...at, resolve: () => today }));
  add(/\b(this|next|coming)\s+weekend\b/g, (m) => {
    const dow = weekday(today);
    // This weekend: the coming Saturday (Sunday when asked on a Saturday).
    let sat = addDays(today, (6 - dow + 7) % 7 || 7);
    if (m[1] !== 'next' && dow === 6) sat = addDays(today, 1);
    if (m[1] === 'next' && dow !== 0 && dow !== 6) sat = addDays(sat, 7);
    return { ...at, resolve: () => sat, weekend: true };
  });
  add(
    new RegExp(`\\b(?:(this|next|coming)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'g'),
    (m) => {
      const target = WEEKDAYS.indexOf(m[2]!);
      // The first such weekday after today ("next Friday" included); the
      // reply always states the resolved date.
      const ahead = (target - weekday(today) + 7) % 7 || 7;
      return { ...at, resolve: () => addDays(today, ahead) };
    },
  );
  add(new RegExp(`\\bin\\s+${NUM}\\s+(days?|weeks?)\\b`, 'g'), (m) => {
    const n = toNumber(m[1]!) * (m[2]!.startsWith('week') ? 7 : 1);
    return { ...at, resolve: () => addDays(today, n) };
  });
  // the 5th, on the 20th (day of month only)
  add(
    /\b(?:the\s+)(\d{1,2})(?:st|nd|rd|th)\b|\b(\d{1,2})(?:st|nd|rd|th)\b/g,
    (m) => {
      const d = Number(m[1] ?? m[2]);
      return { ...at, resolve: (after) => nextDayOfMonth(after, d) };
    },
  );
  return found.sort((a, b) => a.start - b.start);
}

const MONTH_LABEL = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// ---------------------------------------------------------------- places

type Place = { start: number; end: number; code: string; label: string | null };

const ORIGIN_CUE = /(?:\bfrom|\bleaving|\bdeparting|\bout of)\s*$/;
const DEST_CUE = /(?:\bto|\binto|\btowards|\bfor|->|→)\s*$/;
const BACK_CUE = /(?:\bback to|\breturn(?:ing)? to|\bhome to)\s*$/;

function findPlaces(text: string, original: string): Place[] {
  const places: Place[] = [];
  const free = (s: number, e: number) =>
    places.every((p) => e <= p.start || s >= p.end);
  for (const name of NAMES) {
    const re = new RegExp(
      `(?<![a-z0-9])${name.replace(/[.]/g, '\\.')}(?![a-z0-9])`,
      'g',
    );
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      if (!free(m.index, end)) continue;
      // "la"/"sf" only count as places right after a from/to cue.
      if (
        name.length <= 2 &&
        !(
          ORIGIN_CUE.test(text.slice(0, m.index)) ||
          DEST_CUE.test(text.slice(0, m.index))
        )
      )
        continue;
      const code = BY_NAME.get(name)!;
      places.push({ start: m.index, end, code, label: BY_CODE.get(code)! });
    }
  }
  for (const m of text.matchAll(/(?<![a-z0-9])([a-z]{3})(?![a-z0-9])/g)) {
    const end = m.index + 3;
    if (!free(m.index, end)) continue;
    const code = m[1]!.toUpperCase();
    const upper = original.slice(m.index, end) === code;
    const before = text.slice(0, m.index);
    const after = text.slice(end);
    const cued =
      ORIGIN_CUE.test(before) ||
      /(?:\bto|->|→|-)\s*$/.test(before) ||
      /^\s*(?:-|->|→|to)\s*[a-z]{3}(?![a-z])/.test(after);
    // Known codes count when cued ("del to goi") or typed in capitals; an
    // unknown code only when typed in capitals and cued ("from OPO to LIS").
    if (BY_CODE.has(code) ? cued || upper : upper && cued)
      places.push({
        start: m.index,
        end,
        code,
        label: BY_CODE.get(code) ?? null,
      });
  }
  return places.sort((a, b) => a.start - b.start);
}

const NOT_A_PLACE = new Set([
  'book',
  'fly',
  'go',
  'get',
  'find',
  'search',
  'see',
  'travel',
  'the',
  'a',
  'an',
  'me',
  'us',
  'buy',
  'pay',
  'be',
  'have',
  'take',
  'visit',
  'check',
  'do',
  'look',
  'return',
  'come',
  'leave',
  'depart',
  'and',
  'back',
  'home',
  'there',
  'somewhere',
  'anywhere',
  'today',
  'tomorrow',
  'next',
  'this',
  'my',
  'our',
  'all',
  ...MONTHS,
  ...WEEKDAYS,
]);

/** The word(s) after a cue when they are not a place we know. */
function unknownAfter(text: string, cue: RegExp): string | null {
  for (const m of text.matchAll(cue)) {
    const words: string[] = [];
    for (const w of m[1]!.split(/[\s,]+/)) {
      if (!w || NOT_A_PLACE.has(w) || STOP.has(w) || /\d/.test(w)) break;
      words.push(w);
      if (words.length === 3) break;
    }
    if (words.length) return words.join(' ');
  }
  return null;
}
const STOP = new Set([
  'to',
  'on',
  'for',
  'in',
  'at',
  'by',
  'with',
  'from',
  'leaving',
  'returning',
  'one',
  'round',
  'please',
  'flight',
  'flights',
]);

// ---------------------------------------------------------------- travellers & cabin

function findTravelers(text: string): number | null {
  const people =
    '(?:people|persons|adults|travell?ers|passengers|pax|guests|seats|tickets|of us)';
  const rules: [RegExp, (m: RegExpMatchArray) => number][] = [
    [/\b(?:just me|only me|myself|solo|on my own|by myself)\b/, () => 1],
    [
      new RegExp(
        `\\b(?:me|i)\\s+(?:and|plus|\\+|with)\\s+${NUM}\\s+(?:friends?|others?|people|more|colleagues|kids|of my friends)\\b`,
      ),
      (m) => toNumber(m[1]!) + 1,
    ],
    [
      new RegExp(
        `\\bwith\\s+${NUM}\\s+(?:friends?|others?|people|colleagues|kids)\\b`,
      ),
      (m) => toNumber(m[1]!) + 1,
    ],
    [
      new RegExp(`\\b(?:the\\s+)?${NUM}\\s+of\\s+us\\b`),
      (m) => toNumber(m[1]!),
    ],
    [new RegExp(`\\bfamily of\\s+${NUM}\\b`), (m) => toNumber(m[1]!)],
    [new RegExp(`\\b${NUM}\\s+${people}\\b`), (m) => toNumber(m[1]!)],
    [
      new RegExp(
        `\\b(?:for|x)\\s+${NUM}\\b(?!\\s*(?:nights?|days?|weeks?|hours?|am|pm|:|\\.\\d|/|st|nd|rd|th|${MONTH_RE}))`,
      ),
      (m) => toNumber(m[1]!),
    ],
    [/\b(?:me|i)\s+(?:and|&|with)\s+(?:my\s+)?[a-z]+\b/, () => 2],
    [/\b(?:both of us|the two of us|us two|a couple)\b/, () => 2],
  ];
  for (const [re, count] of rules) {
    const m = text.match(re);
    if (m) return count(m);
  }
  return null;
}

function findCabin(text: string): Cabin | null {
  if (/\bpremium economy\b/.test(text)) return 'premium_economy';
  if (
    /\b(?:business|biz)\s*class\b|\b(?:fly(?:ing)?|in)\s+business\b/.test(text)
  )
    return 'business';
  if (/\bfirst\s*class\b|\b(?:fly(?:ing)?|in)\s+first\b/.test(text))
    return 'first';
  if (/\b(?:economy|coach)\b/.test(text)) return 'economy';
  return null;
}

// ---------------------------------------------------------------- intents

const QUESTION =
  /^(?:how|what|why|when|which|who|where|is|are|was|were|did|do|does|should|could|would|will|can we afford)\b/;
const ACT =
  /\b(?:book|find|search|look(?:ing)? for|get|show|need|want|wanna|fly|flying|check|pull up|buy|suggest|recommend|pick|grab|order)\b/;
const FLIGHT_WORD =
  /\b(?:flights?|fly|flying|airfares?|air fares?|plane tickets?|planes?|airline)\b/;
const TICKET_WORD = /\b(?:tickets?|fares?)\b/;
const GIFT_WORD = /\b(?:gifts?|presents?)\b/;

export function parseInstruction(
  input: string,
  options: { today: string; maxGiftPrice: number },
): ParsedInstruction {
  try {
    return parse(input, options);
  } catch {
    // Never let an odd phrasing break the chat; the model takes it instead.
    return { kind: 'NONE' };
  }
}

function parse(
  input: string,
  options: { today: string; maxGiftPrice: number },
): ParsedInstruction {
  const original = input
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const text = original.toLowerCase().replace(/[?!.]+$/, '');
  if (!text) return { kind: 'NONE' };
  const asks =
    QUESTION.test(text) && !/^(?:can|could|would|will) you\b/.test(text);
  const places = findPlaces(text, original);
  const flightWord =
    FLIGHT_WORD.test(text) ||
    (TICKET_WORD.test(text) && places.length > 0) ||
    (places.length >= 2 && findDates(text, options.today).length > 0);
  if (
    flightWord &&
    (ACT.test(text) || places.length > 0) &&
    !(asks && !/\b(?:book|find|search|show)\b/.test(text))
  )
    return flight(text, places, options.today);
  if (
    GIFT_WORD.test(text) &&
    (ACT.test(text) || /\bideas?\b/.test(text)) &&
    !(asks && !/\b(?:find|search|suggest|show)\b/.test(text))
  )
    return gift(text, options.maxGiftPrice);
  return { kind: 'NONE' };
}

const clarify = (
  topic: 'FLIGHT' | 'GIFT',
  question: string,
): ParsedInstruction => ({
  kind: 'CLARIFY',
  topic,
  question,
});

function flight(
  text: string,
  places: Place[],
  today: string,
): ParsedInstruction {
  // Roles from cues; "back to X" names the return leg and is skipped.
  let origin: Place | null = null;
  let destination: Place | null = null;
  const loose: Place[] = [];
  for (const p of places) {
    const before = text.slice(0, p.start);
    if (BACK_CUE.test(before)) continue;
    const role = ORIGIN_CUE.test(before)
      ? 'origin'
      : DEST_CUE.test(before) || /-\s*$/.test(before)
        ? 'destination'
        : null;
    if (role === 'origin') {
      if (origin && origin.code !== p.code)
        return clarify(
          'FLIGHT',
          'I can search one route at a time. Which city are you flying from?',
        );
      origin = p;
    } else if (role === 'destination') {
      if (destination && destination.code !== p.code)
        return clarify(
          'FLIGHT',
          'I can search one route at a time (no multi-city yet). Where do you want to fly to?',
        );
      destination = p;
    } else loose.push(p);
  }
  for (const p of loose) {
    if (!origin && (!destination || p.start < destination.start)) origin = p;
    else if (!destination) destination = p;
    else if (p.code !== origin?.code && p.code !== destination.code)
      return clarify(
        'FLIGHT',
        'I can search one route at a time (no multi-city yet). Which two cities?',
      );
  }
  if (!destination) {
    const unknown = unknownAfter(text, /\bto\s+([a-z][a-z', -]{1,40})/g);
    return clarify(
      'FLIGHT',
      unknown
        ? `I don't know an airport for "${unknown}" yet. What's the nearest big city or its 3-letter airport code?`
        : 'Where do you want to fly to?',
    );
  }
  if (!origin) {
    const unknown = unknownAfter(text, /\bfrom\s+([a-z][a-z', -]{1,40})/g);
    return clarify(
      'FLIGHT',
      unknown
        ? `I don't know an airport for "${unknown}" yet. What's the nearest big city or its 3-letter airport code?`
        : `Where are you flying to ${destination.label ?? destination.code} from?`,
    );
  }
  if (origin.code === destination.code)
    return clarify(
      'FLIGHT',
      'The departure and arrival city are the same. Where are you flying from?',
    );

  // Dates
  const dates = findDates(text, today);
  const ambiguous = dates.find((d) => d.ambiguous);
  if (ambiguous) return clarify('FLIGHT', ambiguous.ambiguous!);
  const oneWay = /\bone[ -]?way\b|\bsingle\b/.test(text);
  let wantsReturn =
    /\breturn(?:ing)?\b|\bround[ -]?trip\b|\band back\b|\bcom(?:e|ing) back\b|\bback (?:on|the|by)\b/.test(
      text,
    );
  const isReturnCue = (d: DateMention) =>
    /(?:\breturn(?:ing)?|\bback|\bcom(?:e|ing) back|\buntil|\btill)(?:\s+(?:on|the|by|home|to [a-z ]+?))*\s*$/.test(
      text.slice(Math.max(0, d.start - 40), d.start),
    );
  const outbound = dates.filter((d) => !isReturnCue(d));
  const inbound = dates.filter(isReturnCue);
  if (outbound.length === 0 && inbound.length) outbound.push(inbound.shift()!);
  const first = outbound[0];
  if (!first)
    return clarify(
      'FLIGHT',
      `What date do you want to fly ${origin.code} → ${destination.code}?`,
    );
  if (
    outbound.length > 2 ||
    inbound.length > 1 ||
    (outbound.length === 2 && (inbound.length || first.rangeEnd))
  )
    return clarify(
      'FLIGHT',
      'I found more dates than I can use. Which day do you leave, and when do you come back?',
    );
  const departureDate = first.resolve(today);
  if (!departureDate)
    return clarify(
      'FLIGHT',
      "That date doesn't exist on the calendar. Which day do you want to fly?",
    );
  if (departureDate <= today)
    return clarify(
      'FLIGHT',
      'Flights have to leave after today. Which day should I search?',
    );
  if (departureDate > addDays(today, MAX_DAYS_AHEAD))
    return clarify(
      'FLIGHT',
      'Airlines only sell about a year ahead. Pick a date within the next 12 months?',
    );
  let returnDate: string | null = null;
  const second = inbound[0] ?? outbound[1];
  if (first.rangeEnd) returnDate = first.rangeEnd(departureDate);
  else if (second) returnDate = second.resolve(departureDate);
  else {
    const stay = text.match(
      new RegExp(
        `\\bfor\\s+(a|an|${NUM.slice(1, -1)})\\s+(nights?|days?|weeks?)\\b`,
      ),
    );
    if (stay) {
      const n = /^an?$/.test(stay[1]!) ? 1 : toNumber(stay[1]!);
      returnDate = addDays(
        departureDate,
        n * (stay[2]!.startsWith('week') ? 7 : 1),
      );
    } else if (
      first.weekend &&
      weekday(departureDate) === 6 &&
      (wantsReturn || /\bfor the weekend\b/.test(text))
    )
      returnDate = addDays(departureDate, 1);
  }
  if ((first.rangeEnd || second) && !returnDate)
    return clarify(
      'FLIGHT',
      "The return date doesn't exist on the calendar. When are you coming back?",
    );
  if (returnDate) {
    if (oneWay)
      return clarify(
        'FLIGHT',
        'You said one way but also gave a return date. Should I search a return trip?',
      );
    if (returnDate <= departureDate)
      return clarify(
        'FLIGHT',
        'The return date has to be after the departure. When are you coming back?',
      );
    if (returnDate > addDays(departureDate, 180))
      return clarify(
        'FLIGHT',
        'That return date looks off: it has to be after the departure. When are you coming back?',
      );
    if (returnDate > addDays(today, MAX_DAYS_AHEAD))
      return clarify(
        'FLIGHT',
        'That return date is more than a year away. When are you coming back?',
      );
    wantsReturn = true;
  }
  if (wantsReturn && !returnDate)
    return clarify(
      'FLIGHT',
      `When are you coming back from ${destination.label ?? destination.code}?`,
    );

  const travelers = findTravelers(text) ?? 1;
  if (travelers < 1 || travelers > MAX_TRAVELERS)
    return clarify(
      'FLIGHT',
      `Test-mode flight search covers up to ${MAX_TRAVELERS} travellers. How many should I search for?`,
    );
  return {
    kind: 'FLIGHT',
    request: {
      origin: origin.code,
      destination: destination.code,
      departureDate,
      returnDate,
      travelers,
      originLabel: origin.label,
      destinationLabel: destination.label,
      cabin: findCabin(text),
    },
  };
}

function gift(text: string, maxGiftPrice: number): ParsedInstruction {
  if (
    /₹|\brs\.?\s*\d|\binr\b|\brupees?\b|€|£|\beur(?:os?)?\b|\bgbp\b/.test(text)
  )
    return clarify(
      'GIFT',
      'Gift budgets are in US dollars for now. What is the budget in USD?',
    );
  const price =
    /\b(?:under|below|less than|max(?:imum)?(?: of)?|up to|upto|within|budget(?: of| is)?|around|about|no more than|at most)\s*\$?\s*(\d{1,6}(?:\.\d{1,2})?)\s*(?:\$|usd|dollars?|bucks)?(?!\s*(?:years?|yrs?|yo|people|st|nd|rd|th))/.exec(
      text,
    ) ??
    /\$\s*(\d{1,6}(?:\.\d{1,2})?)\b|\b(\d{1,6}(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)\b/.exec(
      text,
    );
  const raw = price ? (price[1] ?? price[2])! : null;
  const maxPrice = raw
    ? raw.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
    : DEFAULT_GIFT_BUDGET;
  const value = Number(maxPrice);
  if (
    !/^\d{1,4}(\.\d{1,2})?$/.test(maxPrice) ||
    !(value >= 1 && value <= maxGiftPrice)
  )
    return clarify(
      'GIFT',
      `The fund can spend between $1 and $${maxGiftPrice} on a gift. What budget should I use?`,
    );
  let query = price ? text.replace(price[0], ' ') : text;
  query = query
    .replace(/^(?:hey |hi |ok |okay )?(?:synq,? )?/, '')
    .replace(
      /^(?:please |pls |can you |could you |would you |will you |i (?:want|need) (?:you )?to |let'?s |we (?:need|want) to )+/,
      '',
    )
    .replace(
      /^(?:find|get|buy|search(?: for)?|look(?:ing)? for|suggest|show(?: me| us)?|pick(?: out)?|grab|order|recommend)\b\s*/,
      '',
    )
    .replace(/^(?:me|us)\s+/, '')
    .replace(/\b(?:a|an|some|good|nice|great|cool)\b/g, ' ')
    .replace(/\b(?:please|pls|thanks|thank you)\b/g, ' ')
    .replace(/[^a-z0-9'&+ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const topic = query
    .replace(
      /\b(?:gifts?|presents?|ideas?|for|to|the|me|us|them|him|her|someone|somebody)\b/g,
      '',
    )
    .trim();
  if (!topic)
    return clarify(
      'GIFT',
      'Who\'s the gift for, or what are they into? (e.g. "a gift for a coffee lover under $40")',
    );
  return {
    kind: 'GIFT',
    request: { query: query.slice(0, 80).trim(), maxPrice },
    budgetDefaulted: !raw,
  };
}

// ---------------------------------------------------------------- replies

const short = (day: string) => {
  const [y, m, d] = parts(day);
  return { y, label: `${MONTH_LABEL[m - 1]} ${d}`, m };
};
export function describeDates(
  departure: string,
  ret: string | null,
  today: string,
): string {
  const a = short(departure);
  const [ty] = parts(today);
  const year = (s: { y: number }) => (s.y !== ty ? `, ${s.y}` : '');
  if (!ret) return `${a.label}${year(a)}, one way`;
  const b = short(ret);
  if (a.y === b.y && a.m === b.m)
    return `${a.label}–${parts(ret)[2]}${year(a)}`;
  return `${a.label}${a.y !== b.y ? year(a) : ''} – ${b.label}${year(b)}`;
}

const CABIN_LABEL: Record<Cabin, string> = {
  economy: 'economy',
  premium_economy: 'premium economy',
  business: 'business',
  first: 'first class',
};
export function flightReply(r: FlightRequest, today: string): string {
  const where = (code: string, label: string | null) =>
    label ? `${label} (${code})` : code;
  return [
    `Searching ${where(r.origin, r.originLabel)} → ${where(r.destination, r.destinationLabel)}`,
    describeDates(r.departureDate, r.returnDate, today),
    `${r.travelers} traveller${r.travelers === 1 ? '' : 's'}${r.cabin && r.cabin !== 'economy' ? `, ${CABIN_LABEL[r.cabin]}` : ''}…`,
  ].join(', ');
}
