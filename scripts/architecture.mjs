import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function sourceFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'generated', '.git'].includes(entry.name))
      return [];
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx|mjs|js)$/.test(path)
        ? [path]
        : [];
  });
}
export function checkArchitecture(root) {
  const errors = [];
  const graph = new Map();
  const files = ['packages', 'apps', 'workers'].flatMap((dir) =>
    sourceFiles(join(root, dir)),
  );
  const packageOf = (file) =>
    relative(root, file).split('/').slice(0, 2).join('/');
  for (const file of files) {
    const name = relative(root, file);
    const source = readFileSync(file, 'utf8');
    const owner = packageOf(file);
    if (
      /agent-runtime|brain|plugins\//.test(name) &&
      /\b(privateKeyToAccount|generatePrivateKey|signTransaction|sendTransaction|sendRawTransaction)\b/.test(
        source,
      )
    )
      errors.push(`${name}: planner references signing authority`);
    if (!graph.has(owner)) graph.set(owner, new Set());
    const imports = [
      ...source.matchAll(
        /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"]([^'"]+)['"]/g,
      ),
    ].map((match) => match[1]);
    for (const specifier of imports) {
      const target = specifier.startsWith('.')
        ? relative(root, resolve(dirname(file), specifier))
        : specifier;
      if (specifier.startsWith('.')) {
        const dependency = target.split('/').slice(0, 2).join('/');
        if (owner !== dependency) graph.get(owner).add(dependency);
      }
      const planner = /agent-runtime|brain|plugins\//.test(name);
      if (
        planner &&
        /wallet-core|workers\/execution|privateKeyToAccount|signTransaction|sendTransaction/.test(
          target,
        )
      )
        errors.push(`${name}: planner imports signing authority ${specifier}`);
      if (
        /packages\/(domain|schemas|kernel)\//.test(name) &&
        /openai|mastra|langchain|workers\/execution|wallet-core|plugins\//.test(
          target,
        )
      )
        errors.push(
          `${name}: deterministic authority imports forbidden dependency ${specifier}`,
        );
    }
    if (
      /packages\/(domain|schemas|kernel)\//.test(name) &&
      /\b(privateKeyToAccount|sendRawTransaction|signTransaction)\b/.test(
        source,
      )
    )
      errors.push(`${name}: signing inside deterministic authority`);
    if (
      !/\.test\.|fixture/.test(name) &&
      /(?:\bas\s+any\b|:\s*any\b)/.test(source)
    )
      errors.push(`${name}: unchecked any`);
  }
  function signerPath(node, path = []) {
    if (path.includes(node)) return null;
    if (/wallet-core|workers\/execution/.test(node)) return [...path, node];
    for (const dependency of graph.get(node) ?? []) {
      const found = signerPath(dependency, [...path, node]);
      if (found) return found;
    }
    return null;
  }
  for (const node of graph.keys()) {
    if (/agent-runtime|brain|plugins\//.test(node)) {
      const path = signerPath(node);
      if (path)
        errors.push(
          `planner transitive signing authority: ${path.join(' -> ')}`,
        );
    }
  }
  function visit(node, path) {
    if (path.includes(node)) {
      errors.push(`dependency cycle: ${[...path, node].join(' -> ')}`);
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
