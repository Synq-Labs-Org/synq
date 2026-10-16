import type { ProviderProbe, ToolBinding } from '@synq/world-model';
import { TEAM_TOOLS, type TeamTool } from './manifests.js';

/**
 * Tool awareness: which team tools exist and what each depends on. The
 * WorldSnapshot joins these bindings with provider probes and pending
 * financial outcomes (`capabilities.tools`), so the Supervisor can say
 * "Circle Wallets need credentials" or "a payout is unconfirmed" instead
 * of guessing.
 */
export const TEAM_TOOL_BINDINGS: readonly ToolBinding[] = (
  Object.keys(TEAM_TOOLS) as TeamTool[]
).map((tool) => ({
  tool,
  providerId: TEAM_TOOLS[tool].provider,
  needsHuman: TEAM_TOOLS[tool].needsHuman,
  financial: TEAM_TOOLS[tool].financial,
}));

/**
 * Providers the team depends on beyond the Arc finance set. Presence of a
 * credential name is checked, never its value; a `check` (health probe) is
 * supplied by the deployment when the provider is really reachable.
 */
export const TEAM_PROVIDERS: readonly Omit<
  ProviderProbe,
  'sdkInstalled' | 'check'
>[] = [
  {
    providerId: 'WALLET_SCREENING',
    label: 'Counterparty / wallet screening',
    credentialEnv: ['SYNQ_SCREENING_API_KEY'],
    capabilities: ['COUNTERPARTY_SCREENING'],
    blockerRef: 'reports/blockers/P20-20261016-screening-provider.md',
  },
  {
    providerId: 'X402_RESEARCH',
    label: 'x402 paid data on Arc testnet',
    credentialEnv: ['SYNQ_X402_ARC_SELLER_URL'],
    capabilities: ['PAID_DATA_X402'],
    blockerRef: 'reports/blockers/P21-20261016-x402-arc-seller.md',
  },
  {
    providerId: 'DUFFEL',
    label: 'Duffel flights and stays (sandbox)',
    credentialEnv: ['DUFFEL_TEST_TOKEN'],
    capabilities: ['TRAVEL_SEARCH'],
  },
  {
    providerId: 'COMMERCE_SEARCH',
    label: 'Merchant search (SearchAPI)',
    credentialEnv: ['SEARCHAPI_KEY'],
    capabilities: ['COMMERCE_SEARCH'],
  },
];
