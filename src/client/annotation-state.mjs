// A newer manifest observation must never be overwritten by an older file view.
export function mergeAnnotations(items, file, manifestRevision) {
  const merged = new Map(items.map(item => [item.id, item]));
  for (const item of file?.annotations ?? []) {
    const latest = merged.get(item.id);
    if (!latest) { if ((file.annotationRevision ?? -1) >= manifestRevision) merged.set(item.id, item); continue; }
    if (item.revision > latest.revision || (item.revision === latest.revision && (file.annotationRevision ?? -1) >= manifestRevision)) merged.set(item.id, item);
  }
  return [...merged.values()];
}
