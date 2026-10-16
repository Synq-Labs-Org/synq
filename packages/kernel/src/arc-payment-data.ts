import type {
  PaymentMandate,
  PaymentIntent,
  ApprovalTerms,
} from './arc-authority.js';

export function mandateTypedData(m: PaymentMandate) {
  return {
    domain: { name: 'Synq Payment Mandate', version: '1', chainId: m.chainId },
    types: {
      PaymentMandate: [
        { name: 'mandateId', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'workspaceId', type: 'string' },
        { name: 'owner', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'payer', type: 'address' },
        { name: 'recipients', type: 'address[]' },
        { name: 'purposes', type: 'string[]' },
        { name: 'perActionCap', type: 'uint256' },
        { name: 'periodBudget', type: 'uint256' },
        { name: 'periodSeconds', type: 'uint256' },
        { name: 'validFrom', type: 'uint256' },
        { name: 'validUntil', type: 'uint256' },
      ],
    },
    primaryType: 'PaymentMandate' as const,
    message: {
      mandateId: m.mandateId,
      version: BigInt(m.version),
      workspaceId: m.workspaceId,
      owner: m.owner,
      token: m.token,
      payer: m.payer,
      recipients: [...m.recipients],
      purposes: [...m.purposes],
      perActionCap: m.perActionCap,
      periodBudget: m.periodBudget,
      periodSeconds: BigInt(m.periodSeconds),
      validFrom: BigInt(m.validFrom),
      validUntil: BigInt(m.validUntil),
    },
  };
}

export function intentApprovalTypedData(
  i: PaymentIntent,
  terms: ApprovalTerms,
) {
  return {
    domain: { name: 'Synq Payment Approval', version: '1', chainId: i.chainId },
    types: {
      PaymentApproval: [
        { name: 'intentId', type: 'string' },
        { name: 'mandateId', type: 'string' },
        { name: 'token', type: 'address' },
        { name: 'payer', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'obligationRef', type: 'string' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'PaymentApproval' as const,
    message: {
      intentId: i.intentId,
      mandateId: i.mandateId,
      token: i.token,
      payer: i.payer,
      recipient: i.recipient,
      amount: i.amount,
      obligationRef: i.obligationRef,
      nonce: terms.nonce,
      deadline: BigInt(terms.deadline),
    },
  };
}
