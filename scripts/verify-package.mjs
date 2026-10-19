import { verifyArchive } from './package-check.mjs';
import path from 'node:path';
try {
  const args = process.argv.slice(2); if (args[0] === '--') args.shift(); const [filename, ...extra] = args;
  if (!filename || extra.length || !filename.endsWith('.tgz')) throw new Error('用法：pnpm run verify:package -- releases/dsh-code-reading-<version>.tgz');
  console.log(JSON.stringify({ ok: true, archive: path.resolve(filename), ...await verifyArchive(filename) }, null, 2));
} catch (error) { console.error(`发布包校验失败：${error.message}`); process.exitCode = 1; }
