import { z } from 'zod';

export const ACTION_STATES = [
  'RECEIVED',
  'NORMALIZED',
  'RESEARCHING',
  'PROPOSED',
  'RISKED',
  'SIMULATED',
  'PENDING_APPROVAL',
  'AUTHORIZED',
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'EXPLAINED',
  'POLICY_REJECTED',
  'RISK_REJECTED',
  'EXPIRED',
  'CANCELLED',
  'PREPARE_FAILED',
  'SUBMIT_FAILED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export const TX_STATES = [
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'INCLUDED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'SETTLED',
  'PREPARE_FAILED',
  'SUBMIT_FAILED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type TxState = (typeof TX_STATES)[number];

export const ActionStateSchema = z.enum(ACTION_STATES);
export const TxStateSchema = z.enum(TX_STATES);
export const ACTION_TERMINAL_REJECTIONS = [
  'POLICY_REJECTED',
  'RISK_REJECTED',
] as const satisfies readonly ActionState[];
