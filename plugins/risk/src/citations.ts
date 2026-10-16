import { z } from 'zod';
import { FACT_PROVENANCE } from './rules.js';

/**
 * Citations keep the line between what Synq verified and what a model
 * inferred. A VERIFIED_FACT names an independent source (chain, books,
 * Kernel, provider, config) and a reference a reader can check (tx hash,
 * invoice id, snapshot path); a MODEL_INFERENCE names the model and is
 * always rendered as unverified. Chat text and model output can never be
 * cited as fact.
 */
export const CITATION_KINDS = ['VERIFIED_FACT', 'MODEL_INFERENCE'] as const;
export const CitationSchema = z.strictObject({
  kind: z.enum(CITATION_KINDS),
  claim: z.string().min(1).max(400),
  source: z.string().min(1).max(160),
  ref: z.string().max(200).nullable(),
  provenance: z.string().min(1).max(32),
  observedAt: z.number().int().nullable(),
  ageSeconds: z.number().int().nullable(),
  verifyUrl: z.url().nullable(),
});
export type Citation = z.output<typeof CitationSchema>;

export class CitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitationError';
  }
}

export function citeFact(input: {
  claim: string;
  source: string;
  ref: string;
  provenance: string;
  observedAt: number | null;
  now: number;
  verifyUrl?: string | null;
}): Citation {
  if (!(FACT_PROVENANCE as readonly string[]).includes(input.provenance))
    throw new CitationError(
      `${input.provenance} is not an independent source; cite it as inference`,
    );
  if (!input.ref.trim())
    throw new CitationError('a fact needs a checkable reference');
  return CitationSchema.parse({
    kind: 'VERIFIED_FACT',
    claim: input.claim.slice(0, 400),
    source: input.source.slice(0, 160),
    ref: input.ref.slice(0, 200),
    provenance: input.provenance,
    observedAt: input.observedAt,
    ageSeconds:
      input.observedAt === null
        ? null
        : Math.max(0, input.now - input.observedAt),
    verifyUrl: input.verifyUrl ?? null,
  });
}

export function citeInference(input: {
  claim: string;
  model: string;
  at: number;
}): Citation {
  return CitationSchema.parse({
    kind: 'MODEL_INFERENCE',
    claim: input.claim.slice(0, 400),
    source: `model:${input.model}`.slice(0, 160),
    ref: null,
    provenance: 'MODEL',
    observedAt: input.at,
    ageSeconds: 0,
    verifyUrl: null,
  });
}

/** Problems with a citation list; empty when every fact is checkable. */
export function citationProblems(cs: readonly Citation[]): string[] {
  const out: string[] = [];
  for (const c of cs) {
    const parsed = CitationSchema.safeParse(c);
    if (!parsed.success) {
      out.push(`malformed citation: ${parsed.error.issues[0]?.message}`);
      continue;
    }
    if (c.kind === 'VERIFIED_FACT') {
      if (!(FACT_PROVENANCE as readonly string[]).includes(c.provenance))
        out.push(
          `"${c.claim}" is labelled fact but comes from ${c.provenance}`,
        );
      if (!c.ref) out.push(`"${c.claim}" is labelled fact without a reference`);
    } else if (c.provenance !== 'MODEL')
      out.push(`inference "${c.claim}" must carry MODEL provenance`);
  }
  return out;
}

const shortRef = (r: string) =>
  /^0x[0-9a-fA-F]{64}$/.test(r) ? `${r.slice(0, 10)}…${r.slice(-6)}` : r;

/** One-line rendering that always shows which kind of statement it is. */
export function renderCitation(c: Citation): string {
  if (c.kind === 'MODEL_INFERENCE')
    return `[model inference, ${c.source.replace(/^model:/, '')}; not verified]`;
  const age = c.ageSeconds === null ? 'time unknown' : `${c.ageSeconds}s old`;
  return `[fact: ${c.source} ${shortRef(c.ref ?? '')}, ${age}]`;
}
