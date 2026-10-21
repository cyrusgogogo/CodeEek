// Project-map metadata only. No source bytes, model calls, or browser persistence.
export const MAP_PAGE_SIZE = 100;
export const MAP_LAYER_IDS = ['ui', 'core', 'data', 'tests', 'docs', 'config', 'other'];
const hashPattern = /^[a-f0-9]{64}$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !value.includes('\u0000');
const layerId = value => MAP_LAYER_IDS.includes(value) || /^custom-[a-z0-9-]{1,40}$/.test(value ?? '');
export const mapProjectKey = project => project ? JSON.stringify([project.id, project.bindingRevision]) : '';
export function mapPath(value, empty = false) {
  return text(value, 1024, empty) && (value === '' ? empty : !/^[\/\\]|[\\:\u0000-\u001f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
}
export function normalizeMapPrefix(value) {
  if (typeof value !== 'string' || value.trim().startsWith('/')) throw new Error('路径归属需要有效的相对路径；覆盖全仓请明确留空，不能使用绝对路径。');
  return value.trim().replace(/\/$/, '');
}
export function validateLayerConfiguration(customLayers, assignments) {
  if (!Array.isArray(customLayers) || customLayers.length > 16 || !Array.isArray(assignments) || assignments.length > 128) throw new Error('最多配置 16 个自定义层、128 条路径归属。');
  const ids = new Set(MAP_LAYER_IDS); const prefixes = new Set();
  const layers = customLayers.map(layer => {
    if (!layer || !/^custom-[a-z0-9-]{1,40}$/.test(layer.id) || ids.has(layer.id) || !text(layer.name, 60) || !text(layer.description, 240, true)) throw new Error('自定义层标识、名称或说明无效；名称不可为空。');
    ids.add(layer.id); return { id: layer.id, name: layer.name.trim(), description: layer.description.trim() };
  });
  const rules = assignments.map(rule => {
    const prefix = normalizeMapPrefix(rule?.prefix);
    if (!rule || !mapPath(prefix, true) || !ids.has(rule.layerId) || prefixes.has(prefix)) throw new Error('路径归属需要有效的相对路径、唯一前缀和现有层；不能越出仓库。');
    prefixes.add(prefix); return { prefix, layerId: rule.layerId };
  });
  return { customLayers: layers, assignments: rules };
}
export function validateStructureMap(value, projectId, repoId, bindingRevision) {
  const fail = () => { throw new Error('项目地图响应无效或与当前项目、仓库不一致，请重新加载核对。'); };
  if (!value || value.version !== 1 || value.projectId !== projectId || value.repoId !== repoId || !Number.isSafeInteger(bindingRevision) || bindingRevision < 1 || value.bindingRevision !== bindingRevision || !count(value.revision) || !(value.indexedAt === null || text(value.indexedAt, 64) && Number.isFinite(Date.parse(value.indexedAt))) || !(value.inventoryHash === null || hashPattern.test(value.inventoryHash)) || !Array.isArray(value.files) || value.files.length > 8000 || !Array.isArray(value.layers) || value.layers.length > 23 || !count(value.visited) || typeof value.truncated !== 'boolean' || typeof value.readingTruncated !== 'boolean' || !Array.isArray(value.truncationReasons) || value.truncationReasons.length > 32 || value.truncationReasons.some(reason => !text(reason, 500))) fail();
  try { validateLayerConfiguration(value.customLayers, value.assignments); } catch { fail(); }
  const ids = new Set(); const paths = new Set();
  for (const layer of value.layers) {
    if (!layer || !layerId(layer.id) || ids.has(layer.id) || !text(layer.name, 60) || !text(layer.description, 500, true) || !['heuristic', 'manual'].includes(layer.origin) || !count(layer.fileCount) || !count(layer.readingFileCount)) fail();
    ids.add(layer.id);
  }
  for (const file of value.files) {
    if (!file || !mapPath(file.path) || paths.has(file.path) || !text(file.extension, 1024, true) || !ids.has(file.layerId) || !mapPath(file.modulePath, true) || !count(file.readingCount) || file.modulePath !== file.path.split('/').slice(0, -1).slice(0, 2).join('/')) fail();
    paths.add(file.path);
  }
  if (value.indexedAt === null && (value.files.length || value.inventoryHash !== null)) fail();
  return value;
}
export function validateStructureFile(value, projectId, repoId, path, bindingRevision) {
  const readings = value?.codeReadings;
  const point = position => position && Number.isSafeInteger(position.line) && position.line > 0 && position.line <= value.totalLines && count(position.column);
  const id = (value, kind) => new RegExp(`^${kind}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(value ?? '');
  if (!value || value.projectId !== projectId || value.repoId !== repoId || !Number.isSafeInteger(bindingRevision) || bindingRevision < 1 || value.bindingRevision !== bindingRevision || value.path !== path || !hashPattern.test(value.hash ?? '') || !count(value.indexRevision) || !count(value.bytes) || value.bytes > 1048576 || !Number.isSafeInteger(value.totalLines) || value.totalLines < 1 || !readings || !['code', 'document'].includes(readings.sourceKind) || !count(readings.staleCount) || !count(readings.legacyCount) || typeof readings.truncated !== 'boolean' || !Array.isArray(readings.items) || readings.items.length > 200) throw new Error('文件核验响应无效；不会根据未确认的版本定位源码或知识点。');
  const seen = new Set();
  for (const item of readings.items) {
    if (!item || !text(item.id, 200) || seen.has(item.id) || !['function', 'method', 'constructor', 'class', 'file'].includes(item.kind) || !text(item.name, 200) || !text(item.conclusion, 2000) || !text(item.lessonTitle, 160) || !id(item.sessionId, 'reading') || !id(item.lessonId, 'lesson') || !point(item.start) || !point(item.end) || item.start.line > item.end.line || item.start.line === item.end.line && (item.start.column > item.end.column || item.start.column === item.end.column && item.kind !== 'file')) throw new Error('已有阅读关联格式无效，请重新核验文件。');
    seen.add(item.id);
  }
  return value;
}
export function mapPage(items, page = 0) {
  const pages = Math.max(1, Math.ceil(items.length / MAP_PAGE_SIZE)); const index = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
  return { items: items.slice(index * MAP_PAGE_SIZE, (index + 1) * MAP_PAGE_SIZE), page: index, pages, total: items.length };
}
export function mapFiles(map, location, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return (map?.files ?? []).filter(file => (!location.layerId || file.layerId === location.layerId) && (location.kind !== 'module' || file.modulePath === location.modulePath) && (!needle || file.path.toLocaleLowerCase().includes(needle)));
}
export function mapModules(files) {
  const modules = new Map();
  for (const file of files) {
    const old = modules.get(file.modulePath) ?? { path: file.modulePath, fileCount: 0, readingFileCount: 0 };
    old.fileCount++; if (file.readingCount > 0) old.readingFileCount++; modules.set(file.modulePath, old);
  }
  return [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function readerDocumentKind(activeDocument, previous = null) {
  return activeDocument === 'map' ? ['source', 'reading'].includes(previous) ? previous : null : ['source', 'reading'].includes(activeDocument) ? activeDocument : null;
}
