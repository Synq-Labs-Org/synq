import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { fail } from '../../core/errors.js';
import { dca, type ProposalResult } from '../../core/proposals.js';
import { asCommand, depsFor, readJson } from '../../plugin-host.js';

const inputs = {
  group: {
    type: InputFieldType.Text,
    flag: 'group',
    message: 'Synq group id',
    required: true,
    index: 0,
  },
  template: {
    type: InputFieldType.Text,
    flag: 'template',
    message: 'Path to a mandate JSON whose bindings perform the buy',
    required: true,
  },
  perBuy: {
    type: InputFieldType.Text,
    flag: 'per-buy',
    message: 'AUSD per buy',
    required: true,
  },
  budget: {
    type: InputFieldType.Text,
    flag: 'budget',
    message: 'Total AUSD budget',
    required: true,
  },
  interval: {
    type: InputFieldType.Text,
    flag: 'interval-seconds',
    message: 'Minimum seconds between buys (>= 3600)',
    required: true,
  },
  maxExecutions: {
    type: InputFieldType.Text,
    flag: 'max-executions',
    message: 'Maximum number of buys',
    required: true,
  },
  validUntil: {
    type: InputFieldType.Text,
    flag: 'valid-until',
    message: 'End of the schedule (ISO date or unix seconds)',
    required: true,
  },
  mandateId: {
    type: InputFieldType.Text,
    flag: 'mandate-id',
    message: 'Synq mandate id for the DCA (defaults to the template id)',
    required: false,
    prompt: false,
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

const int = (name: string, v: string) =>
  /^[0-9]{1,12}$/.test(v)
    ? Number(v)
    : fail('INVALID_INPUT', `${name} must be an integer`);
const time = (v: string) => {
  if (/^[0-9]{9,12}$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isNaN(ms)
    ? fail('INVALID_INPUT', `valid-until ${v} is not a date`)
    : Math.floor(ms / 1000);
};

export default class SynqDca extends PluginCommand<ProposalResult> {
  static override description =
    'Propose a bounded AUSD dollar-cost-averaging mandate; group quorum must approve before any buy.';
  static override examples = [
    '<%= config.bin %> synq dca my-club --template dca.json --per-buy 2 --budget 20 --interval-seconds 604800 --max-executions 10 --valid-until 2026-12-31 --change NEW',
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'synq:dca';

  async execute(io: CommandIO): Promise<ProposalResult> {
    const i = await io.resolveInputs(inputs);
    return asCommand(async () =>
      dca(depsFor(this.ctx, io, 'synq:dca'), {
        groupId: i.group,
        template: await readJson(i.template),
        perBuy: i.perBuy,
        budget: i.budget,
        intervalSeconds: int('interval-seconds', i.interval),
        maxExecutions: int('max-executions', i.maxExecutions),
        validUntil: time(i.validUntil),
        mandateId: i.mandateId || undefined,
        change: i.change as 'NEW' | 'SUPERSEDE',
      }),
    );
  }
}
