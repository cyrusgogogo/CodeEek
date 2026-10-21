import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_PAGE_SIZE, MAP_LAYER_IDS, mapPath, mapProjectKey, mapPage, mapFiles, mapModules, readerDocumentKind, validateLayerConfiguration, validateStructureMap, validateStructureFile } from '../src/client/structure-map-state.mjs';

const projectId = 'project-11111111-1111-4111-8111-111111111111';
const repoId = 'repo-11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const file = (path, layerId = 'core', readingCount = 0) => ({ path, layerId, readingCount, extension: path.includes('.') ? path.split('.').at(-1) : '', modulePath: path.split('/').slice(0, -1).slice(0, 2).join('/') });
const empty = () => ({ version: 1, projectId, repoId, bindingRevision: 1, revision: 0, indexedAt: null, inventoryHash: null, files: [], layers: MAP_LAYER_IDS.map(id => ({ id, name: id, description: '', origin: 'heuristic', fileCount: 0, readingFileCount: 0 })), customLayers: [], assignments: [], truncated: false, visited: 0, readingTruncated: false, truncationReasons: [] });
const indexed = files => ({ ...empty(), revision: 1, indexedAt: '2026-10-20T00:00:00.000Z', inventoryHash: hash, files, visited: files.length });
const checked = value => validateStructureMap(value, projectId, repoId, 1);
const unit = (patch = {}) => ({ id: 'unit-current', kind: 'method', name: 'submit', conclusion: '当前版本的归档结论', lessonTitle: '提交知识点', sessionId: 'reading-11111111-1111-4111-8111-111111111111', lessonId: 'lesson-11111111-1111-4111-8111-111111111111', start: { line: 1, column: 0 }, end: { line: 1, column: 6 }, ...patch });
const inspected = items => ({ projectId, repoId, bindingRevision: 1, path: 'src/main.js', indexRevision: 1, hash, bytes: 6, totalLines: 1, codeReadings: { sourceKind: 'code', items, staleCount: 0, legacyCount: 0, truncated: false } });
const checkFile = value => validateStructureFile(value, projectId, repoId, 'src/main.js', 1);

test('地图身份包含项目和绑定修订，不以仓库同名路径替代', () => {
  assert.notEqual(mapProjectKey({ id: projectId, bindingRevision: 1 }), mapProjectKey({ id: projectId, bindingRevision: 2 }));
  assert.equal(mapProjectKey(null), '');
  for (const patch of [{ repoId: 'repo-other' }, { projectId: 'project-other' }, { bindingRevision: 2 }, { bindingRevision: undefined }]) assert.throws(() => checked({ ...empty(), ...patch }), /响应无效/);
});

test('未索引与已索引空结果不同；人工配置修订不冒充已扫描', () => {
  assert.equal(checked(empty()).indexedAt, null);
  assert.equal(checked({ ...empty(), revision: 5 }).indexedAt, null);
  assert.ok(checked(indexed([])).indexedAt);
  assert.throws(() => checked({ ...empty(), files: [file('main.js')] }), /响应无效/);
  assert.throws(() => checked({ ...empty(), inventoryHash: hash }), /响应无效/);
});

test('地图结构校验拒绝越界路径、伪模块、非法类型和重复项', () => {
  for (const path of ['../outside', '/absolute', 'C:/repo/a', 'src\\a', 'a//b', './a', 'src/../a', 'https://x', 'a\u0000b']) assert.equal(mapPath(path), false, path);
  assert.equal(mapPath('目录/[slug]/业务.js'), true); assert.equal(mapPath('', true), true); assert.equal(mapPath(''), false);
  const base = indexed([file('src/client/main.jsx')]);
  assert.equal(checked(base).files.length, 1);
  for (const patch of [{ files: [...base.files, ...base.files] }, { files: [{ ...base.files[0], modulePath: 'other' }] }, { files: [{ ...base.files[0], layerId: 'missing' }] }, { truncated: 'false' }, { readingTruncated: 0 }, { visited: -1 }, { truncationReasons: [12] }]) assert.throws(() => checked({ ...base, ...patch }), /响应无效/);
});

test('8000个路径在内存过滤和100项分页，不能渲染整仓列表', () => {
  const files = Array.from({ length: 8000 }, (_, i) => file(`src/module/file-${String(i).padStart(4, '0')}.js`));
  checked(indexed(files)); assert.throws(() => checked(indexed([...files, file('extra.js')])), /响应无效/);
  assert.equal(MAP_PAGE_SIZE, 100); assert.equal(mapPage(files, 0).items.length, 100); assert.equal(mapPage(files, 999).page, 79); assert.equal(mapPage(files, -3).page, 0);
  assert.equal(mapPage(files, 79).items.at(-1).path, files.at(-1).path); assert.deepEqual(mapPage([], 3), { items: [], page: 0, pages: 1, total: 0 });
  assert.equal(mapFiles({ files }, { kind: 'overview' }, 'FILE-7999').length, 1);
});

