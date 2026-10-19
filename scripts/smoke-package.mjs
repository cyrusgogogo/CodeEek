import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readArchiveBytes, verifyPackageFiles } from './package-check.mjs';
import { readFileBounded } from './bounded-file.mjs';
import { checkReleaseDirectory } from './release-path.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))); const base = path.join(root, '.test-output'); let extracted;
function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error; if (result.status !== 0) throw new Error(`归档副本验收失败（exit ${result.status ?? 'interrupted'}）：${args.join(' ')}`);
}
try {
  const args = process.argv.slice(2); if (args[0] === '--') args.shift();
  if (args.length !== 2 || args[0] !== '--trusted' || !args[1].endsWith('.tgz')) throw new Error('只对自己信任的代码使用：pnpm run test:package -- --trusted <本仓库新构建的.tgz>；此命令会执行包内代码，未知第三方包只用 verify:package');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); const archive = path.resolve(args[1]);
  const bytes = await readFileBounded(archive, 32 * 1024 * 1024); const files = readArchiveBytes(bytes);
  const verification = verifyPackageFiles(files, { expectedVersion: manifest.version, expectedDshVersion: manifest.engines.dsh });
  await checkReleaseDirectory(root, base, { create: true }); extracted = await mkdtemp(path.join(base, 'package-smoke-'));
  for (const [relative, content] of files) {
    const target = path.resolve(extracted, relative); const within = path.relative(extracted, target);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('拒绝异常解包目标');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' });
  }
  const host = await import(pathToFileURL(path.join(extracted, 'lib/index.js')).href); const preset = await import(pathToFileURL(path.join(extracted, 'lib/preset.js')).href);
  assert.equal(typeof host.apply, 'function'); assert.equal(typeof preset.apply, 'function'); assert.deepEqual(host.Config.parse(undefined), {});
  const browserOutput = path.join(base, 'package-browser'); await checkReleaseDirectory(root, browserOutput, { create: true });
  const env = { ...process.env, DSH_TEST_INSTALLED_PACKAGE: extracted, DSH_TEST_CLIENT_BUNDLE: path.join(extracted, 'lib/client.js'), DSH_TEST_BROWSER_OUTPUT: browserOutput }; delete env.DSH_TEST_ARCHIVE_STATE;
  run(['--test', path.join(root, 'test/integration.test.mjs')], env);
  run([path.join(root, 'scripts/browser-test.mjs')], env);
  const browser = JSON.parse(await readFile(path.join(browserOutput, 'report.json'), 'utf8')); assert.equal(browser.passed, true); assert.equal(browser.clientSource, 'extracted release archive'); assert.equal(browser.pluginVersion, manifest.version); assert.equal(browser.fileWorkspace?.passed, true); assert.equal(browser.fileWorkspace.realModelRequest, false);
  const report = { ...verification, artifact: path.basename(archive), sha256: createHash('sha256').update(bytes).digest('hex'), trustedCodeExecuted: true, hostAndPresetImport: true, mockedHostIntegration: true, isolatedBrowser: { passed: true, checks: browser.checks.length, codeReadability: browser.codeReadability.passed, fileWorkspaceChecks: browser.fileWorkspace.checks.length, annotationVersions: browser.fileWorkspace.annotationVersions, realModelRequest: false }, liveDshInstalled: false, realModelRequest: false };
  await writeFile(path.join(base, 'package-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(`可信归档隔离验收失败：${error.message}`); process.exitCode = 1; }
finally {
  if (extracted) {
    try {
      const absolute = path.resolve(extracted); if (path.dirname(absolute) !== base || !path.basename(absolute).startsWith('package-smoke-')) throw new Error('拒绝清理意外解包路径');
      await checkReleaseDirectory(root, absolute); await rm(absolute, { recursive: true, force: true });
    } catch (error) { console.error(`未清理隔离副本，请人工核查：${error.message}`); process.exitCode ||= 1; }
  }
}
