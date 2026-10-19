import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { guardReadingCall } from '../src/index.mjs';
import { safeRelative, digest } from '../src/filesystem.mjs';
import { validateMermaid, TOOL_NAMES, promptSchema, publishSchema } from '../src/contracts.mjs';

const base = path.resolve('.test-output');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'reading-'));
  const a = path.join(root, 'repo-a'); const b = path.join(root, 'repo-b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'service.ts'), 'export class Orders {\n  submit() { return "A"; }\n}\n');
  await fs.writeFile(path.join(b, 'service.ts'), 'export class Orders {\n  submit() { return "B"; }\n}\n');
  await fs.writeFile(path.join(a, '.env'), 'SECRET_SENTINEL=do-not-return');
  const store = await new ReadingStore(path.join(root, 'artifacts')).init();
  const project = await store.createProject({ title: '联合阅读', repositories: [{ name: '订单', path: a }, { name: '支付', path: b }] });
  const session = await store.createSession(project.id); const second = await store.createSession(project.id);
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^reading-/); await fs.rm(absolute, { recursive: true, force: true }); });
  return { root, a, b, store, project, session, second, repoId: project.repositories[0].id };
}
const lesson = (revision, evidence) => {
  const evidenceId = typeof evidence === 'string' ? evidence : evidence.id;
  return { expectedRevision: revision, title: '订单提交', markdown: '订单提交返回仓库特定的结果。', conclusion: '不同仓库的同名实现不是同一个实现。', claims: [{ kind: 'fact', text: '提交方法返回 A', evidenceIds: [evidenceId] }], nextQuestions: ['异常时会怎样？'], mermaid: 'sequenceDiagram\n  participant U as 用户\n  participant A as 订单仓库\n  U->>A: submit()\n  A-->>U: A', ...(typeof evidence === 'object' ? { codeUnits: [{ kind: 'method', name: 'Orders.submit', repoId: evidence.repoId, path: evidence.path, fileHash: evidence.hash, start: { line: 2, column: 2 }, end: { line: 2, column: '  submit() { return "A"; }'.length }, conclusion: '完整提交方法返回仓库特定值。', evidenceIds: [evidenceId] }] } : {}) };
};

