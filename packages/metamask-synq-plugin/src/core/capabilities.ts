export type Capability = 'wallet-read' | 'wallet-submit';

/** Mirrors package.json#mm.commands; a test keeps the two identical. */
export const COMMAND_CAPABILITIES = {
  'synq:groups': ['wallet-read'],
  'synq:login': ['wallet-read', 'wallet-submit'],
  'synq:treasury': ['wallet-read'],
  'synq:contribute': ['wallet-read', 'wallet-submit'],
  'synq:propose': ['wallet-read'],
  'synq:dca': ['wallet-read'],
  'synq:risk': ['wallet-read'],
  'synq:strategies': ['wallet-read'],
  'synq:receipts': ['wallet-read'],
} as const satisfies Record<string, readonly Capability[]>;

export type SynqCommandId = keyof typeof COMMAND_CAPABILITIES;

export const allows = (command: SynqCommandId, capability: Capability) =>
  (COMMAND_CAPABILITIES[command] as readonly Capability[]).includes(capability);
