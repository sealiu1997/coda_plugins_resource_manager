// 文件名搜索（页面）：第 18.4 节的状态场景表每行一条，另加防抖、加粗、结果的选中、从结果打开再返回。
// 真实的 app.mjs，配假 DOM、脚本化的假模块（search 请求由测试自己回答）和假时钟。
import assert from 'node:assert/strict';
import test from 'node:test';
import { clickOn, cmd, doubleClick, press } from './support/finder.mjs';
import { flush } from './support/fake.mjs';
import { visible } from './support/dom.mjs';
import { pick } from './support/more.mjs';
import { box, cancels, found, hit, hitNamed, hitNames, hitRows, search, searchShown, searches, selectedHits, startPhone, startSearch, statusLine, type } from './support/searchhost.mjs';
import { rowNamed } from './support/treehost.mjs';

const rowsOf = ctx => ctx.page.tree.find(node => node.classList.contains('row') && node.classList.contains('entry'));
const more = ctx => ctx.host.events.toolbar({ id: 'more' }); // Mac 的原生「更多」按钮

// ---- 基本：输入、防抖、结果、状态行 ----

test('输入后停顿 0.3 秒才发；阈值前再输入重新计时，只发最后一个词；状态写「正在搜索…」', async t => {
  const ctx = await startSearch(t);
  type(ctx.page, 'a');
  ctx.tick(299);
  assert.equal((await searches(ctx.host)).length, 0, '阈值前不发');
  type(ctx.page, 'a.');
  ctx.tick(299);
  assert.equal((await searches(ctx.host)).length, 0, '再输入重新计时');
  assert.equal(searchShown(ctx.page), true, '有字时结果换掉目录树');
  assert.equal(statusLine(ctx.page), '正在搜索…');
  ctx.tick(1);
  const requests = await searches(ctx.host);
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].query, requests[0].hidden], ['a.', false]);
  ctx.host.answer(requests[0], found([hit('a.txt')]));
  await flush();
  assert.deepEqual(hitNames(ctx.page), ['a.txt']);
  assert.equal(statusLine(ctx.page), '共 1 个');
});

test('搜索词去掉首尾空白，全空白等于没有词：不发，回到目录树', async t => {
  const ctx = await startSearch(t);
  type(ctx.page, '   ');
  ctx.tick(300);
  assert.equal((await searches(ctx.host)).length, 0);
  assert.equal(searchShown(ctx.page), false);
  const request = await search(ctx, '  dir ');
  assert.equal(request.query, 'dir');
});

test('清空搜索词：马上回到目录树，在途请求取消（发 search_cancel），迟到的回答不画', async t => {
  const ctx = await startSearch(t);
  const request = await search(ctx, 'a');
  type(ctx.page, '');
  await flush();
  assert.equal(searchShown(ctx.page), false);
  assert.deepEqual((await cancels(ctx.host)).map(m => m.requestId), [request.requestId]);
  ctx.host.answer(request, found([hit('a.txt')]));
  await flush();
  assert.deepEqual(hitNames(ctx.page), [], '迟到的回答不提交');
  assert.equal(searchShown(ctx.page), false);
});

test('状态行：没有找到、共 N 个、六种停止原因的文案、N 项读不到、出错加重试', async t => {
  const ctx = await startSearch(t);
  const says = async (results, extra) => { await search(ctx, `q${Math.random()}`, results, extra); return statusLine(ctx.page); };
  assert.equal(await says([]), '没有找到');
  assert.equal(await says([hit('a.txt')]), '共 1 个');
  assert.equal(await says([hit('a.txt')], { stop: 'count' }), '结果太多，只显示先找到的 500 个');
  assert.equal(await says([hit('a.txt')], { stop: 'bytes' }), '结果太多，只显示一部分');
  assert.equal(await says([hit('a.txt')], { stop: 'items' }), '没搜完（超过 20 万项），只显示已找到的');
  assert.equal(await says([hit('a.txt')], { stop: 'time' }), '没搜完（超过 5 秒），只显示已找到的');
  assert.equal(await says([hit('a.txt')], { stop: 'queue' }), '没搜完（目录太多），只显示已找到的');
  assert.equal(await says([hit('a.txt')], { unreadable: 3 }), '共 1 个 · 3 项读不到');
  const request = await search(ctx, 'boom');
  ctx.host.answer(request, { error: { code: 'io_error', message: '读取失败' } });
  await flush();
  assert.equal(statusLine(ctx.page), '搜索失败：读取失败');
  const retry = ctx.page.search.find(node => node.tagName === 'BUTTON' && node.textContent === '重试')[0];
  assert.equal(retry.hidden, false);
  retry.dispatch('click');
  ctx.tick(300);
  assert.equal((await searches(ctx.host)).length > 0, true);
});

