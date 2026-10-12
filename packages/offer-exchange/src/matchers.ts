import type {
  EconomicIntent,
  FlightSubject,
  ProductSubject,
  StaySubject,
  Subject,
} from './schemas.js';

export type MatchLevel =
  | 'EXACT_MATCH'
  | 'NEAR_EQUIVALENT'
  | 'SUBSTITUTE'
  | 'NOT_COMPARABLE';
export type MatchResult = {
  level: MatchLevel;
  basis: string;
  reasons: string[];
};
export type Substitution = EconomicIntent['autonomy']['substitution'];

const norm = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');

export function normalizeGtin(gtin: string): string {
  return gtin.padStart(14, '0');
}

export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    );
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

function relax(
  mismatches: string[],
  substitution: Substitution,
  basis: string,
): MatchResult {
  if (!mismatches.length) return { level: 'EXACT_MATCH', basis, reasons: [] };
  return substitution === 'NONE'
    ? { level: 'SUBSTITUTE', basis, reasons: mismatches }
    : { level: 'NEAR_EQUIVALENT', basis, reasons: mismatches };
}

/**
 * Identity priority (Bible §82): GTIN/UPC/EAN > ASIN (same marketplace) > MPN > brand+model > variant >
 * condition > seller > attributes. Fuzzy title similarity never establishes
 * identity on its own.
 */
export function matchProduct(
  want: ProductSubject,
  got: ProductSubject,
  substitution: Substitution,
): MatchResult {
  let basis: string;
  if (want.gtin && got.gtin) {
    if (normalizeGtin(want.gtin) !== normalizeGtin(got.gtin))
      return {
        level: 'NOT_COMPARABLE',
        basis: 'GTIN',
        reasons: ['GTIN differs'],
      };
    basis = 'GTIN';
  } else if (want.asin && got.asin) {
    if (want.asin !== got.asin)
      return {
        level: 'NOT_COMPARABLE',
        basis: 'ASIN',
        reasons: ['ASIN differs'],
      };
    basis = 'ASIN';
  } else if (want.mpn && got.mpn) {
    if (norm(want.mpn) !== norm(got.mpn))
      return {
        level: 'NOT_COMPARABLE',
        basis: 'MPN',
        reasons: ['MPN differs'],
      };
    if (want.brand && got.brand && norm(want.brand) !== norm(got.brand))
      return {
        level: 'NOT_COMPARABLE',
        basis: 'MPN',
        reasons: ['brand differs'],
      };
    basis = 'MPN';
  } else if (want.brand && got.brand && want.model && got.model) {
    if (
      norm(want.brand) !== norm(got.brand) ||
      norm(want.model) !== norm(got.model)
    )
      return {
        level: 'NOT_COMPARABLE',
        basis: 'BRAND_MODEL',
        reasons: ['brand/model differs'],
      };
    basis = 'BRAND_MODEL';
  } else {
    const sim = titleSimilarity(want.title, got.title);
    return sim >= 0.6
      ? {
          level: 'SUBSTITUTE',
          basis: 'TITLE_ONLY',
          reasons: [
            `no structured identity; title similarity ${sim.toFixed(2)} is supporting only`,
          ],
        }
      : {
          level: 'NOT_COMPARABLE',
          basis: 'TITLE_ONLY',
          reasons: ['no structured identity'],
        };
  }
  if (want.condition === 'NEW' && got.condition !== 'NEW')
    return {
      level: 'SUBSTITUTE',
      basis,
      reasons: [`${got.condition.toLowerCase()} never replaces new`],
    };
  if (want.condition !== got.condition && got.condition === 'USED')
    return { level: 'SUBSTITUTE', basis, reasons: ['used offered'] };
  const mismatches: string[] = [];
  for (const key of [
    'color',
    'storage',
    'size',
    'region',
    'revision',
    'warranty',
  ] as const) {
    const w = want.variant[key];
    const g = got.variant[key];
    if (w === undefined) continue;
    if (g === undefined) {
      if (basis !== 'GTIN') mismatches.push(`${key} unknown`);
    } else if (norm(w) !== norm(g)) mismatches.push(`${key} ${g} != ${w}`);
  }
  if (want.seller && got.seller && norm(want.seller) !== norm(got.seller))
    mismatches.push('seller differs');
  for (const [k, w] of Object.entries(want.attributes)) {
    const g = got.attributes[k];
    if (g === undefined || norm(g) !== norm(w))
      mismatches.push(`attribute ${k} differs`);
  }
  return relax(mismatches, substitution, basis);
}

