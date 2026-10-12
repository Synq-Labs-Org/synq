import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { receipts } from '../../core/reads.js';
import { asCommand, depsFor, journalFromEnv } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Synq group id',
    required: true,
    index: 0,
  },
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof receipts>>;

export default class SynqReceipts extends PluginCommand<Result> {
  static override description =
    'List your Synq contribution receipts: local submissions and indexed deposits, with explorer links.';
  static override examples = ['<%= config.bin %> synq receipts my-club --json'];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:receipts';

  async execute(io: CommandIO): Promise<Result> {
    const { group } = await io.resolveInputs(inputs);
    return asCommand(() =>
      receipts(depsFor(this.ctx, io, 'synq:receipts'), journalFromEnv(), group),
    );
  }
}