test('同名路径跨仓读取具有独立仓库与哈希，读取不修改源码', async t => {
  const f = await fixture(t); const original = await fs.readFile(path.join(f.a, 'service.ts'));
  const one = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts', offset: 2, limit: 1, symbol: 'submit' });
  const two = await f.store.read(f.session.id, { repoId: f.project.repositories[1].id, path: 'service.ts' });
  assert.notEqual(one.evidence.repoId, two.evidence.repoId); assert.notEqual(one.evidence.hash, two.evidence.hash); assert.equal(one.lines[0].number, 2); assert.match(one.lines[0].text, /"A"/); assert.equal(one.evidence.hash, digest(original));
  assert.deepEqual(await fs.readFile(path.join(f.a, 'service.ts')), original);
  assert.deepEqual((await fs.readdir(f.a)).sort(), ['.env', 'service.ts']);
});
test('拒绝未绑定仓库、跨会话证据、伪造行号与符号', async t => {
  const f = await fixture(t); const args = { repoId: f.repoId, path: 'service.ts' };
  await assert.rejects(f.store.read(f.session.id, { ...args, repoId: `repo-${randomUUID()}` }), { code: 'REPO_NOT_BOUND' });
  await assert.rejects(f.store.read(f.session.id, { ...args, offset: 99 }), { code: 'LINE_RANGE' });
  await assert.rejects(f.store.read(f.session.id, { ...args, symbol: 'missingSymbol' }), { code: 'SYMBOL_NOT_FOUND' });
  const read = await f.store.read(f.session.id, args);
  await assert.rejects(f.store.publish(f.second.id, lesson(1, read.evidence)), { code: 'EVIDENCE_NOT_FOUND' });
});
test('拒绝路径穿越、绝对路径、设备路径、ADS 和敏感文件', async t => {
  const f = await fixture(t);
  for (const value of ['../outside', '/etc/passwd', 'C:/Windows/file', 'C:relative', '\\\\server\\share', 'folder\\file', 'a//b', 'a/./b', 'a/../b', 'file:secret', 'NUL', 'x./file', 'file ']) assert.throws(() => safeRelative(value));
  await assert.rejects(f.store.read(f.session.id, { repoId: f.repoId, path: '.env' }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts', command: 'write' }));
});
test('拒绝跨仓 junction 和源码根目录替换', async t => {
  const f = await fixture(t); const link = path.join(f.a, 'escape');
  try { await fs.symlink(f.b, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('系统不允许创建测试链接'); throw e; }
  await assert.rejects(f.store.read(f.session.id, { repoId: f.repoId, path: 'escape/service.ts' }), { code: 'LINK_DENIED' });
  assert.equal((await f.store.files(f.session.id, { repoId: f.repoId })).paths.some(p => p.startsWith('escape/')), false);
});
test('禁止产物目录与仓库重叠或嵌套，也禁止重复仓库', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.createProject({ title: '坏绑定', repositories: [{ name: '父目录', path: f.root }] }), { code: 'STORAGE_OVERLAP' });
  await assert.rejects(f.store.createProject({ title: '重复', repositories: [{ name: 'a', path: f.a }, { name: 'a2', path: f.a }] }), { code: 'DUPLICATE_REPOSITORY' });
  await assert.rejects(f.store.createProject({ title: '产物', repositories: [{ name: 'data', path: f.store.root }] }), { code: 'STORAGE_OVERLAP' });
});
test('搜索字面量、排除敏感配置、记录所有实际扫描的文件但不记源码或查询词', async t => {
  const f = await fixture(t); const result = await f.store.search(f.session.id, { repoId: f.repoId, query: 'submit()' });
  assert.equal(result.matches[0].line, 2);
  const audit = await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'audit.jsonl'), 'utf8');
  assert.match(audit, /queryHash/); assert.match(audit, /service.ts/); assert.doesNotMatch(audit, /submit\(\)|SECRET_SENTINEL|export class/);
});
test('源码变化使旧证据失效，即使大小及 mtime 相同也禁止发布', async t => {
  const f = await fixture(t); const file = path.join(f.a, 'service.ts'); const before = await fs.stat(file); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' });
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"A"', '"Z"')); await fs.utimes(file, before.atime, before.mtime);
  assert.equal((await f.store.openEvidence(f.session.id, read.evidence.id)).stale, true);
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence)), { code: 'STALE_EVIDENCE' });
});
test('每轮单一知识点、发布幂等并归档笔记及 Mermaid 原文', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' });
  const one = await f.store.publish(f.session.id, lesson(1, read.evidence), 'call-1', 1);
  const repeat = await f.store.publish(f.session.id, lesson(1, read.evidence), 'call-1', 1); assert.equal(one.id, repeat.id);
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence), 'call-2', 1), { code: 'ONE_TOPIC_PER_TURN' });
  assert.equal(f.store.session(f.session.id).stage, 'discover');
  assert.match(await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'notes', `${one.id}.md`), 'utf8'), /SHA256/);
  assert.match(await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'diagrams', `${one.id}.mmd`), 'utf8'), /sequenceDiagram/);
  assert.equal((await f.store.exportSession(f.session.id)).path.startsWith(f.store.root), true);
});
test('阶段 CAS 拒绝陈旧并发提交，禁止无证据事实', async t => {
  const f = await fixture(t);
  const updates = await Promise.allSettled(['business', 'call-chain'].map(stage => f.store.changeStage({ sessionId: f.session.id, expectedRevision: 1, stage, topic: '提交订单' })));
  assert.equal(updates.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.store.session(f.session.id).revision, 2);
  await assert.rejects(f.store.publish(f.session.id, { ...lesson(2, `evidence-${randomUUID()}`), claims: [{ kind: 'fact', text: '缺证据', evidenceIds: [] }] }));
  assert.equal(f.store.session(f.second.id).revision, 1);
});
test('并发读取不丢证据；重启恢复绑定、阶段和消息，不重复归档', async t => {
  const f = await fixture(t);
  await Promise.all([f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts', offset: 1, limit: 1 }), f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts', offset: 2, limit: 1 })]);
  assert.equal(f.store.session(f.session.id).evidence.length, 2);
  const events = [{ seq: 0, type: 'user/message', time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: '请解释订单' }] } }, { seq: 1, type: 'turn/start', time: Date.now(), data: { turn: 1 } }, { seq: 2, type: 'assistant/message', time: Date.now(), data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '不应归档推理' }, { type: 'text', text: '本轮结论' }] } } }];
  await f.store.archiveEvents(f.session.id, events); await f.store.archiveEvents(f.session.id, events);
  const restored = await new ReadingStore(f.store.root).init(); const snapshot = await restored.snapshot(f.session.id);
  assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.state.evidence.length, 2); assert.equal(restored.diagnostics.length, 0); assert.doesNotMatch(JSON.stringify(snapshot.messages), /不应归档推理/);
});
test('产物目录被替换为 junction 后拒绝所有写入', async t => {
  const f = await fixture(t); const notes = path.join(f.store.sessionDir(f.session.id), 'notes');
  await fs.rmdir(notes); await fs.symlink(f.a, notes, process.platform === 'win32' ? 'junction' : 'dir');
  const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' });
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence)), { code: 'LINK_DENIED' });
  assert.deepEqual((await fs.readdir(f.a)).sort(), ['.env', 'service.ts']);
});
test('超大文件被拒绝，未审计成功的读取不返回', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a, 'huge.txt'), Buffer.alloc(1048577, 65));
  await assert.rejects(f.store.read(f.session.id, { repoId: f.repoId, path: 'huge.txt' }), { code: 'FILE_LIMIT' });
  const old = f.store.audit; f.store.audit = async () => { throw new Error('模拟磁盘不可写'); };
  await assert.rejects(f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }), /磁盘不可写/); f.store.audit = old;
  assert.equal(f.store.session(f.session.id).evidence.length, 0);
});
test('阅读 Agent 对所有非白名单工具拒绝，不影响普通 Agent', async () => {
  const store = { sessions: new Map([['r1', {}]]) }; const presets = { composedPreset: ctx => ctx?.preset };
  const reading = { id: 'r1', ctx: {} }; const normal = { id: 'normal', ctx: {} };
  for (const name of ['pwsh', 'write', 'edit', 'subagent', 'workflow', 'plugin_manager', 'web_fetch', 'run_code', 'multi_tool_use.parallel', 'cordis_host']) assert.ok(guardReadingCall(store, presets, { agent: reading, name }));
  for (const name of TOOL_NAMES) assert.equal(guardReadingCall(store, presets, { agent: reading, name }), undefined);
  assert.equal(guardReadingCall(store, presets, { agent: normal, name: 'write' }), undefined);
});
test('Mermaid 拒绝覆盖配置、交互、HTML 和外部资源', () => {
  assert.match(validateMermaid('flowchart TD\n A[下单] --> B[支付]'), /flowchart/);
  for (const source of ['flowchart TD\n click A "javascript:alert(1)"', '%%{init:{}}%%\nflowchart TD\nA-->B', 'flowchart TD\nA[<img src=x onerror=x>]', 'flowchart TD\nstyle A fill:url(https://evil)', 'flowchart TD\nclassDef a fill:red', 'flowchart TD\nA[https://evil]']) assert.throws(() => validateMermaid(source));
});

