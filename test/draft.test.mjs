// add_text：lib/draft.mjs 直接测，加从 activate 入口走到（假的）coda.call 的整条链路。全部用假接口，不碰真实会话。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { addText } from '../lib/draft.mjs';
import { DRAFT_LIMIT } from '../view/protocol.mjs';
import { appendDraftText, checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';

const caught = promise => promise.then(() => null, error => error);

function withDraft(drafts, hook) {
  const log = [];
  return {
    log, drafts,
    coda: {
      async call(resource, name, input, options) {
        assert.deepEqual(resource.kind, 'coda/thread@1');
        assert.equal(name, 'append-draft');
        log.push({ session: resource.id, input: structuredClone(input), options });
        await hook?.(resource.id, input);
        const current = drafts[resource.id];
        if (!current) throw new Error('未知会话');
        if (current instanceof Error) throw current;
        const next = appendDraftText(current.text, input.text, Boolean(input.line));
        if (next.length > DRAFT_LIMIT) throw Object.assign(new Error('草稿超过 10 万字上限'), { code: 'too_long' });
        current.text = next;
        return {};
      },
    },
  };
}
const draftOf = (text = '', attachments = []) => ({ text, attachments });

// ---- addText 本身 ----

test('addText：调用 coda/thread@1 的 append-draft，路径传 line: false，内容传 line: true，附件原样保留', async () => {
  const api = withDraft({ A: draftOf('hi', [{ id: 'att-1' }]) });
  assert.equal(await addText(api.coda, 'A', { text: 'src/a.ts', block: false }), true);
  assert.equal(await addText(api.coda, 'A', { text: 'const x = 1;', block: true }), true);
  assert.deepEqual(api.log.map(entry => ({ session: entry.session, input: entry.input })), [
    { session: 'A', input: { text: 'src/a.ts', line: false } },
    { session: 'A', input: { text: 'const x = 1;', line: true } },
  ]);
  assert.equal(api.drafts.A.text, 'hi src/a.ts \nconst x = 1;\n');
  assert.deepEqual(api.drafts.A.attachments, [{ id: 'att-1' }]);
});

test('addText：传原样会话 ID，只写传进来的会话', async () => {
  const api = withDraft({ 'a/b': draftOf() });
  await addText(api.coda, 'a/b', { text: 'x', block: true });
  assert.deepEqual(api.log.map(entry => entry.session), ['a/b']);
});

test('addText：超过上限回 draft_too_long（本地超限不调接口，服务端拒绝也能映射）', async () => {
  const local = withDraft({ A: draftOf() });
  assert.equal((await caught(addText(local.coda, 'A', { text: 'x'.repeat(DRAFT_LIMIT + 1), block: false }))).code, 'draft_too_long');
  assert.equal(local.log.length, 0, '单段就超上限：不碰接口');

  const server = withDraft({ A: draftOf('x'.repeat(DRAFT_LIMIT - 2)) });
  assert.equal((await caught(addText(server.coda, 'A', { text: 'abcd', block: false }))).code, 'draft_too_long');
  assert.equal(server.log.length, 1);

  for (const error of [
    Object.assign(new Error('nope'), { code: 'draft_too_long' }),
    Object.assign(new Error('nope'), { code: 'too_large' }),
    new Error('草稿太长'),
    new Error('draft exceeds limit'),
  ]) {
    const mapped = { call: async () => { throw error; } };
    assert.equal((await caught(addText(mapped, 'A', { text: 'p', block: false }))).code, 'draft_too_long', error.message);
  }
});

test('addText：接口抛错或文字无效都是 draft_failed', async () => {
  const boom = { call: async () => { throw new Error('网络'); } };
  assert.equal((await caught(addText(boom, 'A', { text: 'p', block: false }))).code, 'draft_failed');
  const api = withDraft({ A: draftOf() });
  for (const bad of [{ text: 7, block: false }, { text: 'a\0b', block: false }, { text: 'a', block: 'yes' }, { block: true }]) {
    assert.equal((await caught(addText(api.coda, 'A', bad))).code, 'draft_failed', JSON.stringify(bad));
  }
  assert.equal(api.log.length, 0, '无效的文字不碰接口');
});

test('addText：调用前或调用途中 valid() 变假 → 返回 false（调用前不碰接口）', async () => {
  const before = withDraft({ A: draftOf() });
  assert.equal(await addText(before.coda, 'A', { text: 'p', block: false }, { valid: () => false }), false);
  assert.equal(before.log.length, 0);

  const gate = deferred();
  const during = withDraft({ A: draftOf() }, () => gate.promise);
  let live = true;
  const run = addText(during.coda, 'A', { text: 'p', block: false }, { valid: () => live });
  await waitFor(() => during.log.length === 1, 'call');
  live = false;
  gate.resolve();
  assert.equal(await run, false);
});

// ---- 经 activate ----

async function repo(t) {
  const root = join(await tempDir(t), 'repo');
  await mkdir(root);
  return root;
}

function appFor(root, drafts, hook, threads = { A: checkoutOf(root), B: checkoutOf(root) }) {
  const fake = fakeCoda(threads, { drafts });
  if (hook) {
    const prev = fake.coda.call;
    fake.coda.call = async (resource, name, input, options) => {
      await hook(resource.id, input);
      return prev(resource, name, input, options);
    };
  }
  activate(fake.coda);
  return { fake };
}
async function opened(fake, session, options) {
  const view = fake.open(session, options);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}
const add = (view, requestId, body, generation = 1) => view.send({ type: 'add_text', generation, requestId, ...body });

test('经 activate：add_text 写进当前会话的草稿，成功回只有信封的 added；两种拼法', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf('看看', [{ id: 'f1' }]) });
  const view = await opened(fake, 'A');
  add(view, 'r1', { text: 'src/a.ts', block: false });
  assert.deepEqual(await view.answer('r1'), { type: 'added', generation: 1, requestId: 'r1' });
  add(view, 'r2', { text: 'const a = 1;', block: true });
  assert.deepEqual(await view.answer('r2'), { type: 'added', generation: 1, requestId: 'r2' });
  assert.equal(fake.drafts.A.text, '看看 src/a.ts \nconst a = 1;\n');
  assert.deepEqual(fake.drafts.A.attachments, [{ id: 'f1' }]);
  assert.ok(fake.calls.every(entry => entry.resource.id === 'A'));
});

