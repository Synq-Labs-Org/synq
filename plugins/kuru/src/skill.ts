import { erc20Abi, type PublicClient } from 'viem';
import type { ProfileName } from '@synq/domain';
import {
  type Address,
  type KuruDeployment,
  type KuruToken,
} from './deployment.js';
import { KuruError, requireKuru } from './errors.js';
import {
  KuruFlowAdapter,
  flowDeployment,
  type FlowQuote,
  type PreparedSwap,
  type SwapPolicy,
} from './flow.js';

/**
 * Semantics of the official kuru-trading-skills (Kuru-Labs/kuru-trading-skills @ 6075030b, scripts/tokens.ts and
 * scripts/kuru-trade.ts), ported rather than vendored: USDC is the settlement token, BUY spends USDC for a token,
 * SELL spends a token for USDC, only USDC/WMON/AUSD are allowlisted, the chain is Monad mainnet, `prepare` is
 * key-free and returns an unsigned approval (only when the allowance is short, for the exact amount) followed by
 * the swap. Pairs without USDC on one side (for example AUSD->WMON) are not skill semantics and are refused.
 */
export const SKILL_SOURCE = {
  repository: 'https://github.com/Kuru-Labs/kuru-trading-skills',
  commit: '6075030b',
} as const;
export const SETTLEMENT_SYMBOL = 'USDC';
const SKILL_ALLOWLIST = ['USDC', 'WMON', 'AUSD'] as const;
const ALIASES: Record<(typeof SKILL_ALLOWLIST)[number], readonly string[]> = {
  USDC: ['usd coin', 'usdc'],
  WMON: ['wrapped mon', 'wrapped monad', 'wmonad'],
  AUSD: ['agora dollar'],
};
const NAMES: Record<(typeof SKILL_ALLOWLIST)[number], string> = {
  USDC: 'USD Coin',
  WMON: 'Wrapped Monad',
  AUSD: 'AUSD',
};
export type SkillSide = 'buy' | 'sell';

type AllowanceReader = Pick<PublicClient, 'readContract'>;

export class KuruSkillAdapter {
  private readonly flow: KuruFlowAdapter;
  constructor(
    flow: KuruFlowAdapter,
    private readonly reader: AllowanceReader,
  ) {
    this.flow = flow;
  }

  static deployment(profile: ProfileName): KuruDeployment {
    requireKuru(
      profile === 'proof/monad-mainnet',
      'UNAVAILABLE_IN_NETWORK_PROFILE',
      'the Kuru trading skill is Monad mainnet only',
    );
    return flowDeployment(profile);
  }

  static tokens(profile: ProfileName): KuruToken[] {
    const deployment = KuruSkillAdapter.deployment(profile);
    return SKILL_ALLOWLIST.map((symbol) => {
      const token = deployment.tokens[symbol];
      if (!token) throw new KuruError('TOKEN_NOT_ALLOWED', symbol);
      return token;
    });
  }

  static resolveToken(profile: ProfileName, identifier: string): KuruToken {
    const key = identifier.trim().toLowerCase();
    if (!key) throw new KuruError('TOKEN_NOT_ALLOWED', 'empty identifier');
    const matches = KuruSkillAdapter.tokens(profile).filter((token) => {
      const symbol = token.symbol as (typeof SKILL_ALLOWLIST)[number];
      return [token.symbol, NAMES[symbol], token.address, ...ALIASES[symbol]]
        .map((k) => k.toLowerCase())
        .includes(key);
    });
    if (matches.length !== 1)
      throw new KuruError('TOKEN_NOT_ALLOWED', identifier);
    return matches[0]!;
  }

  static pair(
    profile: ProfileName,
    side: SkillSide,
    identifier: string,
  ): { tokenIn: KuruToken; tokenOut: KuruToken } {
    const selected = KuruSkillAdapter.resolveToken(profile, identifier);
    const usdc = KuruSkillAdapter.resolveToken(profile, SETTLEMENT_SYMBOL);
    requireKuru(
      selected.address !== usdc.address,
      'UNSUPPORTED_PAIR',
      'choose a non-USDC token for buy/sell',
    );
    return side === 'buy'
      ? { tokenIn: usdc, tokenOut: selected }
      : { tokenIn: selected, tokenOut: usdc };
  }

  /** Refuses any (tokenIn, tokenOut) that is not a skill BUY or SELL. */
  static assertSkillPair(
    profile: ProfileName,
    tokenIn: Address,
    tokenOut: Address,
  ): SkillSide {
    const tokens = KuruSkillAdapter.tokens(profile);
    const usdc = KuruSkillAdapter.resolveToken(profile, SETTLEMENT_SYMBOL);
    const inToken = tokens.find((t) => t.address === tokenIn.toLowerCase());
    const outToken = tokens.find((t) => t.address === tokenOut.toLowerCase());
    if (!inToken || !outToken)
      throw new KuruError('TOKEN_NOT_ALLOWED', `${tokenIn}->${tokenOut}`);
    if (inToken.address === usdc.address && outToken.address !== usdc.address)
      return 'buy';
    if (outToken.address === usdc.address && inToken.address !== usdc.address)
      return 'sell';
    throw new KuruError(
      'UNSUPPORTED_PAIR',
      `${inToken.symbol}->${outToken.symbol} is not a USDC-settled skill trade; use Kuru Flow`,
    );
  }

  async quote(input: {
    side: SkillSide;
    token: string;
    amountIn: bigint;
    from: Address;
    slippageBps: number;
    now: number;
  }): Promise<FlowQuote> {
    const profile = 'proof/monad-mainnet' as const;
    const { tokenIn, tokenOut } = KuruSkillAdapter.pair(
      profile,
      input.side,
      input.token,
    );
    return this.flow.quote(
      {
        profile,
        account: input.from,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: input.amountIn,
        slippageBps: input.slippageBps,
      },
      input.now,
    );
  }

  /** Skill `prepare`: approval only when the current allowance is short, for the exact amount; then the swap. */
  async prepare(
    input: {
      side: SkillSide;
      token: string;
      amountIn: bigint;
      from: Address;
      slippageBps: number;
      now: number;
    },
    policy: Omit<SwapPolicy, 'now'>,
  ): Promise<PreparedSwap & { skill: typeof SKILL_SOURCE; side: SkillSide }> {
    const quote = await this.quote(input);
    KuruSkillAdapter.assertSkillPair(
      quote.profile,
      quote.tokenIn.address,
      quote.tokenOut.address,
    );
    const prepared = this.flow.prepare(quote, { ...policy, now: input.now });
    const allowance = await this.reader.readContract({
      address: quote.tokenIn.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [quote.account, prepared.swap.target],
    });
    return {
      ...prepared,
      venue: 'kuru-skill',
      approval: allowance >= quote.amountIn ? null : prepared.approval,
      skill: SKILL_SOURCE,
      side: input.side,
    };
  }
}
