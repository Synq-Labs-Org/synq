import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { treasury } from '../../core/reads.js';
import { asCommand, depsFor } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Synq group id',
    required: true,
    index: 0,
  },
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof treasury>>;

export default class SynqTreasury extends PluginCommand<Result> {
  static override description = 'Show a Synq group treasury';
  static override examples = ['<%= config.bin %> synq treasury my-club --json'];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:treasury';

  async execute(io: CommandIO): Promise<Result> {
    const { group } = await io.resolveInputs(inputs);
    return asCommand(() =>
      treasury(depsFor(this.ctx, io, 'synq:treasury'), group),
    );
  }
}
