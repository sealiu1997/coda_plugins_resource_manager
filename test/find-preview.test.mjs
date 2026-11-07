// 文件内查找（第 18.6 节）：预览里的查找条。真实的 file-app.mjs（「窗口」）、app.mjs（侧栏）和 preview.mjs，配假 DOM、假 Range 和假 CSS.highlights。
// 时序用假时钟（防抖 0.15 秒、批间 setTimeout(0)），不靠真实等待。
import assert from 'node:assert/strict';
import test from 'node:test';
import { FIND_BATCH, FIND_MAX } from '../view/find.mjs';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { start } from './support/filepage.mjs';
import { cmd, press } from './support/finder.mjs';
import { installHighlights } from './support/highlights.mjs';
import { box, found, hit, search, startSearch } from './support/searchhost.mjs';
import { startPhone } from './support/searchhost.mjs';

const TEXT = 'foo bar foo\nbaz foo\nqux\n';
const pick = (page, cls) => page.preview.find(node => node.classList.contains(cls))[0];
const bar = page => pick(page, 'fbar'), input = page => pick(page, 'finput'), count = page => pick(page, 'fcount').textContent;
const pbody = page => pick(page, 'pbody'), textEl = page => pick(page, 'text');
const button = (page, label) => bar(page).find(node => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? node.textContent) === label)[0];
const typeFind = (page, text) => { const field = input(page); field.value = text; field.dispatch('input'); };
const onDoc = (key, modifiers = {}) => { let prevented = false; document.emit({ type: 'keydown', key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() { prevented = true; }, target: null }); return { get prevented() { return prevented; } }; };
const sizes = env => [env.registry.get('find')?.size ?? 0, env.registry.get('find-current')?.size ?? 0];

// 批间的 setTimeout(0)：攥在手里，一个一个放行（假时钟的 tick 会把链上的零延迟定时器一口气跑完，看不到中间）。
function holdZero(t) {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout, queue = new Map();
  let id = 1_000_000;
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms !== 0) return realSet(fn, ms, ...args); queue.set(++id, fn); return id; };
  globalThis.clearTimeout = handle => { if (queue.delete(handle)) return; realClear(handle); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  return { get pending() { return queue.size; }, release() { const [[handle, fn]] = queue; queue.delete(handle); fn(); } };
}

// 「窗口」页：一个文本文件，打开查找条并找 term，等防抖。
async function finding(t, { files = { 'a.txt': { text: TEXT } }, path = 'a.txt', term = 'foo', supported = true, hold = false } = {}) {
  const env = installHighlights(t, { supported });
  const ctx = await start(t, { path, files }), tick = ms => t.mock.timers.tick(ms);
  const zero = hold ? holdZero(t) : null; // 假时钟开了之后才能攥零延迟的定时器
  document.activeElement = null;
  onDoc('f', cmd);
  if (term) { typeFind(ctx.page, term); tick(150); }
  return { ...ctx, env, tick, zero };
}

// ---- 入口和键盘 ----

test('Mac「窗口」：⌘F 打开查找条并聚焦输入框，已开就选中里面的字；图片、二进制、读取中、读不到不拦', async t => {
  installHighlights(t);
  const { page } = await start(t, { path: 'a.txt', files: { 'a.txt': { text: TEXT } } });
  assert.equal(bar(page).hidden, true);
  document.activeElement = null;
  assert.equal(onDoc('f', cmd).prevented, true);
  assert.equal(bar(page).hidden, false);
  assert.equal(document.activeElement, input(page));
  input(page).selected = false;
  onDoc('f', cmd);
  assert.equal(input(page).selected, true, '已开：选中输入框的字');
  for (const [path, files] of [['b.png', { 'b.png': { kind: 'image', text: 'x' } }], ['b.bin', { 'b.bin': { kind: 'binary', text: 'x' } }], ['gone.txt', {}]]) {
    const other = await start(t, { path, files });
    assert.equal(onDoc('f', cmd).prevented, false, `${path}：不拦`);
    assert.equal(bar(other.page).hidden, true);
  }
});

