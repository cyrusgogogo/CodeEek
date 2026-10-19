import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { notices } from './notices.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (path.resolve(process.cwd()) !== path.resolve(root)) throw new Error('请从插件仓库根目录执行构建');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const directory = path.resolve('lib');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publishedInputs = ['cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/INSTALL.md', 'docs/USAGE.md', 'skills/code-tutor/SKILL.md'];
const sourceHashes = {}; const inputBytes = new Map();
async function collect(relative) {
  const stat = await lstat(relative); if (stat.isSymbolicLink()) throw new Error(`构建输入不能是链接：${relative}`);
  if (stat.isDirectory()) for (const row of await readdir(relative)) await collect(path.posix.join(relative, row));
  else { const bytes = await readFile(relative); sourceHashes[relative] = hash(bytes); if (publishedInputs.includes(relative)) inputBytes.set(relative, bytes); }
}
for (const name of ['src', 'package.json', 'scripts/build.mjs', 'scripts/notices.mjs', ...publishedInputs]) await collect(name);

// Build everything in memory first. A failed build must not erase the last good output.
const host = await build({ entryPoints: { index: 'src/index.mjs', preset: 'src/preset.mjs' }, outdir: directory, write: false, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22', sourcemap: true, packages: 'bundle', metafile: true });
const client = await build({ entryPoints: ['src/client/index.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'text', '.svg': 'dataurl' }, minify: true, metafile: true });
if (Object.keys(client.metafile.inputs).some(name => /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?\//.test(name.replaceAll('\\', '/')))) throw new Error('Client 不得打包自己的 React/ReactDOM');
const body = client.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? client.outputFiles[0].text;
const outputs = new Map(host.outputFiles.map(file => [path.relative(process.cwd(), file.path).replaceAll('\\', '/'), Buffer.from(file.contents)]));
outputs.set('lib/client.js', Buffer.from(`window.__ModuleLoader__.load({id:"${manifest.name}",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`));
outputs.set('lib/THIRD_PARTY_NOTICES.txt', Buffer.from(await notices([host.metafile, client.metafile])));
const files = Object.fromEntries([...inputBytes, ...outputs].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, hash(bytes)]));
const info = { package: manifest.name, version: manifest.version, targetDshVersion: manifest.engines.dsh, apiVersion: 1, builtAt: new Date().toISOString(), files, sourceHashes };
outputs.set('lib/build-info.json', Buffer.from(`${JSON.stringify(info, null, 2)}\n`));

await mkdir(directory, { recursive: true });
if ((await lstat(directory)).isSymbolicLink()) throw new Error('lib 输出目录不能是链接');
// Delete only known generated outputs, after successful compilation and absolute-path checks.
for (const name of await readdir(directory)) if (/^(?:chunk-[A-Z0-9]+\.js(?:\.map)?|index\.js(?:\.map)?|preset\.js(?:\.map)?|client\.js|build-info\.json|THIRD_PARTY_NOTICES\.txt)$/.test(name)) {
  const target = path.resolve(directory, name);
  if (path.dirname(target) !== directory) throw new Error('Unexpected output cleanup target');
  await unlink(target);
}
for (const [name, bytes] of outputs) {
  const target = path.resolve(name); if (path.dirname(target) !== directory) throw new Error('Unexpected build output target');
  await writeFile(target, bytes, { flag: 'wx' });
}
console.log(`Built ${manifest.name}@${manifest.version}: Host, isolated preset, native Client, notices, and SHA256 build manifest.`);
