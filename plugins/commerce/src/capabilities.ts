import {
  credentialStatus,
  type EconomicOffer,
  type ProviderCapability,
} from '@synq/offer-exchange';
import type { CheckoutRoute } from './checkout.js';
import { EBAY_BROWSE, EBAY_ORDER } from './ebay.js';
import { IMMERSVE } from './immersve.js';
import { SERPAPI_AMAZON, SERPAPI_GOOGLE_SHOPPING } from './serpapi.js';
import { SEARCHAPI_AMAZON, SEARCHAPI_GOOGLE_SHOPPING } from './searchapi.js';
import { CROSSMINT } from './crossmint.js';

const cap = (
  c: Partial<ProviderCapability> &
    Pick<ProviderCapability, 'providerId' | 'displayName' | 'verbs'>,
): ProviderCapability => ({
  domains: ['COMMERCE'],
  environment: 'PRODUCTION',
  status: 'READY',
  statusReason: null,
  kycRequired: false,
  credentialEnv: [],
  settlementRails: [],
  discoveryOnly: false,
  sourceRefs: [],
  ...c,
});

/** Truthful commerce capability snapshot derived from present credentials. */
export function commerceCapabilities(
  env: Readonly<Record<string, string | undefined>>,
): ProviderCapability[] {
  const ebayEnv = env.EBAY_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX';
  const crossmintKey = env.CROSSMINT_API_KEY ?? '';
  const crossmintNotStaging =
    (!!crossmintKey && !crossmintKey.startsWith('sk_staging_')) ||
    (env.CROSSMINT_ENV !== undefined && env.CROSSMINT_ENV !== 'staging');
  return [
    credentialStatus(
      cap({
        providerId: SEARCHAPI_AMAZON,
        displayName: 'Amazon via SearchApi.io',
        verbs: ['DISCOVER', 'QUOTE'],
        credentialEnv: ['SEARCHAPI_KEY'],
        sourceRefs: [
          'https://www.searchapi.io/docs/amazon-search',
          'https://www.searchapi.io/docs/amazon-product',
        ],
      }),
      env,
    ),
    credentialStatus(
      cap({
        providerId: SEARCHAPI_GOOGLE_SHOPPING,
        displayName: 'Google Shopping via SearchApi.io',
        verbs: ['DISCOVER'],
        discoveryOnly: true,
        credentialEnv: ['SEARCHAPI_KEY'],
        sourceRefs: ['https://www.searchapi.io/docs/google-shopping'],
      }),
      env,
    ),
    credentialStatus(
      cap({
        providerId: SERPAPI_AMAZON,
        displayName: 'Amazon via SerpAPI',
        verbs: ['DISCOVER'],
        discoveryOnly: true,
        credentialEnv: ['SERPAPI_KEY'],
        sourceRefs: ['https://serpapi.com/amazon-search-api'],
      }),
      env,
    ),
    credentialStatus(
      cap({
        providerId: SERPAPI_GOOGLE_SHOPPING,
        displayName: 'Google Shopping via SerpAPI',
        verbs: ['DISCOVER'],
        discoveryOnly: true,
        credentialEnv: ['SERPAPI_KEY'],
        sourceRefs: ['https://serpapi.com/google-shopping-api'],
      }),
      env,
    ),
    credentialStatus(
      cap({
        providerId: EBAY_BROWSE,
        displayName: 'eBay Browse API',
        verbs: ['DISCOVER', 'DETAIL', 'QUOTE'],
        environment: ebayEnv,
        credentialEnv: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
        sourceRefs: [
          'https://developer.ebay.com/api-docs/buy/browse/overview.html',
        ],
      }),
      env,
    ),
    cap({
      providerId: EBAY_ORDER,
      displayName: 'eBay Order API',
      verbs: ['PURCHASE', 'TRACK'],
      environment: 'SANDBOX',
      status: 'PARTNER_GATED',
      statusReason: 'Order API is limited release',
      sourceRefs: [
        'https://developer.ebay.com/api-docs/buy/order/overview.html',
      ],
    }),
    crossmintNotStaging
      ? cap({
          providerId: CROSSMINT,
          displayName: 'Crossmint headless checkout',
          verbs: ['QUOTE', 'PURCHASE', 'TRACK'],
          environment: 'SANDBOX',
          status: 'BLOCKED',
          statusReason:
            'only Crossmint staging (sk_staging_, CROSSMINT_ENV=staging) is accepted',
        })
      : credentialStatus(
          cap({
            providerId: CROSSMINT,
            displayName: 'Crossmint headless checkout (staging)',
            verbs: ['QUOTE', 'PURCHASE', 'TRACK'],
            environment: 'SANDBOX',
            credentialEnv: ['CROSSMINT_API_KEY'],
            settlementRails: ['STABLECOIN_CHECKOUT'],
            sourceRefs: [
              'https://docs.crossmint.com/api-reference/headless/create-order',
            ],
          }),
          env,
        ),
    credentialStatus(
      cap({
        providerId: IMMERSVE,
        displayName: 'Immersve virtual card (Monad USDC funding)',
        verbs: ['PURCHASE', 'PAY'],
        environment: 'SANDBOX',
        kycRequired: true,
        credentialEnv: ['IMMERSVE_CLIENT_ID', 'IMMERSVE_CLIENT_SECRET'],
        settlementRails: ['SCOPED_CARD'],
        sourceRefs: ['https://docs.immersve.com/'],
      }),
      env,
    ),
  ];
}

export class EbayOrderRoute implements CheckoutRoute {
  readonly mode = 'NATIVE_API' as const;
  readonly providerId = EBAY_ORDER;
  readonly host = 'api.ebay.com';
  constructor(readonly capability: ProviderCapability) {}
  supports(offer: EconomicOffer) {
    return offer.fulfillmentProviderId === EBAY_ORDER;
  }
  sandboxReady() {
    return false;
  }
}
