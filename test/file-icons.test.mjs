import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getFileIconName, getFolderIconName } from '../src/client/file-icons.mjs';

const fileFixtures = [
  ['main.ts', 'typescript'], ['main.mts', 'typescript'], ['main.cts', 'typescript'], ['App.tsx', 'react_ts'],
  ['main.js', 'javascript'], ['main.mjs', 'javascript'], ['main.cjs', 'javascript'], ['App.jsx', 'react'],
  ['App.vue', 'vue'], ['App.svelte', 'svelte'], ['index.html', 'html'], ['index.htm', 'html'], ['style.css', 'css'], ['theme.scss', 'sass'], ['theme.sass', 'sass'],
  ['ordinary.json', 'json'], ['ordinary.jsonc', 'json'], ['ordinary.json5', 'json'], ['config.yml', 'yaml'], ['config.yaml', 'yaml'], ['Cargo.toml', 'toml'],
  ['guide.md', 'markdown'], ['guide.mdx', 'markdown'], ['guide.markdown', 'markdown'], ['Main.java', 'java'], ['main.py', 'python'], ['types.pyi', 'python'], ['notebook.ipynb', 'python'],
  ['main.go', 'go'], ['main.rs', 'rust'], ['index.php', 'php'], ['main.c', 'c'], ['main.h', 'c'], ['main.cc', 'cpp'], ['main.cpp', 'cpp'], ['main.cxx', 'cpp'], ['main.hpp', 'cpp'], ['Main.cs', 'csharp'],
  ['main.rb', 'ruby'], ['Main.swift', 'swift'], ['Main.kt', 'kotlin'], ['build.kts', 'kotlin'], ['main.dart', 'dart'], ['check.ps1', 'powershell'], ['module.psm1', 'powershell'],
  ['build.sh', 'console'], ['build.bash', 'console'], ['build.zsh', 'console'], ['build.bat', 'console'], ['build.cmd', 'console'], ['query.sql', 'database'], ['local.db', 'database'],
  ['schema.xml', 'xml'], ['schema.xsl', 'xml'], ['schema.xsd', 'xml'], ['logo.svg', 'svg'], ['logo.png', 'image'], ['logo.jpg', 'image'], ['logo.jpeg', 'image'], ['logo.gif', 'image'], ['logo.webp', 'image'], ['logo.ico', 'image'],
  ['document.pdf', 'pdf'], ['archive.zip', 'zip'], ['archive.gz', 'zip'], ['archive.tgz', 'zip'], ['archive.tar', 'zip'], ['archive.7z', 'zip'], ['archive.rar', 'zip'], ['dependency.lock', 'lock'], ['config.ini', 'settings'], ['app.conf', 'settings'],
];
const specialFiles = [
  ['package.json', 'nodejs'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['pnpm-workspace.yaml', 'pnpm'], ['yarn.lock', 'lock'], ['bun.lock', 'lock'], ['bun.lockb', 'lock'],
  ['.gitignore', 'git'], ['.gitattributes', 'git'], ['.gitmodules', 'git'], ['.gitkeep', 'git'], ['.editorconfig', 'settings'], ['settings.json', 'settings'], ['tsconfig.json', 'typescript-def'], ['tsconfig.build.json', 'typescript-def'], ['jsconfig.json', 'javascript'],
  ['Dockerfile', 'docker'], ['Dockerfile.dev', 'docker'], ['docker-compose.yml', 'docker'], ['docker-compose.yaml', 'docker'], ['compose.yml', 'docker'], ['compose.yaml', 'docker'],
  ['README', 'readme'], ['README.md', 'readme'], ['README.zh-CN.md', 'readme'], ['LICENSE', 'license'], ['LICENCE', 'license'], ['LICENSE-MIT', 'license'], ['LICENSE_MIT', 'license'], ['LICENSE.txt', 'license'], ['COPYING', 'license'],
  ['types.d.ts', 'typescript-def'], ['types.d.mts', 'typescript-def'], ['types.d.cts', 'typescript-def'], ['vite.config.ts', 'vite'], ['vitest.config.mts', 'vite'],
  ['eslint.config.js', 'eslint'], ['.eslintrc', 'eslint'], ['.eslintrc.json', 'eslint'], ['prettier.config.cjs', 'prettier'], ['.prettierrc', 'prettier'], ['.prettierrc.json', 'prettier'],
];
const folderFixtures = [
  ['src', 'folder-src'], ['source', 'folder-src'], ['sources', 'folder-src'], ['docs', 'folder-docs'], ['doc', 'folder-docs'], ['documentation', 'folder-docs'],
  ['test', 'folder-test'], ['tests', 'folder-test'], ['__tests__', 'folder-test'], ['spec', 'folder-test'], ['specs', 'folder-test'],
  ['config', 'folder-config'], ['configs', 'folder-config'], ['.config', 'folder-config'], ['.vscode', 'folder-config'],
  ['components', 'folder-components'], ['public', 'folder-public'], ['static', 'folder-public'], ['.github', 'folder-github'],
  ['scripts', 'folder-scripts'], ['bin', 'folder-scripts'], ['images', 'folder-images'], ['assets', 'folder-images'], ['icons', 'folder-images'], ['lib', 'folder-lib'], ['libs', 'folder-lib'], ['packages', 'folder-lib'],
];
const unsafeNames = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '.constructor', 'file.__proto__', 'file.constructor'];
const allKeys = () => new Set([
  'file', 'folder', 'folder-open', 'folder-root', 'folder-root-open',
  ...fileFixtures.map(([, key]) => key), ...specialFiles.map(([, key]) => key),
  ...folderFixtures.flatMap(([, key]) => [key, `${key}-open`]),
]);

