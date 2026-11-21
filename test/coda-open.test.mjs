// coda.open 文件预览分流、异常回退、防竞态与状态保护（Issue #21 第二部分）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadApp, loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const timersOn = new WeakSet();

async function open(t, { roots = {}, coda = {}, mediaToken = 'tok123', holdMedia = false, failMedia = null, platform = 'mac' } = {}) {
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
    getState: () => undefined,
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
const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;

test('PDF、Office、iWork 经 file:///<绝对路径> 调 coda.open，路径逐段编码，不进页内预览、不记入 setState.opened', async t => {
  const roots = {
    '/work/my repo': {
      'report #1.pdf': { text: '%PDF', kind: 'binary' },
      'spec 中文.docx': { text: 'PK', kind: 'binary' },
      'deck.key': { text: 'PK', kind: 'binary' },
    },
  };
  const { page, host, tick } = await open(t, { roots });
  host.session('s1', { state: 'ready', path: '/work/my repo' });
  await flush();

  await dbl(page, 'report #1.pdf');
  await dbl(page, 'spec 中文.docx');
  await dbl(page, 'deck.key');
  tick(300);

  assert.deepEqual(host.opened, [
    'file:///work/my%20repo/report%20%231.pdf',
    'file:///work/my%20repo/spec%20%E4%B8%AD%E6%96%87.docx',
    'file:///work/my%20repo/deck.key',
  ]);
  assert.equal(visible(page.preview), false, '不切到页内预览');
  assert.equal(host.sent.filter(m => m.type === 'read').length, 0, '不读块');
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null, '不把文件记入 setState 的 opened');
});

test('Markdown 经本机流式服务调 coda.open（不带 ?v=），不进页内预览、不记入 setState.opened', async t => {
  const roots = {
    '/A': {
      'README.md': { text: '# hi\n' },
      'notes #2.markdown': { text: '## two\n' },
    },
  };
  const { page, host, tick } = await open(t, { roots, mediaToken: 'abc999' });
  host.session('s1');
  await flush();

  await dbl(page, 'README.md');
  await dbl(page, 'notes #2.markdown');
  tick(300);

  assert.deepEqual(host.opened, [
    'coda-view://service/media/abc999/README.md',
    'coda-view://service/media/abc999/notes%20%232.markdown',
  ]);
  for (const url of host.opened) assert.equal(url.includes('?'), false, '地址不能带查询参数');
  assert.equal(visible(page.preview), false);
  assert.equal(host.sent.filter(m => m.type === 'read').length, 0);
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null);
});

test('代码/文本保持页内预览，不调 coda.open', async t => {
  const roots = { '/A': { 'app.js': { text: 'const x = 1;\n' } } };
  const { page, host } = await open(t, { roots });
  host.session('s1');
  await flush();

  await dbl(page, 'app.js');
  assert.deepEqual(host.opened, []);
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'const x = 1;\n');
});

test('coda.open 抛错（异步 reject 或同步 throw）与无流式服务时静默回退到页内预览', async t => {
  // 异步 reject（如旧版 Coda、超过 20 MiB、不支持类型）
  {
    const roots = { '/A': { 'README.md': { text: '# fallback\n' } } };
    const { page, host } = await open(t, {
      roots,
      coda: { open: () => Promise.reject(new Error('文件超过 20 MiB')) },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'README.md');
    assert.equal(visible(page.preview), true);
    assert.equal(text(page), '# fallback\n');
    assert.equal(page.hint.textContent, '', '静默回退，不弹错误提示');
  }
  // 同步 throw
  {
    const roots = { '/A': { 'doc.pdf': { text: '%PDF' } } };
    const { page, host } = await open(t, {
      roots,
      coda: { open: () => { throw new Error('打不开'); } },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'doc.pdf');
    assert.equal(visible(page.preview), true);
    assert.equal(page.hint.textContent, '');
  }
  // Markdown 无流式服务（token: null）
  {
    const roots = { '/A': { 'README.md': { text: '# no-service\n' } } };
    const calls = [];
    const { page, host } = await open(t, {
      roots,
      mediaToken: null,
      coda: { open: target => { calls.push(target); return Promise.resolve(); } },
    });
    host.session('s1');
    await flush();
    await dbl(page, 'README.md');
    assert.deepEqual(calls, [], '没有口令就不调 coda.open');
    assert.equal(visible(page.preview), true);
    assert.equal(text(page), '# no-service\n');
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
  assert.deepEqual(calls, ['file:///A/a.pdf']);
  await dbl(page, 'b.txt');
  assert.equal(visible(page.preview), true);
  assert.equal(text(page), 'txt-b');

  first.reject(new Error('unsupported'));
  await flush();
  assert.equal(text(page), 'txt-b', '前一个回退不能盖掉 b.txt');
});

test('防竞态：连续点两个 PDF，前一个失败不覆盖后一个成功的 coda.open', async t => {
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
  assert.deepEqual(calls, ['file:///A/a.pdf', 'file:///A/b.pdf']);

  second.resolve();
  first.reject(new Error('too big'));
  await flush();
  assert.equal(visible(page.preview), false, '前一个失败不能把后一个顶成页内预览');
});

test('防竞态：Markdown 等口令期间换会话或点别的文件，旧请求回来不再调 coda.open', async t => {
  const calls = [];
  const roots = {
    '/A': { 'a.md': { text: '# a' }, 'b.txt': { text: 'b' } },
    '/B': { 'b.txt': { text: 'other' } },
  };
  const { page, host } = await open(t, {
    roots,
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

test('iPhone 轻点 PDF / Markdown 走 coda.open，不进页内预览、不记入 setState.opened', async t => {
  const roots = { '/A': { 'a.pdf': { text: '%PDF' }, 'b.md': { text: '# md' } } };
  const { page, host, tick } = await open(t, { roots, platform: 'ios', mediaToken: 'iostok' });
  host.session('s1');
  await flush();

  row(page, 'a.pdf').dispatch('click');
  await flush();
  row(page, 'b.md').dispatch('click');
  await flush();
  tick(300);

  assert.deepEqual(host.opened, [
    'file:///A/a.pdf',
    'coda-view://service/media/iostok/b.md',
  ]);
  assert.equal(visible(page.preview), false);
  assert.equal(host.state.at(-1)?.sessions?.s1?.opened ?? null, null);
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
    getState: () => undefined,
    setState: () => {},
    open: target => { calls.push(target); return Promise.resolve(); },
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/A' });
  await flush();

  assert.deepEqual(calls, [], '独立 file 视图不能再调 coda.open');
  assert.equal(visible(page.preview), true);
  assert.equal(page.preview.find(node => node.classList.contains('text'))[0]?.textContent, '# standalone\n');
});
