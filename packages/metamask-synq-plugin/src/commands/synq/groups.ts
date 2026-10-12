import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { groups, type GroupSummary } from '../../core/reads.js';
import { asCommand, depsFor, groupList } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Comma-separated Synq group ids (defaults to SYNQ_MM_GROUPS)',
    required: false,
    prompt: false,
    index: 0,
  },
} satisfies InputSchema;

type Result = { wallet: string | null; groups: GroupSummary[] };

export default class SynqGroups extends PluginCommand<Result> {
  static override description =
    'List Synq groups, their MandateRegistry-verified Safe and your membership (Monad testnet).';
  static override examples = [
    '<%= config.bin %> synq groups --group my-club --json',
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:groups';

  async execute(io: CommandIO): Promise<Result> {
    const { group } = await io.resolveInputs(inputs);
    return asCommand(() =>
      groups(depsFor(this.ctx, io, 'synq:groups'), groupList(group)),
    );
  }

  override successHint(data: Result): string {
    return `${data.groups.length} group(s); member of ${data.groups.filter((g) => g.myMembership === 'ACTIVE').length}`;
  }
}
