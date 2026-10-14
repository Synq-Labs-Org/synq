'use client';

import { use, useEffect } from 'react';

/**
 * Browser fallback for a payment card shared from Messages: the approval
 * itself lives on the intent page, where the member signs with their passkey.
 */
export default function FundProposalPage({
  params,
}: {
  params: Promise<{ fundId: string; intentHash: string }>;
}) {
  const { intentHash } = use(params);
  const valid = /^0x[0-9a-fA-F]{64}$/.test(intentHash);
  useEffect(() => {
    if (valid) window.location.replace(`/intents/${intentHash}`);
  }, [intentHash, valid]);
  return (
    <p className="lead">{valid ? 'Opening the payment…' : 'Invalid link.'}</p>
  );
}
