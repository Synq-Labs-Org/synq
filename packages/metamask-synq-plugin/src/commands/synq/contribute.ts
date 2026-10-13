import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import {
  capFromEnv,
  contribute,
  type ContributionPlan,
  type ContributionReceipt,
} from '../../core/contribute.js';
import { asCommand, depsFor, journalFromEnv } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Synq group id',
    required: true,
    index: 0,
  },
  amount: {
    type: InputFieldType.Text,
    flag: 'amount',
    message: 'AUSD amount to contribute (e.g. 1.5)',
    required: true,
    index: 1,
  },
  mandateId: {
    type: InputFieldType.Text,
    flag: 'mandate-id',
    message: 'Optional bytes32 mandate id the contribution must match',
    required: false,
    prompt: false,
  },
  requestId: {
    type: InputFieldType.Text,
    flag: 'request-id',
    message: 'Idempotency key; reuse to retry, change to contribute again',
    required: false,
    prompt: false,
  },
  from: {
    type: InputFieldType.Text,
    flag: 'from',
    message: 'Member wallet address (must be the selected wallet)',
    required: false,
    prompt: false,
  },
  dryRun: {
    type: InputFieldType.Boolean,
    flag: 'dry-run',
    message: 'Prepare and validate without submitting',
    required: false,
    prompt: false,
    default: false,
  },
} satisfies InputSchema;

type Result = ContributionPlan | ContributionReceipt;
const opt = (v: string) => (v === '' ? undefined : v);

export default class SynqContribute extends PluginCommand<Result> {
  static override description =
    'Contribute testnet AUSD from your Agent Wallet to your Synq group Safe (bounded, policy-gated, reconciled). If the Agent Wallet gateway rejects Monad testnet, set SYNQ_MM_RPC_URL to an https Monad testnet RPC: it serves reads and receipt polling after its eth_chainId is verified; signing stays in the Agent Wallet.';
  static override examples = [
    '<%= config.bin %> synq contribute my-club 1 --dry-run --json',
    '<%= config.bin %> synq contribute my-club 1 --json',
    'SYNQ_MM_RPC_URL=https://testnet-rpc.monad.xyz <%= config.bin %> synq contribute my-club 1 --json',
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:contribute';

  async execute(io: CommandIO): Promise<Result> {
    const i = await io.resolveInputs(inputs);
    return asCommand(() =>
      contribute(
        depsFor(this.ctx, io, 'synq:contribute'),
        {
          groupId: i.group,
          amount: i.amount,
          mandateId: opt(i.mandateId),
          requestId: opt(i.requestId),
          from: opt(i.from),
          dryRun: i.dryRun,
        },
        { journal: journalFromEnv(), capBaseUnits: capFromEnv(process.env) },
      ),
    );
  }

  override successHint(data: Result): string {
    return data.mode === 'DRY_RUN'
      ? `Prepared ${data.amountFormatted} AUSD -> ${data.safe} (not submitted)`
      : `Contributed ${data.amountFormatted} AUSD: ${data.explorerUrl} (${data.fundingState})`;
  }
}
