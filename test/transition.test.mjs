// iPhone 层级切换的过渡（第 17.6 节）：场景表逐行一条，另加退场期间的各种打断。真实的 app.mjs、preview.mjs、info.mjs，配假 DOM、脚本化的假模块和动画桩。
// 动画桩不自己走：测试调 anim.finish()（相当于播完）；强制结束用 cancel()，和页面里的 endRunning 一致。
import assert from 'node:assert/strict';
import test from 'node:test';
import { flush } from './support/fake.mjs';
import { Type } from '../view/protocol.mjs';
import { openTree, previewName, rowNamed } from './support/treehost.mjs';

const listing = { '': ['dir/', 'other/', 'a.txt', 'b.txt'], dir: ['inner/', 'x.txt'], 'dir/inner': ['deep.txt'], other: ['o.txt'] };
const record = (extra = {}) => ({ at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 }, ...extra });
const stateOf = (session, view = 'list') => ({ v: 1, seq: 1, hidden: false, view, sessions: session ? { s1: session } : {} });
const body = page => page.grid.find(node => node.classList.contains('gbody'))[0];
const pbody = page => page.preview.find(node => node.classList.contains('pbody'))[0];
const cell = (page, name) => page.grid.find(node => node.classList.contains('cell') && node.textContent === name)[0];
const touch = () => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60 });

async function start(t, { state, reduce = false, motion = { reduce }, session = true, hold = false, ...options } = {}) {
  const saved = [];
  const ctx = await openTree(t, { platform: 'ios', back: true, listing, state, motion, coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) }, ...options });
  Object.assign(ctx.host, { autoRead: true, holdReads: hold, files: { 'a.txt': 'AAA', 'b.txt': 'BBB', 'dir/x.txt': 'XXX', 'dir/inner/deep.txt': 'DEEP' } });
  Object.assign(body(ctx.page), { clientWidth: 300, clientHeight: 24 * 5 });
  if (session) { ctx.host.session('s1', '/A'); await flush(); }
  return { ...ctx, saved };
}
const PANES = ['tree', 'grid', 'preview', 'notice', 'info'];
const shown = page => PANES.filter(id => !page[id].classList.contains('off'));
const operable = page => PANES.filter(id => !page[id].inert);
const live = ctx => ctx.page.motion.animations.filter(anim => !anim.finished && !anim.canceled);
const finishAll = ctx => { for (const anim of live(ctx)) anim.finish(); };
const tap = async (ctx, name) => { rowNamed(ctx.page, name).dispatch('click'); await flush(); };
const forPane = (ctx, id) => ctx.page.motion.animations.filter(anim => anim.el === ctx.page[id]);
const text = node => node.textContent;
const previewText = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent ?? ''; // 正文（不含行号列）

// 长按 → 菜单里的「属性」
async function openInfo(ctx, name) {
  rowNamed(ctx.page, name).dispatch('pointerdown', touch());
  ctx.tick(500);
  ctx.page.menu.find(node => node.textContent === '属性')[0].dispatch('click');
  await flush();
}

// ---- 场景表 ----

test('场景：浏览区 → 打开文件（轻点）：预览滑入在上、能操作；opened 设上、开始读；浏览区不释放，原样留着', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  const [deep] = forPane(ctx, 'preview'), [shallow] = forPane(ctx, 'tree');
  assert.deepEqual(deep.frames, { transform: ['translateX(100%)', 'translateX(0)'] }, '深层从右边滑入');
  assert.equal(deep.options.duration, 280);
  assert.deepEqual(shallow.frames.transform, ['translateX(0)', 'translateX(-25%)'], '浅层同时向左移一小段');
  assert.deepEqual(shallow.frames.filter, ['brightness(1)', 'brightness(.9)'], '稍微变暗');
  assert.deepEqual(shown(page), ['tree', 'preview'], '两层都看得见');
  assert.deepEqual(operable(page), ['preview'], '目标页立刻能操作，离开的那层 inert');
  assert.ok(page.tree.classList.contains('leaving') && page.tree.classList.contains('layer') && page.preview.classList.contains('layer'), '两层都不透明，离开的那层不接指针');
  assert.equal(host.reads().length, 1, '预览开始读');
  assert.equal(previewName(page), 'a.txt');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['preview'], '结束后只有一层可见');
  assert.equal(page.tree.classList.contains('layer') || page.tree.classList.contains('leaving') || page.preview.classList.contains('layer'), false);
  assert.ok(rowNamed(page, 'a.txt'), '浏览区的内容原样留着，没有释放');
});