test('prompt 模式可选且省略不填默认值，仅允许 question/code', () => {
  const request = { sessionId: `reading-${randomUUID()}`, requestId: randomUUID(), text: '解释逻辑', expectedRevision: 1, expectedModel: { provider: 'local', model: 'reader' } };
  assert.equal(Object.hasOwn(promptSchema.parse(request), 'readingMode'), false); assert.equal(promptSchema.parse(request).intent, 'explain');
  for (const intent of ['graph', '', null, 1]) assert.throws(() => promptSchema.parse({ ...request, intent }));
  assert.throws(() => promptSchema.parse({ ...request, intent: 'logic-graph' }), /必须提供当前代码选区/);
  for (const readingMode of ['question', 'code']) assert.equal(promptSchema.parse({ ...request, readingMode }).readingMode, readingMode);
  for (const readingMode of ['', 'discover', null, 1]) assert.throws(() => promptSchema.parse({ ...request, readingMode }));
});

test('省略或留空名称从绑定物理目录 basename 推导，显式名称和既有档案保留', async t => {
  const f = await fixture(t); const inputPath = path.join(f.a, '..', 'repo-a') + path.sep;
  const defaults = await f.store.createProject({ repositories: [{ path: inputPath }, { path: f.b, name: '显式仓库名' }] });
  assert.equal(defaults.title, path.basename(defaults.repositories[0].root));
  assert.equal(defaults.repositories[0].name, 'repo-a'); assert.equal(defaults.repositories[1].name, '显式仓库名');
  const blanks = await f.store.createProject({ title: '   ', repositories: [{ name: ' ', path: f.b }] });
  assert.equal(blanks.title, 'repo-b'); assert.equal(blanks.repositories[0].name, 'repo-b');
  const named = await f.store.createProject({ title: '  我的历史项目  ', repositories: [{ name: '  自定义仓库  ', path: f.a }] });
  const file = path.join(f.store.projectDir(named.id), 'project.json'); const before = await fs.readFile(file, 'utf8');
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.project(named.id).title, '我的历史项目'); assert.equal(restored.project(named.id).repositories[0].name, '自定义仓库');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const longPath = path.join(f.root, 'x'.repeat(80)); await fs.mkdir(longPath);
  const bounded = await f.store.createProject({ repositories: [{ path: longPath }] }); assert.equal(bounded.title.length, 80); assert.equal(bounded.repositories[0].name.length, 60);
});

