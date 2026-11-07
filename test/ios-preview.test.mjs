// iPhone 在资源页里打开文件（设计第 16 节）：声明的路径、系统返回和横屏返回、预览的工具条和菜单、恢复的阅读位置（第 16.9 节）。
// 真实的 app.mjs、Model、preview.mjs，配假 DOM 和脚本化的假模块；读文件的回答由测试扣住和放行。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, previewName, rowNamed } from './support/treehost.mjs';

const listing = { '': ['dir/', 'a.txt', 'b.txt'], dir: ['inner/', 'x.txt'], 'dir/inner': ['deep.txt'] };
const record = (extra = {}) => ({ at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 }, ...extra });
const stateOf = (session, view = 'list') => ({ v: 1, seq: 1, hidden: false, view, sessions: { s1: session } });
const pbody = page => page.preview.find(node => node.classList.contains('pbody'))[0];
const button = (root, label) => root.find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];

// holdReads：读文件的回答先扣住，测试用 host.release 放行。saved 是 setState 存下的每一份。
async function start(t, { state, hold = false, session = true, ...options } = {}) {
  const saved = [];
  const ctx = await openTree(t, { platform: 'ios', back: true, listing, state, coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) }, ...options });
  Object.assign(ctx.host, { autoRead: true, holdReads: hold });
  Object.assign(pbody(ctx.page), { scrollTop: 0 });
  if (session) { ctx.host.session(); await flush(); }
  const lastTop = () => { ctx.host.events.visibility(false); return saved.at(-1).sessions.s1.scroll.top; };
  return { ...ctx, saved, lastTop };
}
const release = async (host, request) => { host.release(request); await flush(); };

// ---- 声明的路径和返回 ----

test('列表视图：打开文件后声明「资源管理器」，back 关预览，路径回到打开前、选中留着', async t => {
  const { page, host } = await start(t);
  assert.deepEqual(host.calls.back, [], '目录树层没有上层');
  rowNamed(page, 'a.txt').dispatch('click');
  await flush();
  assert.deepEqual(host.calls.back, [['资源管理器']]);
  host.back(1);
  await flush();
  assert.deepEqual(host.calls.back.at(-1), []);
  assert.ok(visible(page.tree) && !visible(page.preview));
  assert.ok(rowNamed(page, 'a.txt').classList.contains('sel'));
});

test('图标视图：声明的路径多一级「当前目录名」；steps 为 1 只关预览，steps 为 3 关预览并退两层；已在最上层收到 back 重新声明', async t => {
  const state = stateOf(record({ cwd: 'dir/inner', root: '/A', opened: 'dir/inner/deep.txt' }), 'icons');
  const { host } = await start(t, { state });
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir', 'inner']);
  host.back(1);
  await flush();
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir'], '预览关了，仍在 dir/inner');

  const again = await start(t, { state });
  again.host.back(3);
  await flush();
  assert.deepEqual(again.host.calls.back.at(-1), [], '预览一层、dir/inner 两层');
  const count = again.host.calls.back.length;
  again.host.back(1); // 已在最上层：客户端已经退了一层，要重新告诉它现在在哪
  await flush();
  assert.equal(again.host.calls.back.length, count + 1);
  assert.deepEqual(again.host.calls.back.at(-1), []);
});

test('预览时顶部工具条只有「返回」（exit-only，竖屏不显示）；标题和 ⋯ 在预览头部，⋯ 里是刷新、查找（显示着文本时）、复制路径（相对路径），再点同一个按钮关闭', async t => {
  const { page, host } = await start(t);
  const barNames = () => page.bar.find(node => node.tagName === 'BUTTON' || node.classList.contains('bar-title')).map(node => node.getAttribute('aria-label') ?? node.textContent);
  assert.deepEqual(barNames(), ['返回', 'A', '更多'], '目录树上工具条不变');
  assert.equal(page.bar.classList.contains('exit-only'), false);
  rowNamed(page, 'dir').dispatch('click');
  await flush();
  rowNamed(page, 'x.txt').dispatch('click');
  await flush();
  assert.deepEqual(barNames(), ['返回']);
  assert.ok(page.bar.classList.contains('exit-only'));
  assert.equal(previewName(page), 'x.txt');
  const more = button(page.preview.find(node => node.classList.contains('phead'))[0], '更多');
  assert.ok(more, '预览头部右边有 ⋯');
  const items = () => page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  more.dispatch('click');
  assert.deepEqual(items(), ['刷新', '查找', '复制路径']);
  assert.ok(visible(page.menu));
  more.dispatch('click');
  assert.equal(visible(page.menu), false, '再点同一个按钮关闭');
  more.dispatch('click');
  const reads = host.reads().length;
  page.menu.find(node => node.textContent === '刷新')[0].dispatch('click');
  await flush();
  assert.equal(host.reads().length, reads + 1, '刷新重读');
  more.dispatch('click');
  page.menu.find(node => node.textContent === '复制路径')[0].dispatch('click');
  assert.deepEqual(host.calls.copy, ['dir/x.txt']);

  host.back(1);
  await flush();
  assert.deepEqual(barNames(), ['返回', 'A', '更多'], '关了预览，工具条回到目录树的样子');
  assert.equal(page.bar.classList.contains('exit-only'), false);
  button(page.bar, '更多').dispatch('click');
  assert.ok(items().includes('显示隐藏文件'));
});