test('场景：预览 → 返回（系统返回）：预览滑出、浏览区能操作；opened 清掉、预览立即停止；退场结束时释放预览', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  assert.equal(previewText(page), 'AAA');
  const before = ctx.page.motion.animations.length;
  host.back(1);
  await flush();
  const added = ctx.page.motion.animations.slice(before);
  const deep = added.find(anim => anim.el === page.preview), shallow = added.find(anim => anim.el === page.tree);
  assert.deepEqual(deep.frames, { transform: ['translateX(0)', 'translateX(100%)'] }, '深层向右滑出');
  assert.deepEqual(shallow.frames.transform, ['translateX(-25%)', 'translateX(0)'], '返回时完全反过来');
  assert.deepEqual(shown(page), ['tree', 'preview'], '退场期间旧页还在，不是空白');
  assert.deepEqual(operable(page), ['tree'], '浏览区能操作');
  assert.equal(previewText(page), 'AAA', '退场期间旧页内容还在');
  assert.ok(page.preview.classList.contains('leaving'));
  host.changed();
  await flush();
  assert.equal(host.reads().length, 1, '已停止的预览不再读');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(previewText(page), '', '退场结束时释放');
});

test('场景：浏览区 → 属性页（长按菜单「属性」）：属性页滑入、能操作；开始读；浏览区不释放', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await openInfo(ctx, 'a.txt');
  const [deep] = forPane(ctx, 'info');
  assert.deepEqual(deep.frames, { transform: ['translateX(100%)', 'translateX(0)'] });
  assert.deepEqual(shown(page), ['tree', 'info']);
  assert.deepEqual(operable(page), ['info']);
  assert.equal((await host.requests(Type.STAT)).length, 1, '属性页开始读');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['info']);
  assert.ok(rowNamed(page, 'a.txt'));
});

test('场景：属性页 → 返回：属性页滑出、浏览区能操作；立即停止；退场结束时释放属性页', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await openInfo(ctx, 'a.txt');
  const [stat] = await host.requests(Type.STAT);
  host.answer(stat, { kind: 'file', size: 3, mtimeMs: 1, birthtimeMs: 1, mode: 0o644 });
  await flush();
  finishAll(ctx);
  assert.ok(text(page.info).includes('完整路径'), '属性已显示');
  host.back(1);
  await flush();
  assert.deepEqual(shown(page), ['tree', 'info']);
  assert.deepEqual(operable(page), ['tree']);
  assert.ok(text(page.info).includes('完整路径'), '退场期间旧页内容还在');
  host.changed();
  await flush();
  assert.equal((await host.requests(Type.STAT)).length, 1, '已停止的属性页 changed 不再取属性');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(text(page.info), '', '退场结束时释放');
});

test('场景：图标视图子目录里的预览，一次退几级（steps 为 2）：只播一次返回过渡、不叠目录淡入；网格直接是目标层', async t => {
  const state = stateOf(record({ cwd: 'dir/inner', root: '/A', opened: 'dir/inner/deep.txt' }), 'icons');
  const ctx = await start(t, { state });
  const { page, host } = ctx;
  assert.deepEqual(shown(page), ['preview']);
  const before = ctx.page.motion.animations.length;
  host.back(2);
  await flush();
  const added = ctx.page.motion.animations.slice(before);
  assert.equal(added.length, 2, '预览滑出加网格移回：只有这一对');
  assert.deepEqual(added.map(anim => anim.el), [page.preview, page.grid]);
  assert.deepEqual(operable(page), ['grid']);
  assert.equal(host.calls.back.at(-1).join('/'), 'A', '退到 dir：声明的路径只剩根目录名');
  assert.ok(cell(page, 'x.txt') && cell(page, 'inner'), '网格直接显示目标层（dir）');
  finishAll(ctx);
  assert.equal(ctx.page.motion.animations.filter(anim => anim.el.classList.contains('gwin')).length, 0, '没有目录淡入');
  assert.equal(previewText(page), '');
});