test('渐进式层和目录筛选保留层身份，不误将前缀当模块或glob', () => {
  const files = [file('src/client/a.jsx', 'ui', 3), file('src/client/b.jsx', 'ui'), file('src/client2/c.jsx', 'ui', 1), file('src/client/core.js', 'core'), file('README.md', 'docs')];
  const ui = mapFiles({ files }, { kind: 'layer', layerId: 'ui' }); assert.equal(ui.length, 3);
  assert.deepEqual(mapModules(ui), [{ path: 'src/client', fileCount: 2, readingFileCount: 1 }, { path: 'src/client2', fileCount: 1, readingFileCount: 1 }]);
  assert.equal(mapFiles({ files }, { kind: 'module', layerId: 'ui', modulePath: 'src/client' }).length, 2);
  assert.equal(mapFiles({ files }, { kind: 'overview' }, '*.jsx').length, 0);
});

test('人工层和最长前缀规则只做格式校验，不自动推断语义', () => {
  const layers = [{ id: 'custom-payment', name: ' 支付 ', description: ' 入口与失败处理 ' }];
  const config = validateLayerConfiguration(layers, [{ prefix: 'src/pay/', layerId: 'custom-payment' }, { prefix: '', layerId: 'core' }]);
  assert.equal(config.customLayers[0].name, '支付'); assert.equal(config.assignments[0].prefix, 'src/pay');
  assert.throws(() => validateLayerConfiguration(layers, [{ prefix: 'src', layerId: 'custom-payment' }, { prefix: 'src/', layerId: 'core' }]), /唯一前缀/);
  assert.throws(() => validateLayerConfiguration(layers, [{ prefix: '../x', layerId: 'core' }]), /相对路径/);
  for (const prefix of ['/', '//', ' / ', 'src//', {}, 1, null, undefined]) assert.throws(() => validateLayerConfiguration(layers, [{ prefix, layerId: 'core' }]), /相对路径/);
  assert.throws(() => validateLayerConfiguration(layers, [{ prefix: '', layerId: 'custom-missing' }]), /现有层/);
  assert.throws(() => validateLayerConfiguration([{ ...layers[0], id: 'ui' }], []), /标识/);
  assert.throws(() => validateLayerConfiguration([{ ...layers[0], name: ' ' }], []), /名称/);
  assert.throws(() => validateLayerConfiguration(Array.from({ length: 17 }, (_, i) => ({ ...layers[0], id: `custom-${i}` })), []), /16/);
  assert.throws(() => validateLayerConfiguration(layers, Array.from({ length: 129 }, (_, i) => ({ prefix: String(i), layerId: 'core' }))), /128/);
});

test('文件详情绑定当前哈希及明确会话和知识点，不接受越仓响应', () => {
  const value = inspected([unit()]); assert.equal(checkFile(value), value);
  for (const patch of [{ repoId: 'repo-other' }, { bindingRevision: 2 }, { path: 'same-name.js' }, { hash: 'old' }, { bytes: 1048577 }]) assert.throws(() => checkFile({ ...value, ...patch }), /核验响应无效/);
  for (const patch of [{ lessonId: 'latest' }, { sessionId: 'other' }, { start: { line: 0, column: 0 } }, { end: { line: 1, column: 0 } }, { end: { line: 2, column: 0 } }]) assert.throws(() => checkFile(inspected([unit(patch)])), /关联格式无效/);
});

test('空文件整文件单元允许零范围，其余单元及逆序范围仍被拒绝', () => {
  const zero = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };
  assert.equal(checkFile({ ...inspected([unit({ kind: 'file', ...zero })]), bytes: 0 }).codeReadings.items.length, 1);
  for (const kind of ['function', 'method', 'constructor', 'class']) assert.throws(() => checkFile(inspected([unit({ kind, ...zero })])), /关联格式无效/);
  assert.throws(() => checkFile(inspected([unit({ kind: 'file', start: { line: 1, column: 4 }, end: { line: 1, column: 3 } })])), /关联格式无效/);
});

test('地图不能进入旧reader-state activeDocument枚举', () => {
  assert.equal(readerDocumentKind('map', 'source'), 'source'); assert.equal(readerDocumentKind('map', 'reading'), 'reading'); assert.equal(readerDocumentKind('map', 'map'), null);
  for (const kind of ['source', 'reading']) assert.equal(readerDocumentKind(kind), kind);
  for (const kind of ['empty', undefined, null, 'future']) assert.equal(readerDocumentKind(kind), null);
});
