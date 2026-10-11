import type { EconomicOffer, ProviderCapability } from '@synq/offer-exchange';
import type { CheckoutRoute } from './checkout.js';

export const IMMERSVE = 'immersve';

export type CardholderState = {
  principalId: string;
  kycStatus: 'APPROVED' | 'PENDING' | 'REJECTED' | 'NONE';
  residenceCountry: string;
};

export type CardEligibility =
  | { eligible: true }
  | {
      eligible: false;
      code:
        | 'KYC_INCOMPLETE'
        | 'REGION_UNSUPPORTED'
        | 'WRONG_SETTLEMENT_PRINCIPAL'
        | 'NOT_CONFIGURED';
    };

/**
 * Immersve scoped-card rail (Monad Testnet USDC funding per current docs).
 * Card execution requires a KYC-approved cardholder in a supported region who
 * is the group's designated settlement principal; PAN/CVC never leave the
 * issuer — Synq handles only opaque card tokens.
 */
export class ImmersveCardRoute implements CheckoutRoute {
  readonly mode = 'SCOPED_CARD' as const;
  readonly providerId = IMMERSVE;
  readonly host = 'api.immersve.com';
  constructor(
    readonly capability: ProviderCapability,
    private readonly config: {
      supportedRegions: readonly string[];
      settlementPrincipalId: string | null;
      credentialsPresent: boolean;
    },
  ) {}
  supports(offer: EconomicOffer) {
    return (
      offer.domain === 'COMMERCE' && offer.execution.mode !== 'DISCOVERY_ONLY'
    );
  }
  sandboxReady() {
    return false;
  }
  eligibility(cardholder: CardholderState): CardEligibility {
    if (!this.config.credentialsPresent)
      return { eligible: false, code: 'NOT_CONFIGURED' };
    if (this.config.settlementPrincipalId !== cardholder.principalId)
      return { eligible: false, code: 'WRONG_SETTLEMENT_PRINCIPAL' };
    if (cardholder.kycStatus !== 'APPROVED')
      return { eligible: false, code: 'KYC_INCOMPLETE' };
    if (!this.config.supportedRegions.includes(cardholder.residenceCountry))
      return { eligible: false, code: 'REGION_UNSUPPORTED' };
    return { eligible: true };
  }
}