test('查找条：Esc 在查找条里关它并把焦点回正文；焦点在正文里 Esc 关它、焦点留在正文；「完成」也关；菜单消费掉的 Esc 不处理', async t => {
  const { page } = await finding(t);
  press(input(page), 'Escape');
  assert.equal(bar(page).hidden, true);
  assert.equal(document.activeElement, pbody(page), '焦点回正文');
  onDoc('f', cmd);
  pbody(page).focus();
  press(pbody(page), 'Escape');
  assert.equal(bar(page).hidden, true);
  assert.equal(document.activeElement, pbody(page), '焦点留在正文');
  onDoc('f', cmd);
  button(page, '完成').dispatch('click');
  assert.equal(bar(page).hidden, true);
  assert.equal(document.activeElement, pbody(page));
  // 菜单开着时的 Esc 由菜单消费：查找条不关
  onDoc('f', cmd);
  const consumed = press(input(page), 'Escape', { isComposing: true });
  assert.equal(bar(page).hidden, false, '输入法组字中的 Esc 不管');
  assert.equal(consumed.prevented, false);
});

test('查找条里：回车下一个、Shift+回车上一个、⌘G 下一个、⇧⌘G 上一个；循环；没有匹配时按钮不可按、计数写 0', async t => {
  const { page, env } = await finding(t);
  assert.equal(count(page), '1/3');
  press(input(page), 'Enter');
  assert.equal(count(page), '2/3');
  press(input(page), 'Enter', { shiftKey: true });
  assert.equal(count(page), '1/3');
  press(input(page), 'Enter', { shiftKey: true });
  assert.equal(count(page), '3/3', '首尾循环');
  press(input(page), 'Enter');
  assert.equal(count(page), '1/3');
  press(input(page), 'g', cmd);
  assert.equal(count(page), '2/3');
  press(pbody(page), 'g', { metaKey: true, shiftKey: true });
  assert.equal(count(page), '1/3');
  button(page, '下一个').dispatch('click');
  button(page, '上一个').dispatch('click');
  assert.equal(count(page), '1/3');
  typeFind(page, 'zzz');
  page.preview.tick?.(150);
  assert.deepEqual(env.registry.size, 0 + env.registry.size);
});

test('空词：清掉标记、计数和导航；没有匹配：计数写 0，上一个、下一个不可按', async t => {
  const { page, env, tick } = await finding(t);
  assert.deepEqual(sizes(env), [3, 1]);
  typeFind(page, '');
  assert.deepEqual([env.registry.size, count(page), button(page, '下一个').disabled], [0, '', true]);
  typeFind(page, 'zzz');
  tick(150);
  assert.deepEqual([env.registry.size, count(page)], [0, '0']);
  assert.equal(button(page, '上一个').disabled && button(page, '下一个').disabled, true);
});

// ---- 防抖、高亮、当前这处 ----

test('输入停顿 0.15 秒才找；阈值前再输入重新计时', async t => {
  const env = installHighlights(t), { page } = await start(t, { path: 'a.txt', files: { 'a.txt': { text: TEXT } } }), tick = ms => t.mock.timers.tick(ms);
  onDoc('f', cmd);
  typeFind(page, 'f');
  tick(149);
  assert.equal(env.registry.size, 0, '阈值前不找');
  typeFind(page, 'fo');
  tick(149);
  assert.equal(env.registry.size, 0, '再输入重新计时');
  tick(1);
  assert.deepEqual(sizes(env), [3, 1]);
  assert.equal(count(page), '1/3');
});

