import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { notices } from './notices.mjs';

const directory = path.resolve('lib'); await mkdir(directory, { recursive: true });
// Delete only this builder's known generated outputs after absolute-path checks.
for (const name of await readdir(directory)) if (/^(?:chunk-[A-Z0-9]+\.js(?:\.map)?|index\.js(?:\.map)?|preset\.js(?:\.map)?|client\.js|build-info\.json|THIRD_PARTY_NOTICES\.txt)$/.test(name)) {
  const target = path.resolve(directory, name);
  if (path.dirname(target) !== directory) throw new Error('Unexpected output cleanup target');
  await unlink(target);
}
// Host and preset share a chunk; the root-keyed runtime also survives reloads.
const host = await build({ entryPoints: { index: 'src/index.mjs', preset: 'src/preset.mjs' }, outdir: directory, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22', sourcemap: true, packages: 'bundle', metafile: true });
const client = await build({ entryPoints: ['src/client/index.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'text' }, minify: true, metafile: true });
const body = client.outputFiles.find(f => f.path.endsWith('.js'))?.text ?? client.outputFiles[0].text;
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:"dsh-code-reading",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
await writeFile('lib/THIRD_PARTY_NOTICES.txt', await notices([host.metafile, client.metafile]));
await writeFile('lib/build-info.json', JSON.stringify({ package: 'dsh-code-reading', version: JSON.parse(await readFile('package.json', 'utf8')).version, builtAt: new Date().toISOString() }, null, 2));
console.log('Built Host, isolated reading preset, DSH Client factory, and third-party notices.');
