// 文件视图 view/file-app.mjs 的接线：真实页面入口、Link 和预览，配最小的假 DOM 和一个脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const FILE = 'f.txt';
const tree = (text, mtimeMs = 100, name = FILE) => ({ [name]: { text, mtimeMs } });

// 脚本化的假模块：自动回答 read（可扣住、可失败）；收到 list 记下来，文件页不该发。
const timersOn = new WeakSet();
async function open(t, { args = { session: 's1', path: FILE }, roots = { '/A': tree('aaaaa') }, state, coda = {} } = {}) {
  if (!timersOn.has(t)) { timersOn.add(t); t.mock.timers.enable({ apis: ['setTimeout'] }); }
  const sent = [], held = [], events = {}, saved = [];
  const host = { sent, held, saved, events, generation: 0, root: null, roots, hold: false, failRead: null };
  const page = await loadFileApp(t, {
    platform: 'web', args,
    postMessage: message => { sent.push(message); if (message.type === 'read') queueMicrotask(() => answer(message)); },
    on: (name, fn) => { events[name] = fn; },
    copy: () => {},
    getState: () => state,
    setState: value => saved.push(JSON.parse(JSON.stringify(value))),
    ...coda,
  });
  function answer(request) {
    if (request.generation !== host.generation) return;
    const base = { generation: request.generation, requestId: request.requestId };
    if (host.hold) return held.push(request);
    if (host.failRead) return page.post({ type: 'chunk', ...base, error: host.failRead });
    const file = host.roots[host.root?.path]?.[request.path];
    if (!file) return page.post({ type: 'chunk', ...base, error: { code: 'not_found', message: '没有这个文件' } });
    const data = Buffer.from(file.text);
    page.post({ type: 'chunk', ...base, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: file.mtimeMs, kind: 'text', eof: true });
  }
  Object.assign(host, {
    // 换会话：代次加一，先 session 后 root，同真实模块。
    session(id, root = { state: 'ready', path: '/A' }) {
      host.generation++;
      host.root = root;
      page.post({ type: 'session', generation: host.generation, session: id });
      page.post({ type: 'root', generation: host.generation, ...root });
    },
    setRoot(state, path = host.root?.path) { host.root = { state, path }; page.post({ type: 'root', generation: host.generation, state, path }); },
    changed() { page.post({ type: 'changed', generation: host.generation }); },
    late(request, text) {
      const data = Buffer.from(text);
      page.post({ type: 'chunk', generation: request.generation, requestId: request.requestId, data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true });
    },
    count: type => sent.filter(m => m.type === type).length,
  });
  return { page, host, tick: ms => t.mock.timers.tick(ms) };
}

const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;
const body = page => page.preview.find(node => node.classList.contains('pbody'))[0];
// 按可访问名称找：图标按钮靠 aria-label，文字按钮就是它的文字。
const button = (root, label) => root.find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];

async function started(t, options) {
  const ctx = await open(t, options);
  ctx.host.session('s1');
  await flush();
  return ctx;
}

test('启动：握手后打开 args.path，只读文件，不请求目录', async t => {
  const { page, host } = await started(t);
  assert.equal(host.count('hello'), 1);
  assert.equal(text(page), 'aaaaa');
  assert.deepEqual(host.sent.filter(m => m.type === 'read').map(m => m.path), [FILE]);
  assert.equal(host.count('list'), 0);
  assert.ok(visible(page.preview));
  assert.equal(visible(page.notice), false);
});

test('changed：文件变了就重读；没变不重画正文', async t => {
  const { page, host } = await started(t);
  const node = body(page).children[0];
  host.changed();
  await flush();
  assert.equal(body(page).children[0], node, '元数据没变，正文节点不换');
  host.roots['/A'] = tree('aaaaa, changed', 200);
  host.changed();
  await flush();
  assert.equal(text(page), 'aaaaa, changed');
});

