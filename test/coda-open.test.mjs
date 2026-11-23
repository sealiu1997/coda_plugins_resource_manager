// coda.open 按类别记忆打开方式、右键/长按切换、异常回退、单在途防竞态与越界外链拦截。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { parseState } from '../view/model.mjs';
import { loadApp, loadFileApp, visible } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';
import { rowNamed } from './support/treehost.mjs';

const timersOn = new WeakSet();

async function open(t, { roots = {}, coda = {}, state: initialState = undefined, mediaToken = 'tok123', holdMedia = false, failMedia = null, platform = 'mac' } = {}) {
  if (!timersOn.has(t)) { timersOn.add(t); t.mock.timers.enable({ apis: ['setTimeout'] }); }
  const sent = [], opened = [], heldMedia = [], state = [];
  const host = { sent, opened, heldMedia, state, generation: 0, root: null, roots, mediaToken, holdMedia, failMedia };
  const page = await loadApp(t, {
    platform,
    postMessage: message => {
      sent.push(message);
      if (message.type === 'list' || message.type === 'read' || message.type === 'media' || message.type === 'search') {
        queueMicrotask(() => answer(message));
      }
    },
    on: () => {},
    copy: () => {},
    getState: () => initialState,
    setState: value => state.push(JSON.parse(JSON.stringify(value))),
    open: target => { opened.push(target); return Promise.resolve(); },
    close: () => {},
    ...coda,
  });
  function answer(request) {
    if (request.generation !== host.generation) return;
    const files = host.roots[host.root?.path] ?? {};
    const base = { generation: request.generation, requestId: request.requestId };
    if (request.type === 'list') {
      const dir = request.path ? `${request.path}/` : '', kinds = new Map();
      for (const name of Object.keys(files)) if (name.startsWith(dir)) {
        const [head, rest] = name.slice(dir.length).split('/');
        kinds.set(head, rest === undefined ? 'file' : 'dir');
      }
      return page.post({ type: 'listed', ...base, entries: [...kinds].map(([name, kind]) => ({ name, kind })), nextCursor: null });
    }
    if (request.type === 'search') {
      const q = String(request.query ?? '').toLowerCase();
      const hits = Object.keys(files).filter(name => name.toLowerCase().includes(q)).map(path => ({ path, kind: 'file' }));
      return page.post({ type: 'searched', ...base, hits, truncated: false });
    }
    if (request.type === 'media') {
      if (host.holdMedia) return heldMedia.push(request);
      if (host.failMedia) return page.post({ type: 'media_granted', ...base, error: host.failMedia });
      const file = files[request.path];
      if (!file) return page.post({ type: 'media_granted', ...base, error: { code: 'not_found', message: '没有这个文件' } });
      return page.post({ type: 'media_granted', ...base, token: host.mediaToken, size: Buffer.byteLength(file.text), mtimeMs: file.mtimeMs ?? 100 });
    }
    const file = files[request.path];
    if (!file) return page.post({ type: 'chunk', ...base, error: { code: 'not_found', message: '没有这个文件' } });
    const data = Buffer.from(file.text);
    page.post({ type: 'chunk', ...base, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: file.mtimeMs ?? 100, kind: file.kind ?? 'text', eof: true });
  }
  Object.assign(host, {
    session(id, root = { state: 'ready', path: '/A' }) {
      host.generation++;
      host.root = root;
      page.post({ type: 'session', generation: host.generation, session: id });
      page.post({ type: 'root', generation: host.generation, ...root });
    },
    setRoot(state, path = host.root?.path) {
      host.root = { state, path };
      page.post({ type: 'root', generation: host.generation, state, path });
    },
    answerMedia(request, token = host.mediaToken) {
      page.post({ type: 'media_granted', generation: request.generation, requestId: request.requestId, token, size: 10, mtimeMs: 100 });
    },
  });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

const row = (page, name) => page.tree.find(node => node.classList.contains('row') && node.textContent.includes(name))[0];
const dbl = async (page, name) => { row(page, name).dispatch('click'); row(page, name).dispatch('dblclick'); await flush(); };
const text = page => (page.preview.find(node => node.classList.contains('text'))[0] ?? page.preview.find(node => node.classList.contains('md'))[0])?.textContent;
const menuButtons = page => page.menu.find(node => node.tagName === 'BUTTON');
const rightClick = (page, name) => row(page, name).dispatch('contextmenu', { clientX: 5, clientY: 6 });
const choose = async (page, label) => { menuButtons(page).find(node => node.textContent === label).dispatch('click'); await flush(); };

const savedCoda = (...categories) => ({
  v: 1, seq: 1, hidden: false, sort: 'name', view: 'list',
  openWith: Object.fromEntries(categories.map(c => [c, 'coda'])),
  sessions: {},
});

const savedInline = (...categories) => ({ ...savedCoda(), openWith: Object.fromEntries(categories.map(c => [c, 'inline'])) });

test('初始默认：文档类（PDF、Office、iWork）走 Coda，其余类别走资源管理器页内预览', async t => {
  const roots = {
    '/A': {
      'README.md': { text: '# hi\n' },
      'report.pdf': { text: '%PDF', kind: 'binary' },
      'app.js': { text: 'const x = 1;\n' },
    },
  };
  const { page, host } = await open(t, { roots, mediaToken: 'tokD' });
  host.session('s1');
  await flush();

  await dbl(page, 'README.md');
  assert.deepEqual(host.opened, []);
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'hi');

  // 返回目录树后打开 PDF：页内没有预览，没选过时默认交给 Coda
  page.preview.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  await dbl(page, 'report.pdf');
  assert.deepEqual(host.opened, ['coda-view://service/media/tokD/report.pdf']);
  assert.equal(visible(page.preview), false);
  assert.equal(host.state.at(-1)?.openWith?.document ?? null, null, '默认值不写进保存状态，只有用户切过才记');
});

