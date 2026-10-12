import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { strategies } from '../../core/reads.js';
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

type Result = Awaited<ReturnType<typeof strategies>>;

export default class SynqStrategies extends PluginCommand<Result> {
  static override description =
    'Show the Synq mandates (strategy caps and budgets) and scheduled workflows for a group.';
  static override examples = [
    '<%= config.bin %> synq strategies my-club --json',
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:strategies';

  async execute(io: CommandIO): Promise<Result> {
    const { group } = await io.resolveInputs(inputs);
    return asCommand(() =>
      strategies(depsFor(this.ctx, io, 'synq:strategies'), group),
    );
  }
}
