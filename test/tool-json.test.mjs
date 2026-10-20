import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createTranslate } from './fixtures/deepseek-messages-translate-0.2.1-rc.2.mjs';
import { turnEndNotice } from '../src/client/turn-status.mjs';
import { apply } from '../src/preset.mjs';
import { apply as applyHost } from '../src/index.mjs';
import { ReadingStore, setRuntime, getRuntime } from '../src/store.mjs';

// The provider is not installed or contacted: only a hash-pinned upstream translator
// excerpt runs, with the real SDK error/brand types already in our dev dependencies.
const requireSdk = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'));
const { LlmError, ToolCallId } = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-llm')).href);
const translate = createTranslate(LlmError, ToolCallId);
const exactFailure = 'DeepSeek Messages stream: tool input is invalid JSON';
function messages(partial, { stop = 'tool_use', messageStop = true, name = 'reading_publish' } = {}) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-json', name, input: {} } },
    ...partial.map(partial_json => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    ...(messageStop ? [{ type: 'message_stop' }] : [])
  ];
}
async function replay(events) {
  const chunks = []; let error;
  try { for await (const chunk of translate(events, 'offline-fixture')) chunks.push(chunk); }
  catch (caught) { error = caught; }
  return { chunks, error };
}

test('固定真实 DeepSeek 0.2.1-rc.2 translator 字节与来源一致', async () => {
  const fixture = (await readFile(new URL('./fixtures/deepseek-messages-translate-0.2.1-rc.2.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const upstream = fixture.split('// BEGIN UPSTREAM\n')[1].split('// END UPSTREAM')[0];
  assert.equal(createHash('sha256').update(upstream).digest('hex'), '6f11f87cc448e14d3ea5a6fdc1567ee3bb66bcf25b85a01831cb799728fe9bd8');
  assert.match(fixture, /Copyright \(c\) 2026 DeepSeek/);
});

test('真实 provider 回放准确 JSON 症状，恢复提示不把降低风险承诺为根治', async () => {
  // All surrounding provider events are valid; only one unescaped pair of quotes
  // inside a model-generated claims[].text remains in this minimised repro.
  const raw = '{"claims":[{"text":"比较 "cache" 状态"}]}';
  const { error, chunks } = await replay(messages([raw]));
  assert.ok(error instanceof LlmError);
  assert.equal(error.code, 'MALFORMED_RESPONSE'); assert.equal(error.message, exactFailure);
  assert.ok(chunks.some(chunk => chunk.type === 'block-end'), 'A closed tool block is NOT a successful response');
  assert.ok(!chunks.some(chunk => chunk.type === 'finish'), 'No tool execution may be admitted from an unfinished response');
  const reason = { kind: 'error', error: error.failure };
  const notice = turnEndNotice(reason);
  assert.match(notice, /工具参数不是合法 JSON/);
  assert.match(notice, /不会自动修复参数或重发/);
  assert.match(notice, /不能保证.*不再/);
});

test('真实 translator 单变量探针：分片不改变原串、正确序列化不触发该症状', async () => {
  const values = ['比较 "cache" 状态', '路径 C:\\src\\file', '第一行\n下一行', '正则 \\d+ 与制表\t及 emoji 😀'];
  for (const text of values) {
    const raw = JSON.stringify({ text });
    for (const partial of [[raw], [...raw]]) {
      const result = await replay(messages(partial));
      assert.equal(result.error, undefined);
      assert.equal(result.chunks.at(-1).type, 'finish');
      assert.equal(result.chunks.find(chunk => chunk.type === 'block-end').block.arguments, raw);
    }
  }
  for (const raw of ['{"text":"未转义 "quote""}', '{"text":"C:\\src\\file"}', '{"text":"原始\n换行"}', '{"text":"尾部",}', '{"text":']) {
    for (const partial of [[raw], [...raw]]) {
      const result = await replay(messages(partial));
      assert.equal(result.error?.message, exactFailure); assert.equal(result.error?.code, 'MALFORMED_RESPONSE');
      assert.ok(!result.chunks.some(chunk => chunk.type === 'finish'));
    }
  }
});

test('JSON语法错误与流中断、max_tokens及非对象/字段契约失败不混淆', async () => {
  const truncated = await replay(messages(['{"text":'], { messageStop: false }));
  assert.equal(truncated.error.code, 'STREAM_CLOSED'); assert.notEqual(truncated.error.message, exactFailure);
  const limited = await replay(messages(['{"text":'], { stop: 'max_tokens' }));
  assert.equal(limited.error, undefined); assert.equal(limited.chunks.at(-1).reason.kind, 'max-tokens');
  const nonObject = await replay(messages(['[]']));
  assert.equal(nonObject.error.code, 'MALFORMED_RESPONSE'); assert.notEqual(nonObject.error.message, exactFailure);
  const wrongSchema = await replay(messages(['{"title":42}']));
  assert.equal(wrongSchema.error, undefined, 'Provider JSON validation must not be confused with plugin field validation');
});

async function publicationFixture(t) {
  const base = path.resolve('.test-output'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'tool-json-'));
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^tool-json-/); await fs.rm(absolute, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const source = 'export function cache() { return "cache"; }\n'; await fs.writeFile(path.join(repo, 'entry.ts'), source);
  const store = await new ReadingStore(path.join(root, 'artifacts')).init();
  const project = await store.createProject({ repositories: [{ path: repo }] });
  const state = await store.createSession(project.id);
  const { evidence } = await store.read(state.id, { repoId: project.repositories[0].id, path: 'entry.ts' });
  let turn = 1; const events = [];
  const agent = { id: state.id, status: 'idle', ctx: { preset: 'code-reading' }, session: { header: { cwd: store.sessionDir(state.id) }, snapshotEvents: () => events.length ? events : [{ type: 'turn/start', data: { turn } }, { type: 'step/start', data: { step: 1 } }] } };
  const definitions = new Map(); const effects = [];
  const ctx = { root: {}, effects, defaultModel: { provider: 'offline', model: 'fixture' },
    logger: { warn() {} }, effect(factory) { const result = factory(); if (typeof result === 'function') effects.push(result); return result; }, on: () => () => {}, get(name) { return this[name]; },
    tools: { guard: () => () => {}, presentAs: () => () => {}, register(tool) { definitions.set(tool.name, tool); return () => {}; } },
    systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {} }, skills: { register: () => () => {} },
    agentPresets: { composedPreset: value => value.preset, register: async () => () => {} }, connection: { fetch: { register: () => () => {} } },
    agents: { get: id => id === state.id ? agent : undefined }, agentDefaultModel: { currentSelection: () => ctx.defaultModel },
    sessionController: { inspect: async () => ({ events }), resolveAgent: async () => ({ agent }), prompt: () => { throw new Error('No model requests allowed in this fixture'); } }
  };
  setRuntime(ctx.root, { store }); await applyHost(ctx, { dataDir: store.root }); apply(ctx);
  t.after(() => { for (const dispose of effects.reverse()) dispose(); });
  const text = '比较 "cache"；路径 C:\\src\\file；正则 \\d+\n下一行与 emoji 😀';
  const payload = { expectedRevision: 1, title: '字符串边界', markdown: text, conclusion: text, claims: [{ kind: 'fact', text, evidenceIds: [evidence.id] }], nextQuestions: ['为什么返回 "cache"？'], sections: [{ dimension: 'deep-read', markdown: text }], mermaid: 'flowchart TD\n A["cache"] --> B[done]', codeUnits: [{ kind: 'function', name: 'cache', repoId: evidence.repoId, path: evidence.path, fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, conclusion: text, evidenceIds: [evidence.id] }] };
  let executed = 0; let concluded = 0; const tool = definitions.get('reading_publish');
  async function dispatchResponse(raw) {
    const result = await replay(messages([raw]));
    // Mirrors the inspected agent-loop gate: block-end is insufficient; only a
    // settled tool-calls finish admits execution. No repair and no retry path.
    if (!result.error && result.chunks.at(-1)?.reason?.kind === 'tool-calls') {
      executed++;
      result.saved = await tool.execute(JSON.parse(result.chunks.find(chunk => chunk.type === 'block-end').block.arguments), { agent, callId: 'call-json', concludeTurn() { concluded++; } });
    }
    return result;
  }
  return { root, repo, source, store, state, events, payload, runtime: getRuntime(ctx.root), dispatchResponse, counts: () => ({ executed, concluded }), setTurn(value) { turn = value; } };
}

test('真实 translator→preset→store：非法语法不执行/重发，合法正文/证据/代码范围与转义精确保真', async t => {
  const f = await publicationFixture(t);
  await f.dispatchResponse(JSON.stringify(f.payload)); assert.deepEqual(f.counts(), { executed: 1, concluded: 1 });
  const lesson = f.store.session(f.state.id).lessons[0];
  for (const field of ['markdown', 'claims', 'sections', 'codeUnits', 'mermaid']) assert.deepEqual(lesson[field], f.payload[field]);
  await f.store.updateReaderState({ sessionId: f.state.id, expectedRevision: 0, patch: { selectedLessonId: lesson.id, lessonScrollTop: 72 } });
  const directory = f.store.sessionDir(f.state.id);
  const artifacts = async () => ({ state: await fs.readFile(path.join(directory, 'state.json'), 'utf8'), audit: await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8'), notes: await fs.readdir(path.join(directory, 'notes')), diagrams: await fs.readdir(path.join(directory, 'diagrams')) });
  const before = await artifacts(); f.setTurn(2);
  for (const raw of ['{"claims":[{"text":"比较 "cache""}]}', '{"markdown":"literal\nnewline"}', '{"sections":[{"markdown":"C:\\src"}]}', '{"codeUnits":[{"conclusion":"quote "x""}]}', '{"mermaid":"flowchart TD\n A-->B"}']) {
    const result = await f.dispatchResponse(raw); assert.equal(result.error.message, exactFailure);
    assert.deepEqual(f.counts(), { executed: 1, concluded: 1 }); assert.deepEqual(await artifacts(), before);
  }
  // Valid JSON with invalid plugin fields also fails closed, but at the Zod
  // boundary rather than the provider's malformed-JSON boundary.
  await assert.rejects(f.dispatchResponse('{"title":42}'), { name: 'ZodError' });
  assert.deepEqual(f.counts(), { executed: 2, concluded: 1 }); assert.deepEqual(await artifacts(), before);
  assert.equal(await fs.readFile(path.join(f.repo, 'entry.ts'), 'utf8'), f.source);
  const restored = await new ReadingStore(f.store.root).init();
  assert.deepEqual(restored.session(f.state.id).lessons[0], lesson);
  assert.equal(restored.session(f.state.id).readerState.lessonScrollTop, 72);
});

test('真实错误 failure 经 Host snapshot 保留准确分类及已有阅读状态，不触发重发', async t => {
  const f = await publicationFixture(t); const result = await replay(messages(['{"text":"bad "quote""}']));
  const reason = { kind: 'error', error: result.error.failure };
  f.events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } }, { seq: 1, type: 'turn/end', data: { turn: 1, reason } });
  const before = structuredClone(f.store.session(f.state.id));
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.state.id });
  assert.deepEqual(snapshot.turnEnd, { seq: 1, reason }); assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.state.lessons, before.lessons); assert.deepEqual(snapshot.state.evidence, before.evidence); assert.deepEqual(snapshot.state.readerState, before.readerState);
  assert.match(turnEndNotice(snapshot.turnEnd.reason), /工具参数不是合法 JSON/); assert.deepEqual(f.counts(), { executed: 0, concluded: 0 });
});