// ---- 结果的画法：加粗按结果自己的词，映射不出来就不加粗 ----

test('匹配的部分加粗；新结果到来之前旧结果留着，加粗用旧结果自己的词', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'READ', [hit('docs/README.md')]);
  const bold = () => hitRows(ctx.page)[0].find(node => node.tagName === 'B').map(node => node.textContent);
  assert.deepEqual(bold(), ['READ']);
  assert.equal(hitRows(ctx.page)[0].dataset.path, 'docs/README.md');
  type(ctx.page, 'me');
  await flush();
  assert.deepEqual(hitNames(ctx.page), ['README.md'], '旧结果留着');
  assert.deepEqual(bold(), ['READ'], '加粗仍用旧结果的词，不用输入框里的新词');
  assert.equal(statusLine(ctx.page), '正在搜索…');
});

test('加粗的位置映射：分解形式的名字、中文；映射不出来（变小写后长度变了）就不加粗，结果照常显示', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'café', [hit('Café.txt'), hit('中文café.md')]);
  const bolds = ctx.page.search.find(node => node.tagName === 'B').map(node => node.textContent);
  assert.deepEqual(bolds, ['Café', 'café']);
  await search(ctx, 'i', [hit('İx.txt')]);
  assert.deepEqual(hitNames(ctx.page), ['İx.txt'], '照常显示');
  assert.equal(ctx.page.search.find(node => node.tagName === 'B').length, 0, '不加粗');
});

test('每行：类型图标、名字、所在目录（Mac 在右侧，根目录下写「工作目录」）；iPhone 在第二行', async t => {
  for (const platform of ['mac', 'ios']) {
    const ctx = platform === 'mac' ? await startSearch(t) : await startPhone(t);
    await search(ctx, 'x', [hit('dir/x.txt'), hit('top.txt')]);
    const [first, second] = hitRows(ctx.page);
    const part = (node, cls) => node.find(child => child.classList.contains(cls))[0];
    assert.ok(part(first, 'ico'), '类型图标');
    assert.equal(part(first, 'chev'), undefined, '没有展开箭头的位置');
    assert.equal(part(platform === 'mac' ? first : first, platform === 'mac' ? 'meta' : 'sub').textContent, 'dir');
    assert.equal(part(second, platform === 'mac' ? 'meta' : 'sub').textContent, '工作目录');
  }
});

// ---- 结果的选中和操作 ----

test('结果的选中不改 model.selected 和目录树的选中；单击只切 .sel、不重画，真实双击节点不变', async t => {
  const ctx = await startSearch(t);
  await clickOn(rowNamed(ctx.page, 'a.txt'));
  await flush();
  assert.deepEqual(rowsOf(ctx).filter(node => node.classList.contains('sel')).map(node => node.dataset.path), ['a.txt']);
  await search(ctx, 'x', [hit('dir/x.txt'), hit('dir/y.txt')]);
  const node = hitNamed(ctx.page, 'dir/y.txt');
  clickOn(node);
  assert.deepEqual(selectedHits(ctx.page), ['dir/y.txt']);
  assert.equal(hitNamed(ctx.page, 'dir/y.txt'), node, '单击没有重画行');
  const treeSelected = () => rowsOf(ctx).filter(item => item.classList.contains('sel')).map(item => item.dataset.path);
  assert.deepEqual(treeSelected(), ['a.txt'], '目录树的选中没动');
  await doubleClick(ctx.page.search.find(item => item.classList.contains('shits'))[0], node);
});

