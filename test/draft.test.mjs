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
        await hook?.(resource.id, input, options);
        if (options?.signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
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

test('addText：原样传给 coda/thread@1 的 append-draft，路径传 line: false、内容传 line: true；连续追加不多出空格或空行，附件原样保留', async () => {
  const api = withDraft({ A: draftOf('', [{ id: 'att-1' }]), B: draftOf('') });
  assert.equal(await addText(api.coda, 'A', { text: 'a.txt', block: false }), true);
  assert.equal(await addText(api.coda, 'A', { text: 'b.txt', block: false }), true);
  assert.equal(api.drafts.A.text, 'a.txt b.txt', '连续追加路径：仅单个空格分隔，无双空格');

  assert.equal(await addText(api.coda, 'B', { text: '第一段', block: true }), true);
  assert.equal(await addText(api.coda, 'B', { text: '第二段', block: true }), true);
  assert.equal(api.drafts.B.text, '第一段\n第二段', '连续追加选区：仅单个换行分隔，无多余空行');

  assert.deepEqual(api.log.map(entry => ({ session: entry.session, input: entry.input })), [
    { session: 'A', input: { text: 'a.txt', line: false } },
    { session: 'A', input: { text: 'b.txt', line: false } },
    { session: 'B', input: { text: '第一段', line: true } },
    { session: 'B', input: { text: '第二段', line: true } },
  ]);
  assert.deepEqual(api.drafts.A.attachments, [{ id: 'att-1' }]);
});

test('addText：传原样会话 ID，只写传进来的会话', async () => {
  const api = withDraft({ 'a/b': draftOf() });
  await addText(api.coda, 'a/b', { text: 'x', block: true });
  assert.deepEqual(api.log.map(entry => entry.session), ['a/b']);
  assert.equal(api.drafts['a/b'].text, 'x');
});

test('addText：超过上限回 draft_too_long（本地超限不调接口，服务端拒绝也能映射）', async () => {
  const local = withDraft({ A: draftOf() });
  assert.equal((await caught(addText(local.coda, 'A', { text: 'x'.repeat(DRAFT_LIMIT + 1), block: false }))).code, 'draft_too_long');
  assert.equal(local.log.length, 0, '单段就超上限：不碰接口');

  const exact = withDraft({ A: draftOf() });
  assert.equal(await addText(exact.coda, 'A', { text: 'x'.repeat(DRAFT_LIMIT), block: true }), true, '正好满上限：放得下');
  assert.equal(exact.log.length, 1);

  const server = withDraft({ A: draftOf('x'.repeat(DRAFT_LIMIT - 2)) });
  assert.equal((await caught(addText(server.coda, 'A', { text: 'abcd', block: false }))).code, 'draft_too_long');
  assert.equal(server.log.length, 1);

  for (const error of [
    Object.assign(new Error('nope'), { code: 'draft_too_long' }),
    Object.assign(new Error('nope'), { code: 'too_large' }),
    new Error('draft too long'),
  ]) {
    const mapped = { call: async () => { throw error; } };
    assert.equal((await caught(addText(mapped, 'A', { text: 'p', block: false }))).code, 'draft_too_long', error.message);
  }
});

test('addText：只信错误 code，限流等带 limit、超过的 message 不算草稿太长', async () => {
  for (const error of [
    new Error('rate limit exceeded'),
    Object.assign(new Error('rate limit exceeded'), { code: 'rate_limited' }),
    new Error('超过调用频率上限'),
    new Error('草稿太长'),
    new Error('quota exceeded, limit reached'),
  ]) {
    const mapped = { call: async () => { throw error; } };
    assert.equal((await caught(addText(mapped, 'A', { text: 'p', block: false }))).code, 'draft_failed', error.message);
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

test('addText：调用前或调用途中 valid() 变假 / signal 中止 → 取消写入、不修改草稿、返回 false', async () => {
  const before = withDraft({ A: draftOf('原') });
  assert.equal(await addText(before.coda, 'A', { text: 'p', block: false }, { valid: () => false }), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await addText(before.coda, 'A', { text: 'p', block: false }, { signal: aborted.signal }), false);
  assert.equal(before.log.length, 0);
  assert.equal(before.drafts.A.text, '原');

  const gate = deferred(), controller = new AbortController();
  const during = withDraft({ A: draftOf('原') }, () => gate.promise);
  const run = addText(during.coda, 'A', { text: 'p', block: false }, { signal: controller.signal });
  await waitFor(() => during.log.length === 1, 'call');
  assert.equal(during.log[0].options?.signal, controller.signal, '把 signal 传给了 coda.call');
  controller.abort();
  gate.resolve();
  assert.equal(await run, false);
  assert.equal(during.drafts.A.text, '原', '中止后尚未落地的写入被取消，旧草稿未修改');
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
      await hook(resource.id, input, options);
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

test('经 activate：add_text 写进当前会话的草稿，成功回只有信封的 added；连续追加不多出空格或空行', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf('看看', [{ id: 'f1' }]) });
  const view = await opened(fake, 'A');
  add(view, 'r1', { text: 'src/a.ts', block: false });
  assert.deepEqual(await view.answer('r1'), { type: 'added', generation: 1, requestId: 'r1' });
  add(view, 'r2', { text: 'src/b.ts', block: false });
  assert.deepEqual(await view.answer('r2'), { type: 'added', generation: 1, requestId: 'r2' });
  add(view, 'r3', { text: 'const a = 1;', block: true });
  assert.deepEqual(await view.answer('r3'), { type: 'added', generation: 1, requestId: 'r3' });
  add(view, 'r4', { text: 'const b = 2;', block: true });
  assert.deepEqual(await view.answer('r4'), { type: 'added', generation: 1, requestId: 'r4' });
  assert.equal(fake.drafts.A.text, '看看 src/a.ts src/b.ts\nconst a = 1;\nconst b = 2;');
  assert.deepEqual(fake.drafts.A.attachments, [{ id: 'f1' }]);
  assert.deepEqual(fake.calls.map(entry => ({ id: entry.resource.id, input: entry.input })), [
    { id: 'A', input: { text: 'src/a.ts', line: false } },
    { id: 'A', input: { text: 'src/b.ts', line: false } },
    { id: 'A', input: { text: 'const a = 1;', line: true } },
    { id: 'A', input: { text: 'const b = 2;', line: true } },
  ]);
});

test('经 activate：文件视图的会话取 args.session', async t => {
  const root = await repo(t);
  const { fake } = appFor(root, { A: draftOf() });
  const view = await opened(fake, null, { view: 'file', args: { session: 'A', path: 'x' } });
  add(view, 'r', { text: 'p', block: false });
  assert.equal((await view.answer('r')).error, undefined);
  assert.equal(fake.drafts.A.text, 'p');
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

test('经 activate：调用途中切换会话 → 中止旧信号、旧草稿不被修改、新草稿不受影响且可继续写入', async t => {
  const root = await repo(t);
  const entered = deferred(), gate = deferred();
  let capturedSignal = null;
  const { fake } = appFor(root, { A: draftOf('旧A'), B: draftOf('') }, async (session, _input, options) => {
    if (session === 'A') {
      capturedSignal = options?.signal ?? null;
      entered.resolve();
      await gate.promise;
    }
  });
  const view = await opened(fake, 'A');
  add(view, 'r1', { text: 'p', block: false });
  await entered.promise;
  assert.ok(capturedSignal instanceof AbortSignal, '传了 AbortSignal');
  assert.equal(capturedSignal.aborted, false);
  view.switchTo('B');
  await waitFor(() => view.of('root').length === 2, 'B root');
  assert.equal(capturedSignal.aborted, true, '换会话立刻中止上一代次的信号');
  gate.resolve();
  await flush();
  assert.equal(view.posted.some(message => message.requestId === 'r1'), false, '不给旧代次回执');
  assert.equal(fake.drafts.A.text, '旧A', '尚未落地的 A 草稿写入被取消');
  assert.equal(fake.drafts.B.text, '', 'B 草稿未被污染');

  add(view, 'r2', { text: 'b.txt', block: false }, 2);
  assert.deepEqual(await view.answer('r2'), { type: 'added', generation: 2, requestId: 'r2' });
  assert.equal(fake.drafts.B.text, 'b.txt', '切到 B 后用新信号正常写入');
});

test('经 activate：调用途中关闭视图 → 中止信号、旧草稿不被修改、不回执', async t => {
  const root = await repo(t);
  const entered = deferred(), gate = deferred();
  let capturedSignal = null;
  const { fake } = appFor(root, { A: draftOf('旧A') }, async (session, _input, options) => {
    if (session === 'A') {
      capturedSignal = options?.signal ?? null;
      entered.resolve();
      await gate.promise;
    }
  });
  const view = await opened(fake, 'A');
  add(view, 'r1', { text: 'p', block: false });
  await entered.promise;
  assert.ok(capturedSignal instanceof AbortSignal);
  await view.close();
  assert.equal(capturedSignal.aborted, true, '关视图立刻中止信号');
  gate.resolve();
  await flush();
  assert.equal(view.posted.some(message => message.requestId === 'r1'), false);
  assert.equal(fake.drafts.A.text, '旧A', '尚未落地的 A 草稿写入被取消');
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
