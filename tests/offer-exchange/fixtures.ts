import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  type EconomicIntent,
  type EconomicIntentInput,
  type EconomicOffer,
  type EconomicOfferInput,
  type OfferProvider,
  type ProviderCapability,
  type RevalidatedQuote,
  type Subject,
} from '@synq/offer-exchange';

export const NOW = 1_780_000_000;
export const usd = (amount: bigint | number) => ({
  amount: String(amount),
  currency: 'USD',
  decimals: 2,
});

export function capability(
  providerId: string,
  over: Partial<ProviderCapability> = {},
): ProviderCapability {
  return {
    providerId,
    displayName: providerId,
    domains: ['COMMERCE', 'STAY', 'FLIGHT', 'DATA'],
    verbs: ['DISCOVER', 'QUOTE', 'BOOK', 'CANCEL'],
    environment: 'FIXTURE',
    status: 'READY',
    statusReason: null,
    kycRequired: false,
    credentialEnv: [],
    settlementRails: ['PROVIDER_BALANCE'],
    discoveryOnly: false,
    sourceRefs: [],
    ...over,
  };
}

export const graphOf = (...caps: ProviderCapability[]) =>
  new ProviderCapabilityGraph(caps);

export const phone: Subject = {
  kind: 'PRODUCT',
  title: 'Acme Phone 12 128GB Blue',
  gtin: '0012345678905',
  mpn: 'AP12-128-BL',
  brand: 'Acme',
  model: 'Phone 12',
  variant: { color: 'Blue', storage: '128GB', region: 'US' },
  condition: 'NEW',
  attributes: {},
  quantity: 1,
};

export function intent(
  over: Partial<EconomicIntentInput> = {},
): EconomicIntent {
  return EconomicIntentSchema.parse({
    id: 'intent-1',
    groupId: 'group-1',
    domain: 'COMMERCE',
    objective: 'buy the phone',
    subject: phone,
    hardConstraints: [],
    preferences: [],
    budget: { max: usd(100_000) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 200,
    validUntil: NOW + 3_600,
    ...over,
  });
}

export function offer(
  id: string,
  provider: string,
  base: number,
  over: Partial<EconomicOfferInput> = {},
): EconomicOfferInput {
  return {
    offerId: id,
    intentId: 'intent-1',
    domain: 'COMMERCE',
    discoveryProviderId: provider,
    fulfillmentProviderId: provider,
    providerRef: `${provider}:${id}`,
    subject: phone,
    price: {
      quoteId: `q-${id}`,
      base: usd(base),
      shipping: usd(0),
      tax: usd(0),
      fees: usd(0),
      fx: [],
      quotedAt: NOW,
      expiresAt: NOW + 900,
      revalidatedAt: null,
    },
    cancellation: {
      kind: 'FREE_UNTIL',
      refundable: true,
      freeUntil: NOW + 86_400,
      penalty: null,
      changeable: true,
    },
    settlement: {
      accepts: [{ rail: 'PROVIDER_BALANCE', currency: 'USD' }],
      payee: null,
    },
    execution: {
      mode: 'NATIVE_API',
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: [],
    },
    environment: 'FIXTURE',
    evidence: 'MOCKED',
    retrievedAt: NOW,
    executable: false,
    ...over,
  };
}

export class FakeProvider implements OfferProvider {
  calls = 0;
  revalidations = 0;
  constructor(
    readonly providerId: string,
    private readonly offers: EconomicOfferInput[] | (() => Promise<never>),
    private readonly fresh?: (o: EconomicOffer) => RevalidatedQuote,
  ) {}
  async search(): Promise<EconomicOfferInput[]> {
    this.calls++;
    if (typeof this.offers === 'function') return this.offers();
    return this.offers;
  }
  get revalidate() {
    const fresh = this.fresh;
    if (!fresh) return undefined;
    return async (o: EconomicOffer) => {
      this.revalidations++;
      return fresh(o);
    };
  }
}

export const hang = () => new Promise<never>(() => undefined);