test('Mac：双击或 ⌘↓ 打开文件：预览盖上来，结果的选中是刚打开的，目录树的选中不变；关预览回到结果', async t => {
  const ctx = await startSearch(t);
  Object.assign(ctx.host, { autoRead: true, files: { 'dir/x.txt': 'XX' } });
  clickOn(rowNamed(ctx.page, 'a.txt'));
  await search(ctx, 'x', [hit('dir/x.txt'), hit('dir/y.txt')]);
  const hits = ctx.page.search.find(node => node.classList.contains('shits'))[0];
  const node = hitNamed(ctx.page, 'dir/x.txt');
  await doubleClick(hits, node);
  assert.equal(visible(ctx.page.preview), true);
  assert.equal(visible(ctx.page.search), false, '结果被预览盖住');
  assert.equal(ctx.page.browse.classList.contains('off'), true);
  const rows = rowsOf(ctx);
  assert.deepEqual(rows.filter(item => item.classList.contains('sel')).map(item => item.dataset.path), ['a.txt'], '没有设 selected');
  // 关预览（头部返回）：回到结果，选中和滚动都在
  ctx.page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.search), true);
  assert.deepEqual(hitNames(ctx.page), ['x.txt', 'y.txt']);
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt'], '返回后结果的选中是刚打开的那个');
  assert.equal(document.activeElement === hits, true, '焦点回到结果');
});

test('Mac：单击选中后 ⌘↓ 打开；link、other 能选中、能右键，不能打开', async t => {
  const ctx = await startSearch(t);
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'to', [hit('to', 'link'), hit('dir/x.txt')]);
  clickOn(hitNamed(ctx.page, 'to'));
  assert.deepEqual(selectedHits(ctx.page), ['to']);
  const hits = ctx.page.search.find(node => node.classList.contains('shits'))[0];
  press(hits, 'ArrowDown', cmd);
  await flush();
  assert.equal(visible(ctx.page.preview), false, 'link 不能打开');
  clickOn(hitNamed(ctx.page, 'dir/x.txt'));
  press(hits, 'ArrowDown', cmd);
  await flush();
  assert.equal(visible(ctx.page.preview), true);
});

test('iPhone：轻点打开文件；打开时不设 selected', async t => {
  const ctx = await startPhone(t);
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.preview), true);
  assert.deepEqual(ctx.host.calls.open, [], '页内预览，不推入文件页');
});

test('行菜单（Mac 右键）：打开、添加到聊天、复制路径、在目录中显示、属性；链接和 other 没有打开和添加到聊天', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt'), hit('to', 'link')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const labels = () => ctx.page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(labels(), ['打开', '添加到聊天', '复制相对路径', '复制绝对路径', '在目录中显示', '属性']);
  assert.equal(ctx.page.menu.find(node => node.classList.contains('menu-path'))[0].textContent, 'dir/x.txt');
  hitNamed(ctx.page, 'to').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  assert.deepEqual(labels(), ['复制相对路径', '复制绝对路径', '在目录中显示', '属性']);
});

test('菜单开着时结果被换掉：再执行「打开」仍按打开菜单时那一行的路径', async t => {
  const ctx = await startSearch(t);
  Object.assign(ctx.host, { autoRead: true, files: { 'dir/x.txt': 'XX', 'other.txt': 'OO' } });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const open = ctx.page.menu.find(node => node.textContent === '打开')[0];
  await search(ctx, 'o', [hit('other.txt')]); // 结果换了（菜单留着，它的操作按路径做）
  assert.deepEqual(hitNames(ctx.page), ['other.txt']);
  open.dispatch('click');
  await flush();
  assert.equal(ctx.host.reads().at(-1).path, 'dir/x.txt', '仍打开原来那一行');
});

// ---- 场景表 ----