test('手动刷新：先发协议 refresh；gone 时也发，恢复为 ready 后重新打开', async t => {
  const { page, host } = await started(t);
  button(page.bar, '刷新').dispatch('click');
  await flush();
  assert.deepEqual(host.sent.filter(m => m.type === 'refresh'), [{ type: 'refresh', generation: 1 }]);

  host.setRoot('gone');
  await flush();
  assert.equal(visible(page.preview), false);
  assert.match(page.notice.textContent, /工作目录已不存在/);
  assert.equal(text(page), undefined);
  button(page.bar, '刷新').dispatch('click');
  await flush();
  assert.equal(host.count('refresh'), 2, 'gone 下模块不轮询，刷新是恢复入口');

  const reads = host.count('read');
  host.setRoot('ready'); // 模块回应 refresh 后推来
  await flush();
  assert.ok(visible(page.preview));
  assert.equal(text(page), 'aaaaa');
  assert.equal(host.count('read'), reads + 1, '重新打开，读第一块');
});

test('root 的 preparing、gone、none 各显示说明，回到 ready 再打开', async t => {
  const { page, host } = await started(t);
  const says = {
    preparing: /工作树还在准备/, gone: /工作目录已不存在/, none: /没有可浏览的工作目录/,
  };
  for (const [state, pattern] of Object.entries(says)) {
    host.setRoot(state);
    await flush();
    assert.match(page.notice.textContent, pattern, state);
    assert.ok(visible(page.notice), state);
    assert.equal(visible(page.preview), false, state);
    assert.equal(text(page), undefined, state);
    host.setRoot('ready');
    await flush();
    assert.equal(text(page), 'aaaaa', `${state} 之后恢复`);
  }
});

test('没有会话或没有路径：显示说明，不读文件', async t => {
  const none = await open(t, { args: { session: 5, path: FILE } });
  none.host.session(null, { state: 'none', path: null }); // 模块把非字符串的会话当作没有
  await flush();
  assert.match(none.page.notice.textContent, /没有打开的会话/);
  assert.equal(none.host.count('read'), 0);

  const noPath = await open(t, { args: { session: 's1' } });
  noPath.host.session('s1');
  await flush();
  assert.match(noPath.page.notice.textContent, /没有指定要打开的文件/);
  assert.equal(noPath.host.count('read'), 0);
});

test('根目录换了位置（ready → ready）：大小和 mtimeMs 相同也显示新根目录的正文', async t => {
  const { page, host } = await started(t);
  host.roots['/B'] = tree('bbbbb');
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(text(page), 'bbbbb');
});

test('切换会话后迟到的块不显示；新会话 ready 后只显示新内容', async t => {
  const { page, host } = await started(t);
  host.hold = true;
  host.changed();
  await flush();
  const [late] = host.held.splice(0);
  host.session('s2', { state: 'preparing', path: null });
  host.events.context({ args: { session: 's2', path: FILE } });
  assert.equal(page.preview.textContent.includes('aaaaa'), false, '切换的当下就清空');
  host.late(late, 'zzzzz');
  await flush();
  assert.doesNotMatch(page.preview.textContent, /aaaaa|zzzzz/);
  host.hold = false;
  host.roots['/B'] = tree('bbbbb');
  host.setRoot('ready', '/B');
  await flush();
  assert.equal(text(page), 'bbbbb');
});

test('握手没有回答：30 秒后给出原因和重试，收到 session 后恢复', async t => {
  const { page, host, tick } = await open(t);
  assert.equal(page.notice.textContent, '正在读取…');
  tick(30_000);
  await flush();
  assert.match(page.notice.textContent, /没有连上.*30 秒没有收到回答/);
  button(page.notice, '重试').dispatch('click');
  await flush();
  assert.equal(host.count('hello'), 2);
  host.session('s1');
  await flush();
  assert.equal(text(page), 'aaaaa');
});

// ---- 阅读位置 ----

test('滚动位置：停下后保存，重新加载页面能恢复；visibility: false 同步保存', async t => {
  const first = await started(t);
  body(first.page).scrollTop = 120;
  body(first.page).scrollLeft = 8;
  body(first.page).dispatch('scroll');
  assert.equal(first.host.saved.length, 0, '防抖，还没存');
  first.tick(300);
  assert.deepEqual(first.host.saved.at(-1), { v: 1, top: 120, left: 8 });

  body(first.page).scrollTop = 300;
  first.host.events.visibility(false);
  assert.deepEqual(first.host.saved.at(-1), { v: 1, top: 300, left: 8 }, '不等计时器');

  // 重新加载页面：getState 拿回保存的值，内容到了应用一次。
  const second = await started(t, { state: first.host.saved.at(-1) });
  assert.equal(text(second.page), 'aaaaa');
  assert.equal(body(second.page).scrollTop, 300);
  assert.equal(body(second.page).scrollLeft, 8);
});

