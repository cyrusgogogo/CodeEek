import { readFile, mkdtemp, lstat, readdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { verifyDirectory, verifyArchive } from './package-check.mjs';
import { checkReleaseDirectory } from './release-path.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let stage, stageParent;
function run(args) {
  const env = { ...process.env }; for (const key of ['DSH_TEST_INSTALLED_PACKAGE', 'DSH_TEST_CLIENT_BUNDLE', 'DSH_TEST_ARCHIVE_STATE', 'DSH_TEST_BROWSER_OUTPUT']) delete env[key];
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`发布步骤失败（exit ${result.status ?? 'interrupted'}）：${args[0]}`);
}
try {
  const args = process.argv.slice(2); if (args[0] === '--') args.shift();
  let out = 'releases';
  if (args.length) { if (args.shift() !== '--out-dir' || args.length !== 1) throw new Error('用法：pnpm run pack:release [--out-dir <仓库内目录>]'); out = args.shift(); }
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-code-reading' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)) throw new Error('发布包名称或版本无效');
  const output = path.resolve(root, out); await checkReleaseDirectory(root, output);
  const basename = `${manifest.name}-${manifest.version}.tgz`;
  const archive = path.join(output, basename); const checksum = `${archive}.sha256`; const reportFile = path.join(output, `${manifest.name}-${manifest.version}.release.json`);
  // This preflight intentionally precedes build, tests, package-manager invocation, or any write.
  for (const target of [archive, checksum, reportFile]) {
    try { await lstat(target); throw Object.assign(new Error(`拒绝覆盖已有发布文件：${target}。请提升 package.json 的 version；同版本安装归档必须保持不可变`), { code: 'RELEASE_EXISTS' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !path.basename(pnpm).includes('pnpm')) throw new Error('请通过 pnpm run pack:release 执行；本脚本不修改包管理器配置');
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') throw new Error('完整发布需要支持 zstd 的 Node.js；推荐 Node.js 24 LTS，不允许把跳过日志回归称为完整验收');
  run([path.join(root, 'scripts/build.mjs')]);
  const tests = (await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).map(name => path.join(root, 'test', name));
  run(['--test', ...tests]);
  run([path.join(root, 'scripts/browser-test.mjs')]);
  await verifyDirectory(root, { checkSources: true, expectedVersion: manifest.version, expectedDshVersion: manifest.engines.dsh });
  await checkReleaseDirectory(root, output, { create: true });
  stageParent = output; stage = await mkdtemp(path.join(stageParent, '.code-reading-stage-'));
  run([pnpm, 'pack', '--pack-destination', stage]);
  const stagedArchive = path.join(stage, basename);
  const verification = await verifyArchive(stagedArchive, { expectedVersion: manifest.version, expectedDshVersion: manifest.engines.dsh });
  run([path.join(root, 'scripts/smoke-package.mjs'), '--trusted', stagedArchive]);
  const report = { ...verification, artifact: basename, validation: { unit: true, isolatedBrowser: true, extractedPackageHostAndBrowser: true, zstdLogTests: true, liveDshInstall: false, realModelRequest: false } };
  await checkReleaseDirectory(root, output); await checkReleaseDirectory(root, stage);
  // COPYFILE_EXCL also closes the race between preflight and publication.
  await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL);
  await writeFile(checksum, `${verification.sha256}  ${basename}\n`, { flag: 'wx' });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`\n发布完成：${archive}\nSHA256：${verification.sha256}\n校验文件：${checksum}\n报告：${reportFile}\n未安装或替换任何正在运行的 DSH 插件。`);
} catch (error) { console.error(`发布失败：${error.message}`); process.exitCode = error.code === 'RELEASE_EXISTS' ? 2 : error.code === 'RELEASE_PATH' ? 3 : 1; }
finally {
  if (stage) {
    try {
      const absolute = path.resolve(stage);
      if (path.dirname(absolute) !== stageParent || !path.basename(absolute).startsWith('.code-reading-stage-')) throw new Error('拒绝清理意外的发布暂存路径');
      await checkReleaseDirectory(root, absolute);
      await rm(absolute, { recursive: true, force: true });
    } catch (error) { console.error(`未清理暂存目录，请人工核查：${error.message}`); process.exitCode ||= 1; }
  }
}
