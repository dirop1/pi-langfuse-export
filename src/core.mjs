import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONFIG = 'export-langfuse-config.json';
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}: invalid JSON or inaccessible file.`); }
}

export async function loadConfig(agentDir, cwd, env = process.env, trusted = false) {
  const global = await readJson(join(agentDir, CONFIG), {});
  const local = trusted && resolve(cwd) !== resolve(agentDir) ? await readJson(join(cwd, CONFIG), {}) : {};
  for (const document of [global, local]) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Langfuse config must be a JSON object.');
  }
  const config = {
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
    environment: env.LANGFUSE_TRACING_ENVIRONMENT,
    release: env.LANGFUSE_RELEASE,
    userId: env.LANGFUSE_USER_ID,
    captureContent: true,
    ...global, ...local,
  };
  for (const key of ['publicKey', 'secretKey', 'baseUrl']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing or invalid ${key}. Set LANGFUSE env vars or ${CONFIG}.`);
    config[key] = config[key].trim();
  }
  let url;
  try { url = new URL(config.baseUrl); } catch { throw new Error('Invalid Langfuse baseUrl.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
  config.baseUrl = url.href.replace(/\/$/, '');
  if (typeof config.captureContent !== 'boolean') throw new Error('captureContent must be boolean.');
  for (const key of ['environment', 'release', 'userId']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) throw new Error(`Invalid ${key}.`);
  }
  if (config.environment && (!/^[a-z0-9_-]{1,40}$/.test(config.environment) || config.environment.startsWith('langfuse'))) throw new Error('Invalid Langfuse environment.');
  if (config.userId?.length > 200) throw new Error('userId must not exceed 200 characters.');
  return config;
}

// Only known Langfuse keys are masked: this is deliberately not a PII scanner.
export function sanitize(value, secrets = []) {
  const mask = (text) => secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[REDACTED]'), text)
    .replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=]+/g, '[embedded data omitted]');
  const walk = (item, depth) => {
    if (depth > 40) return '[depth limit]';
    if (typeof item === 'string') return mask(item);
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
    if (item.type === 'image') return { type: 'image', mimeType: item.mimeType, omitted: true };
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !/^(thinkingSignature|textSignature|thoughtSignature)$/i.test(key))
      .map(([key, child]) => [mask(key), walk(child, depth + 1)]));
  };
  return walk(value, 0);
}
const numbers = (record) => Object.fromEntries(Object.entries(record ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0));
const iso = (value) => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toISOString() : undefined; };

export function buildPlan({ sessionId, entries, header, name, activeModel, thinkingLevel, config, scope = 'branch' }) {
  const traceId = hash(['pi-langfuse-export/v1', sessionId]).slice(0, 32);
  const capture = (value) => config.captureContent ? value : '[content capture disabled]';
  const entities = new Map();
  const idFor = (entry, suffix = '') => hash([traceId, entry.id, suffix]).slice(0, 16);
  const add = (type, body) => entities.set(body.id, { type, body });
  const calls = new Map();
  const callsByEntry = new Map();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === 'message' && message?.role === 'assistant') {
      for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block.type !== 'toolCall') continue;
        // Entry ancestry, not globally unique tool call IDs, determines correlation.
        const call = { entry, block, index };
        calls.set(`${entry.id}:${block.id}`, call);
        const siblings = callsByEntry.get(entry.id) ?? [];
        siblings.push(call);
        callsByEntry.set(entry.id, siblings);
      }
    }
  }
  const ancestorCall = (entry, callId) => {
    let parent = entry.parentId;
    const visited = new Set();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const match = calls.get(`${parent}:${callId}`);
      if (match) return match;
      parent = byId.get(parent)?.parentId;
    }
  };
  const thinkingFor = (entry) => {
    let parent = entry.parentId;
    const visited = new Set();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (ancestor?.type === 'thinking_level_change') return ancestor.thinkingLevel;
      parent = ancestor?.parentId;
    }
  };
  for (const entry of entries) {
    if (!entry.id) continue;
    const base = { id: idFor(entry), traceId, name: `pi.${entry.type}`, startTime: iso(entry.timestamp), metadata: { 'pi.entry.id': entry.id, 'pi.entry.parent_id': entry.parentId, 'pi.entry.type': entry.type }, ...(config.environment ? { environment: config.environment } : {}) };
    if (entry.type === 'custom') continue; // Internal extension state is not conversation content.
    if (entry.type === 'message' && entry.message) {
      const m = entry.message;
      base.name = `pi.${m.role ?? 'message'}`;
      base.metadata['pi.message.timestamp'] = m.timestamp;
      if (m.role === 'assistant') {
        base.name = 'pi.llm';
        base.output = capture(m.content);
        base.model = m.responseModel || m.model;
        base.metadata = { ...base.metadata, 'pi.provider': m.provider, 'pi.api': m.api, 'pi.requested_model': m.model, 'pi.response.id': m.responseId, 'pi.stop_reason': m.stopReason, 'pi.saved_usage': m.usage };
        const thinking = thinkingFor(entry);
        if (thinking) base.modelParameters = { thinking_level: thinking };
        base.usageDetails = numbers({ input: m.usage?.input, output: m.usage?.output, cache_read_input_tokens: m.usage?.cacheRead, cache_creation_input_tokens: m.usage?.cacheWrite });
        base.costDetails = numbers({ input: m.usage?.cost?.input, output: m.usage?.cost?.output, cache_read: m.usage?.cost?.cacheRead, cache_write: m.usage?.cost?.cacheWrite });
        if (m.stopReason === 'error' || m.errorMessage) { base.level = 'ERROR'; base.statusMessage = m.errorMessage || 'Assistant error'; }
        else if (['aborted', 'length'].includes(m.stopReason)) { base.level = 'WARNING'; base.statusMessage = m.stopReason; }
        add('generation-create', base);
        for (const call of callsByEntry.get(entry.id) ?? []) {
          add('span-create', { id: idFor(entry, `tool:${call.index}`), traceId, parentObservationId: base.id, name: `pi.tool.${call.block.name}`, input: capture(call.block.arguments), metadata: { 'pi.tool.call_id': call.block.id, 'pi.entry.id': entry.id, 'pi.timing.available': false }, ...(config.environment ? { environment: config.environment } : {}) });
        }
      } else if (m.role === 'toolResult') {
        const call = ancestorCall(entry, m.toolCallId);
        base.id = call ? idFor(call.entry, `tool:${call.index}`) : base.id;
        base.parentObservationId = call ? idFor(call.entry) : undefined;
        base.name = `pi.tool.${m.toolName ?? call?.block.name ?? 'unknown'}`;
        delete base.startTime; // The saved result timestamp is not an execution start.
        base.input = call ? capture(call.block.arguments) : undefined;
        base.output = capture({ content: m.content, details: m.details });
        base.metadata = { ...base.metadata, 'pi.tool.call_id': m.toolCallId, 'pi.tool.is_error': m.isError, 'pi.saved_usage': m.usage, 'pi.timing.available': false };
        if (m.isError) { base.level = 'ERROR'; base.statusMessage = 'Tool execution failed'; }
        add('span-create', base);
      } else {
        base.output = capture(m);
        add('event-create', base);
      }
    } else {
      // Preserve saved summaries, model changes, labels, custom messages and future entry types.
      base.output = capture(entry);
      add('event-create', base);
    }
  }
  const first = entries.find((entry) => entry.message?.role === 'user');
  const last = entries.findLast((entry) => entry.message?.role === 'assistant');
  const root = {
    id: traceId, name: name || 'pi.session', sessionId, public: false,
    timestamp: iso(header?.timestamp) || iso(entries[0]?.timestamp),
    input: capture(first?.message?.content), output: capture(last?.message?.content),
    tags: ['pi', 'manual-export'],
    metadata: { 'pi.export.schema': 1, 'pi.export.scope': scope, 'pi.export.active_model': activeModel, 'pi.export.thinking_level': thinkingLevel, 'pi.export.source': 'saved-history', 'pi.export.entry_count': entries.filter((entry) => entry.type !== 'custom').length, 'pi.session.header': header },
    ...(config.userId ? { userId: config.userId } : {}),
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.release ? { release: config.release } : {}),
  };
  const secrets = [config.publicKey, config.secretKey];
  const clean = [{ type: 'trace-create', body: root }, ...entities.values()].map((entity) => ({ ...entity, body: sanitize(entity.body, secrets) }));
  return { sessionId, traceId, entities: clean.map((entity) => ({ ...entity, key: `${entity.type}:${entity.body.id}`, fingerprint: hash(entity) })) };
}