test('sections 默认空列表且有界，完整 markdown 始终必填，维度无固定顺序', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence);
  assert.deepEqual(publishSchema.parse(raw).sections, []);
  for (const sections of [[{ dimension: 'unknown', markdown: '正文' }], [{ dimension: 'business', markdown: '  ' }], [{ dimension: 'business', markdown: 'x'.repeat(30001) }], [{ dimension: 'business', markdown: '正文', prompt: '越权' }], Array.from({ length: 6 }, () => ({ dimension: 'business', markdown: '正文' }))]) await assert.rejects(f.store.publish(f.session.id, { ...raw, sections }));
  const sections = [{ dimension: 'deep-read', markdown: '先解释实现。' }, { dimension: 'business', markdown: '补充相关业务。' }, { dimension: 'call-chain', markdown: '只展示必要关系。' }];
  await assert.rejects(f.store.publish(f.session.id, { ...raw, markdown: '', sections }));
  const saved = await f.store.publish(f.session.id, { ...raw, sections }, 'dimensions', 1);
  assert.deepEqual(saved.sections, sections); assert.equal(saved.markdown, raw.markdown); assert.equal(saved.stage, 'discover');
  const snapshot = await f.store.snapshot(f.session.id); assert.deepEqual(snapshot.state.lessons[0].sections, sections); assert.equal(snapshot.revision, 1);
  const note = await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'notes', `${saved.id}.md`), 'utf8'); assert.ok(note.includes(raw.markdown));
  const exported = await f.store.exportSession(f.session.id); assert.ok(exported.markdown.includes(raw.markdown));
  for (const section of sections) { assert.ok(note.includes(section.markdown)); assert.ok(exported.markdown.includes(section.markdown)); }
  const restored = await new ReadingStore(f.store.root).init(); assert.deepEqual(restored.session(f.session.id).lessons[0].sections, sections);
  await assert.rejects(restored.publish(f.session.id, { ...raw, sections: [{ dimension: 'business', markdown: '不同内容' }] }, 'dimensions', 1), { code: 'RECEIPT_CONFLICT' });
});

test('重复 dimension 明确拒绝且不产生笔记或凭据，同维度合并后可正常发布', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence);
  const sections = [{ dimension: 'business', markdown: '业务背景' }, { dimension: 'deep-read', markdown: '实现逻辑' }, { dimension: 'business', markdown: '业务规则' }];
  await assert.rejects(f.store.publish(f.session.id, { ...raw, sections }, 'duplicate-dimension', 1), /dimension 不能重复/);
  assert.equal(f.store.session(f.session.id).lessons.length, 0); assert.equal(Object.hasOwn(f.store.session(f.session.id).publishReceipts, 'duplicate-dimension'), false);
  assert.deepEqual(await fs.readdir(path.join(f.store.sessionDir(f.session.id), 'notes')), []);
  const merged = [{ dimension: 'business', markdown: '业务背景与业务规则' }, { dimension: 'deep-read', markdown: '实现逻辑' }];
  const saved = await f.store.publish(f.session.id, { ...raw, sections: merged }, 'duplicate-dimension', 1); assert.deepEqual(saved.sections, merged);
});

test('有界最大 sections 可完整归档，完整 markdown 仍是主正文', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence);
  const sections = ['deep-read', 'call-chain', 'business', 'discover', 'verify'].map(dimension => ({ dimension, markdown: dimension + '中'.repeat(29980) }));
  const saved = await f.store.publish(f.session.id, { ...raw, sections }); const note = await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'notes', `${saved.id}.md`), 'utf8');
  assert.ok(note.includes(raw.markdown)); assert.ok(Buffer.byteLength(note) < 1048576);
  const exported = await f.store.exportSession(f.session.id); for (const section of sections) { assert.ok(note.includes(section.markdown)); assert.ok(exported.markdown.includes(section.markdown)); }
});

