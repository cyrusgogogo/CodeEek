import { open } from 'node:fs/promises';

/** Read a regular file without trusting a stale stat size; limit+1 bytes is the hard I/O ceiling. */
export async function readFileBounded(filename, limit, openFile = open) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('读取上限必须是正整数');
  const handle = await openFile(filename, 'r');
  const tooLarge = () => Object.assign(new Error(`文件超过 ${limit} 字节读取上限`), { code: 'FILE_LIMIT' });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只校验普通归档文件');
    if (stat.size > limit) throw tooLarge();
    const chunks = []; let total = 0;
    while (total <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) throw new Error('文件读取器返回了无效字节数');
      if (!bytesRead) break;
      total += bytesRead; if (total > limit) throw tooLarge();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