export const targetKey = (config, sessionId) => hash([config.baseUrl, config.publicKey, sessionId]);
export function pendingEntities(plan, state) { return plan.entities.filter((entity) => state[entity.key] !== entity.fingerprint); }

export async function saveState(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

export async function exportPlan({ plan, config, agentDir, signal, fetchImpl = fetch, onProgress = () => {} }) {
  const directory = join(agentDir, 'pi-langfuse-export-state');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${targetKey(config, plan.sessionId)}.json`);
  const lock = `${path}.lock`;
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another export is running, or a stale lock remains. See README recovery instructions.'); throw error; }
  try {
    const state = await readJson(path, {});
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid export checkpoint.');
    const pending = pendingEntities(plan, state);
    let completed = 0;
    while (completed < pending.length) {
      signal?.throwIfAborted();
      const batch = [];
      let bytes = 0;
      for (const entity of pending.slice(completed, completed + 50)) {
        const timestamp = new Date().toISOString();
        const body = entity.type === 'trace-create'
          ? { ...entity.body, metadata: { ...entity.body.metadata, 'pi.export.exported_at': timestamp } }
          : entity.body;
        const event = { id: randomUUID(), timestamp, type: entity.type, body };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (size > 3_000_000) throw new Error('A saved entry exceeds the 3 MB export limit. Use --metadata-only; no content was silently truncated.');
        if (batch.length && bytes + size > 3_000_000) break;
        bytes += size;
        batch.push({ event, entity });
      }
      const response = await fetchImpl(`${config.baseUrl}/api/public/ingestion`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}` },
        body: JSON.stringify({ batch: batch.map(({ event }) => event) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Langfuse returned HTTP ${response.status}. Retry the command when available.`);
      let result;
      try { result = await response.json(); } catch { throw new Error('Langfuse returned an invalid acknowledgement. Safe to retry.'); }
      if (!Array.isArray(result.successes) || !Array.isArray(result.errors)) throw new Error('Langfuse acknowledgement is missing successes/errors. Safe to retry.');
      const accepted = new Set(result.successes.filter((item) => item.status >= 200 && item.status < 300).map((item) => item.id));
      for (const { event, entity } of batch) if (accepted.has(event.id)) state[entity.key] = entity.fingerprint;
      await saveState(path, state);
      if (result.errors.length || batch.some(({ event }) => !accepted.has(event.id))) throw new Error('Langfuse rejected part of the batch. Accepted entries were checkpointed; retry sends the remainder.');
      completed += batch.length;
      onProgress(completed, pending.length);
    }
    return { count: completed, traceId: plan.traceId };
  } finally { await unlink(lock).catch(() => {}); }
}