test('历史发布凭据不受空 sections/codeUnits 影响，旧档案仅补内存默认且不猜造方法', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const current = lesson(1, read.evidence); const { codeUnits, ...raw } = current;
  const legacyPayload = { expectedRevision: raw.expectedRevision, title: raw.title, markdown: raw.markdown, conclusion: raw.conclusion, claims: raw.claims, nextQuestions: raw.nextQuestions, topics: [], mermaid: raw.mermaid };
  const saved = await f.store.publish(f.session.id, current, 'legacy-receipt', 1); assert.deepEqual(saved.sections, []);
  const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const old = JSON.parse(await fs.readFile(file, 'utf8'));
  delete old.readingMode; delete old.readingModeRevision; delete old.intent; delete old.readingFocus; delete old.lessons[0].intent; delete old.lessons[0].readingFocus; delete old.lessons[0].sections; delete old.lessons[0].codeUnits;
  old.publishReceipts['legacy-receipt'].payloadHash = digest(JSON.stringify(legacyPayload)); old.customMetadata = '保留'; const before = JSON.stringify(old, null, 2) + '\n'; await fs.writeFile(file, before);
  const restored = await new ReadingStore(f.store.root).init(); const snapshot = await restored.snapshot(f.session.id);
  assert.equal(snapshot.readingMode, 'question'); assert.equal(snapshot.state.readingMode, 'question'); assert.equal(snapshot.state.readingModeRevision, 0); assert.equal(snapshot.intent, 'explain'); assert.equal(snapshot.state.intent, 'explain'); assert.equal(snapshot.state.readingFocus, null); assert.equal(snapshot.state.lessons[0].intent, 'explain'); assert.deepEqual(snapshot.state.lessons[0].sections, []); assert.deepEqual(snapshot.state.lessons[0].codeUnits, []);
  assert.equal(await fs.readFile(file, 'utf8'), before); assert.equal(snapshot.state.customMetadata, '保留'); assert.equal(restored.session(f.session.id).publishReceipts['legacy-receipt'].payloadHash, digest(JSON.stringify(legacyPayload)));
  await fs.writeFile(path.join(f.a, 'service.ts'), 'changed after publication');
  assert.equal((await restored.publish(f.session.id, raw, 'legacy-receipt', 1)).id, saved.id);
  assert.equal((await restored.publish(f.session.id, { ...raw, sections: [], codeUnits: [] }, 'legacy-receipt', 1)).id, saved.id);
  assert.equal(restored.session(f.session.id).lessons.length, 1); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('逻辑图意图禁止无图/空图/不安全图归档，合法图保存意图与完整图源码', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence);
  await f.store.updateReadingMode(f.session.id, 'code', undefined, 'logic-graph');
  const before = structuredClone(f.store.session(f.session.id)); const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const disk = await fs.readFile(file, 'utf8');
  for (const mermaid of [undefined, '', '  ', 'flowchart TD', 'flowchart TD\n%% only a comment', 'flowchart TD; %% only a comment', 'flowchart TD\n click A "https://evil"', 'not-a-supported-graph', 'flowchart TD\nA[<script>bad</script>]']) {
    await assert.rejects(f.store.publish(f.session.id, { ...raw, mermaid }, 'graph-validation', 1));
    assert.deepEqual(f.store.session(f.session.id), before); assert.equal(await fs.readFile(file, 'utf8'), disk);
    for (const folder of ['notes', 'diagrams']) assert.deepEqual(await fs.readdir(path.join(f.store.sessionDir(f.session.id), folder)), []);
  }
  const mermaid = 'flowchart TD\n A[submit] --> B[return A]'; const saved = await f.store.publish(f.session.id, { ...raw, mermaid }, 'graph-validation', 1);
  assert.equal(saved.intent, 'logic-graph'); assert.equal(saved.readingMode, 'code'); assert.equal(saved.mermaid, mermaid); assert.equal(saved.markdown, raw.markdown);
  assert.equal(await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'diagrams', `${saved.id}.mmd`), 'utf8'), mermaid + '\n');
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.catalog(f.session.id).intent, 'logic-graph'); assert.equal(restored.session(f.session.id).lessons[0].intent, 'logic-graph');
  const exported = await restored.exportSession(f.session.id); assert.ok(exported.markdown.includes(mermaid));
});

