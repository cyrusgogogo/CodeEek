import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRepository } from '../src/filesystem.mjs';
import { TOOL_NAMES, validateMermaid } from '../src/contracts.mjs';
import { readSessionRecords } from './read-session-log.mjs';

// All reads are local and bounded. This verifier does not call a Host Service,
// send any model request, execute repository code, or write to reading archives.
const [root, projectId, sessionId, journal] = process.argv.slice(2);
assert.match(projectId ?? '', /^project-[0-9a-f-]{36}$/);
assert.match(sessionId ?? '', /^reading-[0-9a-f-]{36}$/);
const projectDir = path.join(root, 'projects', projectId); const directory = path.join(projectDir, 'sessions', sessionId);
const readJson = async file => { const stat = await fs.stat(file); assert.ok(stat.size <= 8 * 1024 * 1024); return JSON.parse(await fs.readFile(file, 'utf8')); };
const project = await readJson(path.join(projectDir, 'project.json')); const state = await readJson(path.join(directory, 'state.json'));
assert.equal(project.id, projectId); assert.equal(state.projectId, projectId); assert.equal(state.id, sessionId);
const projectHash = createHash('sha256').update(await fs.readFile(path.join(projectDir, 'project.json'))).digest('hex');
const auditText = await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8'); assert.ok(Buffer.byteLength(auditText) <= 8 * 1024 * 1024); assert.ok(auditText.endsWith('\n'));
const audits = auditText.trim().split('\n').map(JSON.parse); assert.ok(audits.every(row => row.sessionId === sessionId && row.projectId === projectId));
let matchingSources = 0; const staleEvidenceIds = [];
for (const evidence of state.evidence) {
  assert.equal(evidence.sessionId, sessionId); assert.equal(evidence.projectId, projectId); assert.equal(evidence.bindingRevision, project.bindingRevision);
  assert.ok(audits.some(row => row.action === 'read' && row.evidenceId === evidence.id && row.hash === evidence.hash && row.repoId === evidence.repoId && row.path === evidence.path && row.startLine === evidence.startLine && row.endLine === evidence.endLine));
  const binding = project.repositories.find(repo => repo.id === evidence.repoId); assert.ok(binding);
  try { const source = await readRepository(binding, evidence.path); if (source.hash === evidence.hash && evidence.startLine >= 1 && evidence.endLine <= source.lines.length) matchingSources++; else staleEvidenceIds.push(evidence.id); } catch { staleEvidenceIds.push(evidence.id); }
}
let inlineDiagrams = 0; let standaloneDiagrams = 0;
for (const lesson of state.lessons) {
  const note = await fs.readFile(path.join(directory, 'notes', `${lesson.id}.md`), 'utf8'); assert.ok(note.includes(lesson.title) && note.includes(lesson.conclusion));
  assert.ok(audits.some(row => row.action === 'lesson-published' && row.lessonId === lesson.id));
  for (const claim of lesson.claims) for (const id of claim.evidenceIds) assert.ok(state.evidence.some(e => e.id === id));
  for (const match of lesson.markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)) { validateMermaid(match[1]); assert.ok(note.includes(match[1].trim())); inlineDiagrams++; }
  if (lesson.mermaid) { validateMermaid(lesson.mermaid); const source = await fs.readFile(path.join(directory, 'diagrams', `${lesson.id}.mmd`), 'utf8'); assert.equal(source.trim(), lesson.mermaid.trim()); standaloneDiagrams++; }
}
for (const ref of state.messageRefs) { const message = await readJson(path.join(directory, 'messages', `${ref.seq}.json`)); assert.equal(message.seq, ref.seq); assert.equal(message.role, ref.role); assert.ok(message.text.length > 0); }
const native = await readSessionRecords(journal); const header = native.records[0]; const events = native.records.slice(1);
assert.equal(header.id, sessionId); assert.equal(header.agentPreset, 'code-reading'); assert.equal(path.resolve(header.cwd), path.resolve(directory));
assert.ok(events.every((event, index) => event.seq === index)); assert.equal(state.archiveSeq, events.at(-1).seq);
const request = events.find(event => event.type === 'request/header'); assert.ok(request);
assert.deepEqual(request.data.header.tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
const calls = events.filter(event => event.type === 'tool/call'); assert.ok(calls.length > 0 && calls.every(event => TOOL_NAMES.has(event.data.name)));
const publishCalls = calls.filter(event => event.data.name === 'reading_publish'); assert.equal(publishCalls.length, state.lessons.length);
const readonly = events.filter(event => event.type === 'sandbox/mode').at(-1); assert.equal(readonly.data.mode, 'read-only'); assert.ok(readonly.seq < request.seq);
const end = events.filter(event => event.type === 'turn/end').at(-1); assert.equal(end.data.reason.kind, 'completed');
assert.equal(createHash('sha256').update(await fs.readFile(path.join(projectDir, 'project.json'))).digest('hex'), projectHash);
const report = { passed: true, verifiedAt: new Date().toISOString(), project: { id: projectId, title: project.title, repositories: project.repositories.length }, sessionId, currentStage: state.stage, revision: state.revision, evidence: { total: state.evidence.length, matchingCurrentSource: matchingSources, staleEvidenceIds }, lessons: state.lessons.length, archivedMessages: state.messageRefs.length, archivedRoles: state.messageRefs.map(message => message.role), auditEntries: audits.length, humanStageChanges: audits.filter(row => row.action === 'human-stage-selected').length, diagrams: { inlineInMarkdown: inlineDiagrams, separateMmd: standaloneDiagrams }, native: { frames: native.frames, events: events.length, archivedThroughSeq: state.archiveSeq, preset: header.agentPreset, artifactCwdMatches: true, effectiveSandboxMode: readonly.data.mode, exposedTools: request.data.header.tools.map(tool => tool.name), callCounts: Object.fromEntries([...TOOL_NAMES].map(name => [name, calls.filter(event => event.data.name === name).length])), turnEnd: end.data.reason.kind }, repositoryCodeExecuted: false, additionalModelRequests: 0, realGuiScreenshotCaptured: false };
await fs.mkdir('.test-output/live', { recursive: true }); await fs.writeFile('.test-output/live/archive-verification.json', `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
