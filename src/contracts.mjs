import { z } from 'zod';

export const PRESET = 'code-reading';
export const TOOL_NAMES = new Set(['reading_catalog', 'reading_files', 'reading_search', 'reading_read', 'reading_publish']);
export const READING_MODES = ['question', 'code'];
export const readingModeSchema = z.enum(READING_MODES);
export const PROMPT_INTENTS = ['explain', 'logic-graph'];
export const promptIntentSchema = z.enum(PROMPT_INTENTS);
export const STAGES = ['discover', 'business', 'call-chain', 'deep-read', 'verify'];
export const STAGE_LABELS = { discover: '发现业务', business: '业务解释', 'call-chain': '调用链', 'deep-read': '代码精读', verify: '理解验证' };
export const idSchema = z.string().regex(/^(project|reading|repo|evidence|lesson)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const relativeSchema = z.string().min(1).max(1024);
const str = (max) => z.string().trim().min(1).max(max);
// Model-facing encoding guidance only: no repair, coercion, or relaxed validation.
const jsonStringEncoding = 'JSON 字符串：内容中的英文双引号、反斜杠和换行须按 JSON 规则转义，保持原义。';
const publishText = max => str(max).describe(jsonStringEncoding);
export const createProjectSchema = z.object({ title: z.string().trim().max(120).optional(), repositories: z.array(z.object({ name: z.string().trim().max(60).optional(), path: str(2048), workspaceId: z.string().max(200).optional() }).strict()).min(1).max(12) }).strict();
export const readSchema = z.object({ repoId: idSchema, path: relativeSchema, offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(400).default(160), symbol: z.string().max(200).optional() }).strict();
export const filesSchema = z.object({ repoId: idSchema, filter: z.string().max(200).default(''), limit: z.number().int().min(1).max(300).default(150) }).strict();
export const searchSchema = z.object({ repoId: idSchema, query: str(256), caseSensitive: z.boolean().default(false), pathFilter: z.string().max(200).default(''), limit: z.number().int().min(1).max(80).default(40) }).strict();
export const claimSchema = z.object({ kind: z.enum(['fact', 'inference', 'hypothesis']), text: publishText(2000), evidenceIds: z.array(idSchema).max(20).default([]) }).strict().refine(c => c.kind === 'hypothesis' || c.evidenceIds.length > 0, { message: '事实和推导必须提供证据 ID' });
export const pointSchema = z.object({ line: z.number().int().min(1), column: z.number().int().min(0).max(1048576) }).strict();
export const CODE_UNIT_KINDS = ['function', 'method', 'constructor', 'class', 'file'];
export const readingFocusSchema = z.object({ repoId: idSchema.refine(value => value.startsWith('repo-')), path: relativeSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/), start: pointSchema, end: pointSchema }).strict().refine(value => value.start.line < value.end.line || value.start.line === value.end.line && value.start.column < value.end.column, { message: '阅读关注范围必须非空，end 为 UTF16 排他结束坐标' });
export const codeUnitSchema = z.object({ kind: z.enum(CODE_UNIT_KINDS), name: str(200), repoId: idSchema.refine(value => value.startsWith('repo-')), path: relativeSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/), start: pointSchema, end: pointSchema, conclusion: publishText(2000), evidenceIds: z.array(idSchema.refine(value => value.startsWith('evidence-'))).min(1).max(40) }).strict();
export const publishSectionSchema = z.object({ dimension: z.enum(STAGES), markdown: publishText(30000) }).strict();
export const publishSchema = z.object({ expectedRevision: z.number().int().positive(), title: str(160), markdown: publishText(30000), conclusion: publishText(2000), claims: z.array(claimSchema).min(1).max(20), nextQuestions: z.array(str(300)).min(1).max(3), topics: z.array(z.object({ title: str(120), description: str(500), evidenceIds: z.array(idSchema).min(1).max(10) }).strict()).max(6).default([]), mermaid: z.string().max(10000).describe(jsonStringEncoding).optional(), sections: z.array(publishSectionSchema).max(5).refine(sections => new Set(sections.map(section => section.dimension)).size === sections.length, { message: 'sections 的 dimension 不能重复；同一维度的内容请合并为一个 section' }).default([]), codeUnits: z.array(codeUnitSchema).max(12).default([]) }).strict();
export const changeStageSchema = z.object({ sessionId: idSchema, expectedRevision: z.number().int().positive(), stage: z.enum(STAGES), topic: z.string().trim().max(300).default('') }).strict();
// Human reading position only: never accept source excerpts, prompts, model settings, or credentials.
const lessonIdSchema = idSchema.refine(value => value.startsWith('lesson-'), { message: '需要知识点 ID' });
const repoIdSchema = idSchema.refine(value => value.startsWith('repo-'), { message: '需要仓库 ID' });
const scrollSchema = z.number().finite().min(0).max(1000000000);
export const readerPositionSchema = z.object({ repoId: repoIdSchema, path: relativeSchema, hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1), scrollTop: scrollSchema.default(0), scrollLeft: scrollSchema.default(0) }).strict();
export const readerStateSchema = z.object({ version: z.literal(1).default(1), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), viewStage: z.enum(STAGES).nullable().default(null), selectedLessonId: lessonIdSchema.nullable().default(null), viewedLessonIds: z.array(lessonIdSchema).max(100).default([]), understoodLessonIds: z.array(lessonIdSchema).max(100).default([]), readerPosition: readerPositionSchema.nullable().default(null), activeDocument: z.enum(['source', 'reading']).nullable().default(null), lessonScrollTop: scrollSchema.default(0) }).strict();
export const readerStatePatchSchema = z.object({ viewStage: z.enum(STAGES).nullable().optional(), selectedLessonId: lessonIdSchema.nullable().optional(), viewedLessonIds: z.array(lessonIdSchema).max(100).optional(), understoodLessonIds: z.array(lessonIdSchema).max(100).optional(), readerPosition: readerPositionSchema.nullable().optional(), activeDocument: z.enum(['source', 'reading']).nullable().optional(), lessonScrollTop: scrollSchema.optional() }).strict();
export const updateReaderStateSchema = z.object({ sessionId: idSchema, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), patch: readerStatePatchSchema }).strict();
export const selectionSchema = z.object({ repoId: idSchema, path: relativeSchema, fileHash: z.string().regex(/^[a-f0-9]{64}$/), start: pointSchema, end: pointSchema, quote: z.string().min(1).max(8000) }).strict();
export const promptSchema = z.object({ sessionId: idSchema, requestId: z.string().uuid(), text: str(16000), expectedRevision: z.number().int().positive(), expectedModel: z.object({ provider: str(100), model: str(200) }).strict(), selection: selectionSchema.optional(), readingMode: readingModeSchema.optional(), intent: promptIntentSchema.default('explain') }).strict().refine(value => value.intent !== 'logic-graph' || !!value.selection, { path: ['selection'], message: '生成逻辑图必须提供当前代码选区 selection' });
export const modelSchema = z.object({ sessionId: idSchema, provider: str(100), model: str(200) }).strict();
export function schemaJson(schema) { return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }); }
export function effectiveModelSelection(events, fallback = null) {
  let pending = null; let lastUsed = null;
  for (const event of events) {
    if (event.type === 'model/selection') pending = event.data;
    if (event.type === 'request/header') {
      const config = event.data.header.config;
      lastUsed = { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: String(config.reasoningEffort) } : {}) };
      if (pending && pending.provider === lastUsed.provider && pending.model === lastUsed.model && pending.reasoningEffort === lastUsed.reasoningEffort) pending = null;
    }
  }
  return pending ?? lastUsed ?? fallback;
}
export function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
export function requireObject(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID_REQUEST', '请求字段不合法'); return value; }
// Conservative diagram subset: no source-controlled configuration or web capabilities.
export function validateMermaid(source) {
  if (!source?.trim()) return '';
  if (source.length > 10000 || source.split('\n').length > 160) fail('DIAGRAM_LIMIT', '图过大，请拆分为多个知识点');
  if (!/^\s*(sequenceDiagram|flowchart\s+(TD|TB|BT|LR|RL)|classDiagram|stateDiagram-v2|erDiagram)\b/.test(source)) fail('DIAGRAM_TYPE', '仅支持时序图、流程图、类图、状态图和 ER 图');
  if (/%%\s*\{|^\s*---|@\s*\{|!\[|&(?:lt|gt|#(?:x[0-9a-f]+|[0-9]+));|\b(click|href|callback|classDef|linkStyle|themeCSS)\b|^\s*style\b|<\/?[a-z!]|(?:javascript|data|https?|file):|url\s*\(/im.test(source)) fail('UNSAFE_DIAGRAM', '图包含配置覆盖、资产节点、HTML、外链或交互指令，请改成普通 Mermaid 图');
  return source.trim();
}