test('场景：换会话 — 搜索中：轮次加一、清防抖、发取消，迟到的成功和失败都作废；已有结果：词、结果、选中清空，关菜单', async t => {
  const ctx = await startSearch(t);
  // 搜索中（请求在途）
  const request = await search(ctx, 'a');
  ctx.host.session('s2', '/B');
  await flush();
  assert.equal(box(ctx.page).value, '', '搜索词清空');
  // connect() 先 link.reset：在途请求已经作废，search_cancel 无从发出，也无需发出（模块换会话时自己清槽）
  assert.equal((await cancels(ctx.host)).length, 0);
  ctx.host.answer(request, found([hit('a.txt')]));
  ctx.host.answer(request, { error: { code: 'io_error', message: 'x' } });
  await flush();
  assert.deepEqual(hitNames(ctx.page), []);
  assert.equal(searchShown(ctx.page), false);
  // 防抖等待中换会话：不会用新会话发旧词
  type(ctx.page, 'late');
  ctx.host.session('s3', '/C');
  ctx.tick(300);
  assert.equal((await searches(ctx.host)).filter(m => m.query === 'late').length, 0);
  // 已有结果：选中、菜单
  await search(ctx, 'x', [hit('dir/x.txt')]);
  clickOn(hitNamed(ctx.page, 'dir/x.txt'));
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(visible(ctx.page.menu), true);
  ctx.host.session('s4', '/D');
  await flush();
  assert.equal(visible(ctx.page.menu), false, '关菜单');
  assert.deepEqual([hitNames(ctx.page), selectedHits(ctx.page), box(ctx.page).value], [[], [], '']);
});

test('场景：换根目录（scope 变了，含 A→B→A）— 搜索词、结果清空，在途的作废', async t => {
  const ctx = await startSearch(t);
  const request = await search(ctx, 'a');
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/B' });
  await flush();
  assert.equal(box(ctx.page).value, '');
  ctx.host.answer(request, found([hit('a.txt')]));
  await flush();
  assert.deepEqual(hitNames(ctx.page), [], '旧根目录的回答不提交');
  await search(ctx, 'a', [hit('a.txt')]);
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.equal(box(ctx.page).value, '', 'A→B→A 也算换了');
  assert.deepEqual(hitNames(ctx.page), []);
});

test('场景：根目录暂不可用、scope 没变 — 搜索中取消、留搜索词；已有结果丢掉、留搜索词；就绪后重搜', async t => {
  const ctx = await startSearch(t);
  const request = await search(ctx, 'a');
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'gone', path: '/A' });
  await flush();
  assert.equal(box(ctx.page).value, 'a', '搜索词留着');
  assert.equal((await cancels(ctx.host)).length, 1, '在途的取消');
  ctx.host.answer(request, found([hit('a.txt')]));
  await flush();
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/A' });
  await flush();
  ctx.tick(300);
  const requests = await searches(ctx.host);
  assert.equal(requests.length, 2, '就绪后重搜');
  ctx.host.answer(requests.at(-1), found([hit('a.txt')]));
  await flush();
  assert.deepEqual(hitNames(ctx.page), ['a.txt']);
  // 已有结果时不可用：结果丢掉
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'preparing' });
  await flush();
  assert.equal(box(ctx.page).value, 'a');
  assert.deepEqual(hitNames(ctx.page), [], '丢结果');
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.equal(visible(ctx.page.notice), false);
});

test('场景：changed — 搜索中轮次加一、重新防抖后发，不会两次派发；已有结果留旧结果并重搜，目录模型照常刷新', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt')]);
  const lists = ctx.host.lists().length;
  ctx.host.changed();
  await flush();
  assert.ok(ctx.host.lists().length > lists, '目录模型照常刷新');
  assert.deepEqual(hitNames(ctx.page), ['x.txt'], '旧结果留着');
  assert.equal(statusLine(ctx.page), '正在搜索…');
  ctx.host.changed(); // 防抖等待中又 changed：重新计时，不会两次派发
  ctx.tick(299);
  assert.equal((await searches(ctx.host)).length, 1);
  ctx.tick(1);
  const requests = await searches(ctx.host);
  assert.equal(requests.length, 2);
  // 在途时 changed：在途的取消
  ctx.host.changed();
  await flush();
  assert.equal((await cancels(ctx.host)).length, 1, '在途的请求取消');
  ctx.tick(300);
  assert.equal((await searches(ctx.host)).length, 3);
});