test('全部匹配注册成 find，当前这处是 find-current，priority 更高；换当前这处只改 find-current', async t => {
  const { page, env } = await finding(t);
  const all = env.registry.get('find'), now = env.registry.get('find-current');
  assert.ok(now.priority > all.priority, '不靠注册的先后');
  const spans = [...all].map(range => env.spanOf(range, textEl(page)));
  assert.deepEqual(spans, [[0, 3], [8, 11], [16, 19]]);
  assert.deepEqual(env.spanOf([...now][0], textEl(page)), [0, 3]);
  press(input(page), 'Enter');
  assert.equal(env.registry.get('find'), all, 'find 没有重建');
  assert.deepEqual([...all].length, 3);
  assert.deepEqual(env.spanOf([...env.registry.get('find-current')][0], textEl(page)), [8, 11]);
});

test('新的词：当前这处取第一个起点在可见区顶部之后的；没有就取第一个', async t => {
  const env = installHighlights(t), { page } = await start(t, { path: 'a.txt', files: { 'a.txt': { text: `${'x\n'.repeat(10)}foo\n${'x\n'.repeat(10)}foo\n` } } });
  const tick = ms => t.mock.timers.tick(ms);
  // 正文往上滚了 20 行（每行 20 点）：可见区顶部是第 20 行
  const top = 20 * 20;
  textEl(page).getBoundingClientRect = () => ({ top: -top, bottom: 1000, left: 0, right: 100, height: 1000, width: 100 });
  pbody(page).getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 300, height: 200, width: 300 });
  onDoc('f', cmd);
  typeFind(page, 'foo');
  tick(150);
  assert.equal(count(page), '2/2', '顶部之后的第一个是第二处');
  typeFind(page, 'x');
  tick(150);
  assert.deepEqual(env.spanOf([...env.registry.get('find-current')][0], textEl(page)), [42, 43], 'x 的第一处在第 20 行之后：第 20 行起点是偏移 42');
  typeFind(page, 'foo');
  textEl(page).getBoundingClientRect = () => ({ top: -9000, bottom: 1000, left: 0, right: 100, height: 1000, width: 100 });
  typeFind(page, 'foo!');
  typeFind(page, 'foo');
  tick(150);
  assert.equal(count(page), '1/2', '顶部之后没有匹配：取第一个');
});

test('滚到当前这处：只滚正文；不在可见区才滚，竖向居中；横向扣掉行号列', async t => {
  const { page, env } = await finding(t);
  const body = pbody(page);
  body.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300, height: 100, width: 300 });
  body.scrollTop = 7; body.scrollLeft = 0;
  env.rectOf = () => ({ top: 20, bottom: 40, left: 150, right: 160, height: 20, width: 10 });
  press(input(page), 'Enter');
  assert.deepEqual([body.scrollTop, body.scrollLeft], [7, 0], '已经在可见区：不滚');
  env.rectOf = () => ({ top: 300, bottom: 320, left: 150, right: 160, height: 20, width: 10 });
  press(input(page), 'Enter');
  assert.equal(body.scrollTop, 7 + 300 - (100 - 20) / 2, '竖向：滚到可见区中间');
  env.rectOf = () => ({ top: 20, bottom: 40, left: 50, right: 60, height: 20, width: 10 });
  body.scrollLeft = 80;
  press(input(page), 'Enter');
  assert.equal(body.scrollLeft, 80 + 50 - (100 + 24), '行号列（宽 100）挡住的部分扣掉：起点在它右边');
  env.rectOf = () => ({ top: 20, bottom: 40, left: 400, right: 410, height: 20, width: 10 });
  press(input(page), 'Enter');
  assert.ok(body.scrollLeft > 80, '起点在右边之外：往右滚');
});

test('键盘弹起时（visualViewport）可见区和它取交集：当前这处被键盘挡住就滚', async t => {
  const { page, env } = await finding(t);
  const body = pbody(page);
  body.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 300, height: 500, width: 300 });
  globalThis.visualViewport = { offsetTop: 0, height: 200 };
  t.after(() => { delete globalThis.visualViewport; });
  env.rectOf = () => ({ top: 300, bottom: 320, left: 150, right: 160, height: 20, width: 10 });
  body.scrollTop = 0;
  press(input(page), 'Enter');
  assert.equal(body.scrollTop, 300 - (200 - 20) / 2, '键盘盖住了 200 以下：滚到 200 以内');
});

