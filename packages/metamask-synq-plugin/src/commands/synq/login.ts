import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { login } from '../../core/group.js';
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

type Result = Awaited<ReturnType<typeof login>>;

export default class SynqLogin extends PluginCommand<Result> {
  static override description =
    'Sign in to a Synq group as your member wallet (EIP-712); grants a 5-minute member-scoped session.';
  static override examples = ['<%= config.bin %> synq login my-club --json'];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:login';

  async execute(io: CommandIO): Promise<Result> {
    const { group } = await io.resolveInputs(inputs);
    return asCommand(() => login(depsFor(this.ctx, io, 'synq:login'), group));
  }

  override successHint(data: Result): string {
    return `Signed in to ${data.groupId} as ${data.memberId} until ${new Date(data.expiresAt * 1000).toISOString()}`;
  }
}
