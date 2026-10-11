import {
  credentialStatus,
  type ProviderCapability,
} from '@synq/offer-exchange';
import { DUFFEL_FLIGHTS } from './flights.js';
import { DUFFEL_STAYS } from './stays.js';

const partnerGated = (
  providerId: string,
  displayName: string,
  domains: ProviderCapability['domains'],
  verbs: ProviderCapability['verbs'],
  reason: string,
  sourceRefs: string[],
): ProviderCapability => ({
  providerId,
  displayName,
  domains,
  verbs,
  environment: 'SANDBOX',
  status: 'PARTNER_GATED',
  statusReason: reason,
  kycRequired: false,
  credentialEnv: [],
  settlementRails: [],
  discoveryOnly: false,
  sourceRefs,
});

/** Truthful travel capability snapshot; gated providers are listed, never faked. */
export function travelCapabilities(
  env: Readonly<Record<string, string | undefined>>,
): ProviderCapability[] {
  const duffel = (
    providerId: string,
    displayName: string,
    domain: 'STAY' | 'FLIGHT',
    verbs: ProviderCapability['verbs'],
    ref: string,
  ): ProviderCapability => {
    const token = env.DUFFEL_TEST_TOKEN ?? '';
    const cap = credentialStatus(
      {
        providerId,
        displayName,
        domains: [domain],
        verbs,
        environment: 'SANDBOX',
        status: 'READY',
        statusReason: null,
        kycRequired: false,
        credentialEnv: ['DUFFEL_TEST_TOKEN'],
        settlementRails: ['PROVIDER_BALANCE'],
        discoveryOnly: false,
        sourceRefs: [ref],
      },
      env,
    );
    return token && !token.startsWith('duffel_test_')
      ? {
          ...cap,
          status: 'BLOCKED',
          statusReason: 'live Duffel keys are refused',
        }
      : cap;
  };
  return [
    duffel(
      DUFFEL_STAYS,
      'Duffel Stays (test mode)',
      'STAY',
      ['DISCOVER', 'DETAIL', 'QUOTE', 'BOOK', 'CANCEL', 'TRACK'],
      'https://duffel.com/docs/guides/getting-started-with-stays',
    ),
    duffel(
      DUFFEL_FLIGHTS,
      'Duffel Flights / Duffel Airways (test mode)',
      'FLIGHT',
      ['DISCOVER', 'DETAIL', 'QUOTE', 'BOOK', 'CANCEL', 'REFUND', 'TRACK'],
      'https://duffel.com/docs/api/v2/orders',
    ),
    partnerGated(
      'hbx',
      'HBX / Hotelbeds APItude',
      ['STAY'],
      ['DISCOVER', 'QUOTE', 'BOOK', 'CANCEL'],
      'partner credentials not issued in this environment',
      ['https://developer.hotelbeds.com/'],
    ),
    partnerGated(
      'booking-com-demand',
      'Booking.com Demand API',
      ['STAY'],
      ['DISCOVER', 'QUOTE', 'BOOK', 'MODIFY', 'CANCEL'],
      'affiliate/partner approval required',
      ['https://developers.booking.com/demand/'],
    ),
    partnerGated(
      'expedia-rapid',
      'Expedia Rapid',
      ['STAY'],
      ['DISCOVER', 'QUOTE', 'BOOK', 'CANCEL'],
      'partner onboarding required',
      ['https://developers.expediagroup.com/docs/products/rapid'],
    ),
    partnerGated(
      'travelport',
      'Travelport JSON APIs',
      ['FLIGHT'],
      ['DISCOVER', 'QUOTE', 'BOOK'],
      'workbench credentials required',
      ['https://support.travelport.com/'],
    ),
  ];
}
