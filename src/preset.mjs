import { getRuntime } from './store.mjs';
import { readSchema, filesSchema, searchSchema, publishSchema, schemaJson, TOOL_NAMES, fail } from './contracts.mjs';

export const name = 'code-reading-preset';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  const runtime = getRuntime(ctx.root);
  ctx.effect(() => ctx.tools.presentAs('native'), 'code-reading: native tools');
  // Retained preset revisions keep this guard even if the owning bundle is disabled.
  ctx.effect(() => ctx.tools.guard(exec => runtime.isReading(exec.agent) && (!runtime.enabled || !TOOL_NAMES.has(exec.name)) ? '阅读代码模式禁止此工具，或插件已停用' : undefined), 'code-reading: retained guard');
  ctx.effect(() => ctx.systemPrompt.suppressRuntimeContext(), 'code-reading: isolated context');
  ctx.effect(() => ctx.systemPrompt.section({ name: 'code-reading-tutor', order: -1000, complete: true, interpolate: false, text: context => {
    const id = context.agent?.id ?? context.scope?.id;
    const catalog = id && runtime.store.sessions.has(id) ? JSON.stringify(runtime.store.catalog(id), null, 2) : '未绑定阅读项目：请从阅读代码页面创建，不要猜测仓库。';
    return `你运行在 DSH 阅读代码模式。完整通用 skill 已自动加载，必须遵守。\n\n${runtime.skill}\n\n# 当前不可变仓库绑定与用户选择的阅读状态\n${catalog}\n\n本轮明确意图优先，readingMode 仅为阅读起点；按用户当前问题组织内容，stage 是兼容字段而非步骤约束。只用所列专用工具；成功 reading_publish 后即结束并等待用户。不能将档案目录当作目标项目仓库。`;
  } }), 'code-reading: complete tutor prompt');
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  function own(exec) { if (!runtime.enabled || !exec.agent || !runtime.isReading(exec.agent)) fail('NOT_READING_AGENT', '仅用于已启用的阅读代码模式'); runtime.store.session(exec.agent.id); return exec.agent.id; }
  const definitions = [
    { name: 'reading_catalog', description: '读取本轮 readingMode、intent（explain 或 logic-graph）、readingFocus（元数据关注范围）、兼容 stage、主题、revision 和多仓库绑定；每轮开始先调用。维度按需求组合，不代表固定流程。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async (args, exec) => { if (!args || Object.keys(args).length) fail('INVALID_REQUEST', 'catalog 无参数'); return runtime.store.catalog(own(exec)); } },
    { name: 'reading_files', description: '列出一个显式 repoId 的源码路径；filter 是路径字面子串，不是 glob。默认排除链接、依赖、构建和敏感配置。', parameters: schemaJson(filesSchema), execute: (args, exec) => runtime.store.files(own(exec), args, exec.signal) },
    { name: 'reading_search', description: '在绑定仓库中做有界字面量内容检索；搜索结果需 reading_read 后才可作为证据。', parameters: schemaJson(searchSchema), execute: (args, exec) => runtime.store.search(own(exec), args, exec.signal) },
    { name: 'reading_read', description: '读取源码并登记带 repoId、行号、原始字节 SHA256 的证据；symbol 是需在选定范围中存在的文本线索。代码以完整方法/函数为最小阅读单元，可连续分次读取，选区几行只是关注点，不能当作完整单元；语义边界按该语言识别，不宣称通用 AST。', parameters: schemaJson(readSchema), execute: (args, exec) => runtime.store.read(own(exec), args, exec.signal) },
    { name: 'reading_publish', description: '保存一个知识点、证据结论和可选 Mermaid 图，结束本轮等待用户。参数须为单个合法 JSON 对象；字符串中的英文双引号、反斜杠、换行先正确转义，具体示例见导师 skill 的“工具参数 JSON”。markdown 必须保留完整正文；新输出有可区分的实际维度时应提供 sections，同维度合并为一项，不补空维度、无固定顺序；省略仅兼容旧请求。事实/推导需引用当前会话有效证据。代码须提供 codeUnits（最多12）：完整方法/函数，必要时完整类/整文件；连续证据覆盖全部行，带 repoId/path/fileHash、UTF16 start/end排他坐标、名称、单元结论和 evidenceIds；代码 readingFocus 必须被包含。语义边界由AI按语言识别，Host核验字节/坐标/证据覆盖而非通用AST；文档/数据路径可豁免、未知扩展仍按代码。本轮 intent=logic-graph 时必须提供安全非空 mermaid，不能用无图笔记冒充完成；intent=explain 时图仍可选。不改变兼容 stage。', parameters: schemaJson(publishSchema), execute: async (args, exec) => {
      const id = own(exec);
      const events = [...exec.agent.session.snapshotEvents()].reverse();
      const turn = events.find(e => e.type === 'turn/start')?.data.turn;
      const step = events.find(e => e.type === 'step/start')?.data.step;
      const lesson = await runtime.store.publish(id, args, `${turn}:${step}:${exec.callId}`, turn);
      exec.concludeTurn(); return { saved: true, lessonId: lesson.id, title: lesson.title, conclusion: lesson.conclusion, nextQuestions: lesson.nextQuestions, outputDirectory: runtime.store.sessionDir(id) };
    } }
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register({ ...definition, output }), `code-reading: ${definition.name}`);
}
