/** Tiny dependency-free highlighter for the docs code blocks. Output is escaped HTML. */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KEYWORDS: Record<string, string[]> = {
  ts: 'const let var function return if else for while import export from type interface async await new class extends true false null undefined throw try catch'.split(
    ' ',
  ),
  sol: 'contract function returns return if else for require emit event mapping address uint256 uint bytes32 bool public external internal view pure payable memory calldata struct enum import pragma interface'.split(
    ' ',
  ),
  bash: 'curl export cd echo if then fi for do done pnpm git node'.split(' '),
  json: ['true', 'false', 'null'],
};

const ALIAS: Record<string, string> = {
  typescript: 'ts',
  tsx: 'ts',
  js: 'ts',
  javascript: 'ts',
  solidity: 'sol',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  http: 'bash',
};

export function highlight(code: string, lang: string): string {
  const key = ALIAS[lang] ?? lang;
  const words = KEYWORDS[key];
  if (!words) return esc(code);
  const comment =
    key === 'bash' ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const re = new RegExp(
    `(${key === 'json' ? '(?!)' : comment})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`[^\`]*\`)|(\\b\\d[\\d_.]*\\b)|(\\b[A-Za-z_$][\\w$]*\\b)`,
    'g',
  );
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    out += esc(code.slice(last, i));
    last = i + m[0].length;
    const [text, cm, str, num, word] = m;
    const t = esc(text);
    if (cm) out += `<span class="tk-c">${t}</span>`;
    else if (str) {
      const isKey = key === 'json' && /^\s*:/.test(code.slice(last));
      out += `<span class="${isKey ? 'tk-k' : 'tk-s'}">${t}</span>`;
    } else if (num) out += `<span class="tk-n">${t}</span>`;
    else if (word && words.includes(word))
      out += `<span class="tk-w">${t}</span>`;
    else out += t;
  }
  return out + esc(code.slice(last));
}