test('场景：退场还没结束又打开（同一个文件）：上一个动画立即结束到终点，新的深层在上能操作；释放比对打开次数，不把新打开的清掉', async t => {
  const ctx = await start(t, { hold: true });
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  const first = host.heldReads[0];
  host.back(1);
  await flush();
  const leaving = live(ctx);
  assert.equal(leaving.length, 2);
  await tap(ctx, 'a.txt');
  assert.ok(leaving.every(anim => anim.canceled), '上一个动画结束到终点');
  const fresh = live(ctx);
  assert.equal(fresh.length, 2, '新的一对');
  assert.deepEqual(operable(page), ['preview']);
  assert.deepEqual(shown(page), ['tree', 'preview']);
  assert.equal(host.heldReads.length, 2, '重新读');
  assert.equal(page.preview.find(node => node.classList.contains('pmeta'))[0].textContent, '读取中…', '旧动画的释放没有擦掉新打开的状态（比对打开次数）');
  await (async () => { host.release(first); await flush(); })();
  assert.equal(previewText(page), '', '作废的第一次读取不显示');
  host.release(host.heldReads[1]);
  await flush();
  assert.equal(previewText(page), 'AAA', '新的读取读完显示');
  finishAll(ctx);
  assert.equal(previewText(page), 'AAA', '旧动画的释放没有清掉新打开的');
  assert.deepEqual(shown(page), ['preview']);
});

test('场景：退场没结束又打开别的文件、又打开属性页：都只留最新的一层', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  host.back(1);
  await flush();
  await tap(ctx, 'b.txt');
  assert.equal(previewName(page), 'b.txt');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['preview']);
  assert.equal(previewText(page), 'BBB');
  host.back(1);
  await flush();
  await openInfo(ctx, 'a.txt');
  finishAll(ctx);
  assert.deepEqual(shown(page), ['info']);
  assert.equal(previewText(page), '', '预览在上一次退场结束时已经释放');
});

test('场景：过渡中换会话：动画立即结束，停止并立即释放，没有新的过渡', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  host.back(1);
  await flush();
  const running = live(ctx);
  const total = ctx.page.motion.animations.length;
  host.session('s2', '/B');
  await flush();
  assert.ok(running.every(anim => anim.canceled), '动画结束');
  assert.equal(ctx.page.motion.animations.length, total, '换会话不播');
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(previewText(page), '', '立即释放');
});

test('场景：过渡中换根目录：动画立即结束，意图清掉', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  const running = live(ctx);
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/other' });
  await flush();
  assert.ok(running.every(anim => anim.canceled));
  assert.deepEqual(shown(page), ['tree'], '换根目录：回到浏览区');
  assert.equal(live(ctx).length, 0);
  assert.equal(previewText(page), '');
});

test('场景：过渡中 changed、刷新：过渡不变，已停止的那层不再读', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  host.back(1);
  await flush();
  const running = live(ctx);
  host.changed();
  await flush();
  assert.ok(running.every(anim => !anim.canceled && !anim.finished), '过渡没被打断');
  assert.equal(host.reads().length, 1);
  assert.deepEqual(shown(page), ['tree', 'preview']);
});

// ---- 其余规则 ----

test('快速打开再返回、连续返回：不留下两层都可见', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  for (let i = 0; i < 3; i++) {
    await tap(ctx, 'a.txt');
    host.back(1);
    await flush();
    host.back(1); // 已经在最上层：什么都不退
    await flush();
  }
  finishAll(ctx);
  assert.deepEqual(shown(page), ['tree']);
  assert.deepEqual(operable(page), ['tree']);
  assert.equal(previewText(page), '');
  assert.equal(live(ctx).length, 0);
});

test('不是用户操作不播：恢复状态、changed 刷新', async t => {
  const state = stateOf(record({ opened: 'a.txt', root: '/A' }));
  const ctx = await start(t, { state });
  assert.equal(ctx.page.motion.animations.length, 0, '恢复到预览：不播');
  assert.deepEqual(shown(ctx.page), ['preview']);
  ctx.host.changed();
  await flush();
  assert.equal(ctx.page.motion.animations.length, 0, 'changed 刷新不播');
});