test('恢复的位置在内容到达前不被覆盖；坏的状态被忽略', async t => {
  const held = await open(t, { state: { v: 1, top: 77, left: 0 } });
  held.host.hold = true;
  held.host.session('s1');
  await flush();
  held.host.events.visibility(false); // 内容还没到，滚动条在 0
  assert.deepEqual(held.host.saved.at(-1), { v: 1, top: 77, left: 0 });

  for (const state of [{ v: 2, top: 9 }, 'x', null, { v: 1, top: -5, left: 'a' }]) {
    const { page } = await started(t, { state });
    assert.equal(text(page), 'aaaaa');
    assert.equal(body(page).scrollTop, 0);
  }
});

test('恢复的读取失败不算用上（Mac 窗口）：保存的仍是原位置，重试成功后位置用上、之后才清；改看别的文件从头开始', async t => {
  const roots = { '/A': { ...tree('aaaaa'), ...tree('gggg', 100, 'g.txt') } };
  const { page, host } = await open(t, { roots, state: { v: 1, top: 77, left: 3 } });
  host.failRead = { code: 'io_error', message: '读不了' };
  host.session('s1');
  await flush();
  assert.match(page.preview.textContent, /读不到这个文件/);
  host.events.visibility(false);
  assert.deepEqual(host.saved.at(-1), { v: 1, top: 77, left: 3 }, '失败后仍是原位置');
  host.failRead = null;
  button(page.preview, '重试').dispatch('click');
  await flush();
  assert.equal(body(page).scrollTop, 77);
  body(page).scrollTop = 20;
  host.events.visibility(false);
  assert.deepEqual(host.saved.at(-1), { v: 1, top: 20, left: 3 }, '用上之后才清');

  const again = await open(t, { roots, state: { v: 1, top: 77, left: 3 } });
  again.host.failRead = { code: 'io_error', message: '读不了' };
  again.host.session('s1');
  await flush();
  again.host.failRead = null;
  again.host.events.context({ args: { session: 's1', path: 'g.txt' } });
  await flush();
  assert.equal(text(again.page), 'gggg');
  assert.equal(body(again.page).scrollTop, 0, '改看别的文件，旧位置作废');
});

test('恢复的初次读取被 changed 作废：位置在接替它的读取里用上，之后才存成新位置（Mac 窗口，同一个信号）', async t => {
  const { page, host } = await open(t, { state: { v: 1, top: 77, left: 3 } });
  host.hold = true;
  host.session('s1');
  await flush();
  host.changed();
  await flush();
  assert.equal(host.held.length, 2);
  host.late(host.held[0], 'aaaaa'); // 作废的那次
  await flush();
  assert.equal(body(page).scrollTop, 0);
  host.events.visibility(false);
  assert.deepEqual(host.saved.at(-1), { v: 1, top: 77, left: 3 }, '位置还留着');
  host.late(host.held[1], 'aaaaa');
  await flush();
  assert.equal(body(page).scrollTop, 77);
  body(page).scrollTop = 20;
  host.events.visibility(false);
  assert.deepEqual(host.saved.at(-1), { v: 1, top: 20, left: 3 });
});

test('预览收起（gone）再恢复：回到收起前的位置', async t => {
  const { page, host } = await started(t);
  body(page).scrollTop = 50;
  host.setRoot('gone');
  await flush();
  host.setRoot('ready');
  await flush();
  assert.equal(body(page).scrollTop, 50);
});

// ---- 参数变化 ----

test('context 事件换文件：滚动位置重置，读新路径', async t => {
  const { page, host } = await started(t, { state: { v: 1, top: 90, left: 0 }, roots: { '/A': { ...tree('aaaaa'), ...tree('gggg', 100, 'g.txt') } } });
  assert.equal(body(page).scrollTop, 90);
  body(page).scrollTop = 40;
  host.events.context({ args: { session: 's1', path: 'g.txt' } });
  await flush();
  assert.equal(text(page), 'gggg');
  assert.equal(body(page).scrollTop, 0, '新文件从头开始');
  assert.equal(host.sent.filter(m => m.type === 'read').at(-1).path, 'g.txt');
});