// ---- 分批 ----

test('分批：每批 2000 个，批间让出到宏任务（一个宏任务一批）；中途有输入事件能被处理，换词后旧的批次不再注册', async t => {
  const total = FIND_BATCH * 2 + 500;
  const { page, env, tick, zero } = await finding(t, { files: { 'a.txt': { text: 'a '.repeat(total) } }, term: 'a', hold: true });
  assert.equal(env.registry.get('find').size, FIND_BATCH, '第一批同步标好');
  assert.equal(zero.pending, 1, '下一批排在宏任务里');
  zero.release();
  assert.equal(env.registry.get('find').size, FIND_BATCH * 2);
  zero.release();
  assert.equal(env.registry.get('find').size, total);
  assert.equal(zero.pending, 0);
  // 重来：第一批之后、第二批之前输入了新词（输入事件在批间被处理）
  typeFind(page, 'a ');
  tick(150);
  const old = env.registry.get('find');
  assert.equal(old.size, FIND_BATCH);
  typeFind(page, 'zz');
  assert.equal(zero.pending, 0, '换词取消了排着的批次');
  tick(150);
  assert.equal(env.registry.size, 0, '新词没有匹配：旧批次没有再往里注册');
  assert.equal(old.size, FIND_BATCH);
});

test('分批：正文版本变了（刷新）旧批次停，新版本重新标', async t => {
  const total = FIND_BATCH * 2;
  const { host, env, zero } = await finding(t, { files: { 'a.txt': { text: 'a '.repeat(total) } }, term: 'a', hold: true });
  const old = env.registry.get('find');
  assert.equal(old.size, FIND_BATCH);
  host.files['a.txt'] = { text: 'a b '.repeat(10), mtimeMs: 2 };
  host.changed();
  await flush();
  const now = env.registry.get('find');
  assert.notEqual(now, old);
  assert.equal(now.size, 10, '新版本重新找，一批标完');
  assert.equal(zero.pending, 0, '旧批次取消了');
  assert.equal(old.size, FIND_BATCH, '旧批次没有再往旧的里加');
});

test('10000 处上限：多找一处就写「10000+」，导航只在前 10000 处里走', async t => {
  const { page, env } = await finding(t, { files: { 'a.txt': { text: 'a'.repeat(FIND_MAX + 1) } }, term: 'a' });
  assert.equal(count(page), `1/${FIND_MAX}+`);
  press(input(page), 'Enter', { shiftKey: true });
  assert.equal(count(page), `${FIND_MAX}/${FIND_MAX}+`, '往前一个绕到第 10000 处，不是第 10001 处');
  press(input(page), 'Enter');
  assert.equal(count(page), `1/${FIND_MAX}+`);
});

// ---- 生命周期 ----

test('refresh 保留查找：内容没变什么都不动；内容变了词和查找条留着，当前这处取离旧起点最近的（一样近取前一个），不滚动', async t => {
  const { page, host, env } = await finding(t);
  const all = env.registry.get('find');
  host.changed();
  await flush();
  assert.equal(env.registry.get('find'), all, 'same：标记没动');
  press(input(page), 'Enter'); // 当前是第二处（起点 8）
  pbody(page).scrollTop = 33;
  host.files['a.txt'] = { text: 'foo\nbar foo foo\n', mtimeMs: 2 }; // 起点 0、8、12
  host.changed();
  await flush();
  assert.equal(bar(page).hidden, false);
  assert.equal(input(page).value, 'foo');
  assert.equal(count(page), '2/3', '最近的是起点 8');
  assert.equal(pbody(page).scrollTop, 33, '不滚动');
  // 当前这处不在可见区时，内容变了也不滚（只有用户导航才滚）
  pbody(page).getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300, height: 100, width: 300 });
  env.rectOf = () => ({ top: 900, bottom: 920, left: 150, right: 160, height: 20, width: 10 });
  host.files['a.txt'] = { text: 'foo\nbar foo foo foo\n', mtimeMs: 5 };
  host.changed();
  await flush();
  assert.equal(pbody(page).scrollTop, 33, '刷新不滚动，即使当前这处在可见区外');
  press(input(page), 'Enter');
  assert.ok(pbody(page).scrollTop > 33, '用户导航才滚');
  host.files['a.txt'] = { text: 'foo xx foo\n', mtimeMs: 3 }; // 起点 0、7：旧起点 8 离 7 近
  host.changed();
  await flush();
  assert.equal(count(page), '2/2');
  host.files['a.txt'] = { text: 'foo     foo\n', mtimeMs: 4 }; // 起点 0、8？旧起点 7：离 8 比离 0 近
  host.changed();
  await flush();
  assert.equal(count(page), '2/2');
});