test('返回时旧页内容到动画结束才清；慢读的文件返回后再打开同一个文件，能读完显示', async t => {
  const ctx = await start(t, { hold: true });
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  const slow = host.heldReads[0];
  finishAll(ctx);
  host.back(1);
  await flush();
  await tap(ctx, 'a.txt');
  host.release(slow);
  await flush();
  host.release(host.heldReads.at(-1));
  await flush();
  finishAll(ctx);
  assert.equal(previewText(page), 'AAA');
});

test('过渡中 saveNow 存的位置正确：返回期间（预览已停止）存的是 0，打开了还没读回来的存待恢复的位置', async t => {
  const state = stateOf(record({ opened: 'a.txt', root: '/A', scroll: { tree: 0, top: 77, left: 5 } }));
  const ctx = await start(t, { state, hold: true });
  const { page, host, saved } = ctx;
  host.events.visibility(false);
  assert.equal(saved.at(-1).sessions.s1.scroll.top, 77, '恢复的位置还没用上：存它，不存 0');
  host.release(host.heldReads[0]);
  await flush();
  pbody(page).scrollTop = 40;
  host.back(1);
  await flush();
  host.events.visibility(false);
  const last = saved.at(-1).sessions.s1;
  assert.equal(last.opened, null);
  assert.equal(last.scroll.top, 0, '返回期间旧页还在，预览已停止：位置按 0 算，和关闭后清空正文一致');
});

test('慢的 preview.open 在动画之后才读完：内容和位置都对', async t => {
  const ctx = await start(t, { hold: true });
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  assert.equal(previewText(page), '', '还在读');
  host.release(host.heldReads[0]);
  await flush();
  assert.equal(previewText(page), 'AAA');
});

// ---- 目录淡入（图标视图）----

const iconsState = () => stateOf(record(), 'icons');
const winOf = page => page.grid.find(node => node.classList.contains('gwin'))[0];
const fades = ctx => ctx.page.motion.animations.filter(anim => anim.el === winOf(ctx.page));

test('图标视图进入目录：只淡入，不滑动；内容到了才播，不给「正在读取」播', async t => {
  const ctx = await start(t, { state: iconsState() });
  const { page, host } = ctx;
  host.held.add('dir');
  cell(page, 'dir').dispatch('click');
  await flush();
  assert.equal(ctx.page.motion.animations.length, 0, '还在读取：不播');
  assert.ok(page.grid.find(node => node.classList.contains('gnote'))[0], '显示正在读取');
  host.held.delete('dir');
  host.answer(host.heldLists[0], { entries: [{ name: 'x.txt', kind: 'file' }, { name: 'inner', kind: 'dir' }], nextCursor: null });
  await flush();
  assert.equal(fades(ctx).length, 1, '内容到了才播');
  assert.deepEqual(fades(ctx)[0].frames, [{ opacity: 0 }, { opacity: 1 }]);
  assert.equal(fades(ctx)[0].options.duration, 150);
  assert.equal(ctx.page.motion.animations.length, 1, '没有滑动');
});

test('图标视图进出目录：目录已在缓存里就在这次 render 播；头部返回键退一层也只淡入', async t => {
  const ctx = await start(t, { state: iconsState() });
  const { page } = ctx;
  cell(page, 'dir').dispatch('click');
  await flush();
  assert.equal(fades(ctx).length, 1);
  const back = page.grid.find(node => node.getAttribute('aria-label') === '返回')[0];
  assert.equal(back, undefined, 'iPhone 用原生返回，没有页内返回键');
  ctx.host.back(1);
  await flush();
  assert.equal(fades(ctx).length, 2, '退一层（已缓存）：淡入');
  assert.equal(ctx.page.motion.animations.length, 2, '只有淡入，没有滑动');
  cell(page, 'dir').dispatch('click');
  await flush();
  assert.equal(fades(ctx).length, 3, '再进已缓存的目录：当次 render 播');
});

