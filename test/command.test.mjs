import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consentPath, hasServerConsent, rememberServerConsent } from '../src/core.mjs';

const server = 'https://example.invalid';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-langfuse-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'export-langfuse-config.json'), JSON.stringify({ baseUrl: server, publicKey: 'pk-test', secretKey: 'sk-test' }));
  let source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  source = source.replace(/^import .*pi-coding-agent.*;$/m, `const getAgentDir = () => ${JSON.stringify(dir)};`)
    .replace("'./core.mjs'", JSON.stringify(new URL('../src/core.mjs', import.meta.url).href));
  const module = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const events = {}, notices = [], selections = [], statuses = [], sent = [];
  let handler;
  module.default({ on: (event, callback) => { events[event] = callback; }, registerCommand: (_name, command) => { handler = command.handler; } });
  const idle = deferred();
  const ctx = {
    hasUI: true, cwd: dir, isProjectTrusted: () => false, isIdle: () => true,
    waitForIdle: () => idle.promise,
    sessionManager: { getSessionId: () => 'session-test', getEntries: () => [], getBranch: () => [], getHeader: () => ({}), getSessionName: () => 'Synthetic test' },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), select: async (...args) => { selections.push(args); return 'Yes, don’t ask again for this server'; } },
  };
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ successes: sent.at(-1).batch.map(e => ({ id: e.id, status: 201 })), errors: [] }) };
  });
  return { dir, ctx, events, notices, selections, statuses, sent, idle, run: (args = '') => handler(args, ctx) };
}

test('approval persists per normalized server, can be reset, and contains no credentials', async t => {
  const f = await fixture(t);
  assert.equal(await hasServerConsent(f.dir, server), false);
  await rememberServerConsent(f.dir, server + '/');
  assert.equal(await hasServerConsent(f.dir, server), true);
  assert.equal(await hasServerConsent(f.dir, server + '/other'), false);
  assert.equal(await hasServerConsent(f.dir, 'http://example.invalid'), false);
  assert.deepEqual(JSON.parse(await readFile(consentPath(f.dir, server), 'utf8')), { approved: true });
  await writeFile(consentPath(f.dir, server), '{"approved":false}');
  assert.equal(await hasServerConsent(f.dir, server), false);
  await writeFile(consentPath(f.dir, server), '{bad');
  await assert.rejects(hasServerConsent(f.dir, server), /invalid JSON/);
});

test('remembered consent skips later prompts but server changes ask again', async t => {
  const f = await fixture(t);
  await f.run(); await f.run();
  assert.equal(f.selections.length, 1);
  await writeFile(join(f.dir, 'export-langfuse-config.json'), JSON.stringify({ baseUrl: server + '/other', publicKey: 'pk-test', secretKey: 'sk-test' }));
  await f.run();
  assert.equal(f.selections.length, 2);
});

test('No, cancellation, and one-time approval never persist approval', async t => {
  const f = await fixture(t);
  for (const answer of ['No', undefined, 'Yes, export once']) {
    f.ctx.ui.select = async () => answer;
    await f.run();
    assert.equal(await hasServerConsent(f.dir, server), false);
  }
  assert.equal(f.sent.length, 1);
});

test('busy command waits, rejects duplicates, then snapshots completed history', async t => {
  const f = await fixture(t);
  f.ctx.isIdle = () => false;
  const running = f.run('--yes');
  await f.run('--all');
  assert.equal(f.sent.length, 0);
  assert.ok(f.notices.some(([n]) => n.includes('already queued')));
  f.ctx.sessionManager.getBranch = () => [{ type: 'message', id: 'new', timestamp: '2026-01-01', message: { role: 'user', content: 'saved after queue' } }];
  f.ctx.isIdle = () => true;
  f.idle.resolve();
  await running;
  assert.ok(JSON.stringify(f.sent).includes('saved after queue'));
  assert.equal(f.selections.length, 0);
  assert.equal(await hasServerConsent(f.dir, server), false);
});

test('shutdown cancels queued export even when idle never resolves', async t => {
  const f = await fixture(t);
  f.ctx.isIdle = () => false;
  const running = f.run('--yes');
  f.events.session_shutdown();
  await running;
  f.idle.resolve();
  assert.equal(f.sent.length, 0);
  assert.equal(f.selections.length, 0);
});

test('session identity changes discard queued work', async t => {
  const f = await fixture(t);
  f.ctx.isIdle = () => false;
  const running = f.run('--yes');
  f.ctx.sessionManager.getSessionId = () => 'other-session';
  f.idle.resolve();
  await running;
  assert.equal(f.sent.length, 0);
});

test('dry run never persists approval; noninteractive still requires --yes', async t => {
  const f = await fixture(t);
  await f.run('--dry-run');
  assert.equal(f.selections.length, 0);
  assert.deepEqual(await readdir(f.dir), ['export-langfuse-config.json']);
  await rememberServerConsent(f.dir, server);
  f.ctx.hasUI = false;
  await assert.rejects(f.run(), /requires --yes/);
  await f.run('--yes');
  assert.equal(f.sent.length, 1);
});

test('shutdown during confirmation never uploads or remembers approval', async t => {
  const f = await fixture(t);
  const selected = deferred(), opened = deferred();
  f.ctx.ui.select = async () => { opened.resolve(); return selected.promise; };
  const running = f.run();
  await opened.promise;
  f.events.session_shutdown();
  selected.resolve('Yes, don’t ask again for this server');
  await running;
  assert.equal(f.sent.length, 0);
  assert.equal(await hasServerConsent(f.dir, server), false);
});

test('server consent covers another project and expanded export scope', async t => {
  const f = await fixture(t);
  await f.run('--metadata-only');
  await writeFile(join(f.dir, 'export-langfuse-config.json'), JSON.stringify({ baseUrl: server, publicKey: 'pk-other-project', secretKey: 'sk-other-project' }));
  await f.run('--all');
  assert.equal(f.selections.length, 1);
  assert.equal(f.sent.length, 2);
});

test('malformed consent fails closed without uploading', async t => {
  const f = await fixture(t);
  await rememberServerConsent(f.dir, server);
  await writeFile(consentPath(f.dir, server), '{bad');
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.ok(f.notices.some(([n]) => n.includes('export failed')));
});
