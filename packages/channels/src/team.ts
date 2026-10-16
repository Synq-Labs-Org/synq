/**
 * Synq's specialists in chat. They are labelled personas inside the single
 * Synq bot (no extra bots): "ask your CFO and Risk Agent whether we should
 * pay this contractor" is routed to the team port and answered as one
 * message with a section per role and a Kernel decision. The same
 * normalized path serves Telegram, iMessage and the PWA.
 */
export const TEAM_PERSONAS = [
  'CFO',
  'RISK',
  'PAYMENT',
  'AUDIT',
  'INVOICE',
  'DEAL',
  'COMMERCE',
  'TRAVEL',
  'RESEARCH',
] as const;
export type TeamPersona = (typeof TEAM_PERSONAS)[number];

const MENTIONS: readonly [TeamPersona, RegExp][] = [
  ['CFO', /\bcfo\b/i],
  ['RISK', /\brisk(\s+agent)?\b/i],
  ['PAYMENT', /\bpayments?\s+agent\b/i],
  ['AUDIT', /\baudit(or|\s+agent)?\b/i],
  ['INVOICE', /\binvoice\s+agent\b/i],
  ['DEAL', /\bdeal\s+agent\b/i],
  ['COMMERCE', /\bcommerce\s+agent\b/i],
  ['TRAVEL', /\btravel\s+agent\b/i],
  ['RESEARCH', /\bresearch(er|\s+agent)\b/i],
];

/** A request addressed to the team: "ask your CFO and Risk Agent …", "CFO, …", "@SynqRisk …". */
export function parseTeamAsk(
  text: string,
): { personas: TeamPersona[]; question: string } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const handles: Record<string, TeamPersona> = {
    cfo: 'CFO',
    risk: 'RISK',
    pay: 'PAYMENT',
    audit: 'AUDIT',
    invoice: 'INVOICE',
    deal: 'DEAL',
    commerce: 'COMMERCE',
    travel: 'TRAVEL',
    research: 'RESEARCH',
  };
  const mentioned = [
    ...t.matchAll(
      /@synq(cfo|risk|pay|audit|invoice|deal|commerce|travel|research)\b/gi,
    ),
  ].map((m) => handles[m[1]!.toLowerCase()]!);
  const personas = TEAM_PERSONAS.filter(
    (p) =>
      mentioned.includes(p) ||
      MENTIONS.some(([q, re]) => q === p && re.test(t)),
  );
  const addressed =
    /\b(ask|check with|consult|get)\b[^.?!]{0,24}\b(your|the|synq'?s)\b/i.test(
      t,
    ) ||
    /@synq(cfo|risk|pay|audit|invoice|deal|commerce|travel|research)\b/i.test(
      t,
    ) ||
    /^(cfo|risk agent|audit agent|payment agent)\s*[,:]/i.test(t);
  if (!personas.length || !addressed) return null;
  return { personas, question: t.slice(0, 1000) };
}

export type TeamSectionView = Readonly<{
  label: string;
  text: string;
  evidence: readonly string[];
}>;
export type TeamReplyView = Readonly<{
  sections: readonly TeamSectionView[];
  /** Tools that cannot run now (e.g. "risk.screenCounterparty NEEDS_CREDENTIALS"). */
  unavailable: readonly string[];
  /** A payout proposal: the owner signs in the wallet; chat never approves. */
  approval: { label: string; reviewPath: string } | null;
  footer?: string | null;
}>;

/** One coherent chat message: "CFO: …", "Risk: …", "Decision (Kernel): …". */
export function renderTeamReply(r: TeamReplyView, limit = 3800): string {
  const lines: string[] = [];
  for (const s of r.sections) {
    lines.push(`${safeLine(s.label)}: ${safeLine(s.text)}`);
    if (s.evidence.length)
      lines.push(`  Evidence: ${s.evidence.map(safeLine).join(' ')}`);
  }
  if (r.unavailable.length)
    lines.push(`Unavailable now: ${r.unavailable.join(', ')}.`);
  if (r.approval)
    lines.push(
      'Nothing is paid until the owner signs the payment approval in their wallet; a chat reply is never an approval.',
    );
  if (r.footer) lines.push(r.footer);
  const out = lines.join('\n');
  return out.length <= limit ? out : `${out.slice(0, limit - 1)}…`;
}

function safeLine(text: string): string {
  return text
    .replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