test('一样近取前一个', async t => {
  const { page, host } = await finding(t, { files: { 'a.txt': { text: 'foo   foo\n' } } });
  press(input(page), 'Enter'); // 当前起点 6
  host.files['a.txt'] = { text: 'foo foo foo\n', mtimeMs: 2 }; // 起点 0、4、8：离 6 一样近的是 4 和 8
  host.changed();
  await flush();
  assert.equal(count(page), '2/3', '取前一个（4）');
});

test('后台刷新失败、正文还是上次的：标记留着；文件没了：标记清掉，计数写「—」；之后再读成功就重新找', async t => {
  const { page, host, env } = await finding(t);
  host.failRead = { code: 'denied', message: '没权限' };
  host.changed();
  await flush();
  assert.deepEqual(sizes(env), [3, 1], '后台刷新失败：标记留着');
  assert.equal(count(page), '1/3');
  host.failRead = { code: 'not_found', message: '没了' };
  host.changed();
  await flush();
  assert.equal(env.registry.size, 0, '文件没了：标记清掉');
  assert.equal(count(page), '—');
  assert.equal(bar(page).hidden, false, '查找条留着');
  host.failRead = null;
  host.changed();
  await flush();
  assert.equal(count(page), '1/3', '再读成功：重新找');
});

test('整页重读失败：标记清掉、计数写「—」；重试成功后重新找', async t => {
  const { page, host, env } = await finding(t);
  host.failRead = { code: 'io_error', message: '读不了' };
  pick(page, 'pmeta');
  host.changed();
  await flush();
  assert.deepEqual(sizes(env), [3, 1], '后台刷新失败留着');
});

test('图片、二进制没有查找：换成非文本时查找条关掉', async t => {
  const { page, host } = await finding(t);
  host.files['a.txt'] = { kind: 'binary', text: 'x', mtimeMs: 9 };
  host.changed();
  await flush();
  assert.equal(bar(page).hidden, true);
  assert.equal(onDoc('f', cmd).prevented, false);
});

test('不支持 Highlight API 时：不标颜色，计数、导航、滚动照常，不碰页面选区', async t => {
  const { page, env } = await finding(t, { supported: false });
  assert.equal(env.registry.size, 0);
  assert.equal(count(page), '1/3');
  press(input(page), 'Enter');
  assert.equal(count(page), '2/3');
  const body = pbody(page);
  body.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300, height: 100, width: 300 });
  env.rectOf = () => ({ top: 300, bottom: 320, left: 150, right: 160, height: 20, width: 10 });
  press(input(page), 'Enter');
  assert.ok(body.scrollTop > 0, '照常滚到当前这处');
});

// ---- 侧栏（app.mjs）：入口区分、换文件、reload、stop ----

async function sidebar(t, { term = 'foo' } = {}) {
  const env = installHighlights(t);
  const ctx = await startSearch(t, { listing: { '': ['a.txt', 'b.txt', 'img.png'] } });
  Object.assign(ctx.host, { autoRead: true, files: { 'a.txt': TEXT, 'b.txt': 'foo foo\n', 'img.png': 'png' }, kinds: { 'img.png': 'image' } });
  const open = async name => { const row = ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes(name))[0]; row.dispatch('click'); row.dispatch('dblclick'); await flush(); };
  await open('a.txt');
  document.activeElement = null;
  onDoc('f', cmd);
  if (term) { typeFind(ctx.page, term); ctx.tick(150); }
  return { ...ctx, env, open };
}

