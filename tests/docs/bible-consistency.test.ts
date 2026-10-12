import { expect, it } from 'vitest';
import {
  checkRepository,
  findStaleClaims,
} from '../../scripts/check-bible-consistency.js';

const rules = (text: string) =>
  findStaleClaims('planted.md', text).map((claim) => claim.rule);

it('flags stale v1.2 claims that contradict the v1.3 Bible', () => {
  expect(rules('Immersve is the mandatory card rail for P11.')).toEqual([
    'IMMERSVE_MANDATORY',
  ]);
  expect(rules('Linq is required for every group chat.')).toEqual([
    'LINQ_REQUIRED',
  ]);
  expect(rules('P16 hardens the submission.')).toEqual(['PHASE_P16']);
  expect(rules('Lithic cards are funded by AUSD from the group Safe.')).toEqual(
    ['CARD_SANDBOX_FUNDED_BY_AUSD'],
  );
  expect(rules('Both Privy and Dynamic are required.')).toEqual([
    'PRIVY_AND_DYNAMIC_BOTH_REQUIRED',
  ]);
  expect(rules('Tapping the button counts as approval.')).toEqual([
    'CARD_URL_AS_SIGNATURE',
  ]);
});

it('accepts the truthful v1.3 statements', () => {
  for (const line of [
    'Immersve is FUTURE_PARTNER_INTEGRATION and is not required.',
    'LinqV3Adapter is OPTIONAL; Telegram and iMessage bridges work without it.',
    'Lithic and Reloadly never accept AUSD from the Safe; sandbox balances are provider test funds.',
    'Exactly one of Privy or Dynamic is required, chosen by ADR PRIVY_VS_DYNAMIC_SELECTION.',
    'A button or card URL is never a signature.',
    '| Funding | AUSD treasury | SettlementRouter: Lithic (SANDBOX), Reloadly (SANDBOX) |',
  ])
    expect(rules(line)).toEqual([]);
});

it('the in-repo v1.3 Bible mirror is consistent', () => {
  expect(checkRepository(process.cwd())).toEqual([]);
});
