import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

// Native v4 journals append independent zstd frames. Node's synchronous API
// returns just one frame; info.engine.bytesWritten is the consumed input size.
export async function readSessionRecords(file, maxBytes = 32 * 1024 * 1024) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('Use the bundled Node 24+ runtime for zstd journal verification');
  const stat = await fs.stat(file); if (stat.size > maxBytes) throw new Error('Compressed journal exceeds verification limit');
  const raw = await fs.readFile(file); const chunks = []; let offset = 0; let total = 0;
  while (offset < raw.length) {
    if (chunks.length >= 100000) throw new Error('Too many journal frames');
    const result = zlib.zstdDecompressSync(raw.subarray(offset), { info: true, maxOutputLength: maxBytes - total });
    const used = result.engine.bytesWritten;
    if (!Number.isSafeInteger(used) || used <= 0 || used > raw.length - offset) throw new Error('Invalid zstd frame progress');
    total += result.buffer.length; if (total > maxBytes) throw new Error('Decoded journal exceeds verification limit');
    chunks.push(result.buffer); offset += used;
  }
  const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(line => line.trim());
  return { records: lines.map(JSON.parse), frames: chunks.length, bytes: raw.length, decodedBytes: total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await readSessionRecords(process.argv[2]);
  console.log(JSON.stringify({ records: result.records.length, frames: result.frames, first: result.records.slice(0, 5).map(record => ({ type: record.type, keys: Object.keys(record), eventKeys: record.event ? Object.keys(record.event) : [], eventType: record.event?.type })) }, null, 2));
}
