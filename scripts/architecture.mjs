import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOTS = ['packages', 'apps', 'workers', 'plugins'];
const SKIPPED = new Set(['node_modules', 'dist', 'generated', '.git', 'out']);
const PLANNER =
  /^(apps\/web|packages\/(agent-runtime|brain|world-model|strategy-engine)|plugins\/[^/]+)$/;
const DETERMINISTIC = /^packages\/(domain|schemas|kernel)$/;
const SIGNER_PACKAGES = /^(workers\/execution|packages\/wallet-core)$/;
const SIGNING_IDENTIFIERS = new Set([
  'privateKeyToAccount',
  'mnemonicToAccount',
  'hdKeyToAccount',
  'generatePrivateKey',
  'createWalletClient',
  'signTransaction',
  'sendTransaction',
  'sendRawTransaction',
]);
const SIGNING_MODULES =
  /^(viem\/accounts|@synq\/(execution-worker|wallet-core)(\/.*)?)$/;
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
  let anyCount = 0;
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names = [];
      const clause = ts.isImportDeclaration(node) ? node.importClause : null;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const el of clause.namedBindings.elements)
          names.push((el.propertyName ?? el.name).text);
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      )
        for (const el of node.exportClause.elements)
          names.push((el.propertyName ?? el.name).text);
      imports.push({ specifier: node.moduleSpecifier.text, names });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    )
      imports.push({ specifier: node.arguments[0].text, names: [] });
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      imports.push({ specifier: node.argument.literal.text, names: [] });
    else if (ts.isIdentifier(node) && SIGNING_IDENTIFIERS.has(node.text))
      identifiers.add(node.text);
    else if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, identifiers, anyCount };
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
      const { imports, identifiers, anyCount } = analyze(
        name,
        readFileSync(file, 'utf8'),
      );
      const planner = PLANNER.test(pkg.dir);
      const deterministic = DETERMINISTIC.test(pkg.dir);
      if (identifiers.size && !SIGNER_PACKAGES.test(pkg.dir)) {
        if (planner)
          errors.push(
            `${name}: planner references signing authority ${[...identifiers].join(', ')}`,
          );
        if (deterministic)
          errors.push(`${name}: signing inside deterministic authority`);
      }
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
        const signingImport =
          SIGNING_MODULES.test(specifier) ||
          (specifier === 'viem' &&
            names.some((n) => SIGNING_IDENTIFIERS.has(n))) ||
          (target !== null && SIGNER_PACKAGES.test(target));
        if (planner && signingImport)
          errors.push(
            `${name}: planner imports signing authority ${specifier}`,
          );
        if (
          deterministic &&
          (signingImport ||
            MODEL_SDKS.test(specifier) ||
            /^plugins\//.test(target ?? ''))
        )
          errors.push(
            `${name}: deterministic authority imports forbidden dependency ${specifier}`,
          );
        if (
          specifier === 'viem/accounts' ||
          (specifier === 'viem' &&
            names.some((n) => SIGNING_IDENTIFIERS.has(n)))
        )
          if (
            !SIGNER_PACKAGES.test(pkg.dir) &&
            !pkg.dir.startsWith('apps/demo')
          )
            signers.add(pkg.dir);
      }
    }
  function signerPath(node, path = []) {
    if (path.includes(node)) return null;
    if (signers.has(node)) return [...path, node];
    for (const dependency of graph.get(node) ?? []) {
      const found = signerPath(dependency, [...path, node]);
      if (found) return found;
    }
    return null;
  }
  for (const node of graph.keys())
    if (PLANNER.test(node)) {
      const path = signerPath(node);
      if (path)
        errors.push(
          `planner transitive signing authority: ${path.join(' -> ')}`,
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
