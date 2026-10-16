import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOTS = ['packages', 'apps', 'workers', 'plugins'];
const SKIPPED = new Set(['node_modules', 'dist', 'generated', '.git', 'out']);
const UI = /^apps\/web$/;
const PLANNER =
  /^(packages\/(agent-runtime|brain|world-model|strategy-engine)|plugins\/[^/]+)$/;
const DETERMINISTIC = /^packages\/(domain|schemas|kernel)$/;
const SIGNER_PACKAGES = /^(workers\/execution|packages\/wallet-core)$/;
const HUMAN_SIGNING_BOUNDARY = /^packages\/identity$/;
// Perpl API-key signer, key-file loader and test operator wallet live only in
// execution infrastructure; planner zones may not reach them or name their keys.
const PERPL_SIGNER = /^workers\/perpl-executor$/;
const PERPL_KEY_MATERIAL =
  /SYNQ_PERPL_[A-Z_]*KEY[A-Z_]*|SYNQ_TESTNET_KEY_FILE|perpl\/(read|trade)\.key/;
const SIGNING_PRIMITIVE_MODULES =
  /^(viem\/accounts|ethers\/wallet|@noble\/(curves|secp256k1|ed25519)(\/.*)?|@scure\/bip(32|39)(\/.*)?|@synq\/(execution-worker|wallet-core)(\/.*)?)$/;
const VIEM_MODULES = /^viem(\/actions|\/wallet)?$/;
const ETHERS_MODULES = /^ethers(\/.*)?$/;
const ETHERS_VERIFICATION_API = new Set([
  'verifyMessage',
  'verifyTypedData',
  'recoverAddress',
  'hashMessage',
  'TypedDataEncoder',
  'getAddress',
  'isAddress',
  'keccak256',
  'id',
  'solidityPackedKeccak256',
  'AbiCoder',
  'Interface',
  'getBytes',
  'hexlify',
  'toUtf8Bytes',
  'ZeroAddress',
]);
const SIGNING_NAMES = new Set([
  'privateKeyToAccount',
  'mnemonicToAccount',
  'hdKeyToAccount',
  'generatePrivateKey',
  'generateMnemonic',
  'createWalletClient',
  'walletActions',
  'toAccount',
  'writeContract',
  'deployContract',
  'Wallet',
  'HDNodeWallet',
  'SigningKey',
  'HDKey',
]);
export function isSigningName(name) {
  return (
    SIGNING_NAMES.has(name) ||
    /^(sign|send)(Transaction|RawTransaction|Message|TypedData|Authorization|Calls|UserOperation)$/.test(
      name,
    )
  );
}
export function signingImport(specifier, names) {
  if (SIGNING_PRIMITIVE_MODULES.test(specifier)) return true;
  if (/^(node:)?crypto$/.test(specifier))
    return names.some((n) =>
      [
        'sign',
        'createSign',
        'generateKeyPair',
        'generateKeyPairSync',
        'createPrivateKey',
        'privateEncrypt',
      ].includes(n),
    );
  if (VIEM_MODULES.test(specifier))
    return names.some((n) => n === '*' || isSigningName(n));
  if (ETHERS_MODULES.test(specifier))
    return names.some((n) => !ETHERS_VERIFICATION_API.has(n));
  return false;
}
const DYNAMIC_LOADING_ALLOWED = new Set([]);
const DISTINCTIVE_CHAIN_IDS = new Set(['31337', '10143']);
const CHAIN_LITERAL_OWNERS = /^packages\/(schemas|chain-registry)$/;
const CHAIN_COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const KEY_LOADER = /^load[A-Za-z]*Key$/;
const SECRET_MATERIAL =
  /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|_KEY_FILE|AUDIT_KEY|JOURNAL_KEY|OWNER_KEY|DEPLOYER_KEY|secrets\.env)/;
const PLANNER_FORBIDDEN_MODULES =
  /^(@synq\/(execution-worker|wallet-core|identity)(\/.*)?|.*\/(workers\/execution|contracts)(\/.*)?)$/;
const BRAIN_ZONE =
  /^(packages\/(agent-runtime|brain|world-model)|plugins\/(qwen|kimi|openai))$/;
