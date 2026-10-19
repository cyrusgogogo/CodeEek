// Display-only geometry over Host-verified reading metadata; never infer symbols here.
export const MAX_CODE_READING_ITEMS = 200;
export const CODE_READING_KINDS = { function: '函数', method: '方法', constructor: '构造方法', class: '类', file: '文件' };
const validPoint = point => Number.isSafeInteger(point?.line) && point.line > 0 && Number.isSafeInteger(point.column) && point.column >= 0;
export const compareCodePoints = (left, right) => left.line - right.line || left.column - right.column;
export const codeReadingContains = (reading, point) => compareCodePoints(reading.start, point) <= 0 && compareCodePoints(point, reading.end) < 0;
const rangeKey = reading => `${['function', 'method', 'constructor'].includes(reading.kind) ? 'callable' : reading.kind}:${reading.start.line}:${reading.start.column}-${reading.end.line}:${reading.end.column}`;
export const lastReadingLine = reading => reading.end.line - (reading.end.column === 0 ? 1 : 0);
export const newestCodeReadings = items => [...items].sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0) || left.id.localeCompare(right.id));
function validVisiblePoint(point, rows) {
  const row = rows.find(value => value.number === point.line); if (!row) return true;
  if (point.column > row.text.length) return false;
  return !(point.column > 0 && /[\uD800-\uDBFF]/.test(row.text[point.column - 1]) && /[\uDC00-\uDFFF]/.test(row.text[point.column] ?? ''));
}
export function codeReadingGroups(value, rows) {
  if (!Array.isArray(value?.items) || !rows.length) return [];
  const groups = new Map(); const seen = new Set(); const first = rows[0].number; const last = rows.at(-1).number;
  for (const item of value.items.slice(0, MAX_CODE_READING_ITEMS)) {
    if (!item || !Object.hasOwn(CODE_READING_KINDS, item.kind) || !['id', 'name', 'conclusion', 'sessionId', 'lessonId', 'lessonTitle', 'createdAt'].every(key => typeof item[key] === 'string' && item[key].length > 0) || seen.has(item.id)) continue;
    if (!validPoint(item.start) || !validPoint(item.end) || compareCodePoints(item.start, item.end) >= 0 || !validVisiblePoint(item.start, rows) || !validVisiblePoint(item.end, rows)) continue;
    if (item.start.line > last || lastReadingLine(item) < first) continue;
    seen.add(item.id); const key = rangeKey(item); let group = groups.get(key);
    if (!group) { group = { key, start: { ...item.start }, end: { ...item.end }, markerLine: Math.max(first, item.start.line), items: [] }; groups.set(key, group); }
    group.items.push(item);
  }
  return [...groups.values()].map(group => ({ ...group, items: newestCodeReadings(group.items) })).sort((left, right) => compareCodePoints(left.start, right.start) || compareCodePoints(left.end, right.end));
}
export function codeReadingGroupAt(groups, point) {
  if (!validPoint(point)) return null;
  const priority = group => group.items.some(item => ['function', 'method', 'constructor'].includes(item.kind)) ? 0 : group.items.some(item => item.kind === 'class') ? 1 : 2;
  return groups.filter(group => codeReadingContains(group, point)).sort((left, right) => priority(left) - priority(right) || (left.end.line - left.start.line) - (right.end.line - right.start.line) || (left.end.column - left.start.column) - (right.end.column - right.start.column) || left.key.localeCompare(right.key))[0] ?? null;
}
export function codeReadingLines(groups, rows) {
  const result = new Map();
  for (const row of rows) {
    const covered = groups.filter(group => row.number >= group.start.line && row.number <= lastReadingLine(group));
    const markers = covered.filter(group => group.markerLine === row.number);
    if (covered.length) result.set(row.number, { covered, markers });
  }
  return result;
}
