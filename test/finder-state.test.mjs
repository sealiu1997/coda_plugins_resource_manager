// 选中和预览中的文件拆开（第 15.10 节「状态」）：模型、保存和恢复、换会话、同根和异根重建、0.6.0 的旧状态。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Model, parseState, putSession, trimState } from '../view/model.mjs';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { doubleClick, drain, press, savedOf, selectedRows, startMac, clickOn } from './support/finder.mjs';
import { manual } from './support/page.mjs';
import { rowNamed } from './support/treehost.mjs';

// ---- 模型 ----

test('select 只改 selected：同一路径返回 false，不发 onChange；openFile 设两个并发 onChange；closeFile 只清 opened', () => {
  let changes = 0;
  const model = new Model({ link: { reset() {} }, onChange: () => { changes++; } });
  assert.equal(model.select('a'), true);
  assert.equal(model.select('a'), false);
  assert.equal(model.select(null), true);
  assert.equal(changes, 0, '选中不通知重画');
  model.openFile('f');
  assert.deepEqual([model.selected, model.opened, changes], ['f', 'f', 1]);
  model.select('g');
  model.closeFile();
  assert.deepEqual([model.selected, model.opened, changes], ['g', null, 2], '返回：opened 清掉，selected 留着');
});

test('换会话：恢复目标会话自己存的 selected 和 opened，没有记录才是空的', () => {
  const t = manual();
  t.session(1, 'A', { expanded: [], selected: 'x', opened: 'y' });
  assert.deepEqual([t.model.selected, t.model.opened], ['x', 'y']);
  t.session(2, 'B');
  assert.deepEqual([t.model.selected, t.model.opened], [null, null]);
  t.session(3, 'C', { expanded: [], selected: 'q' });
  assert.deepEqual([t.model.selected, t.model.opened], ['q', null], '0.6.0 的旧记录没有 opened');
});

test('同根重建保留选中和预览，异根重建清空；首次 root 到达前的快照还是保存的那份；之后的 root 变化同样清空', async () => {
  const saved = { expanded: [], selected: 'x', opened: 'y', cwd: '', root: '/r' };
  const same = manual();
  same.session(1, 'A', saved);
  assert.deepEqual([same.model.snapshot().selected, same.model.snapshot().opened], ['x', 'y'], '首次 root 之前保存不冲掉');
  same.root(1, 'ready', '/r');
  assert.deepEqual([same.model.selected, same.model.opened], ['x', 'y']);
  same.root(1, 'ready', '/r');
  assert.deepEqual([same.model.selected, same.model.opened], ['x', 'y'], '重复就绪');

  const other = manual();
  other.session(1, 'A', saved);
  other.root(1, 'ready', '/other');
  assert.deepEqual([other.model.selected, other.model.opened], [null, null], '异根重建');

  const later = manual();
  later.session(1, 'A', { ...saved, root: '/r' });
  later.root(1, 'ready', '/r');
  later.root(1, 'ready', '/moved');
  assert.deepEqual([later.model.selected, later.model.opened], [null, null], '会话中换了根目录');
});

test('parseState：opened 形状不对回 null；0.6.0 的状态没有 opened，selected 当选中', () => {
  const base = { at: 1, expanded: [], scroll: { tree: 0, top: 0, left: 0 } };
  const state = parseState({ v: 1, seq: 1, sessions: {
    a: { ...base, selected: 'x', opened: 'y' }, b: { ...base, selected: 'x' }, c: { ...base, selected: 'x', opened: 7 }, d: { ...base, selected: null, opened: 'z'.repeat(2000) },
  } });
  assert.deepEqual(Object.entries(state.sessions).map(([id, s]) => [id, s.selected, s.opened]), [['a', 'x', 'y'], ['b', 'x', null], ['c', 'x', null], ['d', null, null]]);
  const put = { v: 1, seq: 0, hidden: false, sort: 'name', view: 'list', sessions: {} };
  putSession(put, 's', { expanded: [], selected: 'x', opened: 'y', scroll: { tree: 0, top: 0, left: 0 } });
  assert.equal(parseState(trimState(put, 's')).sessions.s.opened, 'y', '存了再读回来');
});