test('经 activate：文件视图的会话取 args.session', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf() });
  const view = await opened(fake, null, { view: 'file', args: { session: 'A', path: 'x' } });
  add(view, 'r', { text: 'p', block: false });
  assert.equal((await view.answer('r')).error, undefined);
  assert.equal(fake.drafts.A.text, 'p ');
});

test('经 activate：草稿失败、太长、文字无效都回对应的错误码', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf('x'.repeat(DRAFT_LIMIT)) });
  const view = await opened(fake, 'A');
  add(view, 'long', { text: 'p', block: false });
  const long = await view.answer('long');
  assert.deepEqual([long.type, long.error.code], ['added', 'draft_too_long']);
  add(view, 'bad', { text: 5, block: false });
  assert.equal((await view.answer('bad')).error.code, 'draft_failed');
  fake.drafts.A = new Error('接口出错');
  add(view, 'broken', { text: 'p', block: false });
  assert.equal((await view.answer('broken')).error.code, 'draft_failed');
});

test('经 activate：调用途中换会话或视图关闭 → 不回答、不报错', async t => {
  const root = await repo(t);
  const gate = deferred();
  const { fake } = appFor(root, { A: draftOf(), B: draftOf() }, session => (session === 'A' ? gate.promise : undefined));
  const view = await opened(fake, 'A');
  add(view, 'r', { text: 'p', block: false });
  await waitFor(() => fake.calls.length === 0, '尚未完成');
  view.switchTo('B');
  gate.resolve();
  await flush();
  assert.equal(view.posted.some(message => message.requestId === 'r'), false);
  assert.equal(fake.drafts.B.text, '', '新会话的草稿没被动');
});

test('经 activate：旧代次的 add_text 不处理', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf(), B: draftOf() });
  const view = await opened(fake, 'A');
  add(view, 'old', { text: 'p', block: false }, 99);
  await flush();
  assert.equal(fake.calls.length, 0);
});

// ---- 契约边界：已删除的 coda.api 不应再出现在代码中 ----

async function legacyApiHits(root) {
  const hits = [];
  const legacy = /\bcoda\.api\s*\(/;
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  assert.ok(tracked.length > 0, 'git ls-files 没有列出文件：不在仓库里，边界没有检查');
  for (const rel of tracked) {
    if (!/\.(mjs|js)$/.test(rel) || rel.startsWith('view/vendor/')) continue;
    let text;
    try { text = await readFile(join(root, rel), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (legacy.test(text)) hits.push(rel);
  }
  return hits;
}

test('代码（含测试）里不再调用已删除的 coda.api', async () => {
  assert.deepEqual(await legacyApiHits(new URL('..', import.meta.url).pathname), []);
});

test('契约边界测试只看 git 跟踪的脚本文件：没跟踪的不扫，跟踪后删掉的跳过，名字里有空格和中文也行', async t => {
  const root = await tempDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  const leaky = `await ${['coda', 'api'].join('.')}('threads/1');\n`;
  await mkdir(join(root, '.claude'));
  await mkdir(join(root, '文档 目录'));
  await writeFile(join(root, 'clean.mjs'), 'export const a = 1;\n');
  await writeFile(join(root, 'gone.mjs'), leaky);
  await writeFile(join(root, 'leak.mjs'), leaky);
  await writeFile(join(root, '文档 目录', '泄露.mjs'), leaky);
  await writeFile(join(root, 'note.md'), leaky);
  git('add', '-A');
  await rm(join(root, 'gone.mjs'));
  await writeFile(join(root, '.claude', 'local.mjs'), leaky);
  await writeFile(join(root, 'untracked.mjs'), leaky);
  assert.deepEqual((await legacyApiHits(root)).sort(), ['leak.mjs', '文档 目录/泄露.mjs']);
});
