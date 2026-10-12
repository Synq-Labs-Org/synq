import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { propose, type ProposalResult } from '../../core/proposals.js';
import { asCommand, depsFor, readJson } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Synq group id',
    required: true,
    index: 0,
  },
  mandateFile: {
    type: InputFieldType.Text,
    flag: 'mandate-file',
    message: 'Path to the mandate JSON to propose',
    required: true,
  },
  change: {
    type: InputFieldType.Select,
    flag: 'change',
    message: 'New mandate or supersede an existing one',
    options: [
      { value: 'NEW', label: 'NEW' },
      { value: 'SUPERSEDE', label: 'SUPERSEDE' },
    ],
    required: true,
  },
} satisfies InputSchema;

export default class SynqPropose extends PluginCommand<ProposalResult> {
  static override description =
    'Propose a Synq mandate for group approval; the Kernel and approver quorum decide, never this plugin.';
  static override examples = [
    '<%= config.bin %> synq propose my-club --mandate-file mandate.json --change NEW --json',
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:propose';

  async execute(io: CommandIO): Promise<ProposalResult> {
    const i = await io.resolveInputs(inputs);
    return asCommand(async () =>
      propose(depsFor(this.ctx, io, 'synq:propose'), {
        groupId: i.group,
        mandate: await readJson(i.mandateFile),
        change: i.change as 'NEW' | 'SUPERSEDE',
      }),
    );
  }

  override successHint(data: ProposalResult): string {
    return `Proposal ${data.proposalId} is ${data.state}: ${data.approvals.counted}/${data.approvals.required} approvals`;
  }
}