test('场景：手动刷新 — 同 changed；预览刷新时查找词留着（第 2 步）', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt')]);
  more(ctx);
  pick(ctx.page, '刷新');
  await flush();
  assert.deepEqual(hitNames(ctx.page), ['x.txt'], '旧结果留着');
  ctx.tick(300);
  assert.equal((await searches(ctx.host)).length, 2, '重搜');
});

test('场景：显示隐藏文件 — 轮次加一，按新的 hidden 重发；重搜期间旧结果留着', async t => {
  const ctx = await startSearch(t);
  const first = await search(ctx, 'x', [hit('dir/x.txt')]);
  assert.equal(first.hidden, false);
  more(ctx);
  pick(ctx.page, '显示隐藏文件');
  await flush();
  ctx.tick(300);
  const requests = await searches(ctx.host);
  assert.deepEqual(requests.map(m => m.hidden), [false, true]);
  assert.deepEqual(hitNames(ctx.page), ['x.txt']);
});

test('场景：列表和图标切换 — 搜索词不变，结果仍是列表；不用浏览视图的选中', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt')]);
  clickOn(hitNamed(ctx.page, 'dir/x.txt'));
  more(ctx);
  pick(ctx.page, '图标');
  await flush();
  assert.equal(box(ctx.page).value, 'x');
  assert.equal(searchShown(ctx.page), true, '结果仍盖着');
  assert.equal(ctx.page.grid.classList.contains('off'), true);
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
  more(ctx);
  pick(ctx.page, '列表');
  await flush();
  assert.equal(searchShown(ctx.page), true);
});

test('场景：页面重建 — 搜索不恢复；保存的预览照常恢复，返回回到浏览', async t => {
  const first = await startSearch(t);
  Object.assign(first.host, { autoRead: true, files: { 'a.txt': 'AA' } });
  await search(first, 'a', [hit('a.txt')]);
  hitNamed(first.page, 'a.txt').dispatch('dblclick');
  await flush();
  first.tick(300);
  await flush();
  const state = first.saves.at(-1);
  assert.equal(state.sessions.s1.opened, 'a.txt', '预览保存了');
  assert.ok(!JSON.stringify(state).includes('"query"') && !JSON.stringify(state).includes('search'), '搜索词和结果不存进会话状态');
  const second = await startSearch(t, { state });
  assert.equal(box(second.page).value ?? '', '', '搜索框是空的');
  assert.equal(searchShown(second.page), false);
  assert.equal(visible(second.page.preview), true, '预览照常恢复');
  second.page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  assert.equal(visible(second.page.tree), true, '返回回到浏览');
  assert.equal(searchShown(second.page), false);
});

test('场景：从结果打开预览、过渡中根目录不可用或恢复 — 先结束过渡到终点，再按新状态画', async t => {
  const ctx = await startPhone(t, { motion: { reduce: false } });
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  const running = ctx.page.motion.animations.filter(anim => !anim.finished && !anim.canceled);
  assert.ok(running.length > 0, '过渡在播');
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'gone', path: '/A' });
  await flush();
  assert.equal(ctx.page.motion.animations.filter(anim => !anim.finished && !anim.canceled).length, 0, '外层过渡已结束到终点');
  assert.equal(visible(ctx.page.notice), true);
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.equal(visible(ctx.page.notice), false);
  assert.equal(ctx.page.browse.classList.contains('leaving'), false);
});

test('场景：从结果打开预览、过渡中搜索词被清空（换会话）— 同上，返回回到浏览视图', async t => {
  const ctx = await startPhone(t, { motion: { reduce: false } });
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  ctx.host.session('s2', '/B');
  await flush();
  assert.equal(ctx.page.motion.animations.filter(anim => !anim.finished && !anim.canceled).length, 0);
  assert.equal(box(ctx.page).value, '');
  assert.equal(visible(ctx.page.tree), true, '回到浏览视图');
  assert.equal(searchShown(ctx.page), false);
});