function assembled(skill) {
  const definitions = new Map(); let section;
  const ctx = { root: {}, effect: factory => factory(), tools: { presentAs: () => {}, guard: () => {}, register: tool => definitions.set(tool.name, tool) }, systemPrompt: { suppressRuntimeContext: () => {}, section: value => { section = value; } } };
  setRuntime(ctx.root, { enabled: true, skill, isReading: () => true, store: { sessions: new Map() } });
  apply(ctx);
  return { prompt: section.text({}), definitions };
}

test('实际导师提示包含工具 JSON 序列化步骤和可解析的字符串示例', async () => {
  const skill = await readFile(new URL('../skills/code-tutor/SKILL.md', import.meta.url), 'utf8');
  const { prompt } = assembled(skill);
  assert.match(prompt, /### 工具参数 JSON/);
  const section = prompt.split('### 工具参数 JSON')[1].split('\n### ')[0];
  assert.match(section, /claims\[\]\.text/);
  assert.match(section, /序列化/);
  const example = section.match(/```json\s*\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, 'Show one syntax-only example without fabricated evidence ids');
  const parsed = JSON.parse(example);
  assert.deepEqual(Object.keys(parsed), ['text']);
  assert.equal(parsed.text, '比较 "cache" 状态；路径 C:\\src\\file\n下一行');
  assert.match(section, /仅演示字符串转义/);
  assert.match(section, /真实证据/);
  assert.match(section, /不能保证真实模型/);
  assert.match(prompt, /明确成功响应作为归档成功依据/);
  assert.match(prompt, /提交结果不明/);
  assert.match(prompt, /等待用户核对已有档案/);
  assert.match(prompt, /不自行重发写操作/);
  assert.match(prompt, /不把整篇主 markdown 复制到每个 section/);
  assert.match(prompt, /完整 markdown 仍保留全部内容/);
  assert.doesNotMatch(prompt, /重试保持同一调用凭据/);
});

test('归档工具描述在发送前强调合法 JSON，保留原五工具及严格契约', async () => {
  const skill = await readFile(new URL('../skills/code-tutor/SKILL.md', import.meta.url), 'utf8');
  const { definitions } = assembled(skill);
  assert.deepEqual([...definitions.keys()].sort(), ['reading_catalog', 'reading_files', 'reading_publish', 'reading_read', 'reading_search']);
  const publish = definitions.get('reading_publish');
  assert.match(publish.description, /合法 JSON/);
  assert.match(publish.description, /转义/);
  assert.equal(publish.parameters.type, 'object');
  assert.equal(publish.parameters.additionalProperties, false);
  assert.equal(publish.parameters.properties.codeUnits.maxItems, 12);
  assert.ok(publish.parameters.required.includes('claims'));
  for (const field of [publish.parameters.properties.markdown, publish.parameters.properties.claims.items.properties.text, publish.parameters.properties.sections.items.properties.markdown, publish.parameters.properties.codeUnits.items.properties.conclusion, publish.parameters.properties.mermaid]) {
    assert.match(field.description ?? '', /JSON/);
    assert.match(field.description ?? '', /转义/);
  }
});
