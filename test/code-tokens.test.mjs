import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { prepareCode } from '../src/client/code-tokens.mjs';
const lineTexts = result => result.lines.map(line => line.tokens.map(token => token.text).join(''));
const tokens = result => result.lines.flatMap(line => line.tokens);
const safeClass = /^(?:hljs-[a-z][a-z0-9_-]*|(?:class|function|language|constant|inherited|invoke|escape|prompt)_+)$/;
function assertPreserved(result, source) {
  assert.equal(lineTexts(result).join('\n'), source); assert.deepEqual(lineTexts(result), source.split('\n'));
  assert.deepEqual(Object.keys(result).sort(), ['highlighted', 'label', 'language', 'lines']);
  for (const line of result.lines) {
    assert.deepEqual(Object.keys(line), ['tokens']);
    for (const token of line.tokens) {
      assert.deepEqual(Object.keys(token).sort(), ['classes', 'text']); assert.equal(typeof token.text, 'string'); assert.ok(Array.isArray(token.classes));
      for (const value of token.classes) { assert.equal(typeof value, 'string'); assert.match(value, safeClass); }
    }
  }
}
function assertPlain(result, source) { assertPreserved(result, source); assert.equal(result.language, 'text'); assert.equal(result.highlighted, false); assert.ok(result.label.length > 0); assert.ok(tokens(result).every(token => token.classes.length === 0)); }
const hasToken = (result, value, className) => tokens(result).some(token => token.text === value && token.classes.includes(className));
test('按扩展名、Windows 路径和特殊文件名选择精选语言', () => {
  const fixtures = [
    ['src/view.jsx', 'javascript', 'const view = () => <div>你好</div>;\n'], ['C:\\repo\\Main.TSX', 'typescript', 'export const value: number = 42;\n'],
    ['src/Demo.java', 'java', 'public class Demo {}\n'], ['settings.json', 'json', '{"name":"你好"}\n'], ['main.py', 'python', 'def greet():\n    return "你好"\n'],
    ['main.css', 'css', '.card { color: red; }\n'], ['index.html', 'xml', '<div title="你好">文本</div>\n'], ['icon.svg', 'xml', '<svg><path d="M0 0"/></svg>\n'],
    ['App.vue', 'xml', '<template><div>{{ message }}</div></template>\n<script>const message = "你好"</script>\n'], ['.bashrc', 'bash', 'export HOME_DIR="$HOME"\n'],
    ['deploy.sh', 'bash', 'echo "你好"\n'], ['check.ps1', 'powershell', 'Write-Output "你好"\n'], ['config.yml', 'yaml', 'name: 你好\n'], ['query.sql', 'sql', 'SELECT name FROM users;\n'],
    ['README.md', 'markdown', '# 标题\n\n**内容**\n'], ['main.go', 'go', 'package main\nfunc main() {}\n'], ['main.rs', 'rust', 'fn main() { let n = 1; }\n'],
    ['main.c', 'c', '#include <stdio.h>\nint main(void) { return 0; }\n'], ['main.hpp', 'cpp', 'class Demo { public: int value = 1; };\n'],
    ['Demo.cs', 'csharp', 'public class Demo { public string Name = "你好"; }\n'], ['index.php', 'php', '<?php echo "你好";\n'], ['Gemfile', 'ruby', 'source "https://example.invalid"\n'],
    ['config.ini', 'ini', '[app]\nname = "你好"\n'], ['Cargo.toml', 'ini', '[package]\nname = "你好"\n'], ['change.patch', 'diff', '@@ -1 +1 @@\n-old\n+new\n'], ['Dockerfile.dev', 'dockerfile', 'FROM node:24\nRUN echo "你好"\n'],
  ];
  for (const [pathHint, language, source] of fixtures) { const result = prepareCode(source, { pathHint }); assert.equal(result.language, language, pathHint); assert.equal(result.highlighted, true, pathHint); assert.ok(result.label.length > 0); assertPreserved(result, source); }
});
test('显式语言优先于文件名并支持 JSX/TSX 与常用别名', () => {
  const aliases = [[' JS ', 'javascript'], ['jsx', 'javascript'], ['TSX', 'typescript'], ['C++', 'cpp'], ['C#', 'csharp'], ['Vue', 'xml'], ['HTML', 'xml'], ['shell', 'bash'], ['toml', 'ini'], ['yml', 'yaml'], ['md', 'markdown'], ['py', 'python'], ['patch', 'diff'], ['ps1', 'powershell']];
  for (const [language, canonical] of aliases) { const source = 'value\n'; const result = prepareCode(source, { pathHint: 'wrong.java', language }); assert.equal(result.language, canonical, language); assert.equal(result.highlighted, true, language); assertPreserved(result, source); }
  const result = prepareCode('public class Demo {}', { pathHint: 'wrong.ts', language: 'java' }); assert.equal(result.language, 'java'); assert.equal(result.label, 'Java');
});
test('TypeScript 以词法 token 区分关键字、数值和字符串', () => {
  const source = 'export interface User { name: string; }\nconst answer: number = 42;\nconst title: string = "你好";\n'; const result = prepareCode(source, { pathHint: 'src/model.ts' });
  assert.equal(result.language, 'typescript'); assert.equal(result.highlighted, true);
  for (const word of ['export', 'interface', 'const']) assert.ok(hasToken(result, word, 'hljs-keyword'), word); assert.ok(hasToken(result, '42', 'hljs-number')); assert.ok(hasToken(result, '"你好"', 'hljs-string')); assertPreserved(result, source);
});
test('Java 以词法 token 区分关键字、数值和字符串', () => {
  const source = 'public class Greeter {\n  private final String name = "你好";\n  int count = 42;\n}\n'; const result = prepareCode(source, { pathHint: 'src/Greeter.java' });
  assert.equal(result.language, 'java'); assert.equal(result.highlighted, true); for (const word of ['public', 'class', 'private', 'final']) assert.ok(hasToken(result, word, 'hljs-keyword'), word); assert.ok(hasToken(result, '42', 'hljs-number')); assert.ok(hasToken(result, '"你好"', 'hljs-string')); assertPreserved(result, source);
});
test('整段分词保留跨行注释上下文且不漏空行', () => {
  const source = '/* 第一行\n\nstill comment "text" <b>\nlast */\nconst done = true;\n';
  for (const language of ['typescript', 'java']) { const result = prepareCode(source, { language }); assert.equal(result.highlighted, true); assertPreserved(result, source); for (const index of [0, 2, 3]) { assert.ok(result.lines[index].tokens.length > 0); assert.ok(result.lines[index].tokens.every(token => token.classes.includes('hljs-comment'))); } assert.deepEqual(result.lines[1].tokens, []); assert.ok(result.lines[4].tokens.every(token => !token.classes.includes('hljs-comment'))); }
});
test('跨行模板与三引号字符串保持词法上下文', () => {
  for (const [language, source] of [['javascript', 'const view = `第一行\n<tag attr="value">第二行</tag>\n最后`;\n'], ['python', 'text = """第一行\n第二行\n"""\nprint(text)\n']]) { const result = prepareCode(source, { language }); assert.equal(result.highlighted, true); assertPreserved(result, source); assert.ok(result.lines[1].tokens.length > 0); assert.ok(result.lines[1].tokens.every(token => token.classes.includes('hljs-string'))); }
});
test('中文、标签、引号、制表符、首尾空行与空输入逐字保留', () => {
  const source = '\nconst 文本 = \'<标签 属性="中文"> & "双引号" 😀</标签>\';\n\n// 空白\t保留  \n'; const result = prepareCode(source, { language: 'typescript' }); assert.equal(result.highlighted, true); assertPreserved(result, source);
  for (const value of ['', '\n', '\n\n', '\t  \n\n']) { assertPreserved(prepareCode(value, { language: 'javascript' }), value); assertPlain(prepareCode(value), value); }
});
test('CRLF 中的 CR 原样留在各行，混合换行不做规范化', () => {
  const source = '/* 开始\r\n中间\r\n*/\n\r\nconst x = "<b>中文</b>";\r\n'; const result = prepareCode(source, { pathHint: 'source.ts' }); assert.equal(result.highlighted, true); assertPreserved(result, source); assert.ok(lineTexts(result)[0].endsWith('\r'));
});
test('恶意 HTML、脚本与事件属性只成为文本和安全 class', t => {
  const key = '__codeTokensExecuted'; const previous = globalThis[key]; globalThis[key] = false; t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
  const source = '<img src=x onerror="globalThis.__codeTokensExecuted=true">\n<script>globalThis.__codeTokensExecuted=true</script>\n<style>body{background:url(javascript:alert(1))}</style>\n&lt;script&gt; &quot; \' " 中文\n';
  const result = prepareCode(source, { pathHint: 'untrusted.html' }); assert.equal(result.language, 'xml'); assert.equal(result.highlighted, true); assertPreserved(result, source); assert.equal(globalThis[key], false); assert.ok(tokens(result).some(token => token.text.includes('globalThis')));
});
test('未知语言或路径只回退文本，不做内容自动猜测', () => {
  const source = 'public class LooksLikeJava { String text = "<script>中文</script>"; }\n\n';
  for (const options of [{}, { pathHint: 'unknown.ext' }, { language: 'unknown', pathHint: 'Demo.java' }, { language: '__proto__', pathHint: 'Demo.java' }, { language: 'constructor' }, { language: '<img onerror=x>', pathHint: 'Demo.java' }, ...['text', 'txt', 'plain', 'plaintext', 'none'].map(language => ({ language, pathHint: 'Demo.java' }))]) assertPlain(prepareCode(source, options), source);
});
test('60,000 字符边界允许高亮，超过后无损回退纯文本', () => {
  const exact = '// ' + '中'.repeat(59_997); assert.equal(exact.length, 60_000); const result = prepareCode(exact, { language: 'javascript' }); assert.equal(result.language, 'javascript'); assert.equal(result.highlighted, true); assertPreserved(result, exact); const oversized = exact + '\n'; assertPlain(prepareCode(oversized, { language: 'javascript' }), oversized);
});
test('调用不修改参数，返回的 token 与 class 不跨调用共享', () => {
  const source = 'const n = 1;\n'; const options = Object.freeze({ pathHint: 'source.ts', language: '' }); const first = prepareCode(source, options); const second = prepareCode(source, options); assert.deepEqual(first, second); first.lines[0].tokens[0].classes.push('not-a-safe-class'); first.lines[0].tokens[0].text = 'changed'; assertPreserved(second, source); assert.deepEqual(options, { pathHint: 'source.ts', language: '' }); assert.throws(() => prepareCode({ toString() { throw new Error('must not be coerced'); } }), TypeError);
});
test('解析失败安全回退，未知和超长输入在解析前直接短路', async () => {
  let substituted = false;
  const compiled = await build({ stdin: { contents: `export {prepareCode} from './src/client/code-tokens.mjs'; export {getParses} from 'lowlight';`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'controlled-parser-failure', setup(builder) { builder.onResolve({ filter: /^lowlight$/ }, () => { substituted = true; return { path: 'lowlight', namespace: 'parser-test' }; }); builder.onLoad({ filter: /.*/, namespace: 'parser-test' }, () => ({ contents: `let parses=0; export const getParses=()=>parses; export function createLowlight(){return {highlight(){parses++;throw new Error('synthetic parser failure')}}}`, loader: 'js' })); } }] });
  assert.equal(substituted, true);
  const { prepareCode: withFailure, getParses } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const oversized = 'x'.repeat(60_001); assertPlain(withFailure(oversized, { language: 'typescript' }), oversized); assertPlain(withFailure('const value = 1;', { language: 'unknown' }), 'const value = 1;'); assert.equal(getParses(), 0);
  const source = 'const title = "中文";\n\n'; assertPlain(withFailure(source, { language: 'typescript' }), source); assert.equal(getParses(), 1);
});
