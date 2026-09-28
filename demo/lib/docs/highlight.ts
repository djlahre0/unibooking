/**
 * A small TypeScript / shell tokenizer for the docs' code blocks. Deliberately
 * lexical: it colours comments, strings, keywords, numbers, types and calls,
 * which is all a reader needs, without shipping a grammar engine. The output
 * is plain tokens; `CodeBlock` turns them into spans, so no HTML is built
 * from strings anywhere.
 */
export type TokenType =
  'comment' | 'string' | 'keyword' | 'number' | 'type' | 'fn' | 'punct' | 'text';

export type Token = { type: TokenType; text: string };

const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'const',
  'let',
  'var',
  'function',
  'return',
  'await',
  'async',
  'if',
  'else',
  'for',
  'of',
  'in',
  'new',
  'try',
  'catch',
  'throw',
  'type',
  'interface',
  'extends',
  'true',
  'false',
  'null',
  'undefined',
  'default',
  'switch',
  'case',
  'break',
  'as',
  'typeof',
]);

const TS_RULES: Array<[TokenType, RegExp]> = [
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
  ['string', /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/y],
  ['number', /\b\d[\d_]*(?:\.\d+)?\b/y],
  ['text', /[A-Za-z_$][\w$]*/y],
  ['punct', /[{}()[\];,.:<>=+\-*/!?&|%^~@]/y],
  ['text', /\s+/y],
];

const SHELL_RULES: Array<[TokenType, RegExp]> = [
  ['comment', /#[^\n]*/y],
  ['string', /'[^'\n]*'|"(?:\\.|[^"\\\n])*"/y],
  ['text', /[^\s#'"]+/y],
  ['text', /\s+/y],
];

export function tokenize(code: string, lang: string): Token[] {
  // Diagrams and plain output: nothing to colour.
  if (lang === 'text') return [{ type: 'text', text: code }];
  const shell = lang === 'bash' || lang === 'sh' || lang === 'shell';
  const rules = shell ? SHELL_RULES : TS_RULES;
  const out: Token[] = [];
  let i = 0;
  let lineStart = true;
  while (i < code.length) {
    let matched = false;
    for (const [type, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || m[0].length === 0) continue;
      let t: TokenType = type;
      const text = m[0];
      if (shell) {
        // The command word of each line: `npm`, `node`, `npx`…
        if (type === 'text' && lineStart && /\S/.test(text)) t = 'fn';
      } else if (type === 'text' && /^[A-Za-z_$]/.test(text)) {
        if (KEYWORDS.has(text)) t = 'keyword';
        else if (/^[A-Z]/.test(text)) t = 'type';
        else if (code[i + text.length] === '(') t = 'fn';
      }
      push(out, t, text);
      if (/\S/.test(text)) lineStart = false;
      if (text.includes('\n')) lineStart = true;
      i += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      push(out, 'text', code[i]!);
      i += 1;
    }
  }
  return out;
}

/** Merge adjacent plain text so the DOM stays small. */
function push(out: Token[], type: TokenType, text: string): void {
  const prev = out[out.length - 1];
  if (prev && prev.type === type && type === 'text') prev.text += text;
  else out.push({ type, text });
}
