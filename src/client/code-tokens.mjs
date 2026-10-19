import { createLowlight } from 'lowlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import ini from 'highlight.js/lib/languages/ini';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';

const MAX_CODE_LENGTH = 60_000;
const MAX_TREE_NODES = 120_000;
const MAX_TREE_DEPTH = 64;
const languages = [
  { name: 'javascript', label: 'JavaScript', grammar: javascript, aliases: ['js', 'jsx', 'node', 'nodejs', 'ecmascript'], extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  { name: 'typescript', label: 'TypeScript', grammar: typescript, aliases: ['ts', 'tsx'], extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { name: 'java', label: 'Java', grammar: java, extensions: ['java'] },
  { name: 'json', label: 'JSON', grammar: json, aliases: ['jsonc'], extensions: ['json', 'jsonc'] },
  { name: 'python', label: 'Python', grammar: python, aliases: ['py', 'python3'], extensions: ['py', 'pyw', 'pyi'] },
  { name: 'css', label: 'CSS', grammar: css, extensions: ['css'] },
  { name: 'xml', label: 'HTML / XML / Vue', grammar: xml, aliases: ['html', 'htm', 'xhtml', 'svg', 'vue'], extensions: ['xml', 'html', 'htm', 'xhtml', 'svg', 'vue'] },
  { name: 'bash', label: 'Shell', grammar: bash, aliases: ['shell', 'sh', 'zsh', 'shellscript', 'shell-script', 'console'], extensions: ['sh', 'bash', 'zsh'], filenames: ['.bashrc', '.bash_profile', '.bash_login', '.zshrc', '.zprofile', '.profile'] },
  { name: 'powershell', label: 'PowerShell', grammar: powershell, aliases: ['ps', 'ps1'], extensions: ['ps1', 'psm1', 'psd1'] },
  { name: 'yaml', label: 'YAML', grammar: yaml, aliases: ['yml'], extensions: ['yaml', 'yml'] },
  { name: 'sql', label: 'SQL', grammar: sql, extensions: ['sql'] },
  { name: 'markdown', label: 'Markdown', grammar: markdown, aliases: ['md', 'mdown', 'mkdn'], extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mdx'] },
  { name: 'go', label: 'Go', grammar: go, aliases: ['golang'], extensions: ['go'], filenames: ['go.mod'] },
  { name: 'rust', label: 'Rust', grammar: rust, aliases: ['rs'], extensions: ['rs'] },
  { name: 'c', label: 'C', grammar: c, extensions: ['c', 'h'] },
  { name: 'cpp', label: 'C++', grammar: cpp, aliases: ['c++', 'cplusplus', 'cc', 'cxx', 'hpp'], extensions: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++'] },
  { name: 'csharp', label: 'C#', grammar: csharp, aliases: ['c#', 'cs', 'c-sharp'], extensions: ['cs', 'csx'] },
  { name: 'php', label: 'PHP', grammar: php, extensions: ['php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'php8'] },
  { name: 'ruby', label: 'Ruby', grammar: ruby, aliases: ['rb'], extensions: ['rb', 'rake', 'gemspec'], filenames: ['gemfile', 'rakefile', 'guardfile', 'vagrantfile', 'berksfile'] },
  { name: 'ini', label: 'INI / TOML', grammar: ini, aliases: ['toml'], extensions: ['ini', 'toml'], filenames: ['.editorconfig', 'pipfile'] },
  { name: 'diff', label: 'Diff', grammar: diff, aliases: ['patch'], extensions: ['diff', 'patch'] },
  { name: 'dockerfile', label: 'Dockerfile', grammar: dockerfile, aliases: ['docker'], extensions: ['dockerfile'], filenames: ['dockerfile', 'containerfile'] },
];
const lowlight = createLowlight(Object.fromEntries(languages.map(({ name, grammar }) => [name, grammar])));
const aliases = new Map(); const extensions = new Map(); const filenames = new Map();
for (const entry of languages) {
  for (const alias of [entry.name, ...(entry.aliases ?? [])]) aliases.set(alias, entry);
  for (const extension of entry.extensions) extensions.set(extension, entry);
  for (const filename of entry.filenames ?? []) filenames.set(filename, entry);
}
const textAliases = new Set(['text', 'txt', 'plain', 'plaintext', 'plain-text', 'none']);
const safeClasses = new Set([
  'hljs-addition', 'hljs-attr', 'hljs-attribute', 'hljs-built_in', 'hljs-bullet',
  'hljs-char', 'hljs-code', 'hljs-comment', 'hljs-deletion', 'hljs-doctag',
  'hljs-emphasis', 'hljs-formula', 'hljs-keyword', 'hljs-link', 'hljs-literal',
  'hljs-meta', 'hljs-name', 'hljs-number', 'hljs-operator', 'hljs-params',
  'hljs-property', 'hljs-punctuation', 'hljs-quote', 'hljs-regexp', 'hljs-section',
  'hljs-selector-attr', 'hljs-selector-class', 'hljs-selector-id',
  'hljs-selector-pseudo', 'hljs-selector-tag', 'hljs-string', 'hljs-strong',
  'hljs-subst', 'hljs-symbol', 'hljs-tag', 'hljs-template-tag',
  'hljs-template-variable', 'hljs-title', 'hljs-type', 'hljs-variable',
  'class_', 'function_', 'language_', 'constant_', 'inherited__', 'invoke__',
  'escape_', 'prompt_',
]);
function selectLanguage(pathHint, language) {
  const explicit = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (explicit) return textAliases.has(explicit) ? undefined : aliases.get(explicit);
  if (typeof pathHint !== 'string') return undefined;
  const filename = pathHint.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (filenames.has(filename)) return filenames.get(filename);
  if (filename.startsWith('dockerfile.') || filename.startsWith('containerfile.')) return aliases.get('dockerfile');
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? undefined : extensions.get(filename.slice(dot + 1));
}
function plainCode(text) {
  return { language: 'text', label: '纯文本', highlighted: false, lines: text.split('\n').map(line => ({ tokens: line ? [{ text: line, classes: [] }] : [] })) };
}
function sameClasses(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function splitTree(tree, source) {
  const lines = [{ tokens: [] }]; let nodes = 0; let length = 0;
  function append(value, classes) {
    length += value.length; if (length > source.length) throw new Error('Unexpected token text length');
    const parts = value.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index) lines.push({ tokens: [] }); const text = parts[index]; if (!text) continue;
      const tokens = lines.at(-1).tokens; const previous = tokens.at(-1);
      if (previous && sameClasses(previous.classes, classes)) previous.text += text; else tokens.push({ text, classes: [...classes] });
    }
  }
  function visit(node, inherited, depth) {
    if (++nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) throw new Error('Token tree limit exceeded');
    if (node.type === 'text' && typeof node.value === 'string') return append(node.value, inherited);
    if (node.type !== 'root' && node.type !== 'element') throw new Error('Unexpected token node');
    if (!Array.isArray(node.children)) throw new Error('Missing token children');
    const own = node.type === 'element' && Array.isArray(node.properties?.className) ? node.properties.className.filter(value => safeClasses.has(value)) : [];
    const classes = own.length ? [...new Set([...inherited, ...own])] : inherited;
    for (const child of node.children) visit(child, classes, depth + 1);
  }
  visit(tree, [], 0);
  if (lines.map(line => line.tokens.map(token => token.text).join('')).join('\n') !== source) throw new Error('Token text did not preserve source');
  return lines;
}
/** Public HAST API only. Token text is never HTML; rendering must use text children.
 * Full-source parsing preserves multiline context. Unknown/large/parser-error input
 * falls back to plain text; recombining lines/tokens preserves every source byte
 * represented by the input string, including CRLF and leading/trailing blank lines.
 */
export function prepareCode(text, { pathHint = '', language = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('prepareCode expects source text');
  const selected = selectLanguage(pathHint, language);
  if (!selected || text.length > MAX_CODE_LENGTH) return plainCode(text);
  try { const lines = splitTree(lowlight.highlight(selected.name, text), text); return { language: selected.name, label: selected.label, highlighted: true, lines }; }
  catch { return plainCode(text); }
}