for (const failure of ['audit', 'state']) {
  test(`逻辑图 ${failure} 提交失败仅清理本次新产物，不破坏旧凭据/笔记，修复后可重试`, async t => {
    const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence);
    const old = await f.store.publish(f.session.id, raw, 'old-lesson', 1); await f.store.updateReadingMode(f.session.id, 'code', undefined, 'logic-graph');
    const before = structuredClone(f.store.session(f.session.id)); const dir = f.store.sessionDir(f.session.id); const files = {};
    for (const folder of ['notes', 'diagrams']) files[folder] = await fs.readdir(path.join(dir, folder));
    const oldNote = await fs.readFile(path.join(dir, 'notes', `${old.id}.md`), 'utf8'); const disk = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    const audit = f.store.audit.bind(f.store); const save = f.store.saveState.bind(f.store);
    if (failure === 'audit') f.store.audit = async (...args) => { if (args[1] === 'lesson-publish-attempt') throw new Error('graph audit failed'); return audit(...args); };
    else f.store.saveState = async () => { throw new Error('graph state failed'); };
    const graph = { ...raw, mermaid: 'classDiagram\n class Orders' };
    await assert.rejects(f.store.publish(f.session.id, graph, 'graph-retry', 2), /graph .* failed/);
    assert.deepEqual(f.store.session(f.session.id), before); assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), disk);
    for (const folder of ['notes', 'diagrams']) assert.deepEqual(await fs.readdir(path.join(dir, folder)), files[folder]);
    assert.equal(await fs.readFile(path.join(dir, 'notes', `${old.id}.md`), 'utf8'), oldNote);
    f.store.audit = audit; f.store.saveState = save; assert.equal((await f.store.publish(f.session.id, graph, 'graph-retry', 2)).intent, 'logic-graph');
  });
}

test('旧解释发布凭据在后续绘图意图下仍幂等，普通解释无图行为不变', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }); const raw = lesson(1, read.evidence); delete raw.mermaid;
  const saved = await f.store.publish(f.session.id, raw, 'old-no-graph', 1); assert.equal(saved.intent, 'explain'); assert.equal(saved.mermaid, undefined);
  await f.store.updateReadingMode(f.session.id, 'code', undefined, 'logic-graph');
  const replay = await f.store.publish(f.session.id, { ...raw, sections: [] }, 'old-no-graph', 1); assert.equal(replay.id, saved.id); assert.equal(replay.intent, 'explain');
  assert.equal(f.store.catalog(f.session.id).intent, 'logic-graph'); assert.equal(f.store.session(f.session.id).lessons.length, 1);
  await f.store.updateReadingMode(f.session.id, undefined, undefined, 'explain'); assert.equal(f.store.session(f.session.id).readingModeRevision, 1);
  assert.equal((await f.store.publish(f.session.id, raw, 'followup-no-graph', 2)).intent, 'explain'); assert.equal(f.store.session(f.session.id).revision, 1);
});

test('模式、取证、阅读位置与归档共用会话锁，不丢状态或消耗兼容阶段 revision', async t => {
  const f = await fixture(t); assert.equal(f.store.catalog(f.session.id).readingMode, 'question');
  await Promise.all([f.store.updateReadingMode(f.session.id, 'code'), f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' }), f.store.updateReaderState({ sessionId: f.session.id, expectedRevision: 0, patch: { lessonScrollTop: 25 } }), f.store.archiveEvents(f.session.id, [])]);
  const state = f.store.session(f.session.id); assert.equal(state.readingMode, 'code'); assert.equal(state.readingModeRevision, 1); assert.equal(state.revision, 1); assert.equal(state.stageHistory.length, 1); assert.equal(state.evidence.length, 1); assert.equal(state.readerState.lessonScrollTop, 25);
  await f.store.updateReadingMode(f.session.id, undefined); await f.store.updateReadingMode(f.session.id, 'code'); assert.equal(f.store.session(f.session.id).readingModeRevision, 1);
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.catalog(f.session.id).readingMode, 'code'); assert.equal(restored.list().projects[0].sessions.find(s => s.id === f.session.id).readingMode, 'code');
  await restored.changeStage({ sessionId: f.session.id, expectedRevision: 1, stage: 'verify' }); await restored.changeStage({ sessionId: f.session.id, expectedRevision: 2, stage: 'business' }); assert.equal(restored.catalog(f.session.id).readingMode, 'code');
  await restored.updateReadingMode(f.session.id, 'question'); assert.equal(restored.session(f.session.id).readingModeRevision, 2); assert.equal(restored.session(f.session.id).revision, 3);
});
