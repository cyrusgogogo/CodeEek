import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

function fail(message) { throw Object.assign(new Error(message), { code: 'RELEASE_PATH' }); }
function inside(root, target) { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

/** Check every existing output ancestor; creation is opt-in and never follows an accepted link. */
export async function checkReleaseDirectory(root, directory, { create = false } = {}) {
  root = path.resolve(root); directory = path.resolve(directory);
  if (!inside(root, directory)) fail('发布输出目录必须位于当前仓库内');
  const relative = path.relative(root, directory); const parts = relative ? relative.split(path.sep) : [];
  if (['.git', 'node_modules', 'lib', 'src', 'skills', 'docs', 'scripts', 'test'].includes(parts[0]?.toLowerCase())) fail('发布输出不能位于源码、依赖或包运行目录；请使用 releases 或 .test-output 子目录');
  const rootStat = await lstat(root); if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('发布仓库根必须是普通目录，不能是链接');
  const realRoot = await realpath(root); let current = root;
  for (const part of parts) {
    current = path.join(current, part); let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) continue;
      try { await mkdir(current); } catch (creation) { if (creation.code !== 'EEXIST') throw creation; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`发布目录祖先不能是链接／junction 或非目录：${current}`);
    if (!inside(realRoot, await realpath(current))) fail('发布目录的真实位置超出仓库');
  }
  if (create && !inside(realRoot, await realpath(directory))) fail('发布目录的真实位置超出仓库');
  return directory;
}