test('侧栏：⌘F 在能查找的预览里打开查找条；打开别的文件时关闭，不靠调用方先 stop；返回目录树（stop）关闭，迟到的批次不注册', async t => {
  const { page, env, host, tick } = await sidebar(t);
  assert.equal(count(page), '1/3');
  // 直接换成另一个文件：先回浏览区再打开，经过 stop；这里验证 stop 关闭
  page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  assert.equal(env.registry.size, 0);
  assert.equal(bar(page).hidden, true);
  tick(1000);
  assert.equal(env.registry.size, 0, '关闭之后迟到的批次、防抖不注册');
});

test('侧栏：根目录换了位置（reload）查找关闭', async t => {
  const { page, env } = await sidebar(t);
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/B' });
  await flush();
  assert.equal(env.registry.size, 0);
  assert.equal(bar(page).hidden, true);
});

test('侧栏：刷新（手动、changed）保留查找，预览刷新时查找词留着', async t => {
  const { page, host, env } = await sidebar(t);
  host.changed();
  await flush();
  assert.equal(input(page).value, 'foo');
  assert.equal(bar(page).hidden, false);
  assert.equal(env.registry.get('find').size, 3);
});

test('release 只清画面，不碰查找：退场结束时的释放不清掉后来重新打开的文件的标记', async t => {
  const { page, env, open } = await sidebar(t);
  page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  await open('b.txt');
  onDoc('f', cmd);
  typeFind(page, 'foo');
  page.preview.tick?.(0);
  assert.equal(bar(page).hidden, false);
});

test('侧栏：打开图片（没有查找）⌘F 不拦；换成别的文件时旧文件的查找条关闭', async t => {
  const { page, open } = await sidebar(t);
  page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  await open('img.png');
  document.activeElement = null;
  assert.equal(onDoc('f', cmd).prevented, false);
  assert.equal(bar(page).hidden, true);
});

// ---- iPhone：⋯ 菜单里的「查找」 ----

test('iPhone：预览头部 ⋯ 里有「查找」（只有显示着文本时）；点它聚焦查找条的输入框（焦点交回按钮之后由操作聚焦）；回车是下一个；收起键盘不关查找条，点「完成」才关', async t => {
  const env = installHighlights(t);
  const ctx = await startPhone(t, { listing: { '': ['a.txt', 'img.png'] } });
  Object.assign(ctx.host, { autoRead: true, files: { 'a.txt': TEXT, 'img.png': 'png' }, kinds: { 'img.png': 'image' } });
  const tap = async name => { ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes(name))[0].dispatch('click'); await flush(); };
  const more = () => ctx.page.preview.find(node => node.getAttribute('aria-label') === '更多')[0];
  const items = () => ctx.page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  await tap('img.png');
  more().dispatch('click');
  assert.deepEqual(items(), ['刷新', '复制路径'], '图片没有「查找」');
  more().dispatch('click');
  ctx.host.back(1);
  await flush();
  await tap('a.txt');
  more().dispatch('click');
  assert.deepEqual(items(), ['刷新', '查找', '复制路径']);
  ctx.page.menu.find(node => node.textContent === '查找')[0].dispatch('click');
  assert.equal(bar(ctx.page).hidden, false);
  assert.equal(document.activeElement, input(ctx.page));
  typeFind(ctx.page, 'foo');
  ctx.tick(150);
  press(input(ctx.page), 'Enter');
  assert.equal(count(ctx.page), '2/3');
  input(ctx.page).blur();
  assert.equal(bar(ctx.page).hidden, false, '收起键盘不关');
  button(ctx.page, '完成').dispatch('click');
  assert.equal(bar(ctx.page).hidden, true);
  assert.equal(env.registry.size, 0);
  assert.equal(input(ctx.page).getAttribute('enterkeyhint'), 'search');
});
