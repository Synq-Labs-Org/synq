import { evaluateDca, type DcaDecision } from './evaluate.js';
import { parseDcaEvaluationInput } from './schema.js';

type Jsonify<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;
export type DcaDecisionJson = Jsonify<DcaDecision>;

function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJson(v)]),
    );
  return value;
}

export function decisionToJson(decision: DcaDecision): DcaDecisionJson {
  return toJson(decision) as DcaDecisionJson;
}

export function evaluateDcaActivity(input: unknown): DcaDecisionJson {
  return decisionToJson(evaluateDca(parseDcaEvaluationInput(input)));
}
