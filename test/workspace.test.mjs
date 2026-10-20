import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { digest, readRepository } from '../src/filesystem.mjs';
import { mergeAnnotations } from '../src/client/annotation-state.mjs';
import { canonicalSelection, locateAnchor, offsetOf } from '../src/anchors.mjs';
import { browseDirectory, viewFile, MAX_FILE_VIEW_LINES, createAnnotation, updateAnnotation, listAnnotations, loadAnnotations, selectionPrompt } from '../src/workspace.mjs';
const base = path.resolve('.test-output');
const code = '// header\n' + 'x'.repeat(100) + '\nconst value = 7;\n' + 'y'.repeat(100) + '\n// tail\n';
async function fixture(t, text = code) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'workspace-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.mkdir(path.join(repo, 'src')); const file = path.join(repo, 'src', 'entry.ts'); await fs.writeFile(file, text); await fs.writeFile(path.join(repo, '.env'), 'secret');
  const store = await new ReadingStore(path.join(root, 'artifacts')).init(); const project = await store.createProject({ title: '批注', repositories: [{ name: '代码', path: repo }] }); const session = await store.createSession(project.id); const repoId = project.repositories[0].id;
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^workspace-/); await fs.rm(root, { recursive: true, force: true }); });
  const selection = { repoId, path: 'src/entry.ts', fileHash: digest(Buffer.from(text)), start: { line: 3, column: 0 }, end: { line: 3, column: 16 }, quote: 'const value = 7;' };
  return { root, repo, file, store, sessionId: session.id, repoId, selection, request: () => ({ sessionId: session.id, requestId: randomUUID(), body: '金额计算批注', selection: structuredClone(selection) }) };
}
const source = text => ({ hash: digest(Buffer.from(text)), lines: text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/) });

