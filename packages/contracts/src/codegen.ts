import { z } from 'zod';
import { CONTRACT_VERSION } from './common.js';
import { NAMED_SCHEMAS } from './index.js';
import { ROUTES } from './routes.js';

/*
 * Generates the OpenAPI document and Swift Codable models from the zod
 * contract, so iOS and web never hand-copy wire types. Pure: the CLI in
 * scripts/contracts-generate.ts writes the files and a test checks they match.
 */

type Json = { [k: string]: unknown };
const REF = '#/components/schemas/';

export function componentSchemas(): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(NAMED_SCHEMAS))
    registry.add(schema, { id });
  const out = z.toJSONSchema(registry, {
    uri: (id) => `${REF}${id}`,
    unrepresentable: 'any',
  }) as { schemas: Record<string, Json> };
  const schemas: Record<string, Json> = {};
  for (const [id, s] of Object.entries(out.schemas)) {
    const { $schema: _s, $id: _i, ...rest } = s;
    schemas[id] = rest;
  }
  return schemas;
}

function nameOf(schema: z.ZodType): string | undefined {
  return Object.entries(NAMED_SCHEMAS).find(([, s]) => s === schema)?.[0];
}

function inlineSchema(schema: z.ZodType): Json {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  }) as Json;
  return rest;
}

function ref(schema: z.ZodType): Json {
  const name = nameOf(schema);
  return name ? { $ref: `${REF}${name}` } : inlineSchema(schema);
}

export function openApi(): Json {
  const paths: Record<string, Json> = {};
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const query = r.query
      ? Object.entries(
          (inlineSchema(r.query).properties ?? {}) as Record<string, Json>,
        ).map(([name, schema]) => ({
          name,
          in: 'query',
          required: false,
          schema,
        }))
      : [];
    const op: Json = {
      operationId: r.id,
      summary: r.summary,
      'x-synq-auth': r.auth,
      'x-synq-roles': r.roles,
      'x-synq-status': r.status,
      parameters: [
        ...params,
        ...query,
        ...(r.auth === 'mutation'
          ? [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ]
          : []),
      ],
      responses: {
        '200':
          r.response === 'text/event-stream'
            ? {
                description:
                  'Server-sent events; each data line is a StreamEvent',
                content: {
                  'text/event-stream': {
                    schema: { $ref: `${REF}StreamEvent` },
                  },
                },
              }
            : {
                description: 'OK',
                content: { 'application/json': { schema: ref(r.response) } },
              },
        default: {
          description: 'Error',
          content: {
            'application/json': { schema: { $ref: `${REF}ApiError` } },
          },
        },
      },
    };
    if (r.request)
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: ref(r.request) } },
      };
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Synq app API',
      version: CONTRACT_VERSION,
      description:
        'One backend for the iOS app, web hub and channel bots. Money is integer base units in decimal strings; times are UTC ISO-8601. Login never approves payments.',
    },
    paths,
    components: { schemas: componentSchemas() },
  };
}

// MARK: Swift

const SWIFT_RESERVED = new Set([
  'default',
  'class',
  'struct',
  'enum',
  'protocol',
  'extension',
  'func',
  'var',
  'let',
  'operator',
  'return',
  'self',
  'Self',
  'super',
  'init',
  'internal',
  'public',
  'private',
  'static',
  'subscript',
  'import',
  'in',
  'is',
  'as',
  'case',
  'switch',
  'where',
  'while',
  'repeat',
  'if',
  'else',
  'for',
  'do',
  'catch',
  'throw',
  'throws',
  'try',
  'true',
  'false',
  'nil',
]);
const id = (s: string) => (SWIFT_RESERVED.has(s) ? `\`${s}\`` : s);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Nested type name for a property; avoids names Swift reserves for members. */
const typeName = (hint: string) => {
  const n = upper(hint);
  return ['Type', 'Protocol', 'Self', 'Any'].includes(n) ? `${n}Value` : n;
};
function caseName(raw: string): string {
  const parts = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const name = parts.map((p, i) => (i ? upper(p) : p)).join('') || 'empty';
  return id(/^[0-9]/.test(name) ? `v${name}` : name);
}

class SwiftWriter {
  readonly blocks: string[] = [];

  enumBlock(name: string, values: string[], indent = ''): string {
    const cases = values.map(
      (v) => `${indent}    case ${caseName(v)} = ${JSON.stringify(v)}`,
    );
    return [
      `${indent}public enum ${name}: String, Codable, Sendable, CaseIterable, Equatable {`,
      ...cases,
      `${indent}    /// A value this client version does not know yet.`,
      `${indent}    case unknown = "__unknown__"`,
      '',
      `${indent}    public init(from decoder: Decoder) throws {`,
      `${indent}        let raw = try decoder.singleValueContainer().decode(String.self)`,
      `${indent}        self = Self(rawValue: raw) ?? .unknown`,
      `${indent}    }`,
      `${indent}}`,
    ].join('\n');
  }