test('用户在行菜单选过「在资源管理器中打开」的文档类，仍按记下的走页内预览', async t => {
  const { page, host } = await open(t, { roots: { '/A': { 'report.pdf': { text: '%PDF', kind: 'binary' } } }, state: savedInline('document') });
  host.session('s1');
  await flush();
  await dbl(page, 'report.pdf');
  assert.deepEqual(host.opened, []);
  assert.equal(visible(page.preview), true);
});

test('右键「在 Coda 中打开」立即用 Coda 打开并按类别记住默认习惯，反向选「在资源管理器中打开」可切回', async t => {
  const roots = {
    '/work/my repo': {
      'report #1.pdf': { text: '%PDF', kind: 'binary' },
      'spec 中文.docx': { text: 'PK', kind: 'binary' },
      'deck.key': { text: 'PK', kind: 'binary' },
      'README.md': { text: '# hi\n' },
    },
  };
  const { page, host, tick } = await open(t, { roots, mediaToken: 'abc999', state: savedInline('document') });
  host.session('s1', { state: 'ready', path: '/work/my repo' });
  await flush();

  // 用户记下的是页内预览：右键菜单显示「在 Coda 中打开」
  rightClick(page, 'report #1.pdf');
  assert.ok(menuButtons(page).some(b => b.textContent === '在 Coda 中打开'));
  await choose(page, '在 Coda 中打开');
  tick(300);

  assert.deepEqual(host.opened, ['coda-view://service/media/abc999/report%20%231.pdf']);
  assert.equal(visible(page.preview), false, '不切到页内预览');
  assert.equal(host.state.at(-1)?.openWith?.document, 'coda', '按类别记住 document=coda');
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null, '不记入 setState.opened');

  // 同类别（document）的 .docx 和 .key 双击自动跟随走 Coda
  await dbl(page, 'spec 中文.docx');
  await dbl(page, 'deck.key');
  assert.deepEqual(host.opened, [
    'coda-view://service/media/abc999/report%20%231.pdf',
    'coda-view://service/media/abc999/spec%20%E4%B8%AD%E6%96%87.docx',
    'coda-view://service/media/abc999/deck.key',
  ]);
  for (const url of host.opened) assert.equal(url.includes('?'), false, '地址不能带查询参数');

  // 不同类别（markdown）不受影响，仍默认走资源管理器页内预览
  await dbl(page, 'README.md');
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'hi');
  page.preview.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();

  // 反向切换：此时右键 .docx 应显示「在资源管理器中打开」
  rightClick(page, 'spec 中文.docx');
  assert.ok(menuButtons(page).some(b => b.textContent === '在资源管理器中打开'));
  await choose(page, '在资源管理器中打开');
  tick(300);
  assert.equal(visible(page.preview), true);
  assert.equal(host.state.at(-1)?.openWith?.document, 'inline', '按类别切回 document=inline');
});

