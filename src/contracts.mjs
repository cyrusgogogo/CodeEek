import { z } from 'zod';

export const PRESET = 'code-reading';
export const TOOL_NAMES = new Set(['reading_catalog', 'reading_files', 'reading_search', 'reading_read', 'reading_publish']);
export const STAGES = ['discover', 'business', 'call-chain', 'deep-read', 'verify'];
export const STAGE_LABELS = { discover: '发现业务', business: '业务解释', 'call-chain': '调用链', 'deep-read': '代码精读', verify: '理解验证' };
export const idSchema = z.string().regex(/^(project|reading|repo|evidence|lesson)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const relativeSchema = z.string().min(1).max(1024);
const str = (max) => z.string().trim().min(1).max(max);
export const createProjectSchema = z.object({ title: str(120), repositories: z.array(z.object({ name: str(60), path: str(2048), workspaceId: z.string().max(200).optional() }).strict()).min(1).max(12) }).strict();
export const readSchema = z.object({ repoId: idSchema, path: relativeSchema, offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(400).default(160), symbol: z.string().max(200).optional() }).strict();
export const filesSchema = z.object({ repoId: idSchema, filter: z.string().max(200).default(''), limit: z.number().int().min(1).max(300).default(150) }).strict();
export const searchSchema = z.object({ repoId: idSchema, query: str(256), caseSensitive: z.boolean().default(false), pathFilter: z.string().max(200).default(''), limit: z.number().int().min(1).max(80).default(40) }).strict();
export const claimSchema = z.object({ kind: z.enum(['fact', 'inference', 'hypothesis']), text: str(2000), evidenceIds: z.array(idSchema).max(20).default([]) }).strict().refine(c => c.kind === 'hypothesis' || c.evidenceIds.length > 0, { message: '事实和推导必须提供证据 ID' });
export const publishSchema = z.object({ expectedRevision: z.number().int().positive(), title: str(160), markdown: str(30000), conclusion: str(2000), claims: z.array(claimSchema).min(1).max(20), nextQuestions: z.array(str(300)).min(1).max(3), topics: z.array(z.object({ title: str(120), description: str(500), evidenceIds: z.array(idSchema).min(1).max(10) }).strict()).max(6).default([]), mermaid: z.string().max(10000).optional() }).strict();
export const changeStageSchema = z.object({ sessionId: idSchema, expectedRevision: z.number().int().positive(), stage: z.enum(STAGES), topic: z.string().trim().max(300).default('') }).strict();
export const promptSchema = z.object({ sessionId: idSchema, requestId: z.string().uuid(), text: str(16000), expectedRevision: z.number().int().positive(), expectedModel: z.object({ provider: str(100), model: str(200) }).strict() }).strict();
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