test('精选文件类型返回语义图标键，不再生成扩展名文字徽章', () => {
  for (const [file, expected] of fileFixtures) assert.equal(getFileIconName(file), expected, file);
});

test('准确文件名及复合后缀优先于普通扩展名', () => {
  for (const [file, expected] of specialFiles) assert.equal(getFileIconName(file), expected, file);
  for (const [specific, ordinary] of [['package.json', 'ordinary.json'], ['settings.json', 'ordinary.json'], ['tsconfig.build.json', 'ordinary.json'], ['types.d.ts', 'main.ts'], ['vite.config.ts', 'main.ts'], ['eslint.config.js', 'main.js'], ['README.md', 'guide.md']]) {
    assert.notEqual(getFileIconName(specific), getFileIconName(ordinary), `${specific} must win over its extension`);
  }
});

test('文件和文件夹按 basename 识别，兼容 Windows 分隔符与大小写', () => {
  for (const [file, expected] of [...fileFixtures, ...specialFiles]) {
    for (const prefix of ['nested/project/', 'C:\\repo\\nested\\']) assert.equal(getFileIconName(prefix + file.toUpperCase()), expected, prefix + file);
  }
  for (const [folder, expected] of folderFixtures) {
    assert.equal(getFolderIconName(`nested/${folder.toUpperCase()}/`), expected, folder);
    assert.equal(getFolderIconName(`C:\\repo\\${folder.toUpperCase()}\\`, { open: true }), `${expected}-open`, folder);
  }
  assert.equal(getFileIconName('package.json/no-extension'), 'file', 'a parent directory name is not a file association');
  assert.equal(getFolderIconName('src/unrecognized-child'), 'folder', 'a parent directory name is not inherited');
});

test('未知文件与近似名称回退为普通文件，原型属性名不会命中对象继承链', () => {
  for (const file of ['', 'no-extension', 'unknown.fixture-extension', '业务说明.未知扩展', 'READMEish', 'licensed', 'COPYINGRIGHT', ...unsafeNames]) assert.equal(getFileIconName(file), 'file', file);
  for (const folder of ['', 'unrecognized-child', 'srcish', 'docstrings', ...unsafeNames]) {
    assert.equal(getFolderIconName(folder), 'folder', folder); assert.equal(getFolderIconName(folder, { open: true }), 'folder-open', folder);
  }
  for (const file of [undefined, null]) assert.equal(getFileIconName(file), 'file');
});

