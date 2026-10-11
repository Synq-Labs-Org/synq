export const COMMANDS = [
  'synq',
  'wallet',
  'balance',
  'contribute',
  'send',
  'mandates',
  'propose',
  'status',
  'help',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export type ParsedCommand =
  | { kind: 'COMMAND'; name: CommandName; args: string }
  | { kind: 'UNKNOWN_COMMAND'; name: string }
  | { kind: 'TEXT'; text: string };

/** `/cmd@bot args`; a command addressed to a different bot is not ours. */
export function parseCommand(
  body: string,
  botUsername: string | null,
): ParsedCommand | null {
  const text = body.trim();
  const m =
    /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/.exec(
      text,
    );
  if (!m) return { kind: 'TEXT', text };
  const [, raw, target, rest] = m;
  if (
    target !== undefined &&
    (botUsername === null || target.toLowerCase() !== botUsername.toLowerCase())
  )
    return null;
  const name = raw!.toLowerCase();
  return (COMMANDS as readonly string[]).includes(name)
    ? { kind: 'COMMAND', name: name as CommandName, args: (rest ?? '').trim() }
    : { kind: 'UNKNOWN_COMMAND', name };
}

export type SendArgs = { amount: string; recipient: string };
const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/;
/** `/send <amount> [AUSD] [to] <recipient>`; exact decimal strings only. */
export function parseSendArgs(args: string): SendArgs | null {
  const parts = args.split(/\s+/).filter(Boolean);
  const amount = parts.shift();
  if (!amount || !AMOUNT.test(amount)) return null;
  if (parts[0]?.toUpperCase() === 'AUSD') parts.shift();
  if (parts[0]?.toLowerCase() === 'to') parts.shift();
  const recipient = parts.join(' ').replace(/^@/, '');
  if (!recipient || recipient.length > 200 || !/^[\w.\- ]+$/.test(recipient))
    return null;
  if (/^0+(\.0+)?$/.test(amount)) return null;
  return { amount, recipient };
}

export const HELP_TEXT = [
  'Synq commands:',
  '/synq - link this chat and your account to a Synq group',
  '/wallet - group treasury account',
  '/balance - AUSD treasury balance',
  '/contribute - how to contribute AUSD',
  '/send <amount> <recipient> - start a Send (confirmed on the web with your passkey)',
  '/mandates - active spending mandates',
  '/propose <text> - ask the Brain to draft a proposal for the Kernel',
  '/status - pending approvals and receipts',
  'Approvals only happen on the Synq web page with your passkey. Replying "yes" in chat never approves anything.',
].join('\n');
