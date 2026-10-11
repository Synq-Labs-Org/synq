import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type DeliveryResult,
} from './events.js';

export const WHATSAPP_UNAVAILABLE_REASON =
  'WhatsApp Cloud API groups are limited to Official Business Accounts, small business-created groups joined by invite link, and cannot add the business to existing user groups; unofficial libraries are not allowed. See reports/findings/whatsapp-groups.md.';

/** Interface placeholder: reports UNAVAILABLE and refuses every operation. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly status = 'UNAVAILABLE' as const;
  async send(): Promise<DeliveryResult> {
    throw new ChannelDeliveryError(
      'CHANNEL_UNAVAILABLE',
      0,
      WHATSAPP_UNAVAILABLE_REASON,
    );
  }
}
