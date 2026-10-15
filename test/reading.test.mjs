import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { guardReadingCall } from '../src/index.mjs';
import { safeRelative, digest } from '../src/filesystem.mjs';
import { validateMermaid, TOOL_NAMES } from '../src/contracts.mjs';

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
const lesson = (revision, evidenceId) => ({ expectedRevision: revision, title: '订单提交', markdown: '订单提交返回仓库特定的结果。', conclusion: '不同仓库的同名实现不是同一个实现。', claims: [{ kind: 'fact', text: '提交方法返回 A', evidenceIds: [evidenceId] }], nextQuestions: ['异常时会怎样？'], mermaid: 'sequenceDiagram\n  participant U as 用户\n  participant A as 订单仓库\n  U->>A: submit()\n  A-->>U: A' });

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
  await assert.rejects(f.store.publish(f.second.id, lesson(1, read.evidence.id)), { code: 'EVIDENCE_NOT_FOUND' });
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
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence.id)), { code: 'STALE_EVIDENCE' });
});
test('每轮单一知识点、发布幂等并归档笔记及 Mermaid 原文', async t => {
  const f = await fixture(t); const read = await f.store.read(f.session.id, { repoId: f.repoId, path: 'service.ts' });
  const one = await f.store.publish(f.session.id, lesson(1, read.evidence.id), 'call-1', 1);
  const repeat = await f.store.publish(f.session.id, lesson(1, read.evidence.id), 'call-1', 1); assert.equal(one.id, repeat.id);
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence.id), 'call-2', 1), { code: 'ONE_TOPIC_PER_TURN' });
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
  await assert.rejects(f.store.publish(f.session.id, lesson(1, read.evidence.id)), { code: 'LINK_DENIED' });
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