test('目录读取失败也播（显示原因）；等待期间换了目录就不播', async t => {
  const ctx = await start(t, { state: iconsState() });
  const { host } = ctx;
  host.failing.add('dir');
  cell(ctx.page, 'dir').dispatch('click');
  await flush();
  assert.equal(fades(ctx).length, 1, '读取失败：显示原因，也播');
  host.back(1);
  await flush();
  const total = ctx.page.motion.animations.length;
  host.held.add('other');
  cell(ctx.page, 'other').dispatch('click');
  await flush();
  host.back(1); // 内容没到就退回
  await flush();
  host.held.delete('other');
  host.answer(host.heldLists[0], { entries: [], nextCursor: null });
  await flush();
  assert.equal(ctx.page.motion.animations.length, total + 1, '只有退回根目录的那一次淡入，other 的内容到了也不补播');
});

// ---- 减弱动态效果 ----

test('减弱动态效果：没有任何过渡，面板直接切换，停止和释放同时做', async t => {
  const ctx = await start(t, { reduce: true });
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  assert.equal(ctx.page.motion.animations.length, 0);
  assert.deepEqual(shown(page), ['preview']);
  assert.equal(previewText(page), 'AAA');
  host.back(1);
  await flush();
  assert.equal(ctx.page.motion.animations.length, 0);
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(previewText(page), '', '没有退场：立即释放');
});

test('减弱动态效果：图标视图进出目录也没有淡入', async t => {
  const ctx = await start(t, { state: iconsState(), reduce: true });
  cell(ctx.page, 'dir').dispatch('click');
  await flush();
  assert.equal(ctx.page.motion.animations.length, 0);
});

test('设置在动画进行中改变：正在播的动画结束到终点', async t => {
  const ctx = await start(t);
  const { page } = ctx;
  await tap(ctx, 'a.txt');
  const running = live(ctx);
  assert.equal(running.length, 2);
  ctx.page.motion.set(true);
  assert.ok(running.every(anim => anim.canceled));
  assert.deepEqual(shown(page), ['preview']);
});

test('动画中旋转或改变尺寸：结束到终点', async t => {
  const ctx = await start(t);
  const { page } = ctx;
  await tap(ctx, 'a.txt');
  const running = live(ctx);
  globalThis.window.emit({ type: 'resize' });
  assert.ok(running.every(anim => anim.canceled));
  assert.deepEqual(shown(page), ['preview']);
});

test('Mac 没有过渡：停止和释放同时做，行为不变', async t => {
  const ctx = await start(t, { platform: 'mac', back: false });
  const { page } = ctx;
  rowNamed(page, 'a.txt').dispatch('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse' });
  rowNamed(page, 'a.txt').dispatch('dblclick');
  await flush();
  assert.equal(ctx.page.motion.animations.length, 0);
  assert.equal(previewText(page), 'AAA');
});

test('意图只记一个：goBack 退预览加一层目录时只播预览的返回，不被目录淡入覆盖（意图由最外层记）', async t => {
  const state = stateOf(record({ cwd: 'dir', root: '/A', opened: 'dir/x.txt' }), 'icons');
  const ctx = await start(t, { state });
  const before = ctx.page.motion.animations.length;
  ctx.host.back(2);
  await flush();
  const added = ctx.page.motion.animations.slice(before);
  assert.equal(added.length, 2);
  assert.ok(added.every(anim => anim.options.duration === 280), '都是 280 毫秒的滑动，没有 150 毫秒的淡入');
  finishAll(ctx);
  assert.equal(fades(ctx).length, 0);
});

// ---- 滑动期间整页不响应点按：页面加 html.moving，CSS 的 pointer-events: none 盖住整页（真实的点按在 harness 里用触摸验证）----
const moving = () => globalThis.document.documentElement.classList.contains('moving');

test('滑动期间（打开、返回都算）html 带 .moving，播完去掉', async t => {
  const ctx = await start(t);
  assert.equal(moving(), false);
  await tap(ctx, 'a.txt');
  assert.equal(moving(), true, '打开的滑动期间');
  finishAll(ctx);
  assert.equal(moving(), false, '结束后目标页能点');
  ctx.host.back(1);
  await flush();
  assert.equal(moving(), true, '返回的滑动期间');
  finishAll(ctx);
  assert.equal(moving(), false);
});