test('同类别连续打开回归：README、Dockerfile、Makefile、.gitignore 跟随 text 偏好，article.mdx 跟随 markdown 偏好且均有切换项', async t => {
  const roots = {
    '/A': {
      'example.txt': { text: 'ex' },
      'README': { text: 'readme' },
      'Dockerfile': { text: 'FROM node' },
      'Makefile': { text: 'all:' },
      '.gitignore': { text: 'node_modules' },
      'README.md': { text: '# md' },
      'article.mdx': { text: '# mdx' },
    },
  };
  const { page, host } = await open(t, { roots, mediaToken: 't999' });
  host.session('s1');
  await flush();

  // 对 example.txt 选「在 Coda 中打开」→ 同属 text 的无后缀/点文件均自动跟随且菜单有「在资源管理器中打开」
  rightClick(page, 'example.txt');
  await choose(page, '在 Coda 中打开');
  for (const name of ['README', 'Dockerfile', 'Makefile', '.gitignore']) {
    rightClick(page, name);
    assert.ok(menuButtons(page).some(b => b.textContent === '在资源管理器中打开'), `${name} 应有切换项`);
    await dbl(page, name);
  }
  assert.deepEqual(host.opened, [
    'coda-view://service/media/t999/example.txt',
    'coda-view://service/media/t999/README',
    'coda-view://service/media/t999/Dockerfile',
    'coda-view://service/media/t999/Makefile',
    'coda-view://service/media/t999/.gitignore',
  ]);

  // 对 README.md 选「在 Coda 中打开」→ 同属 markdown 的 article.mdx 自动跟随且有切换项
  rightClick(page, 'README.md');
  await choose(page, '在 Coda 中打开');
  rightClick(page, 'article.mdx');
  assert.ok(menuButtons(page).some(b => b.textContent === '在资源管理器中打开'), 'article.mdx 应归为 markdown 且有切换项');
  await dbl(page, 'article.mdx');
  assert.equal(host.opened.at(-1), 'coda-view://service/media/t999/article.mdx');
});

test('跨会话与重建页面连贯回归：会话 A 经菜单设定偏好后，用实际 setState 保存值重建页面，会话 B 首次打开同类别文件沿用该偏好', async t => {
  const roots = {
    '/A': { 'report.pdf': { text: '%PDF', kind: 'binary' } },
    '/B': { 'slides.pptx': { text: 'PK', kind: 'binary' }, 'notes.md': { text: '# b' } },
  };
  const first = await open(t, { roots, mediaToken: 'tokA', state: savedInline('document') });
  first.host.session('sA', { state: 'ready', path: '/A' });
  await flush();
  rightClick(first.page, 'report.pdf');
  await choose(first.page, '在 Coda 中打开');
  first.tick(300);
  const persisted = first.host.state.at(-1);
  assert.ok(persisted, '会话 A 应写出持久化状态');

  // 用会话 A 实际 setState 的值重建页面，在会话 B 首次双击同类别（document）文件
  const second = await open(t, { roots, state: persisted, mediaToken: 'tokB' });
  second.host.session('sB', { state: 'ready', path: '/B' });
  await flush();
  await dbl(second.page, 'slides.pptx');
  assert.deepEqual(second.host.opened, ['coda-view://service/media/tokB/slides.pptx'], '会话 B 应沿用会话 A 存下的 document=coda 偏好');
  assert.equal(visible(second.page.preview), false);

  // 未设定偏好的 markdown 在会话 B 仍默认走资源管理器页内预览
  await dbl(second.page, 'notes.md');
  assert.equal(visible(second.page.preview), true);
  assert.equal(text(second.page), 'b');
});