  /** Swift type for a property schema; nested types are appended to `nested`. */
  type(schema: Json, hint: string, nested: string[], indent: string): string {
    if (typeof schema.$ref === 'string')
      return (schema.$ref as string).slice(REF.length);
    if (Array.isArray(schema.anyOf)) {
      const options = schema.anyOf as Json[];
      const nonNull = options.filter((o) => o.type !== 'null');
      if (nonNull.length === 1 && options.length === 2)
        return `${this.type(nonNull[0]!, hint, nested, indent)}?`;
      return 'JSONValue';
    }
    if (
      Array.isArray(schema.enum) &&
      schema.enum.every((v) => typeof v === 'string')
    ) {
      nested.push(
        this.enumBlock(typeName(hint), schema.enum as string[], indent),
      );
      return typeName(hint);
    }
    if ('const' in schema)
      return typeof schema.const === 'boolean'
        ? 'Bool'
        : typeof schema.const === 'number'
          ? 'Double'
          : 'String';
    switch (schema.type) {
      case 'string':
        return 'String';
      case 'integer':
        return 'Int';
      case 'number':
        return 'Double';
      case 'boolean':
        return 'Bool';
      case 'array':
        return `[${this.type((schema.items ?? {}) as Json, hint.endsWith('s') ? hint.slice(0, -1) : `${hint}Item`, nested, indent)}]`;
      case 'object': {
        if (schema.properties) {
          nested.push(this.structBlock(typeName(hint), schema, indent));
          return typeName(hint);
        }
        const values = schema.additionalProperties;
        if (values && typeof values === 'object' && Object.keys(values).length)
          return `[String: ${this.type(values as Json, `${hint}Value`, nested, indent)}]`;
        return '[String: JSONValue]';
      }
      default:
        return 'JSONValue';
    }
  }

  structBlock(name: string, schema: Json, indent = ''): string {
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required ?? []) as string[]);
    const nested: string[] = [];
    const fields = Object.entries(props).map(([key, prop]) => {
      let t = this.type(prop, key, nested, `${indent}    `);
      if (!required.has(key) && !t.endsWith('?')) t = `${t}?`;
      const doc =
        typeof prop.description === 'string'
          ? `${indent}    /// ${prop.description}\n`
          : '';
      return { key, t, doc };
    });
    const lines = [
      `${indent}public struct ${name}: Codable, Sendable, Equatable {`,
      ...fields.map(
        (f) => `${f.doc}${indent}    public var ${id(f.key)}: ${f.t}`,
      ),
    ];
    if (fields.length) {
      lines.push('');
      lines.push(
        `${indent}    public init(${fields.map((f) => `${f.key}: ${f.t}${f.t.endsWith('?') ? ' = nil' : ''}`).join(', ')}) {`,
      );
      for (const f of fields)
        lines.push(`${indent}        self.${id(f.key)} = ${id(f.key)}`);
      lines.push(`${indent}    }`);
    } else {
      lines.push(`${indent}    public init() {}`);
    }
    for (const n of nested) lines.push('', n);
    lines.push(`${indent}}`);
    return lines.join('\n');
  }
}

const JSON_VALUE = `/// Any JSON value (used for EIP-712 typed data passed straight to a wallet).
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}`;

export function swiftModels(): string {
  const w = new SwiftWriter();
  const out = [
    '// Generated by scripts/contracts-generate.ts from packages/contracts. Do not edit.',
    `// Synq app API contract ${CONTRACT_VERSION}. Money: integer base units as String. Times: ISO-8601 String.`,
    '',
    'import Foundation',
    '',
    `public enum SynqContract {\n    public static let version = ${JSON.stringify(CONTRACT_VERSION)}\n}`,
    '',
    JSON_VALUE,
  ];
  for (const [name, schema] of Object.entries(componentSchemas())) {
    out.push('');
    if (Array.isArray(schema.enum))
      out.push(w.enumBlock(name, schema.enum as string[]));
    else out.push(w.structBlock(name, schema));
  }
  const routes = ROUTES.map(
    (r) =>
      `        Route(id: ${JSON.stringify(r.id)}, method: ${JSON.stringify(r.method)}, path: ${JSON.stringify(r.path)}, mutation: ${r.auth === 'mutation'})`,
  );
  out.push(
    '',
    '/// Every v3 route; build URLs from `path` by replacing `{name}` segments.',
    'public struct Route: Sendable, Equatable {',
    '    public let id: String',
    '    public let method: String',
    '    public let path: String',
    '    /// Needs an Idempotency-Key header.',
    '    public let mutation: Bool',
    '',
    '    public static let all: [Route] = [',
    routes.join(',\n'),
    '    ]',
    '',
    '    public static func named(_ id: String) -> Route? { all.first { $0.id == id } }',
    '}',
    '',
  );
  return out.join('\n');
}