test('语义目录和普通目录各有独立展开态，不因看似文件的后缀丢失目录类型', () => {
  for (const [folder, expected] of folderFixtures) {
    assert.equal(getFolderIconName(folder), expected, folder); assert.equal(getFolderIconName(folder, { open: false }), expected, folder);
    assert.equal(getFolderIconName(folder, { open: true }), `${expected}-open`, folder); assert.notEqual(getFolderIconName(folder), getFolderIconName(folder, { open: true }), folder);
  }
  assert.equal(getFolderIconName('package.json'), 'folder'); assert.equal(getFolderIconName('App.tsx', { open: true }), 'folder-open');
});

test('仓库根目录优先于文件夹名，展开与收起保持根目录身份', () => {
  for (const folder of ['', 'src', 'docs', '.github', 'unrecognized-child', 'C:\\repo\\src']) {
    assert.equal(getFolderIconName(folder, { root: true }), 'folder-root', folder);
    assert.equal(getFolderIconName(folder, { root: true, open: true }), 'folder-root-open', folder);
  }
  const options = Object.freeze({ root: false, open: true }); assert.equal(getFolderIconName('docs', options), 'folder-docs-open'); assert.deepEqual(options, { root: false, open: true });
});

test('不可信文件名只选择有限静态键，不作为 URL、SVG 或资源路径返回', () => {
  const fixtures = [
    ['<img src=x onerror=alert(1)>.tsx', 'react_ts'], ['https://attacker.invalid/private.svg', 'svg'], ['../private/readme.md', 'readme'],
    ['C:\\private\\logo.png', 'image'], ['data:image/svg+xml,<svg onload=alert(1)>', 'file'], ['javascript:alert(1)', 'file'],
    [`业务订单-${'金额校验与异常分支-'.repeat(50)}阅读说明.md`, 'markdown'],
  ];
  for (const [file, expected] of fixtures) {
    const key = getFileIconName(file); assert.equal(key, expected, file); assert.match(key, /^[a-z][a-z0-9_-]*$/); assert.ok(allKeys().has(key));
    assert.equal(getFolderIconName(file), 'folder'); assert.equal(getFolderIconName(file, { open: true }), 'folder-open');
  }
});

test('resolver 的所有图标都有显式静态 SVG import，资源只能是无脚本且自包含的矢量', async () => {
  // Do not import this module in Node: the client build owns the SVG data-url
  // loader. Inspect explicit imports and bytes without bundling or executing it.
  const registryURL = new URL('../src/client/icons/icon-assets.mjs', import.meta.url); const source = await fs.readFile(registryURL, 'utf8');
  assert.match(source, /export\s+const\s+iconAssets\s*=\s*Object\.freeze\(/);
  const imports = [...source.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+\.svg)['"];?\s*$/gm)];
  assert.ok(imports.length > 0, 'registry must enumerate static SVG imports');
  const imported = new Map();
  for (const [, binding, relative] of imports) {
    assert.match(relative, /^\.\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.svg$/, 'icons never resolve repository-supplied or remote paths'); assert.equal(imported.has(binding), false); imported.set(binding, relative);
    const svg = await fs.readFile(new URL(relative, registryURL), 'utf8'); assert.match(svg, /<svg\b[^>]*\bxmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/i);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|iframe|image|animate|animateTransform|set)\b|\bon\w+\s*=|\b(?:href|src)\s*=|url\(\s*['"]?(?:https?:|\/\/|data:)/i, `${relative} must contain only static self-contained vector content`);
  }
  const entries = [...source.matchAll(/['"]([a-z0-9_-]+)['"]\s*:\s*([A-Za-z_$][\w$]*)/g)]; const registry = new Map(entries.map(([, key, binding]) => [key, binding]));
  assert.equal(registry.size, entries.length, 'duplicate icon keys are forbidden');
  for (const key of allKeys()) assert.ok(registry.has(key), `missing bundled icon: ${key}`);
  for (const [key, binding] of registry) { assert.match(key, /^[a-z][a-z0-9_-]*$/); assert.ok(imported.has(binding), `${key} must reference an explicit local SVG import`); }
});