test('parseState 校验 openWith：只保留合法类别与 coda/inline，坏值被忽略', () => {
  const parsed = parseState({
    v: 1,
    openWith: {
      markdown: 'coda',
      document: 'inline',
      text: 'coda',
      unknown: 'coda',
      image: 'invalid',
    },
    sessions: {},
  });
  assert.deepEqual(parsed.openWith, { markdown: 'coda', document: 'inline', text: 'coda' });
});

test('coda.open 抛错（异步 reject 或同步 throw）与无流式服务时静默回退到页内预览', async t => {
  // 异步 reject（如旧版 Coda、超过 20 MiB、不支持类型）
  {
    const roots = { '/A': { 'README.md': { text: '# fallback\n' } } };
    const { page, host } = await open(t, {
      roots,
      state: savedCoda('markdown'),
      coda: { open: () => Promise.reject(new Error('文件超过 20 MiB')) },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'README.md');
    assert.equal(visible(page.preview), true);
    assert.equal(text(page), 'fallback');
    assert.equal(page.hint.textContent, '', '静默回退，不弹错误提示');
  }
  // 同步 throw
  {
    const roots = { '/A': { 'doc.pdf': { text: '%PDF' } } };
    const { page, host } = await open(t, {
      roots,
      state: savedCoda('document'),
      coda: { open: () => { throw new Error('打不开'); } },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'doc.pdf');
    assert.equal(visible(page.preview), true);
    assert.equal(page.hint.textContent, '');
  }
  // 无流式服务（token: null）
  {
    const roots = { '/A': { 'README.md': { text: '# no-service\n' } } };
    const calls = [];
    const { page, host } = await open(t, {
      roots,
      state: savedCoda('markdown'),
      mediaToken: null,
      coda: { open: target => { calls.push(target); return Promise.resolve(); } },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'README.md');
    assert.deepEqual(calls, [], '没有口令就不调 coda.open');
    assert.equal(visible(page.preview), true);
    assert.equal(text(page), 'no-service');
  }
});

test('防竞态：连续点两个文件时，前一个 coda.open 晚到失败不覆盖后一个', async t => {
  const first = deferred();
  const calls = [];
  const roots = {
    '/A': {
      'a.pdf': { text: 'pdf-a' },
      'b.txt': { text: 'txt-b' },
    },
  };
  const { page, host } = await open(t, {
    roots,
    state: savedCoda('document'),
    coda: {
      open: target => {
        calls.push(target);
        return first.promise;
      },
    },
  });
  host.session('s1');
  await flush();

  await dbl(page, 'a.pdf');
  assert.deepEqual(calls, ['coda-view://service/media/tok123/a.pdf']);
  await dbl(page, 'b.txt');
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'txt-b');

  first.reject(new Error('unsupported'));
  await flush();
  assert.equal(text(page), 'txt-b', '前一个回退不能盖掉 b.txt');
});

test('防竞态：同一页面只允许一个 coda.open 在途，在途期间的新打开意图合并，首次请求晚成功时最终展示最后点击的文件', async t => {
  const first = deferred(), last = deferred();
  const calls = [], shown = [];
  const roots = {
    '/A': {
      'a.pdf': { text: 'pdf-a' },
      'b.pdf': { text: 'pdf-b' },
      'c.pdf': { text: 'pdf-c' },
    },
  };
  const { page, host } = await open(t, {
    roots,
    state: savedCoda('document'),
    coda: {
      open: target => {
        calls.push(target);
        const gate = calls.length === 1 ? first.promise : last.promise;
        return gate.then(() => { shown.push(target); });
      },
    },
  });
  host.session('s1');
  await flush();

  await dbl(page, 'a.pdf');
  await dbl(page, 'b.pdf');
  await dbl(page, 'c.pdf');
  assert.deepEqual(calls, ['coda-view://service/media/tok123/a.pdf'], 'a.pdf 在途期间不并发调 b.pdf / c.pdf');

  first.resolve();
  await flush();
  assert.deepEqual(calls, [
    'coda-view://service/media/tok123/a.pdf',
    'coda-view://service/media/tok123/c.pdf',
  ]);
  last.resolve();
  await flush();
  assert.deepEqual(shown, [
    'coda-view://service/media/tok123/a.pdf',
    'coda-view://service/media/tok123/c.pdf',
  ], '最终展示最后打开的 c.pdf，不会被晚到的 a.pdf 覆盖');
  assert.equal(visible(page.preview), false);
});

test('防竞态：前一个 PDF 在途失败时，不回退页内预览并继续打开排队的下一个 PDF', async t => {
  const first = deferred(), second = deferred();
  const calls = [];
  const roots = {
    '/A': {
      'a.pdf': { text: 'pdf-a' },
      'b.pdf': { text: 'pdf-b' },
    },
  };
  const { page, host } = await open(t, {
    roots,
    state: savedCoda('document'),
    coda: {
      open: target => {
        calls.push(target);
        return calls.length === 1 ? first.promise : second.promise;
      },
    },
  });
  host.session('s1');
  await flush();

  await dbl(page, 'a.pdf');
  await dbl(page, 'b.pdf');
  assert.deepEqual(calls, ['coda-view://service/media/tok123/a.pdf']);

  first.reject(new Error('too big'));
  await flush();
  assert.equal(visible(page.preview), false, 'a.pdf 已被 b.pdf 取代，失败不回退页内预览');
  assert.deepEqual(calls, [
    'coda-view://service/media/tok123/a.pdf',
    'coda-view://service/media/tok123/b.pdf',
  ]);
  second.resolve();
  await flush();
  assert.equal(visible(page.preview), false);
});

test('防竞态：等口令期间换会话，旧口令回来不再调 coda.open', async t => {
  const calls = [];
  const roots = {
    '/A': { 'a.md': { text: '# a' }, 'b.txt': { text: 'b' } },
    '/B': { 'b.txt': { text: 'other' } },
  };
  const { page, host } = await open(t, {
    roots,
    state: savedCoda('markdown'),
    holdMedia: true,
    coda: { open: target => { calls.push(target); return Promise.resolve(); } },
  });
  host.session('s1');
  await flush();

  await dbl(page, 'a.md');
  assert.equal(host.heldMedia.length, 1);
  host.session('s2', { state: 'ready', path: '/B' });
  await flush();

  host.answerMedia(host.heldMedia[0], 'oldtok');
  await flush();
  assert.deepEqual(calls, [], '换会话后旧口令回来不调 coda.open');
  assert.equal(visible(page.preview), false);
});

test('防竞态：coda.open 期间根目录变更，晚到失败不回退到页内预览', async t => {
  const first = deferred();
  const roots = {
    '/A': { 'a.pdf': { text: 'pdf-a' } },
    '/B': { 'a.pdf': { text: 'pdf-b' } },
  };
  const { page, host } = await open(t, {
    roots,
    state: savedCoda('document'),
    coda: { open: () => first.promise },
  });
  host.session('s1');
  await flush();

  await dbl(page, 'a.pdf');
  host.setRoot('ready', '/B');
  await flush();
  first.reject(new Error('failed'));
  await flush();
  assert.equal(visible(page.preview), false, '根目录切换后旧失败不回退');
});

test('iPhone 长按「在 Coda 中打开」立即打开并记住偏好，后续轻点同类别文件自动跟随', async t => {
  const roots = { '/A': { 'a.pdf': { text: '%PDF' }, 'b.docx': { text: 'PK' }, 'c.md': { text: '# md' } } };
  const { page, host, tick } = await open(t, { roots, platform: 'ios', mediaToken: 'iostok', state: savedInline('document') });
  host.session('s1');
  await flush();

  row(page, 'a.pdf').dispatch('pointerdown', { pointerId: 1, isPrimary: true, clientX: 5, clientY: 6 });
  tick(500);
  row(page, 'a.pdf').dispatch('pointerup', { pointerId: 1, isPrimary: true, clientX: 5, clientY: 6 });
  row(page, 'a.pdf').dispatch('click');
  assert.ok(menuButtons(page).some(b => b.textContent === '在 Coda 中打开'));
  await choose(page, '在 Coda 中打开');
  tick(300);

  // 同类别 b.docx 轻点自动走 Coda，不同类别 c.md 仍走页内预览
  row(page, 'b.docx').dispatch('click');
  await flush();
  assert.deepEqual(host.opened, [
    'coda-view://service/media/iostok/a.pdf',
    'coda-view://service/media/iostok/b.docx',
  ]);
  assert.equal(visible(page.preview), false);
  assert.equal(host.state.at(-1)?.openWith?.document, 'coda');
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null);

  row(page, 'c.md').dispatch('click');
  await flush();
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'md');
});