// Arc v3: packages on the active Arc runtime may not reach archived Monad
// sponsor integrations, directly or transitively. Their code and tests stay.
const ARC_ACTIVE =
  /^(packages\/(domain|schemas|kernel|identity|chain-registry|ledger|invoices|payables|treasury|governance|arc-execution|settlement|funding|channels|agent-runtime|offer-exchange|world-model)|plugins\/circle-[a-z-]+)$/;
const LEGACY_MONAD =
  /^(plugins\/(kuru|perpl|agora|aurora|chainlink-cre|layerzero)|workers\/perpl-executor)$/;
const MODEL_SDKS =
  /^(openai|ai|langchain|@langchain\/.*|@mastra\/.*|@anthropic-ai\/.*|@openai\/.*)$/;

export function sourceFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx|mts|mjs|js)$/.test(path) && !/\.d\.m?ts$/.test(path)
        ? [path]
        : [];
  });
}
const posix = (path) => path.split(sep).join('/');
function discoverPackages(root) {
  const packages = [];
  for (const group of PACKAGE_ROOTS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const dir = `${group}/${entry.name}`;
      const manifest = join(root, dir, 'package.json');
      const name = existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, 'utf8')).name
        : null;
      packages.push({ dir, name });
    }
  }
  return packages;
}
const CRYPTO_MODULES = /^(node:)?crypto$/;
const CRYPTO_SIGNING = new Set([
  'sign',
  'createSign',
  'generateKeyPair',
  'generateKeyPairSync',
  'createPrivateKey',
  'privateEncrypt',
]);
function analyze(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = [];
  const identifiers = new Set();
  const dynamic = [];
  const cryptoNamespaces = new Set();
  const rawChainIds = [];
  const keyLoaders = new Set();
  const secretLiterals = new Set();
  const reportedChainLiterals = new WeakSet();
  let anyCount = 0;
  const visitType = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount++;
    ts.forEachChild(node, visitType);
  };
  const literal = (node) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const reference = (node) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isIdentifier(node)) return node.text;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['globalThis', 'global', 'window', 'self'].includes(node.expression.text)
    )
      return node.name.text;
    return null;
  };
  const memberName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node))
      return literal(node.argumentExpression);
    return undefined;
  };
  const loadedCryptoUse = (call) => {
    let node = call;
    for (;;) {
      const parent = node.parent;
      if (
        parent &&
        (ts.isAwaitExpression(parent) ||
          ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isNonNullExpression(parent))
      )
        node = parent;
      else break;
    }
    const parent = node.parent;
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node
    ) {
      if (ts.isIdentifier(parent.name))
        return { names: [], namespace: parent.name.text, opaque: false };
      if (ts.isObjectBindingPattern(parent.name)) {
        const names = [];
        for (const el of parent.name.elements) {
          const key = el.propertyName ?? el.name;
          if (el.dotDotDotToken) return { names: [], opaque: true };
          if (ts.isIdentifier(key) || ts.isStringLiteral(key))
            names.push(key.text);
          else return { names: [], opaque: true };
        }
        return { names, opaque: false };
      }
      return { names: [], opaque: true };
    }
    if (
      parent &&
      memberName(parent) !== undefined &&
      parent.expression === node
    ) {
      const name = memberName(parent);
      return name === null || ['then', 'catch', 'finally'].includes(name)
        ? { names: [], opaque: true }
        : { names: [name], opaque: false };
    }
    if (parent && ts.isExpressionStatement(parent))
      return { names: [], opaque: false };
    return { names: [], opaque: true };
  };
  const visit = (node) => {
    if (ts.isTypeNode(node)) {
      visitType(node);
      return;
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = ts.isImportDeclaration(node) ? node.importClause : null;
      const runtime = [];
      let typeOnly = ts.isImportDeclaration(node)
        ? (clause?.isTypeOnly ?? false)
        : node.isTypeOnly;
      if (clause?.name) runtime.push('default');
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        runtime.push('*');
        if (CRYPTO_MODULES.test(specifier))
          cryptoNamespaces.add(clause.namedBindings.name.text);
      }
      if (clause?.name && CRYPTO_MODULES.test(specifier))
        cryptoNamespaces.add(clause.name.text);
      const elements =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : ts.isExportDeclaration(node) &&
              node.exportClause &&
              ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : [];
      for (const el of elements)
        if (!el.isTypeOnly) runtime.push((el.propertyName ?? el.name).text);
      if (ts.isExportDeclaration(node) && !node.exportClause) runtime.push('*');
      if (!typeOnly && runtime.length === 0 && elements.length > 0)
        typeOnly = true;
      if (!typeOnly) imports.push({ specifier, names: runtime });
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        !node.isTypeOnly
      ) {
        const specifier = literal(node.moduleReference.expression);
        if (specifier === null) dynamic.push('import = require(<computed>)');
        else imports.push({ specifier, names: ['*'] });
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const getBuiltin =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'getBuiltinModule';
      const loader =
        getBuiltin ||
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        (ts.isCallExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'createRequire');
      if (getBuiltin) dynamic.push('process.getBuiltinModule');
      if (loader) {
        const specifier = literal(node.arguments[0]);
        if (specifier === null) dynamic.push(node.getText(source).slice(0, 60));
        else if (CRYPTO_MODULES.test(specifier)) {
          const use = loadedCryptoUse(node);
          imports.push({ specifier, names: use.names });
          if (use.namespace) cryptoNamespaces.add(use.namespace);
          if (use.opaque) identifiers.add('crypto.<dynamic>');
        } else imports.push({ specifier, names: ['*'] });
      }
    }
    if (ts.isNewExpression(node) && reference(node.expression) === 'Function')
      dynamic.push('new Function');
    if (ts.isCallExpression(node) && reference(node.expression) === 'eval')
      dynamic.push('eval');
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'require' &&
      ts.isIdentifier(node.expression) &&
      ['globalThis', 'global', 'module', 'window', 'self'].includes(
        node.expression.text,
      )
    )
      dynamic.push(`${node.expression.text}.require`);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['globalThis', 'global', 'module', 'window', 'self'].includes(
        node.expression.text,
      ) &&
      ['require', 'eval', 'Function', null].includes(
        literal(node.argumentExpression),
      )
    )
      dynamic.push(`${node.expression.text}[...]`);
    const member = memberName(node);
    if (member !== undefined) {
      const base = node.expression;
      if (
        ts.isIdentifier(base) &&
        cryptoNamespaces.has(base.text) &&
        (member === null || CRYPTO_SIGNING.has(member))
      )
        identifiers.add(`crypto.${member ?? '<computed>'}`);
      if (
        (member === null || member === 'sign' || member === 'generateKey') &&
        memberName(base) === 'subtle'
      )
        identifiers.add(`crypto.subtle.${member ?? '<computed>'}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      CHAIN_COMPARISON.has(node.operatorToken.kind)
    ) {
      const sides = [node.left, node.right];
      const chainSide = sides.some((side) => {
        while (ts.isParenthesizedExpression(side)) side = side.expression;
        if (ts.isAwaitExpression(side)) side = side.expression;
        while (ts.isParenthesizedExpression(side)) side = side.expression;
        if (ts.isCallExpression(side)) side = side.expression;
        const name = ts.isIdentifier(side)
          ? side.text
          : ts.isPropertyAccessExpression(side)
            ? side.name.text
            : null;
        return name !== null && /chainid$/i.test(name);
      });
      if (chainSide && sides.some((side) => ts.isNumericLiteral(side))) {
        rawChainIds.push(node.getText(source));
        for (const side of sides) reportedChainLiterals.add(side);
      }
    } else if (
      ts.isNumericLiteral(node) &&
      DISTINCTIVE_CHAIN_IDS.has(node.text) &&
      !reportedChainLiterals.has(node)
    )
      rawChainIds.push(node.getText(source));
    if (ts.isIdentifier(node) && node.text === 'createRequire')
      dynamic.push('createRequire');
    if (ts.isIdentifier(node) && isSigningName(node.text))
      identifiers.add(node.text);
    if (ts.isIdentifier(node) && KEY_LOADER.test(node.text))
      keyLoaders.add(node.text);
    const text = literal(node);
    if (text !== null && SECRET_MATERIAL.test(text))
      secretLiterals.add(text.slice(0, 60));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    imports,
    identifiers,
    keyLoaders,
    secretLiterals,
    anyCount,
    rawChainIds,
    dynamic: [...new Set(dynamic)],
  };
}
export function checkArchitecture(root) {
  const errors = [];
  const packages = discoverPackages(root);
  const byName = new Map(
    packages.filter((p) => p.name).map((p) => [p.name, p.dir]),
  );
  const ownerOf = (absolute) => {
    const path = posix(relative(root, absolute));
    return (
      packages.find((p) => path === p.dir || path.startsWith(`${p.dir}/`))
        ?.dir ?? null
    );
  };
  const graph = new Map(packages.map((p) => [p.dir, new Set()]));
  const signers = new Set(
    packages
      .filter((p) => SIGNER_PACKAGES.test(p.dir) || PERPL_SIGNER.test(p.dir))
      .map((p) => p.dir),
  );
  for (const pkg of packages)
    for (const file of sourceFiles(join(root, pkg.dir))) {
      const name = posix(relative(root, file));
      const text = readFileSync(file, 'utf8');
      const {
        imports,
        identifiers,
        keyLoaders,
        secretLiterals,
        anyCount,
        rawChainIds,
        dynamic,
      } = analyze(name, text);
      const ui = UI.test(pkg.dir);
      const planner = PLANNER.test(pkg.dir) || ui;
      const deterministic = DETERMINISTIC.test(pkg.dir);
      if (planner && PERPL_KEY_MATERIAL.test(text))
        errors.push(
          `${name}: planner references Perpl or operator key material`,
        );
      if (identifiers.size && !SIGNER_PACKAGES.test(pkg.dir)) {
        if (planner)
          errors.push(
            `${name}: planner references signing authority ${[...identifiers].join(', ')}`,
          );
        if (deterministic)
          errors.push(`${name}: signing inside deterministic authority`);
      }
      if (PLANNER.test(pkg.dir) && keyLoaders.size)
        errors.push(
          `${name}: planner references key loader ${[...keyLoaders].join(', ')}`,
        );
      if (PLANNER.test(pkg.dir) && secretLiterals.size)
        errors.push(
          `${name}: planner references secret key material ${[...secretLiterals].join(', ')}`,
        );
      if (
        (planner || deterministic) &&
        dynamic.length &&
        !DYNAMIC_LOADING_ALLOWED.has(name)
      )
        errors.push(
          `${name}: unresolvable dynamic module loading in restricted zone (${dynamic.join(', ')})`,
        );
      if (anyCount && !/\.test\.|fixture/.test(name))
        errors.push(`${name}: unchecked any`);
      if (
        rawChainIds.length &&
        !CHAIN_LITERAL_OWNERS.test(pkg.dir) &&
        !/\.test\.|fixture/.test(name)
      )
        errors.push(
          `${name}: raw chain-id comparison ${rawChainIds.join(', ')}; use @synq/chain-registry profile helpers`,
        );
      for (const { specifier, names } of imports) {
        let target = null;
        if (specifier.startsWith('.')) {
          target = ownerOf(resolve(dirname(file), specifier));
          if (target && target !== pkg.dir)
            errors.push(
              `${name}: cross-package relative import ${specifier}; use the @synq/* package name`,
            );
        } else if (specifier.startsWith('@synq/')) {
          const base = specifier.split('/').slice(0, 2).join('/');
          target = byName.get(base) ?? null;
          if (!target)
            errors.push(`${name}: unknown workspace package ${specifier}`);
        }
        if (target && target !== pkg.dir) graph.get(pkg.dir).add(target);
        if (planner && target && PERPL_SIGNER.test(target))
          errors.push(`${name}: planner imports the Perpl signer ${specifier}`);
        const signs =
          signingImport(specifier, names) ||
          (target !== null && SIGNER_PACKAGES.test(target));
        if (planner && signs)
          errors.push(
            `${name}: planner imports signing authority ${specifier}`,
          );
        if (
          BRAIN_ZONE.test(pkg.dir) &&
          (PLANNER_FORBIDDEN_MODULES.test(specifier) ||
            // Traveler, shipping and gift-code plaintext never reaches a model prompt.
            /^@synq\/profile-vault(\/.*)?$/.test(specifier) ||
            (target !== null &&
              /^(workers\/execution|packages\/(identity|wallet-core)|contracts)$/.test(
                target,
              )))
        )
          errors.push(
            `${name}: Brain zone imports signer, identity, ProfileVault or execution-secret module ${specifier}`,
          );
        if (
          deterministic &&
          (signs ||
            MODEL_SDKS.test(specifier) ||
            /^plugins\//.test(target ?? ''))
        )
          errors.push(
            `${name}: deterministic authority imports forbidden dependency ${specifier}`,
          );
        if (
          signingImport(specifier, names) &&
          !specifier.startsWith('@synq/') &&
          !SIGNER_PACKAGES.test(pkg.dir)
        )
          signers.add(pkg.dir);
      }
    }
  function signerPath(node, permitted, path = []) {
    if (path.includes(node)) return null;
    if (path.length && signers.has(node) && !permitted(node))
      return [...path, node];
    for (const dependency of graph.get(node) ?? []) {
      const found = signerPath(dependency, permitted, [...path, node]);
      if (found) return found;
    }
    return null;
  }
  for (const node of graph.keys()) {
    const zone = UI.test(node)
      ? 'planner'
      : PLANNER.test(node)
        ? 'planner'
        : DETERMINISTIC.test(node)
          ? 'deterministic authority'
          : null;
    if (!zone) continue;
    const path = signerPath(node, (dep) =>
      UI.test(node) ? HUMAN_SIGNING_BOUNDARY.test(dep) : false,
    );
    if (path)
      errors.push(`${zone} transitive signing authority: ${path.join(' -> ')}`);
  }
  function legacyPath(node, path = []) {
    if (path.includes(node)) return null;
    if (path.length && LEGACY_MONAD.test(node)) return [...path, node];
    for (const dependency of graph.get(node) ?? []) {
      const found = legacyPath(dependency, [...path, node]);
      if (found) return found;
    }
    return null;
  }
  for (const node of graph.keys()) {
    if (!ARC_ACTIVE.test(node)) continue;
    const path = legacyPath(node);
    if (path)
      errors.push(
        `Arc runtime reaches archived Monad integration: ${path.join(' -> ')}`,
      );
  }
  const reported = new Set();
  function visit(node, path) {
    const at = path.indexOf(node);
    if (at !== -1) {
      const cycle = [...path.slice(at), node];
      const key = [...cycle.slice(0, -1)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
      }
      return;
    }
    for (const dependency of graph.get(node) ?? [])
      visit(dependency, [...path, node]);
  }
  for (const node of graph.keys()) visit(node, []);
  errors.push(...checkWorkflowSandbox(root));
  return [...new Set(errors)];
}

// Temporal workflow sandbox: workflow code is replayed, so it may only reach deterministic modules.
// Activities, RPC clients, databases, the Kernel runtime and the execution worker stay out (type-only
// imports are fine). Kept as one block so other zone rules merge independently.
const WORKFLOW_SANDBOX_DIR = /^workers\/[^/]+\/src\/workflows\//;
const WORKFLOW_SANDBOX_ALLOWED =
  /^(@temporalio\/(workflow|common)|@synq\/(schemas|domain))$/;
const WORKFLOW_SANDBOX_GLOBALS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'require',
  'setInterval',
  'setImmediate',
]);
function workflowSandboxViolations(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : null;
      const elements =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : ts.isExportDeclaration(node) &&
              node.exportClause &&
              ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
            : [];
      const typeOnly =
        (ts.isImportDeclaration(node)
          ? (clause?.isTypeOnly ?? false)
          : node.isTypeOnly) ||
        (elements.length > 0 &&
          !clause?.name &&
          elements.every((el) => el.isTypeOnly));
      const specifier = node.moduleSpecifier.text;
      const local = specifier.startsWith('./');
      if (!typeOnly && !local && !WORKFLOW_SANDBOX_ALLOWED.test(specifier))
        found.push(`imports ${specifier}`);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      found.push('dynamic import');
    if (
      ts.isIdentifier(node) &&
      WORKFLOW_SANDBOX_GLOBALS.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    )
      found.push(`uses ${node.text}`);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    )
      found.push(`uses process.${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(found)];
}
export function checkWorkflowSandbox(root) {
  const errors = [];
  const base = join(root, 'workers');
  for (const file of sourceFiles(base)) {
    const name = posix(relative(root, file));
    if (!WORKFLOW_SANDBOX_DIR.test(name)) continue;
    for (const violation of workflowSandboxViolations(
      name,
      readFileSync(file, 'utf8'),
    ))
      errors.push(`${name}: workflow sandbox ${violation}`);
  }
  return errors;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkArchitecture(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log('Architecture boundaries and package dependency graph pass.');
}
