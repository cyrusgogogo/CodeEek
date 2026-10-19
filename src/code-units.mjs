import { readingFocusSchema, codeUnitSchema, idSchema, STAGES, fail } from './contracts.mjs';
import { safeRelative, readRepository } from './filesystem.mjs';
import { offsetOf } from './anchors.mjs';

// An explicit data/document exemption, not a language detector. Unknown paths are code.
const NON_CODE_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc', 'org', 'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'properties', 'lock', 'log', 'xml', 'xsd', 'dtd', 'resx', 'plist', 'cfg', 'conf', 'config']);
const NON_CODE_NAMES = new Set(['readme', 'license', 'licence', 'notice', 'copying', 'authors', 'changelog', '.gitignore', '.gitattributes', '.editorconfig']);
export const CODE_READING_LIMITS = Object.freeze({ sessions: 1000, lessons: 5000, items: 200, checks: 400 });
function sourceLayout(source) {
  const offsets = []; let length = 0;
  for (const line of source.lines) { offsets.push(length); length += line.length + 1; }
  return { offsets, length: Math.max(0, length - 1) };
}
function sourceOffset(source, point, layout) {
  const line = source.lines[point.line - 1];
  if (typeof line !== 'string') fail('CODE_UNIT_RANGE', '代码单元行号超出文件');
  return layout.offsets[point.line - 1] + offsetOf([line], { line: 1, column: point.column });
}
const compare = (left, right) => left.line - right.line || left.column - right.column;
const lastTouchedLine = unit => unit.end.line - (unit.end.column === 0 && unit.end.line > unit.start.line ? 1 : 0);
export function isNonCodePath(relative) {
  const leaf = relative.split('/').at(-1).toLowerCase();
  if (leaf === 'cmakelists.txt') return false;
  return NON_CODE_NAMES.has(leaf) || NON_CODE_EXTENSIONS.has(leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.') + 1) : '');
}
export function parseReadingFocus(value, project) {
  const focus = readingFocusSchema.nullable().parse(value);
  if (focus) {
    safeRelative(focus.path);
    if (!project.repositories.some(repo => repo.id === focus.repoId)) fail('REPO_NOT_BOUND', '阅读关注范围的仓库未绑定到当前项目');
  }
  return focus;
}
export function restoredCodeUnits(value) {
  if (!Array.isArray(value) || value.length > 12) return [];
  const units = [];
  for (const raw of value) {
    const parsed = codeUnitSchema.safeParse(raw);
    if (!parsed.success || compare(parsed.data.start, parsed.data.end) > 0 || compare(parsed.data.start, parsed.data.end) === 0 && parsed.data.kind !== 'file') return [];
    units.push(parsed.data);
  }
  return units;
}
export function archivedCodeUnits(lesson) { return restoredCodeUnits(lesson.codeUnits).map((unit, index) => ({ ...unit, id: `${lesson.id}:${index}` })); }
function evidenceFor(state, id, evidenceMap) {
  const evidence = evidenceMap ? evidenceMap.get(id) : state.evidence.find(item => item.id === id);
  if (!evidence) fail('EVIDENCE_NOT_FOUND', '代码单元引用的证据不属于当前阅读会话');
  if (evidence.sessionId !== state.id || evidence.projectId !== state.projectId || evidence.bindingRevision !== 1) fail('CODE_UNIT_EVIDENCE', '代码单元证据的会话、项目或绑定版本不一致');
  return evidence;
}
export function verifyUnitEvidence(unit, state, evidenceMap) {
  const spans = [...new Set(unit.evidenceIds)].map(id => {
    const evidence = evidenceFor(state, id, evidenceMap);
    if (evidence.repoId !== unit.repoId || evidence.path !== unit.path || evidence.hash !== unit.fileHash) fail('CODE_UNIT_EVIDENCE', '每个代码单元必须引用同一仓库、路径和 SHA256 的完整范围证据');
    if (!Number.isSafeInteger(evidence.startLine) || !Number.isSafeInteger(evidence.endLine) || evidence.startLine < 1 || evidence.endLine < evidence.startLine) fail('CODE_UNIT_EVIDENCE', '代码单元证据行范围无效');
    return [evidence.startLine, evidence.endLine];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let nextLine = unit.start.line;
  for (const [start, end] of spans) {
    if (end < nextLine) continue;
    if (start > nextLine) break;
    nextLine = end + 1;
    if (nextLine > lastTouchedLine(unit)) return;
  }
  fail('CODE_UNIT_COVERAGE', '请完整读取方法/函数（或所声明的完整类/文件）；同版本证据必须连续覆盖代码单元的每一行，不能只发布局部选区');
}
export function verifyUnitSource(unit, source, state, layout = sourceLayout(source), evidenceMap) {
  if (source.hash !== unit.fileHash) fail('STALE_CODE_UNIT', '代码单元的源码版本已变化，请重新读取完整范围后发布');
  let start; let end;
  try { start = sourceOffset(source, unit.start, layout); end = sourceOffset(source, unit.end, layout); } catch { fail('CODE_UNIT_RANGE', '代码单元行列越界或切开 Unicode 字符'); }
  const fullLength = layout.length;
  if (end < start || end === start && !(unit.kind === 'file' && fullLength === 0)) fail('CODE_UNIT_RANGE', '代码单元必须是完整的非空语义范围，end 使用 UTF16 排他结束坐标');
  if (unit.kind === 'file' && (start !== 0 || end !== fullLength)) fail('CODE_UNIT_SCOPE', 'file 代码单元必须覆盖整份文件；不能以 file 包装局部片段');
  verifyUnitEvidence(unit, state, evidenceMap);
}
export async function verifyCodeUnits(store, state, units, refs) {
  const focus = state.readingFocus ?? null;
  const codeEvidence = refs.map(id => evidenceFor(state, id)).some(evidence => !isNonCodePath(evidence.path));
  if ((codeEvidence && !units.some(unit => !isNonCodePath(unit.path))) || (!units.length && focus && !isNonCodePath(focus.path))) fail('CODE_UNIT_REQUIRED', '代码阅读归档必须提供完整方法/函数或更大完整语义范围的 codeUnits；文档/数据文件可豁免');
  const sources = new Map(); const seen = new Set();
  for (const unit of units) {
    safeRelative(unit.path); const key = JSON.stringify([unit.repoId, unit.path]);
    if (!sources.has(key)) sources.set(key, await readRepository(store.repo(state.id, unit.repoId), unit.path));
    verifyUnitSource(unit, sources.get(key), state);
    const identity = JSON.stringify([unit.kind, unit.name, unit.repoId, unit.path, unit.fileHash, unit.start, unit.end]);
    if (seen.has(identity)) fail('DUPLICATE_CODE_UNIT', '相同代码范围只能归档为一个代码单元，请合并结论');
    seen.add(identity);
  }
  if (focus && !isNonCodePath(focus.path)) {
    const containing = units.some(unit => unit.repoId === focus.repoId && unit.path === focus.path && unit.fileHash === focus.fileHash && compare(unit.start, focus.start) <= 0 && compare(unit.end, focus.end) >= 0);
    if (!containing) fail('CODE_FOCUS_UNCOVERED', '本轮代码选区必须被同版本的完整代码单元包含；即使 claims 未引用选区证据，也不能转移到无关范围');
  }
  return structuredClone(units);
}

// State objects are replaced only after commit. This synchronous, bounded scan never
// reads other files, creates evidence, infers symbols, or asks a model on hover.
export function collectCodeReadings(store, sessionId, repoId, relative, source, limits = CODE_READING_LIMITS) {
  const current = store.session(sessionId); store.repo(sessionId, repoId); safeRelative(relative);
  const result = { sourceKind: isNonCodePath(relative) ? 'document' : 'code', items: [], staleCount: 0, legacyCount: 0, truncated: false };
  const records = []; let visitedSessions = 0; let visitedLessons = 0;
  function* states() { yield current; for (const state of store.sessions.values()) if (state.id !== current.id) yield state; }
  scan: for (const state of states()) {
    if (state.projectId !== current.projectId) continue;
    if (visitedSessions++ >= limits.sessions) { result.truncated = true; break; }
    for (const lesson of state.lessons) {
      if (visitedLessons++ >= limits.lessons) { result.truncated = true; break scan; }
      if (!lesson || !idSchema.safeParse(lesson.id).success || !lesson.id.startsWith('lesson-') || typeof lesson.title !== 'string' || !lesson.title.trim() || lesson.title.length > 160 || !STAGES.includes(lesson.stage) || typeof lesson.createdAt !== 'string' || lesson.createdAt.length > 64 || !Number.isFinite(Date.parse(lesson.createdAt))) { result.truncated = true; continue; }
      records.push({ state, lesson });
    }
  }
  // Sort bounded lesson references before validation; a fresh insight must not lose
  // its marker merely because 200 older records were encountered first.
  records.sort((left, right) => String(right.lesson.createdAt).localeCompare(String(left.lesson.createdAt)) || left.state.id.localeCompare(right.state.id) || String(left.lesson.id).localeCompare(String(right.lesson.id)));
  const layout = sourceLayout(source); const maps = new Map(); const ids = new Set(); let checks = 0;
  candidates: for (const { state, lesson } of records) {
    let evidenceMap = maps.get(state.id);
    if (!evidenceMap) {
      if (state.evidence.length > 500) result.truncated = true;
      evidenceMap = new Map(state.evidence.slice(0, 500).filter(evidence => evidence && typeof evidence.id === 'string').map(evidence => [evidence.id, evidence])); maps.set(state.id, evidenceMap);
    }
    if (!lesson.codeUnits?.length) {
      try {
        const referenced = [...(lesson.claims ?? []).slice(0, 20).flatMap(claim => (claim.evidenceIds ?? []).slice(0, 20)), ...(lesson.topics ?? []).slice(0, 6).flatMap(topic => (topic.evidenceIds ?? []).slice(0, 10))];
        if (referenced.some(id => { const evidence = evidenceMap.get(id); return evidence && evidence.sessionId === state.id && evidence.projectId === state.projectId && evidence.repoId === repoId && evidence.path === relative; })) result.legacyCount++;
      } catch { result.truncated = true; /* One malformed legacy record must not block the current source file. */ }
      continue;
    }
    const allUnits = archivedCodeUnits(lesson);
    if (!allUnits.length) { result.truncated = true; continue; }
    for (const unit of allUnits) {
      if (unit.repoId !== repoId || unit.path !== relative) continue;
      if (result.items.length >= limits.items || checks++ >= (limits.checks ?? CODE_READING_LIMITS.checks)) { result.truncated = true; break candidates; }
      try {
        if (unit.fileHash !== source.hash) { verifyUnitEvidence(unit, state, evidenceMap); result.staleCount++; continue; }
        verifyUnitSource(unit, source, state, layout, evidenceMap);
        if (ids.has(unit.id)) { result.truncated = true; continue; }
        ids.add(unit.id);
        result.items.push({ id: unit.id, kind: unit.kind, name: unit.name, start: { ...unit.start }, end: { ...unit.end }, conclusion: unit.conclusion, sessionId: state.id, lessonId: lesson.id, lessonTitle: lesson.title, stage: lesson.stage, createdAt: lesson.createdAt });
      } catch { result.truncated = true; /* Invalid local records never become invented gutter marks. */ }
    }
  }
  return result;
}
export function codeUnitsMarkdown(lesson, depth = 2) {
  if (!lesson.codeUnits?.length) return '';
  return `\n\n${'#'.repeat(depth)} 完整代码阅读范围\n\n> 语义边界由 AI 依据源码识别；Host 核验字节版本、坐标与完整证据覆盖，不代表通用 AST 证明。\n` + lesson.codeUnits.map(unit => `\n${'#'.repeat(depth + 1)} ${unit.name}（${unit.kind}）\n\n${unit.conclusion}\n\n- ${unit.repoId}:${unit.path}:${unit.start.line}:${unit.start.column + 1}–${unit.end.line}:${unit.end.column + 1}（结束排他）\n- SHA256 ${unit.fileHash}\n- 证据：${unit.evidenceIds.join(', ')}\n`).join('');
}