// ---- 页面：保存和恢复 ----

const rebuild = (t, ctx, options) => startMac(t, { state: ctx.saves.at(-1), ...options });

test('selected 和 opened 分别保存和恢复：只选中的重建后是目录树，打开的重建后是预览，都不用「换会话时补存」', async t => {
  const first = await startMac(t);
  clickOn(rowNamed(first.page, 'b.txt'));
  first.tick(300);
  assert.deepEqual([savedOf(first).selected, savedOf(first).opened], ['b.txt', null]);
  const selectedOnly = await rebuild(t, first);
  assert.equal(visible(selectedOnly.page.tree), true);
  assert.equal(visible(selectedOnly.page.preview), false);
  assert.deepEqual(selectedRows(selectedOnly.page), ['b.txt']);
  assert.equal(selectedOnly.host.sent.filter(m => m.type === 'read').length, 0, '恢复选中不读文件');

  await doubleClick(selectedOnly.page.tree, rowNamed(selectedOnly.page, 'a.txt'));
  selectedOnly.tick(300);
  assert.deepEqual([savedOf(selectedOnly).selected, savedOf(selectedOnly).opened], ['a.txt', 'a.txt']);
  const reopened = await rebuild(t, selectedOnly);
  assert.equal(visible(reopened.page.preview), true);
  assert.equal(reopened.host.sent.filter(m => m.type === 'read').length, 1);
});

test('返回后保存：opened 清掉，selected 留着', async t => {
  const ctx = await startMac(t);
  await doubleClick(ctx.page.tree, rowNamed(ctx.page, 'a.txt'));
  press(document.activeElement, 'ArrowUp', { metaKey: true });
  await flush();
  ctx.tick(300);
  assert.deepEqual([savedOf(ctx).selected, savedOf(ctx).opened], ['a.txt', null]);
});

test('换会话 A→B→A：各自恢复自己的选中和预览', async t => {
  const ctx = await startMac(t);
  const { page, host } = ctx;
  await doubleClick(page.tree, rowNamed(page, 'a.txt'));
  host.session('s2', '/A');
  await flush();
  assert.equal(visible(page.preview), false, '换会话：预览关掉');
  assert.deepEqual(selectedRows(page), [], 'B 没有记录：空的');
  clickOn(rowNamed(page, 'b.txt'));
  host.session('s1', '/A');
  await flush();
  assert.equal(visible(page.preview), true, 'A 的预览回来');
  press(document.activeElement ?? page.preview, 'ArrowUp', { metaKey: true });
  await flush();
  assert.deepEqual(selectedRows(page), ['a.txt']);
  host.session('s2', '/A');
  await flush();
  assert.deepEqual(selectedRows(page), ['b.txt'], 'B 回来：只选中，没有预览');
  assert.equal(visible(page.preview), false);
});

test('同根重建保留选中', async t => {
  const first = await startMac(t);
  clickOn(rowNamed(first.page, 'b.txt'));
  first.tick(300);
  const same = await rebuild(t, first);
  assert.deepEqual(selectedRows(same.page), ['b.txt']);
});

test('异根重建清空选中和预览', async t => {
  const first = await startMac(t);
  clickOn(rowNamed(first.page, 'b.txt'));
  first.tick(300);
  const state = first.saves.at(-1);
  const other = await startMac(t, { state, settle: false, root: '/elsewhere' });
  await drain(other);
  assert.deepEqual(selectedRows(other.page), []);
  assert.equal(savedOf(other).selected, null);
});

test('首次 root 到达前保存不冲掉选中：页面先收到 session，root 还没来就保存', async t => {
  const first = await startMac(t);
  await doubleClick(first.page.tree, rowNamed(first.page, 'a.txt'));
  first.tick(300);
  const state = first.saves.at(-1);
  const second = await startMac(t, { state, settle: false, rootless: true });
  second.host.events.visibility(false); // 页面被收起：立即保存
  const record = second.saves.at(-1)?.sessions.s1;
  assert.deepEqual([record.selected, record.opened, record.root], ['a.txt', 'a.txt', '/A'], '还是保存的那一份');
});