test('结果和浏览视图之间切换没有过渡：开始搜索、清空搜索都不播动画', async t => {
  const ctx = await startPhone(t, { motion: { reduce: false } });
  const before = ctx.page.motion.animations.length;
  await search(ctx, 'x', [hit('dir/x.txt')]);
  type(ctx.page, '');
  await flush();
  assert.equal(ctx.page.motion.animations.length, before);
  assert.equal(visible(ctx.page.tree), true);
});

test('过渡：结果 → 预览是外层 browse → preview（浏览区层滑动，不是结果面板）', async t => {
  const ctx = await startPhone(t, { motion: { reduce: false } });
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  const before = ctx.page.motion.animations.length;
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  const added = ctx.page.motion.animations.slice(before);
  assert.deepEqual(added.map(anim => anim.el), [ctx.page.preview, ctx.page.browse]);
});

test('新结果里没有的选中清掉：之后结果里再出现它也不是选中的', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt'), hit('dir/y.txt')]);
  clickOn(hitNamed(ctx.page, 'dir/x.txt'));
  await search(ctx, 'y', [hit('dir/y.txt')]);
  await search(ctx, 'x', [hit('dir/x.txt'), hit('dir/y.txt')]);
  assert.deepEqual(selectedHits(ctx.page), []);
});

test('清空搜索词后再搜：旧结果不会冒出来；根目录不可用再就绪后重搜期间也不显示旧结果', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', [hit('dir/x.txt')]);
  type(ctx.page, '');
  await flush();
  await search(ctx, 'y'); // 不回答
  assert.deepEqual(hitNames(ctx.page), [], '清空时结果已经丢了');
  const second = await startSearch(t);
  await search(second, 'x', [hit('dir/x.txt')]);
  second.page.post({ type: 'root', generation: second.host.generation, state: 'gone', path: '/A' });
  second.page.post({ type: 'root', generation: second.host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.deepEqual(hitNames(second.page), [], '丢掉的结果不再显示，重搜的结果来之前是空的');
});

test('失效的链接和 other 的结果也显示所在目录（Mac 在右侧，iPhone 在第二行）；大小、日期仍不显示', async t => {
  for (const platform of ['mac', 'ios']) {
    const ctx = platform === 'mac' ? await startSearch(t) : await startPhone(t);
    await search(ctx, 'q', [hit('dir/gone', 'link'), hit('dir/sock', 'other'), hit('top', 'link')]);
    const cls = platform === 'mac' ? 'meta' : 'sub';
    const places = hitRows(ctx.page).map(node => node.find(n => n.classList.contains(cls))[0]?.textContent);
    assert.deepEqual(places, ['dir', 'dir', '工作目录'], platform);
    assert.ok(hitRows(ctx.page).every(node => node.classList.contains('dead')));
  }
});

test('changed 时结果行的菜单留着：重搜替换结果后执行原菜单项，仍按打开菜单时那一行的路径；目录树的行菜单照旧关', async t => {
  const ctx = await startSearch(t);
  Object.assign(ctx.host, { autoRead: true, files: { 'dir/x.txt': 'XX', 'other.txt': 'OO' } });
  await search(ctx, 'x', [hit('dir/x.txt')]);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(visible(ctx.page.menu), true);
  ctx.host.changed();
  await flush();
  assert.equal(visible(ctx.page.menu), true, '结果行的菜单没有被 changed 关掉');
  ctx.tick(300);
  const requests = await searches(ctx.host);
  ctx.host.answer(requests.at(-1), found([hit('other.txt')])); // 重搜：结果换成别的
  await flush();
  assert.deepEqual(hitNames(ctx.page), ['other.txt']);
  assert.equal(visible(ctx.page.menu), true);
  ctx.page.menu.find(node => node.textContent === '打开')[0].dispatch('click');
  await flush();
  assert.equal(ctx.host.reads().at(-1).path, 'dir/x.txt', '仍按那时的路径');
  // 目录树的行菜单：changed 照旧关
  type(ctx.page, '');
  await flush();
  rowNamed(ctx.page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(visible(ctx.page.menu), true);
  ctx.host.changed();
  await flush();
  assert.equal(visible(ctx.page.menu), false);
});
