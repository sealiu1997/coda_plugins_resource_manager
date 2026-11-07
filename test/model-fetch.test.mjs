// 模型给定位操作用的接口：fetchNext（取一页并告诉我结局）、whenLoaded（等进行中的加载）、openFile 的两步、刷新轮次（第 18.3 节）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { flush } from './support/fake.mjs';
import { entries, manual } from './support/page.mjs';

async function ready(t, listing = ['dir/', 'a.txt']) {
  t.session(1, 'A');
  t.root(1);
  t.reply((await t.lists(''))[0], entries(listing));
  await flush();
}
const dirOf = (t, path) => t.model.dirs.get(path);

// 展开一个分页的目录：第一页 + 游标。
async function paged(t, path = 'dir', first = ['f1', 'f2'], next = 'c1') {
  await ready(t);
  t.model.toggle(path);
  t.reply((await t.lists(path)).at(-1), entries(first, next));
  await flush();
}

test('fetchNext：ok（接上了新条目，游标更新）、end（没有下一页了）', async () => {
  const t = manual();
  await paged(t);
  const outcome = t.model.fetchNext('dir');
  const request = (await t.lists('dir')).at(-1);
  assert.equal(request.cursor, 'c1');
  assert.equal(dirOf(t, 'dir').loading, true);
  t.reply(request, entries(['f3'], null));
  assert.equal(await outcome, 'ok');
  assert.deepEqual(dirOf(t, 'dir').entries.map(e => e.name), ['f1', 'f2', 'f3']);
  assert.equal(dirOf(t, 'dir').next, null);
  assert.equal(await t.model.fetchNext('dir'), 'end', '没有下一页');
  assert.equal(await t.model.fetchNext('nowhere'), 'void', '没有这个目录');
});

test('fetchNext：failed（失败行照常显示，条目留着）；不自动重试', async () => {
  const t = manual();
  await paged(t);
  const outcome = t.model.fetchNext('dir');
  const before = (await t.lists('dir')).length;
  t.fail((await t.lists('dir')).at(-1), 'io_error', '读不了');
  assert.equal(await outcome, 'failed');
  assert.equal(dirOf(t, 'dir').error.message, '读不了');
  assert.deepEqual(dirOf(t, 'dir').entries.map(e => e.name), ['f1', 'f2']);
  assert.equal((await t.lists('dir')).length, before, '没有重发同一页');
});

test('fetchNext：void（这次读取被作废：换会话、有更新的加载）；目录正在加载时也是 void', async () => {
  const t = manual();
  await paged(t);
  const superseded = t.model.fetchNext('dir');
  const request = (await t.lists('dir')).at(-1);
  assert.equal(await t.model.fetchNext('dir'), 'void', '正在加载：不叠加');
  t.model.retry('dir'); // 更新的加载取代它
  t.reply(request, entries(['f3']));
  assert.equal(await superseded, 'void');
  const second = manual();
  await paged(second);
  const outcome = second.model.fetchNext('dir');
  await second.lists('dir');
  second.session(2, 'B');
  assert.equal(await outcome, 'void', '换会话');
});

test('fetchNext：不碰 wanted，也不按 wanted 取够，取一页就停；游标过期时从第一页重取，结局按条数有没有增加', async () => {
  const t = manual();
  await paged(t);
  t.model.wanted.set('dir', 50); // 还有保存的条数没取够：定位不按它取，也不删它
  const outcome = t.model.fetchNext('dir');
  const request = (await t.lists('dir')).at(-1);
  t.reply(request, entries(['f3'], 'c2'));
  assert.equal(await outcome, 'ok');
  assert.equal((await t.lists('dir')).at(-1), request, '只取了一页，没有按 wanted 接着取');
  assert.equal(t.model.wanted.get('dir'), 50, '没有碰 wanted');
  // 游标过期：从第一页重取，条数比现在多一条
  const expired = t.model.fetchNext('dir');
  t.fail((await t.lists('dir')).at(-1), 'cursor_expired');
  const refetch = (await t.lists('dir')).at(-1);
  assert.equal(refetch.cursor, null, '从第一页重取');
  t.reply(refetch, entries(['f1', 'f2', 'f3', 'f4'], null));
  assert.equal(await expired, 'ok');
  assert.deepEqual(dirOf(t, 'dir').entries.map(e => e.name), ['f1', 'f2', 'f3', 'f4']);
});

test('fetchNext：游标过期重取回来条数没有增加，结局是 end', async () => {
  const t = manual();
  await paged(t);
  const outcome = t.model.fetchNext('dir');
  t.fail((await t.lists('dir')).at(-1), 'cursor_expired');
  t.reply((await t.lists('dir')).at(-1), entries(['f1', 'f2'], null)); // 想要 3 条，只给了原来的 2 条
  assert.equal(await outcome, 'end');
});

test('whenLoaded：进行中的加载给出它的结局；没在加载按状态给；没有这个目录是 void', async () => {
  const t = manual();
  t.session(1, 'A');
  t.root(1);
  const waiting = t.model.whenLoaded('');
  t.reply((await t.lists('')).at(-1), entries(['dir/']));
  assert.equal(await waiting, 'ok');
  assert.equal(await t.model.whenLoaded(''), 'ok', '已加载');
  assert.equal(await t.model.whenLoaded('nowhere'), 'void');
  t.model.toggle('dir');
  const failing = t.model.whenLoaded('dir');
  t.fail((await t.lists('dir')).at(-1), 'io_error', 'x');
  assert.equal(await failing, 'failed');
  assert.equal(await t.model.whenLoaded('dir'), 'failed', '只有失败行');
  t.model.retry('dir');
  const superseded = t.model.whenLoaded('dir');
  const [old] = (await t.lists('dir')).slice(-1);
  t.model.retry('dir'); // 更新的加载取代旧的
  t.reply(old, entries(['x']));
  assert.equal(await superseded, 'void');
});

test('openFile 分两步：设预览和设选中在同一次同步操作里做完，只重画一次；select: false 只设预览', async () => {
  let changes = 0;
  const t = manual({ onChange: () => { changes++; } });
  await ready(t);
  t.model.select('dir');
  changes = 0;
  t.model.openFile('a.txt');
  assert.deepEqual([t.model.selected, t.model.opened, changes], ['a.txt', 'a.txt', 1]);
  t.model.closeFile();
  changes = 0;
  t.model.openFile('dir/x.txt', { select: false });
  assert.deepEqual([t.model.selected, t.model.opened, changes], ['a.txt', 'dir/x.txt', 1], '搜索结果里打开：不改 selected');
});

test('round：换会话和每次 refresh（含换排序、换视图）都加一；进入目录、展开不加', async () => {
  const t = manual();
  await ready(t);
  const base = t.model.round;
  t.model.toggle('dir');
  await t.lists('dir');
  assert.equal(t.model.round, base, '展开不加');
  t.model.refresh();
  assert.equal(t.model.round, base + 1);
  t.model.setSort('date');
  assert.equal(t.model.round, base + 2);
  t.session(2, 'B');
  assert.equal(t.model.round, base + 3);
});