export function matchStay(
  want: StaySubject,
  got: StaySubject,
  substitution: Substitution,
): MatchResult {
  const anyProperty =
    want.propertyId === undefined &&
    want.propertyName === undefined &&
    Object.keys(want.providerPropertyIds).length === 0;
  const sameProperty = !anyProperty && resolveProperty(want, got).same;
  if (!sameProperty && !anyProperty)
    return {
      level: 'NOT_COMPARABLE',
      basis: 'PROPERTY',
      reasons: ['different property'],
    };
  const hard: string[] = [];
  if (got.checkIn !== want.checkIn || got.checkOut !== want.checkOut)
    hard.push('dates differ');
  if (got.rooms < want.rooms) hard.push('fewer rooms');
  if (got.adults < want.adults || got.children < want.children)
    hard.push('occupancy below request');
  if (want.refundable === true && got.refundable !== true)
    hard.push('not refundable');
  if (hard.length)
    return { level: 'NOT_COMPARABLE', basis: 'PROPERTY', reasons: hard };
  const soft: string[] = [];
  if (want.roomCategory && norm(want.roomCategory) !== norm(got.roomCategory))
    soft.push('room category differs');
  if (want.beds && norm(want.beds) !== norm(got.beds)) soft.push('beds differ');
  if (want.mealPlan && want.mealPlan !== got.mealPlan)
    soft.push('meal plan differs');
  return relax(soft, substitution, anyProperty ? 'AREA' : 'PROPERTY');
}

export function matchFlight(
  want: FlightSubject,
  got: FlightSubject,
  substitution: Substitution,
): MatchResult {
  const hard: string[] = [];
  if (want.segments.length !== got.segments.length)
    hard.push('segment count differs');
  want.segments.forEach((w, i) => {
    const g = got.segments[i];
    if (!g) return;
    if (w.origin !== g.origin || w.destination !== g.destination)
      hard.push(`segment ${i} route differs`);
    if (w.departureDate !== g.departureDate)
      hard.push(`segment ${i} date differs`);
    if (w.carrier && w.carrier !== g.carrier)
      hard.push(`segment ${i} carrier differs`);
    if (w.flightNumber && w.flightNumber !== g.flightNumber)
      hard.push(`segment ${i} flight differs`);
  });
  if (got.adults < want.adults) hard.push('fewer passengers');
  if (want.cabin !== got.cabin) hard.push('cabin differs');
  if (got.checkedBags < want.checkedBags) hard.push('insufficient bags');
  if (want.refundable === true && got.refundable !== true)
    hard.push('not refundable');
  if (want.changeable === true && got.changeable !== true)
    hard.push('not changeable');
  if (hard.length)
    return { level: 'NOT_COMPARABLE', basis: 'ITINERARY', reasons: hard };
  const soft: string[] = [];
  if (want.fareFamily && norm(want.fareFamily) !== norm(got.fareFamily))
    soft.push('fare family differs');
  return relax(soft, substitution, 'ITINERARY');
}

export function matchSubject(
  want: Subject,
  got: Subject,
  substitution: Substitution,
): MatchResult {
  if (want.kind === 'PRODUCT' && got.kind === 'PRODUCT')
    return matchProduct(want, got, substitution);
  if (want.kind === 'STAY' && got.kind === 'STAY')
    return matchStay(want, got, substitution);
  if (want.kind === 'FLIGHT' && got.kind === 'FLIGHT')
    return matchFlight(want, got, substitution);
  if (want.kind === 'DATA' && got.kind === 'DATA')
    return want.resource === got.resource
      ? { level: 'EXACT_MATCH', basis: 'RESOURCE', reasons: [] }
      : {
          level: 'NOT_COMPARABLE',
          basis: 'RESOURCE',
          reasons: ['resource differs'],
        };
  return {
    level: 'NOT_COMPARABLE',
    basis: 'KIND',
    reasons: ['subject kind differs'],
  };
}

export function comparable(level: MatchLevel, substitution: Substitution) {
  if (level === 'EXACT_MATCH') return true;
  if (level === 'NEAR_EQUIVALENT') return substitution !== 'NONE';
  return false;
}

export type PropertyResolution = {
  same: boolean;
  confidence: number;
  basis: 'PROVIDER_MAPPING' | 'CANONICAL_ID' | 'GEO_NAME' | 'NONE';
};

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const r = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * Deterministic property identity (Bible §83): provider mappings or canonical
 * ids first, otherwise coordinates plus normalized name above a threshold.
 * Ambiguous properties stay separate.
 */
export function resolveProperty(
  a: StaySubject,
  b: StaySubject,
  threshold = 0.85,
): PropertyResolution {
  if (a.propertyId && b.propertyId)
    return a.propertyId === b.propertyId
      ? { same: true, confidence: 1, basis: 'CANONICAL_ID' }
      : { same: false, confidence: 1, basis: 'CANONICAL_ID' };
  for (const [provider, id] of Object.entries(a.providerPropertyIds))
    if (b.providerPropertyIds[provider] !== undefined)
      return {
        same: b.providerPropertyIds[provider] === id,
        confidence: 1,
        basis: 'PROVIDER_MAPPING',
      };
  if (!a.coordinates || !b.coordinates || !a.propertyName || !b.propertyName)
    return { same: false, confidence: 0, basis: 'NONE' };
  const meters = distanceMeters(a.coordinates, b.coordinates);
  const name = titleSimilarity(a.propertyName, b.propertyName);
  const geo = meters <= 50 ? 1 : meters <= 150 ? 0.7 : 0;
  const confidence = Math.round(((geo + name) / 2) * 100) / 100;
  return {
    same: geo > 0 && confidence >= threshold,
    confidence,
    basis: 'GEO_NAME',
  };
}