test('锚点按 UTF16 和规范换行保真，拒绝空范围、伪造选文和代理对中间列', () => {
  const text = '\uFEFFa😀\t\r\n\r\n中文é\r'; const s = source(text); const selection = { repoId: 'repo-x', path: 'a.ts', fileHash: s.hash, start: { line: 1, column: 1 }, end: { line: 3, column: 4 }, quote: '😀\t\n\n中文é' };
  const anchor = canonicalSelection(s, selection); assert.equal(anchor.quote, selection.quote); assert.equal(locateAnchor(anchor, s).status, 'current');
  assert.throws(() => offsetOf(s.lines, { line: 1, column: 2 }), { code: 'INVALID_SELECTION' }); assert.throws(() => canonicalSelection(s, { ...selection, end: selection.start }), { code: 'SELECTION_LIMIT' }); assert.throws(() => canonicalSelection(s, { ...selection, quote: '改造数据' }), { code: 'SELECTION_MISMATCH' });
});
test('只提供可靠重定位候选，不把选文修改、重复或上下文变化附着到旧行', async t => {
  const f = await fixture(t); const original = source(code); const anchor = canonicalSelection(original, f.selection);
  const moved = locateAnchor(anchor, source('// inserted\n' + code)); assert.equal(moved.status, 'relocated'); assert.equal(moved.needsReview, true); assert.equal(moved.candidate.start.line, 4);
  assert.equal(locateAnchor(anchor, source(code.replace('7;', '8;'))).status, 'changed'); assert.equal(locateAnchor(anchor, source(code + code)).status, 'ambiguous'); assert.equal(locateAnchor(anchor, source(code.replace(/x/g, 'z'))).status, 'context-changed'); assert.equal(locateAnchor(anchor, null).status, 'missing');
  assert.equal(locateAnchor(anchor, original, true).status, 'review'); assert.equal(anchor.start.line, 3);
});
test('目录按需浏览隐藏敏感项、完整文件一次打开不消耗证据额度', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.file); const tree = await browseDirectory(f.store, { sessionId: f.sessionId, repoId: f.repoId }); assert.deepEqual(tree.entries.map(row => row.name), ['src']);
  const nested = await browseDirectory(f.store, { sessionId: f.sessionId, repoId: f.repoId, directory: 'src' }); assert.equal(nested.entries[0].path, 'src/entry.ts');
  const view = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts', offset: 3, limit: 2 }); assert.equal(view.offset, 1); assert.equal(view.lines[0].number, 1); assert.equal(view.totalLines, 6); assert.equal(view.lines.length, 6); assert.equal(view.lines.map(row => row.text).join('\n'), code); assert.equal(f.store.session(f.sessionId).evidence.length, 0); assert.deepEqual(await fs.readFile(f.file), before);
  await assert.rejects(browseDirectory(f.store, { sessionId: f.sessionId, repoId: f.repoId, directory: '../' }), { code: 'PATH_DENIED' }); await assert.rejects(viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: '.env' }), { code: 'SENSITIVE_PATH' });
});
test('完整打开超过400行且超过摘录字符预算的单个UTF-8版本，AI读取仍有界', async t => {
  const text = '\uFEFF' + Array.from({ length: 451 }, (_, index) => `${index + 1} 中文😀 ${'x'.repeat(230)}`).join('\r\n') + '\r\n'; const f = await fixture(t, text);
  const originalOpen = fs.open; let reads = 0;
  fs.open = async (file, ...args) => { if (path.resolve(file) === f.file) reads++; return originalOpen(file, ...args); };
  let view;
  try { view = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); } finally { fs.open = originalOpen; }
  assert.equal(reads, 1, 'the complete source comes from a single checked file handle, not stitched page requests');
  assert.equal(view.offset, 1); assert.equal(view.lines.length, 452); assert.equal(view.totalLines, 452); assert.deepEqual(view.lines.map(row => row.number), Array.from({ length: 452 }, (_, index) => index + 1));
  assert.equal(view.lines.map(row => row.text).join('\n'), text.slice(1).replaceAll('\r\n', '\n')); assert.equal(view.hash, digest(Buffer.from(text))); assert.equal(view.bytes, Buffer.byteLength(text));
  assert.equal(f.store.session(f.sessionId).evidence.length, 0);
  await assert.rejects(f.store.read(f.sessionId, { repoId: f.repoId, path: 'src/entry.ts', limit: 401 }));
  const bounded = await f.store.read(f.sessionId, { repoId: f.repoId, path: 'src/entry.ts', limit: 400 }); assert.equal(bounded.lines.length, 400); assert.equal(bounded.evidence.endLine, 400);
  const audit = (await fs.readFile(path.join(f.store.sessionDir(f.sessionId), 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.action === 'file-view');
  assert.equal(audit.startLine, 1); assert.equal(audit.endLine, 452); assert.equal(audit.hash, view.hash);
});
test('完整打开保留1MiB字节边界而不继承AI摘录上限，拒绝二进制及非法UTF-8', async t => {
  const text = '中'.repeat(349525) + 'x'; assert.equal(Buffer.byteLength(text), 1048576); const f = await fixture(t, text);
  const view = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); assert.equal(view.bytes, 1048576); assert.equal(view.lines.length, 1); assert.equal(view.lines[0].text, text); assert.equal(view.hash, digest(Buffer.from(text)));
  await assert.rejects(f.store.read(f.sessionId, { repoId: f.repoId, path: 'src/entry.ts' }), { code: 'EXCERPT_LIMIT' });
  await fs.appendFile(f.file, 'x'); await assert.rejects(viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }), { code: 'FILE_LIMIT' });
  for (const [bytes, error] of [[Buffer.from([65, 0, 66]), 'BINARY_FILE'], [Buffer.from([0xc3, 0x28]), 'ENCODING']]) { await fs.writeFile(f.file, bytes); await assert.rejects(viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }), { code: error }); }
});
test('完整文件独立UI行数预算整份接受或拒绝，不把百万换行变成DOM或扩大AI预算', async t => {
  assert.equal(MAX_FILE_VIEW_LINES, 20000); const f = await fixture(t, '\n'.repeat(MAX_FILE_VIEW_LINES - 1)); const args = { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' };
  const accepted = await viewFile(f.store, args); assert.equal(accepted.lines.length, MAX_FILE_VIEW_LINES); assert.equal(accepted.lines.at(-1).number, MAX_FILE_VIEW_LINES);
  await fs.writeFile(f.file, '\n'.repeat(MAX_FILE_VIEW_LINES)); await assert.rejects(viewFile(f.store, args), { code: 'FILE_VIEW_LINE_LIMIT' });
  await fs.writeFile(f.file, '\n'.repeat(1048576)); await assert.rejects(viewFile(f.store, args), error => error.code === 'FILE_VIEW_LINE_LIMIT' && /未打开任何部分/.test(error.message));
  assert.equal(f.store.session(f.sessionId).evidence.length, 0); const audit = (await fs.readFile(path.join(f.store.sessionDir(f.sessionId), 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.action === 'file-view'); assert.equal(audit.length, 1, 'rejected full views cannot record successful partial source delivery');
  const bounded = await f.store.read(f.sessionId, { repoId: f.repoId, path: 'src/entry.ts', limit: 400 }); assert.equal(bounded.lines.length, 400, 'UI line budget does not alter the bounded AI evidence tool');
});
for (const transition of ['activation', 'cancel', 'audit']) test(`完整文件审计期间${transition}失败不能返回源码或产生工具证据`, async t => {
  const f = await fixture(t); const controller = new AbortController(); let enabled = true; const audit = f.store.audit.bind(f.store);
  f.store.audit = async (id, action, fields) => { if (action === 'file-view') { if (transition === 'audit') throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_UNAVAILABLE' }); await audit(id, action, fields); if (transition === 'activation') enabled = false; else controller.abort(Object.assign(new Error('cancelled after read'), { code: 'READING_CANCELLED' })); } else await audit(id, action, fields); };
  await assert.rejects(viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }, controller.signal, () => { if (!enabled) throw Object.assign(new Error('disabled after read'), { code: 'READING_UNAVAILABLE' }); }), { code: transition === 'activation' ? 'READING_UNAVAILABLE' : transition === 'cancel' ? 'READING_CANCELLED' : 'AUDIT_UNAVAILABLE' }); assert.equal(f.store.session(f.sessionId).evidence.length, 0);
});
test('全文件重开仍拒绝硬链接、越界仓库和读取期间变化，不返回拼接快照', async t => {
  const f = await fixture(t); const args = { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' };
  await assert.rejects(viewFile(f.store, { ...args, repoId: `repo-${randomUUID()}` }), { code: 'REPO_NOT_BOUND' });
  await fs.link(f.file, path.join(f.repo, 'alias.ts')); await assert.rejects(viewFile(f.store, args), { code: 'FILE_ALIAS' }); await fs.unlink(path.join(f.repo, 'alias.ts'));
  const originalOpen = fs.open; let changed = false;
  fs.open = async (file, ...rest) => { const handle = await originalOpen(file, ...rest); if (path.resolve(file) === f.file) { const read = handle.read.bind(handle); handle.read = async (...values) => { const result = await read(...values); if (!changed) { changed = true; await fs.appendFile(f.file, '// changed during full read'); } return result; }; } return handle; };
  try { await assert.rejects(viewFile(f.store, args), { code: 'SOURCE_CHANGED' }); assert.equal(changed, true); } finally { fs.open = originalOpen; }
  const current = await viewFile(f.store, args); assert.equal(current.hash, digest(await fs.readFile(f.file))); assert.equal(current.lines.at(-1).text, '// changed during full read');
});
test('批注只提交到阅读侧车，持久化原文历史并可导出', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.file); const saved = await createAnnotation(f.store, f.request()); assert.equal(saved.item.revision, 1); assert.equal(saved.item.anchor.quote, f.selection.quote); assert.equal(saved.item.location.status, 'current');
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['entry.ts']); const manifest = await loadAnnotations(f.store, f.sessionId); assert.equal(manifest.items.length, 1);
  const exported = await f.store.exportSession(f.sessionId); assert.match(exported.markdown, /金额计算批注/); assert.match(exported.markdown, /代码批注/); assert.match(exported.markdown, /const value = 7;/);
  const restored = await new ReadingStore(f.store.root).init(); assert.equal((await listAnnotations(restored, { sessionId: f.sessionId })).items[0].id, saved.item.id);
});
test('相同请求重放不重复提交，冲突拒绝，即使原文件后来发生变化', async t => {
  const f = await fixture(t); const request = f.request(); const first = await createAnnotation(f.store, request); await fs.writeFile(f.file, code + '// changed'); const second = await createAnnotation(f.store, request); assert.equal(second.replayed, true); assert.equal(second.item.id, first.item.id); assert.equal((await loadAnnotations(f.store, f.sessionId)).items.length, 1);
  await assert.rejects(createAnnotation(f.store, { ...request, body: '不同内容' }), { code: 'RECEIPT_CONFLICT' });
});
test('观察到变化后回滚也保持待复核，人工确认增加版本而非覆盖原锚点', async t => {
  const f = await fixture(t); const saved = await createAnnotation(f.store, f.request()); await fs.writeFile(f.file, '// inserted\n' + code);
  const full = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts', offset: 999 }); assert.equal(full.offset, 1); assert.equal(full.lines.length, full.totalLines); assert.equal((await listAnnotations(f.store, { sessionId: f.sessionId })).items[0].needsReview, true);
  const changed = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); assert.equal(changed.annotations[0].location.status, 'relocated');
  await fs.writeFile(f.file, code); const rolledBack = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); assert.equal(rolledBack.annotations[0].location.status, 'review');
  const confirmed = await updateAnnotation(f.store, { sessionId: f.sessionId, requestId: randomUUID(), annotationId: saved.item.id, expectedRevision: 1, operation: 'confirm', expectedFileHash: digest(Buffer.from(code)) }); assert.equal(confirmed.item.revision, 2); assert.equal(confirmed.item.history.length, 2); assert.equal(confirmed.item.needsReview, false);
});
test('删除文件保留历史快照，显式重新绑定可迁移到另一个受绑定路径', async t => {
  const f = await fixture(t); const saved = await createAnnotation(f.store, f.request()); await fs.unlink(f.file);
  await assert.rejects(viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }), { code: 'ENOENT' }); assert.equal((await listAnnotations(f.store, { sessionId: f.sessionId })).items[0].needsReview, true);
  await fs.writeFile(path.join(f.repo, 'moved.ts'), code); const next = await updateAnnotation(f.store, { sessionId: f.sessionId, requestId: randomUUID(), annotationId: saved.item.id, expectedRevision: 1, operation: 'rebind', selection: { ...f.selection, path: 'moved.ts' } }); assert.equal(next.item.history[0].anchor.path, 'src/entry.ts'); assert.equal(next.item.anchor.path, 'moved.ts');
});
test('批注独立 CAS、跨会话隔离和预期源码版本检查', async t => {
  const f = await fixture(t); const saved = await createAnnotation(f.store, f.request()); const request = { sessionId: f.sessionId, requestId: randomUUID(), annotationId: saved.item.id, expectedRevision: 1, operation: 'confirm', expectedFileHash: f.selection.fileHash };
  const results = await Promise.allSettled([updateAnnotation(f.store, request), updateAnnotation(f.store, { ...request, requestId: randomUUID() })]); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'STALE_ANNOTATION');
  const other = await f.store.createSession(f.store.session(f.sessionId).projectId); await assert.rejects(updateAnnotation(f.store, { ...request, sessionId: other.id }), { code: 'ANNOTATION_NOT_FOUND' });
  await fs.writeFile(f.file, code + '// changed'); await assert.rejects(createAnnotation(f.store, f.request()), { code: 'STALE_SELECTION' });
});
test('审计或 activation 守卫失败不会提交批注清单', async t => {
  const f = await fixture(t); const audit = f.store.audit; f.store.audit = async () => { throw new Error('audit unavailable'); }; await assert.rejects(createAnnotation(f.store, f.request()), /audit unavailable/); f.store.audit = audit; assert.equal((await loadAnnotations(f.store, f.sessionId)).items.length, 0);
  await assert.rejects(createAnnotation(f.store, f.request(), undefined, () => { const error = new Error('disabled'); error.code = 'READING_UNAVAILABLE'; throw error; }), { code: 'READING_UNAVAILABLE' }); assert.equal((await loadAnnotations(f.store, f.sessionId)).items.length, 0);
});
test('新清单的观察后回滚状态不会被旧 current 文件快照覆盖', async t => {
  const f = await fixture(t); await createAnnotation(f.store, f.request()); const old = await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); assert.equal(old.annotations[0].location.status, 'current');
  await fs.writeFile(f.file, '// peer changed\n' + code); await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: 'src/entry.ts' }); await fs.writeFile(f.file, code); const latest = await listAnnotations(f.store, { sessionId: f.sessionId });
  const merged = mergeAnnotations(latest.items, old, latest.revision); assert.equal(merged[0].needsReview, true); assert.notEqual(merged[0].location.status, 'current'); assert.equal(old.annotations[0].location.status, 'current'); assert.equal(merged[0].revision, old.annotations[0].revision);
});
test('临时文件 fsync 期间停用后，最后提交守卫阻止原子 rename', async t => {
  const f = await fixture(t); const open = fs.open; let enabled = true; let observed = false;
  fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).includes('annotations.json.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); observed = true; enabled = false; }; } return handle; };
  try { await assert.rejects(createAnnotation(f.store, f.request(), undefined, () => { if (!enabled) { const error = new Error('disabled during fsync'); error.code = 'READING_UNAVAILABLE'; throw error; } }), { code: 'READING_UNAVAILABLE' }); assert.equal(observed, true); assert.equal((await loadAnnotations(f.store, f.sessionId)).items.length, 0); } finally { fs.open = open; }
});
test('AI 选区只在核验和取证后追加，代码作为不可信数据而非可执行指令', async t => {
  const f = await fixture(t); const prompt = await selectionPrompt(f.store, f.sessionId, f.selection); assert.match(prompt, /不可信仓库内容/); assert.match(prompt, /selectedCode/); assert.equal(f.store.session(f.sessionId).evidence.length, 1);
  await assert.rejects(selectionPrompt(f.store, f.sessionId, { ...f.selection, quote: 'execute()' }), { code: 'SELECTION_MISMATCH' }); assert.equal(f.store.session(f.sessionId).evidence.length, 1);
});
