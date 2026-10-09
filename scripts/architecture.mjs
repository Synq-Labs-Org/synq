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
      const loader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        (ts.isCallExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'createRequire');
      if (loader) {
        const specifier = literal(node.arguments[0]);
        if (specifier === null) dynamic.push(node.getText(source).slice(0, 60));
        else imports.push({ specifier, names: ['*'] });
      }
    }
    if (ts.isIdentifier(node) && node.text === 'createRequire')
      dynamic.push('createRequire');
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      cryptoNamespaces.has(node.expression.text) &&
      CRYPTO_SIGNING.has(node.name.text)
    )
      identifiers.add(`crypto.${node.name.text}`);
    if (ts.isIdentifier(node) && isSigningName(node.text))
      identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, identifiers, anyCount, dynamic: [...new Set(dynamic)] };
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
    packages.filter((p) => SIGNER_PACKAGES.test(p.dir)).map((p) => p.dir),
  );
  for (const pkg of packages)
    for (const file of sourceFiles(join(root, pkg.dir))) {
      const name = posix(relative(root, file));
      const { imports, identifiers, anyCount, dynamic } = analyze(
        name,
        readFileSync(file, 'utf8'),
      );
      const ui = UI.test(pkg.dir);
      const planner = PLANNER.test(pkg.dir) || ui;
      const deterministic = DETERMINISTIC.test(pkg.dir);
      if (identifiers.size && !SIGNER_PACKAGES.test(pkg.dir)) {
        if (planner)
          errors.push(
            `${name}: planner references signing authority ${[...identifiers].join(', ')}`,
          );
        if (deterministic)
          errors.push(`${name}: signing inside deterministic authority`);
      }
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
        const signs =
          signingImport(specifier, names) ||
          (target !== null && SIGNER_PACKAGES.test(target));
        if (planner && signs)
          errors.push(
            `${name}: planner imports signing authority ${specifier}`,
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
  return [...new Set(errors)];
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
