import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StaleClaim {
  file: string;
  line: number;
  rule: string;
  text: string;
}

interface Rule {
  id: string;
  match: (line: string) => boolean;
}

const NEGATED =
  /\b(not|never|no|cannot|can't|isn't|aren't|don't|doesn't|without|superseded|removed|instead of|neither|nor|forbid|forbidden|reject|fails?)\b|n't\b/i;

const RULES: Rule[] = [
  {
    id: 'IMMERSVE_MANDATORY',
    match: (l) =>
      /immersve/i.test(l) &&
      /\b(mandatory|required|must|primary card rail|core rail)\b/i.test(l) &&
      !/FUTURE_PARTNER_INTEGRATION|PARTNER_GATED|optional|future/i.test(l) &&
      !NEGATED.test(l),
  },
  {
    id: 'LINQ_REQUIRED',
    match: (l) =>
      /\blinq/i.test(l) &&
      /\b(mandatory|required|the only (chat|conversation) surface|must use linq)\b/i.test(
        l,
      ) &&
      !/OPTIONAL/i.test(l) &&
      !NEGATED.test(l),
  },
  {
    id: 'PHASE_P16',
    match: (l) =>
      /\bP16\b/.test(l) && !NEGATED.test(l) && !/\bno P16\b/i.test(l),
  },
  {
    id: 'CARD_SANDBOX_FUNDED_BY_AUSD',
    match: (l) =>
      /\b(lithic|reloadly)\b/i.test(l) &&
      /\b(AUSD|group safe|treasury)\b/i.test(l) &&
      /\b(funded|funds|funding|accepts?|top[- ]?ups?|pays?|paid)\b/i.test(l) &&
      !NEGATED.test(l),
  },
  {
    id: 'PRIVY_AND_DYNAMIC_BOTH_REQUIRED',
    match: (l) =>
      /privy/i.test(l) &&
      /dynamic/i.test(l) &&
      /\b(both|and)\b/i.test(l) &&
      /\b(required|mandatory|must integrate)\b/i.test(l) &&
      !/\b(one of|exactly one|either|or)\b|ADR|PRIVY_VS_DYNAMIC/i.test(l) &&
      !NEGATED.test(l),
  },
  {
    id: 'CARD_URL_AS_SIGNATURE',
    match: (l) =>
      /\b(button|card url|link click|tap)\b/i.test(l) &&
      /\b(is|counts as|serves as|acts as)\s+(a |an )?(signature|approval)\b/i.test(
        l,
      ) &&
      !NEGATED.test(l),
  },
];

export function findStaleClaims(file: string, text: string): StaleClaim[] {
  const out: StaleClaim[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    // Table cells are independent claims; a row's columns are not one sentence.
    const units = line.startsWith('|')
      ? line.split('|').map((cell) => cell.trim())
      : [line];
    for (const rule of RULES)
      if (units.some((unit) => unit && rule.match(unit)))
        out.push({ file, line: index + 1, rule: rule.id, text: line });
  });
  return out;
}

interface Requirement {
  file: string;
  pattern: RegExp;
  why: string;
}

export const REQUIRED_STATEMENTS: Requirement[] = [
  {
    file: 'docs/adr/PRIVY_VS_DYNAMIC_SELECTION.md',
    pattern: /Privy/,
    why: 'the embedded-wallet selection ADR exists',
  },
  {
    file: 'docs/bible/chapters',
    pattern: /PRIVY_VS_DYNAMIC_SELECTION/,
    why: 'the identity chapter defers the embedded-wallet choice to the ADR',
  },
  {
    file: 'docs/bible/chapters',
    pattern: /FUTURE_PARTNER_INTEGRATION/,
    why: 'Immersve is recorded as a future partner integration',
  },
  {
    file: 'docs/bible/chapters',
    pattern: /LinqV3Adapter[^\n]*OPTIONAL|OPTIONAL[^\n]*LinqV3Adapter/,
    why: 'Linq is an optional ChannelGateway adapter',
  },
  {
    file: 'docs/bible/chapters',
    pattern: /REAL_MONEY_APPROVAL_REQUIRED/,
    why: 'financial execution modes are defined',
  },
  {
    file: 'AGENTS.md',
    pattern: /docs\/bible/,
    why: 'repository AGENTS.md points at the in-repo v1.3 Bible',
  },
];

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

const SCANNED = ['AGENTS.md', 'docs/bible', 'docs/adr'];
// The v1.3 delta and version history describe superseded claims on purpose.
const HISTORICAL = /(^|\/)(100-100-v1-2-|95-95-v1-1-|101-101-v1-3-)/;
// The consolidated Bible is assembled from the chapters; it is checked for drift instead.
const CONSOLIDATED = 'docs/bible/Synq_Build_Bible_Canonical_v1.3.md';

export function checkRepository(root: string): string[] {
  const problems: string[] = [];
  for (const base of SCANNED)
    for (const path of walk(join(root, base))) {
      if (!path.endsWith('.md')) continue;
      const file = relative(root, path);
      if (HISTORICAL.test(file) || file === CONSOLIDATED) continue;
      for (const claim of findStaleClaims(file, readFileSync(path, 'utf8')))
        problems.push(
          `${claim.file}:${claim.line} ${claim.rule}: ${claim.text.slice(0, 160)}`,
        );
    }
  const consolidated = join(root, CONSOLIDATED);
  if (!existsSync(consolidated)) problems.push(`${CONSOLIDATED}: missing`);
  else {
    const text = readFileSync(consolidated, 'utf8');
    for (const chapter of walk(join(root, 'docs/bible/chapters')))
      if (/\/\d+-[^/]*\.md$/.test(chapter))
        if (!text.includes(readFileSync(chapter, 'utf8').trim()))
          problems.push(
            `${CONSOLIDATED}: out of date with ${relative(root, chapter)}`,
          );
  }
  for (const requirement of REQUIRED_STATEMENTS) {
    const files = walk(join(root, requirement.file)).filter((f) =>
      f.endsWith('.md'),
    );
    if (!files.some((f) => requirement.pattern.test(readFileSync(f, 'utf8'))))
      problems.push(
        `${requirement.file}: missing statement (${requirement.why})`,
      );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkRepository(process.cwd());
  if (problems.length) {
    console.error(`Bible consistency check failed (${problems.length}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else console.log('Bible consistency check passed.');
}
