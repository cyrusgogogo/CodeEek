import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { verifyDirectory } from './package-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
try {
  const args = process.argv.slice(2); if (args[0] === '--') args.shift(); let dshVersion; let packageOnly = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--dsh-version') { dshVersion = args.shift(); if (!dshVersion) throw new Error('--dsh-version 后需要明确的宿主版本'); }
    else if (arg === '--package-only') packageOnly = true;
    else throw new Error(`不支持的参数：${arg}`);
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('需要 Node.js >=22.18.0；完整开发验收推荐 Node.js 24 LTS');
  if (dshVersion && dshVersion !== manifest.engines.dsh) throw new Error(`未声明兼容 DSH ${dshVersion}；本插件目标为 ${manifest.engines.dsh}，不会自动豁免版本`);
  const report = await verifyDirectory(root, { checkSources: true, expectedVersion: manifest.version, expectedDshVersion: manifest.engines.dsh });
  const zstd = typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function';
  const result = { ok: true, ...report, runtime: { node: process.versions.node, zstd }, dshVersionCheck: dshVersion ? `user-supplied ${dshVersion}` : 'not-detected; pass --dsh-version to compare explicitly', liveDshVerified: false, warnings: zstd || packageOnly ? [] : ['当前 Node 没有完整 zstd 支持：3 项原生日志回归将跳过，不能称为完整日志验收'] };
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`安装/发布自检失败：${error.message}`); process.exitCode = 1; }