test('预览开着：changed 重读；根目录换了位置回到目录树、路径清空；打开不交焦点', async t => {
  const { page, host } = await start(t);
  globalThis.document.activeElement = null;
  rowNamed(page, 'a.txt').dispatch('click');
  await flush();
  assert.equal(globalThis.document.activeElement, null, 'iPhone 打开不交焦点');
  assert.equal(host.reads().length, 1);
  host.changed();
  await flush();
  assert.equal(host.reads().length, 2, 'changed 重读（同 Mac 侧栏）');
  assert.equal(previewName(page), 'a.txt');
  host.session('s1', '/B'); // 同一个会话里根目录换了位置
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/C' });
  await flush();
  assert.ok(visible(page.tree) && !visible(page.preview));
  assert.deepEqual(host.calls.back.at(-1), []);
});

// ---- 第 16.4 节：根目录没就绪 ----

test('根目录没就绪：路径为空，横屏「返回」直接 coda.close，不消耗预览和目录层；保存的 opened、cwd 不变', async t => {
  const state = stateOf(record({ cwd: 'dir', root: '/A', opened: 'dir/x.txt' }), 'icons');
  const { page, host, saved } = await start(t, { state, session: false });
  host.generation++;
  page.post({ type: 'session', generation: host.generation, session: 's1' }); // 只有 session，root 还没到
  await flush();
  assert.ok(host.calls.back.every(path => path.length === 0), '声明的路径为空');
  button(page.bar, '返回').dispatch('click');
  assert.equal(host.calls.close, 1);
  host.events.visibility(false);
  assert.equal(saved.at(-1).sessions.s1.opened, 'dir/x.txt');
  assert.equal(saved.at(-1).sessions.s1.cwd, 'dir');
  host.back(1);
  await flush();
  assert.equal(host.calls.close, 1, '系统返回由客户端自己处理，页面只重新声明');

  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir'], 'root 到达的那次声明完整路径（图标视图在 dir 里，预览多一级）');
  assert.ok(visible(page.preview));
});

// ---- 第 16.9 节：恢复的阅读位置 ----

const RESTORE = stateOf(record({ opened: 'a.txt', root: '/A', scroll: { tree: 0, top: 120, left: 7 } }));

test('恢复的文件还没读回来就 visibility: false：存的仍是原来的位置；读回来后位置用上，之后跟着滚动走', async t => {
  const { host, page, lastTop } = await start(t, { state: RESTORE, hold: true });
  assert.equal(host.heldReads.length, 1);
  assert.equal(lastTop(), 120, '空正文的 0 不能覆盖');
  await release(host, host.heldReads[0]);
  assert.equal(pbody(page).scrollTop, 120);
  assert.equal(pbody(page).scrollLeft, 7);
  pbody(page).scrollTop = 50;
  assert.equal(lastTop(), 50, '用上之后才清：之后存的是新位置');
});

test('读回来之前换会话再换回来：位置仍对（A→B→A，两次恢复的会话和路径相同）', async t => {
  const state = { ...RESTORE, sessions: { ...RESTORE.sessions, s2: record() } };
  const { host, page, saved } = await start(t, { state, hold: true });
  host.session('s2');
  await flush();
  assert.equal(saved.at(-1).sessions.s1.scroll.top, 120, '换走时存的是待恢复的位置');
  host.session('s1');
  await flush();
  const [stale, current] = host.heldReads.slice(-2);
  await release(host, stale); // 第一次恢复的回答：代次不对，忽略
  assert.equal(pbody(page).scrollTop, 0);
  await release(host, current);
  assert.equal(pbody(page).scrollTop, 120);
});