test('iPhone：恢复偏好后轻点 PDF / Markdown 走 coda.open，不进页内预览、不记入 setState.opened', async t => {
  const roots = { '/A': { 'a.pdf': { text: '%PDF' }, 'b.md': { text: '# md' } } };
  const { page, host, tick } = await open(t, { roots, state: savedCoda('document', 'markdown'), platform: 'ios', mediaToken: 'iostok' });
  host.session('s1');
  await flush();

  row(page, 'a.pdf').dispatch('click');
  await flush();
  row(page, 'b.md').dispatch('click');
  await flush();
  tick(300);

  assert.deepEqual(host.opened, [
    'coda-view://service/media/iostok/a.pdf',
    'coda-view://service/media/iostok/b.md',
  ]);
  assert.equal(visible(page.preview), false);
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null);
});

test('真实链路回归：旧条目在点击前被替换为指向目录外的符号链接时，拒绝 coda.open 且流式服务返回 403', async t => {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'ok.pdf'), '%PDF-ok');
  await writeFile(join(root, 'report.pdf'), '%PDF-inner');
  await writeFile(join(base, 'secret.pdf'), '%PDF-OUTSIDE-SECRET');

  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const view = fake.open('A');
  const loaded = deferred();
  view.listen(message => loaded.promise.then(() => queueMicrotask(() => page.post(message))));
  const opened = [];
  const page = await loadApp(t, {
    platform: 'mac',
    postMessage: message => view.send(message),
    on: () => {},
    copy: () => {},
    getState: () => savedCoda('document'),
    setState: () => {},
    open: target => { opened.push(target); return Promise.resolve(); },
    close: () => {},
  });
  loaded.resolve();
  await waitFor(() => rowNamed(page, 'report.pdf'), '目录树列出旧条目');

  rowNamed(page, 'ok.pdf').dispatch('click');
  rowNamed(page, 'ok.pdf').dispatch('dblclick');
  await waitFor(() => opened.length === 1, '目录内 PDF 经流式服务打开');
  const match = /^coda-view:\/\/service\/media\/([0-9a-f]+)\/ok\.pdf$/.exec(opened[0]);
  assert.ok(match, `应为流式服务地址，实际为 ${opened[0]}`);
  const token = match[1];

  await unlink(join(root, 'report.pdf'));
  await symlink(join(base, 'secret.pdf'), join(root, 'report.pdf'));

  rowNamed(page, 'report.pdf').dispatch('click');
  rowNamed(page, 'report.pdf').dispatch('dblclick');
  await waitFor(() => visible(page.preview) && page.preview.textContent.includes('读不到这个文件'), '外链被拒绝，页面显示读不到');
  assert.equal(opened.length, 1, '绝不把外链交给 coda.open');
  assert.equal(page.preview.textContent.includes('OUTSIDE-SECRET'), false, '绝不泄露外部内容');

  const server = createServer(fake.services.get('media'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/${token}/report.pdf`);
  const body = await res.text();
  assert.equal(res.status, 403);
  assert.equal(body.includes('OUTSIDE-SECRET'), false);
});

test('独立 file 视图不调 coda.open，打开 Markdown/PDF 仍走页内预览', async t => {
  const calls = [];
  const page = await loadFileApp(t, {
    platform: 'mac',
    args: { session: 's1', path: 'README.md' },
    postMessage: message => {
      if (message.type === 'read') {
        const data = Buffer.from('# standalone\n');
        queueMicrotask(() => page.post({
          type: 'chunk', generation: message.generation, requestId: message.requestId,
          data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true,
        }));
      }
    },
    on: () => {},
    copy: () => {},
    getState: () => savedCoda('markdown'),
    setState: () => {},
    open: target => { calls.push(target); return Promise.resolve(); },
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/A' });
  await flush();

  assert.deepEqual(calls, [], '独立 file 视图不能再调 coda.open');
  assert.equal(visible(page.preview), true);
  assert.equal(page.preview.find(node => node.classList.contains('md'))[0]?.textContent, 'standalone');
});
