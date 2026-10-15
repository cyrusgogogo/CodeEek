import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { readSessionRecords } from '../scripts/read-session-log.mjs';
const supported = typeof zlib.zstdCompressSync === 'function';
const base = path.resolve('.test-output');
async function fixture(t, bytes) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'journal-codec-')); const file = path.join(root, 'session.zstd'); await fs.writeFile(file, bytes);
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^journal-codec-/); await fs.rm(root, { recursive: true, force: true }); });
  return file;
}
test('原生日志解码覆盖全部 zstd 帧，中文跨帧字节不丢失', { skip: !supported }, async t => {
  const records = [{ type: 'session', id: 'fixture' }, { type: 'user/message', seq: 0, data: { text: '中文内容' } }, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }];
  const raw = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n'); const cut = raw.indexOf(Buffer.from('中文')) + 1;
  const file = await fixture(t, Buffer.concat([zlib.zstdCompressSync(raw.subarray(0, cut)), zlib.zstdCompressSync(raw.subarray(cut))])); const result = await readSessionRecords(file);
  assert.equal(result.frames, 2); assert.deepEqual(result.records, records);
});
test('损坏的后继帧不能被首帧成功掩盖', { skip: !supported }, async t => {
  const file = await fixture(t, Buffer.concat([zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n')), Buffer.from('broken-frame')])); await assert.rejects(readSessionRecords(file));
});
test('原生日志验证限制解压后的字节数', { skip: !supported }, async t => {
  const file = await fixture(t, zlib.zstdCompressSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(100000) }) + '\n'))); await assert.rejects(readSessionRecords(file, 1024));
});