test('context 事件在内容到达前换文件：待恢复的位置不用于新文件', async t => {
  const roots = { '/A': { ...tree('aaaaa'), ...tree('gggg', 100, 'g.txt') } };
  const { page, host } = await open(t, { roots, state: { v: 1, top: 90, left: 0 } });
  host.hold = true;
  host.session('s1');
  await flush();
  host.events.context({ args: { session: 's1', path: 'g.txt' } });
  host.hold = false;
  host.held.splice(0);
  await flush();
  assert.equal(text(page), 'gggg');
  assert.equal(body(page).scrollTop, 0);
});

test('换会话：context 和 session 两条消息谁先到都一样，对上之前不读', async t => {
  for (const contextFirst of [true, false]) {
    const roots = { '/A': tree('aaaaa'), '/B': tree('bbbbb') };
    const { page, host } = await started(t, { roots });
    const reads = host.count('read');
    const newSession = () => host.session('s2', { state: 'ready', path: '/B' });
    const newArgs = () => host.events.context({ args: { session: 's2', path: FILE } });
    (contextFirst ? newArgs : newSession)();
    await flush();
    assert.equal(host.count('read'), reads, `${contextFirst ? 'context' : 'session'} 先到：另一半没到，不读`);
    assert.equal(text(page), undefined);
    assert.match(page.notice.textContent, /正在读取/);
    (contextFirst ? newSession : newArgs)();
    await flush();
    assert.equal(text(page), 'bbbbb');
  }
});

test('只收到 session、没有 root：30 秒后也提示，之后 root 到达就恢复；已有 root 不再提示', async t => {
  const { page, host, tick } = await open(t);
  host.generation++;
  host.root = { state: 'ready', path: '/A' };
  page.post({ type: 'session', generation: host.generation, session: 's1' });
  tick(30_000);
  await flush();
  assert.match(page.notice.textContent, /没有连上.*30 秒没有收到回答/);
  page.post({ type: 'root', generation: host.generation, ...host.root });
  await flush();
  assert.equal(text(page), 'aaaaa');
  assert.equal(visible(page.notice), false);
  tick(60_000);
  await flush();
  assert.equal(visible(page.notice), false, '已收到 root，不再提示');
});

// ---- 按下反馈的生命周期（第 17.3 节）：文件页也有，和资源页一样重置 ----
import { start as startFile } from './support/filepage.mjs';
const pressedButtons = page => page.preview.find(node => node.classList.contains('pressed'));
const copyButton = page => page.preview.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '复制路径')[0];
const mouseDown = { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };

test('文件页：按住「复制路径」时 visibility(false)、换会话、根目录变化、换文件，都清掉按下反馈', async t => {
  const { page, host } = await startFile(t, { path: 'a.txt', files: { 'a.txt': { text: 'x' }, 'b.txt': { text: 'y' } } });
  const hold = () => { copyButton(page).dispatch('pointerdown', mouseDown); assert.equal(pressedButtons(page).length, 1); };
  hold();
  host.events.visibility(false);
  assert.equal(pressedButtons(page).length, 0, '页面隐藏');
  hold();
  host.start('/A');
  await flush();
  assert.equal(pressedButtons(page).length, 0, '换会话');
  hold();
  page.post({ type: 'root', generation: 2, state: 'ready', path: '/other' });
  await flush();
  assert.equal(pressedButtons(page).length, 0, '根目录变化');
  hold();
  host.events.context({ args: { session: 's1', path: 'b.txt' } });
  await flush();
  assert.equal(pressedButtons(page).length, 0, '换文件');
});

test('文件页：触摸按下不到 80 毫秒就隐藏，之后不会补亮', async t => {
  const { page, host } = await startFile(t, { path: 'a.txt', files: { 'a.txt': { text: 'x' } } });
  copyButton(page).dispatch('pointerdown', { ...mouseDown, pointerType: 'touch' });
  host.events.visibility(false);
  t.mock.timers.tick(500);
  assert.equal(pressedButtons(page).length, 0);
});