test('强制结束也去掉 .moving：又打开、换会话、换根目录、resize、设置改成减弱', async t => {
  const cases = {
    又打开: async ({ host, page }, ctx) => { finishAll(ctx); host.back(1); await flush(); await tap(ctx, 'b.txt'); assert.equal(moving(), true, '新的滑动'); finishAll(ctx); },
    换会话: async ({ host }) => host.session('s2', '/B'),
    换根目录: async ({ page, host }) => { page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/other' }); await flush(); },
    resize: async () => globalThis.window.emit({ type: 'resize' }),
    减弱: async ({ page }) => page.motion.set(true),
  };
  for (const [name, force] of Object.entries(cases)) {
    const ctx = await start(t);
    await tap(ctx, 'a.txt');
    assert.equal(moving(), true, `${name}：滑动中`);
    await force(ctx, ctx);
    await flush();
    assert.equal(moving(), false, `${name}：强制结束后去掉`);
  }
});

test('目录淡入期间页面照常能点（不加 .moving）', async t => {
  const ctx = await start(t, { state: stateOf(record(), 'icons') });
  cell(ctx.page, 'dir').dispatch('click');
  await flush();
  assert.equal(fades(ctx).length, 1);
  assert.equal(moving(), false);
});

test('滑动期间收到 back 事件照常处理：上一个动画先结束到终点，再按新的返回处理', async t => {
  const ctx = await start(t);
  await tap(ctx, 'a.txt');
  const opening = live(ctx);
  ctx.host.back(1);
  await flush();
  assert.ok(opening.every(anim => anim.canceled), '打开的动画结束');
  assert.equal(moving(), true, '新的返回在播');
  assert.deepEqual(operable(ctx.page), ['tree']);
  finishAll(ctx);
  assert.equal(moving(), false);
  assert.deepEqual(shown(ctx.page), ['tree']);
});

// ---- 动画被取消（浏览器自己取消只触发 cancel，不触发 finish）----
test('取消一条动画、另一条正常完成：过渡结束，.moving 去掉，只剩一层可见，释放一次', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  host.back(1);
  await flush();
  const [first, second] = live(ctx);
  first.cancel();
  assert.equal(moving(), false);
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(previewText(page), '', '释放');
  assert.ok(second.canceled, '其余动画被结束');
  second.finish(); // 迟到的 finish：什么都不做
  assert.equal(moving(), false);
  assert.deepEqual(shown(page), ['tree']);
});

test('两条都被取消：只结束一次，释放一次', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  host.back(1);
  await flush();
  let releases = 0;
  const body = page.preview.find(node => node.classList.contains('pbody'))[0];
  const real = body.replaceChildren.bind(body);
  body.replaceChildren = (...nodes) => { releases++; return real(...nodes); };
  for (const anim of live(ctx)) anim.cancel();
  assert.equal(moving(), false);
  assert.deepEqual(shown(page), ['tree']);
  assert.equal(releases, 1, '释放只执行一次');
});

test('打开时被取消：.moving 去掉，浏览区 .off，预览是唯一一层', async t => {
  const ctx = await start(t);
  const { page } = ctx;
  await tap(ctx, 'a.txt');
  live(ctx)[1].cancel();
  assert.equal(moving(), false);
  assert.deepEqual(shown(page), ['preview']);
  assert.equal(previewText(page), 'AAA', '没有释放新打开的');
});

test('返回被取消之后又打开过的不释放：取消发生在重新打开之后的那次过渡', async t => {
  const ctx = await start(t, { hold: true });
  const { page, host } = ctx;
  await tap(ctx, 'a.txt');
  finishAll(ctx);
  host.back(1);
  await flush();
  const leaving = live(ctx);
  await tap(ctx, 'a.txt');
  host.release(host.heldReads.at(-1));
  await flush();
  assert.ok(leaving.every(anim => anim.canceled));
  assert.equal(previewText(page), 'AAA', '新打开的没被旧过渡的释放清掉');
});

test('目录淡入被取消：过渡结束（不留着 running），下一次淡入照常播', async t => {
  const ctx = await start(t, { state: stateOf(record(), 'icons') });
  cell(ctx.page, 'dir').dispatch('click');
  await flush();
  fades(ctx)[0].cancel();
  assert.equal(moving(), false);
  ctx.host.back(1);
  await flush();
  assert.equal(fades(ctx).length, 2);
  assert.ok(!fades(ctx)[1].canceled);
});
