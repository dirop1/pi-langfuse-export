import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, exportPlan, loadConfig, sanitize } from '../src/core.mjs';

const config = { publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: 'https://example.invalid', captureContent: true };
const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message });
const entries = [entry('u', null, { role: 'user', content: 'hello' }), entry('a', 'u', { role: 'assistant', model: 'historical-model', provider: 'historical-provider', content: [{ type: 'thinking', thinking: 'reasoning', thinkingSignature: 'opaque' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'demo.txt' } }], usage: { input: 10, output: 5, cacheRead: 2, cost: { input: 0, output: 0.1 } }, stopReason: 'toolUse' }), entry('t', 'a', { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'result' }], isError: true })];
const plan = (items = entries, overrides = {}) => buildPlan({ sessionId: 'session-test', entries: items, activeModel: { provider: 'export-provider', id: 'export-model' }, config, ...overrides });
const temp = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'pi-langfuse-export-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const success = (body) => ({ ok: true, json: async () => ({ successes: JSON.parse(body).batch.map((event) => ({ id: event.id, status: 201 })), errors: [] }) });

test('preserves saved details and distinguishes active export model', () => {
  const p = plan();
  assert.equal(p.sessionId, 'session-test');
  assert.equal(p.entities[0].body.metadata['pi.export.active_model'].id, 'export-model');
  const generation = p.entities.find((e) => e.type === 'generation-create');
  assert.equal(generation.body.model, 'historical-model');
  assert.equal(generation.body.usageDetails.input, 10);
  assert.equal(generation.body.costDetails.input, 0);
  assert.ok(!JSON.stringify(p).includes('opaque'));
  const tool = p.entities.find((e) => e.type === 'span-create');
  assert.equal(tool.body.parentObservationId, generation.body.id);
  assert.equal(tool.body.input.path, 'demo.txt');
  assert.equal(tool.body.level, 'ERROR');
  assert.equal(tool.body.startTime, undefined);
});

test('missing metrics and unknown entries do not crash; saved compaction preserved', () => {
  const p = plan([entry('x', null, { role: 'assistant', content: [] }), { type: 'compaction', id: 'c', parentId: 'x', summary: 'old history', timestamp: 'invalid' }, { type: 'future_type', id: 'z', parentId: 'c', info: 'saved' }]);
  assert.ok(JSON.stringify(p).includes('old history'));
  assert.equal(p.entities.length, 4);
});

test('sanitization masks configured keys, signatures and images, not arbitrary PII', () => {
  assert.deepEqual(sanitize({ text: 'sk-test person@example.invalid', image: { type: 'image', data: 'base64', mimeType: 'image/png' }, textSignature: 'opaque' }, ['sk-test']), { text: '[REDACTED] person@example.invalid', image: { type: 'image', mimeType: 'image/png', omitted: true } });
  const p = plan(entries, { config: { ...config, captureContent: false } });
  assert.ok(!JSON.stringify(p).includes('reasoning'));
  assert.ok(!JSON.stringify(p).includes('demo.txt'));
});

test('env < global < trusted working-directory configuration; untrusted ignored', async (t) => {
  const dir = await temp(t), cwd = join(dir, 'project'); await mkdir(cwd);
  const env = { LANGFUSE_PUBLIC_KEY: 'pk-env', LANGFUSE_SECRET_KEY: 'sk-env', LANGFUSE_HOST: 'https://env.invalid' };
  await writeFile(join(dir, 'export-langfuse-config.json'), JSON.stringify({ baseUrl: 'https://global.invalid' }));
  await writeFile(join(cwd, 'export-langfuse-config.json'), JSON.stringify({ baseUrl: 'https://local.invalid', captureContent: false }));
  assert.equal((await loadConfig(dir, cwd, env, true)).baseUrl, 'https://local.invalid');
  assert.equal((await loadConfig(dir, cwd, env, false)).baseUrl, 'https://global.invalid');
  await writeFile(join(cwd, 'export-langfuse-config.json'), '{bad');
  await assert.rejects(loadConfig(dir, cwd, env, true), /invalid JSON/);
});

test('repeat export is a no-op after restart; continuation sends only new and root update', async (t) => {
  const agentDir = await temp(t); const sent = [];
  const fetchImpl = async (_url, request) => { sent.push(JSON.parse(request.body).batch); assert.equal(request.redirect, 'error'); return success(request.body); };
  assert.equal((await exportPlan({ plan: plan(), config, agentDir, fetchImpl })).count, 4);
  assert.equal((await exportPlan({ plan: plan(), config, agentDir, fetchImpl })).count, 0);
  const continued = plan([...entries, entry('new', 't', { role: 'assistant', content: [{ type: 'text', text: 'done' }] })]);
  assert.equal((await exportPlan({ plan: continued, config, agentDir, fetchImpl })).count, 2);
  assert.equal(sent[0][0].body.id, sent[1][0].body.id);
});

test('pending tool is updated under the same observation ID', async (t) => {
  const agentDir = await temp(t); const sent = [];
  const fetchImpl = async (_url, request) => { sent.push(JSON.parse(request.body).batch); return success(request.body); };
  await exportPlan({ plan: plan(entries.slice(0, 2)), config, agentDir, fetchImpl });
  await exportPlan({ plan: plan(), config, agentDir, fetchImpl });
  const before = sent[0].find((e) => e.type === 'span-create');
  const after = sent[1].find((e) => e.type === 'span-create');
  assert.equal(before.body.id, after.body.id);
});

test('offline failure leaves retry possible and removes lock', async (t) => {
  const agentDir = await temp(t);
  await assert.rejects(exportPlan({ plan: plan(), config, agentDir, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await exportPlan({ plan: plan(), config, agentDir, fetchImpl: async (_url, req) => success(req.body) })).count, 4);
});

test('partial 207 acknowledgement persists only successes', async (t) => {
  const agentDir = await temp(t);
  await assert.rejects(exportPlan({ plan: plan(), config, agentDir, fetchImpl: async (_url, req) => {
    const events = JSON.parse(req.body).batch;
    return { ok: true, json: async () => ({ successes: [{ id: events[0].id, status: 201 }], errors: [{ id: events[1].id, status: 400 }] }) };
  } }), /part of the batch/);
  assert.equal((await exportPlan({ plan: plan(), config, agentDir, fetchImpl: async (_url, req) => success(req.body) })).count, 3);
});

test('different project keys have separate checkpoints; malformed acknowledgements not accepted', async (t) => {
  const agentDir = await temp(t);
  await assert.rejects(exportPlan({ plan: plan(), config, agentDir, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /acknowledgement/);
  await exportPlan({ plan: plan(), config, agentDir, fetchImpl: async (_u, r) => success(r.body) });
  assert.equal((await exportPlan({ plan: plan(), config: { ...config, publicKey: 'other-project' }, agentDir, fetchImpl: async (_u, r) => success(r.body) })).count, 4);
});

test('fork session IDs produce distinct traces', () => {
  assert.notEqual(plan().traceId, plan(entries, { sessionId: 'fork' }).traceId);
});