test('恢复期间根目录换了位置：旧位置作废，再打开新文件从头开始', async t => {
  const { host, page } = await start(t, { state: RESTORE, hold: true });
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/B' });
  await flush();
  assert.ok(visible(page.tree), 'opened 清了');
  rowNamed(page, 'b.txt').dispatch('click');
  await flush();
  assert.equal(previewName(page), 'b.txt');
  const request = host.heldReads.at(-1);
  pbody(page).scrollTop = 33; // 假的滚动条不会自己归零：看位置有没有被设成旧的 120
  await release(host, request);
  assert.equal(pbody(page).scrollTop, 0, '从头开始，没有用旧文件的位置');
});

test('恢复的文件读取中关预览再开别的文件（或同一个文件）：新的从头开始', async t => {
  const { host, page } = await start(t, { state: RESTORE, hold: true });
  host.back(1);
  await flush();
  rowNamed(page, 'b.txt').dispatch('click');
  await flush();
  const [first, second] = host.heldReads;
  await release(host, first);
  await release(host, second);
  assert.equal(previewName(page), 'b.txt');
  assert.equal(pbody(page).scrollTop, 0);

  host.back(1);
  await flush();
  rowNamed(page, 'a.txt').dispatch('click');
  await flush();
  await release(host, host.heldReads.at(-1));
  assert.equal(pbody(page).scrollTop, 0, '关掉再开同一个文件也从头');
});

test('恢复的初次读取被 changed 作废：位置在接替它的那次读取里用上，之后才存成新位置', async t => {
  const { host, page, lastTop } = await start(t, { state: RESTORE, hold: true });
  host.changed();
  await flush();
  assert.equal(host.heldReads.length, 2);
  await release(host, host.heldReads[0]); // 作废的那次：结果丢掉，位置不能算用掉
  assert.equal(pbody(page).scrollTop, 0);
  assert.equal(lastTop(), 120, '位置还留着');
  await release(host, host.heldReads[1]);
  assert.equal(pbody(page).scrollTop, 120);
  pbody(page).scrollTop = 80;
  assert.equal(lastTop(), 80);
});

test('退出再进来：恢复到开着的文件，返回回到目录（正常按返回离开时预览已关，不恢复）', async t => {
  const first = await start(t);
  rowNamed(first.page, 'a.txt').dispatch('click');
  await flush();
  first.host.events.visibility(false);
  const state = first.saved.at(-1);
  assert.equal(state.sessions.s1.opened, 'a.txt');
  const second = await start(t, { state });
  assert.ok(visible(second.page.preview));
  second.host.back(1);
  await flush();
  assert.ok(visible(second.page.tree));

  second.host.events.visibility(false);
  const third = await start(t, { state: second.saved.at(-1) });
  assert.ok(visible(third.page.tree) && !visible(third.page.preview), '返回过的不再恢复到文件');
});

for (const platform of ['ios', 'mac']) {
  test(`恢复的读取失败不算用上（${platform}）：visibility: false 存的仍是原位置，重试成功后位置用上、之后才清；失败后关预览再开别的文件从头开始`, async t => {
    const { host, page, lastTop } = await start(t, { state: RESTORE, platform, back: platform === 'ios' ? true : undefined, session: false });
    host.failRead = { code: 'io_error', message: '读不了' };
    host.session();
    await flush();
    assert.match(page.preview.textContent, /读不到这个文件/);
    assert.equal(lastTop(), 120, '失败后存的仍是原来的位置');
    host.failRead = null;
    button(page.preview, '重试').dispatch('click');
    await flush();
    assert.equal(pbody(page).scrollTop, 120);
    assert.equal(pbody(page).scrollLeft, 7);
    pbody(page).scrollTop = 40;
    assert.equal(lastTop(), 40, '用上之后才清');
  });

  test(`恢复的读取失败后关预览再开别的文件：新文件从头开始，旧位置作废（${platform}）`, async t => {
    const { host, page } = await start(t, { state: RESTORE, platform, back: platform === 'ios' ? true : undefined, session: false });
    host.failRead = { code: 'io_error', message: '读不了' };
    host.session();
    await flush();
    host.failRead = null;
    if (platform === 'ios') host.back(1); else button(page.preview, '返回').dispatch('click');
    await flush();
    rowNamed(page, 'b.txt').dispatch(platform === 'ios' ? 'click' : 'dblclick');
    await flush();
    assert.equal(previewName(page), 'b.txt');
    assert.equal(pbody(page).scrollTop, 0);
  });
}
