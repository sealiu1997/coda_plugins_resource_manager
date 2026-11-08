// 查找条的生命周期：预览自己判断，不靠调用方先 stop()（第 18.6 节「由预览自己持有」）。直接挂 mountPreview，不经页面入口。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { deferred, flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';
import { installHighlights } from './support/highlights.mjs';

async function mounted(t) {
  const env = installHighlights(t);
  await open(t, { path: 'x.txt', files: {} }); // 只为装好假 DOM 的全局
  const files = { 'a.txt': 'foo foo', 'b.txt': 'foo bar' };
  const reads = [], mode = { fail: null, hold: null }; // fail：读取失败的原因；hold：扣住读取，测试自己放行
  const read = async path => {
    reads.push(path);
    if (mode.hold) await mode.hold.promise;
    if (mode.fail) throw Object.assign(new Error(mode.fail.message), { code: mode.fail.code });
    const data = Buffer.from(files[path]);
    return { data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, kind: 'text', eof: true };
  };
  const eaten = new WeakSet();
  const el = new Element('div'), preview = mountPreview(el, { read, copy() {}, consumed: event => eaten.has(event) });
  const type = text => { const input = el.find(n => n.classList.contains('finput'))[0]; input.value = text; input.dispatch('input'); };
  return { env, preview, el, files, type, eaten, mode, tick: ms => t.mock.timers.tick(ms) };
}

test('open 换了文件：查找关闭，标记删除；同一个文件 refresh 保留；stop、close、reload 关闭', async t => {
  const { env, preview, type, tick, files } = await mounted(t);
  await preview.open('a.txt');
  preview.openFind();
  type('foo');
  tick(150);
  assert.equal(env.registry.get('find').size, 2);
  await preview.refresh();
  assert.equal(preview.findOpen, true, 'refresh 保留');
  assert.equal(env.registry.get('find').size, 2);
  files['a.txt'] = 'foo foo foo';
  await preview.refresh();
  assert.equal(env.registry.get('find').size, 3, '内容变了：重新找');
  await preview.open('b.txt'); // 没有先 stop()
  assert.equal(preview.findOpen, false, 'open 别的文件：关');
  assert.equal(env.registry.size, 0);
  preview.openFind();
  type('foo');
  tick(150);
  await preview.reload();
  assert.equal(preview.findOpen, false, 'reload 关');
  assert.equal(env.registry.size, 0);
  await preview.open('a.txt');
  preview.openFind();
  type('foo');
  tick(150);
  preview.stop();
  assert.equal(preview.findOpen, false, 'stop 关');
  assert.equal(env.registry.size, 0);
  await preview.open('a.txt');
  preview.openFind();
  type('foo');
  tick(150);
  preview.close();
  assert.equal(preview.findOpen, false, 'close 关');
});

test('stop 之后迟到的防抖和批次不注册；release 只清画面，不清后来重新打开的文件的标记', async t => {
  const { env, preview, type, tick } = await mounted(t);
  await preview.open('a.txt');
  preview.openFind();
  type('foo'); // 防抖还没到
  preview.stop();
  tick(1000);
  assert.equal(env.registry.size, 0, '迟到的防抖不注册');
  // 退场没结束又打开另一个文件并查找，这时旧页的 release 到了
  await preview.open('b.txt');
  preview.openFind();
  type('foo');
  tick(150);
  const marks = env.registry.get('find');
  preview.release();
  assert.equal(env.registry.get('find'), marks, 'release 不碰查找');
  assert.equal(preview.findOpen, true);
});

test('同一个文件 open 不关查找（只有换了文件才关）', async t => {
  const { preview } = await mounted(t);
  await preview.open('a.txt');
  preview.openFind();
  await preview.open('a.txt');
  assert.equal(preview.findOpen, true);
});

test('菜单消费掉的 Esc 不关查找条', async t => {
  const { preview, el, eaten } = await mounted(t);
  await preview.open('a.txt');
  preview.openFind();
  const event = { type: 'keydown', key: 'Escape', preventDefault() {} };
  eaten.add(event);
  el.emit(event);
  assert.equal(preview.findOpen, true);
  el.emit({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(preview.findOpen, false);
});

// ---- 样式只在查找开着时生效：.pbody 的 finding 类跟着查找条的开关走（::highlight 规则只要存在就拖慢每次打开上色文件）----

test('finding 类：打开查找加上，Esc、完成、open 换文件、reload、stop、close 都去掉', async t => {
  const { preview, el, files } = await mounted(t);
  const body = () => el.find(n => n.classList.contains('pbody'))[0], on = () => body().classList.contains('finding');
  assert.equal(on(), false, '没开查找：没有');
  await preview.open('a.txt');
  assert.equal(on(), false, '打开文件不加');
  preview.openFind();
  assert.equal(on(), true);
  preview.openFind(); // 已开再按 ⌘F
  assert.equal(on(), true);
  el.emit({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(on(), false, 'Esc');
  preview.openFind();
  el.find(n => n.classList.contains('fdone'))[0].dispatch('click');
  assert.equal(on(), false, '完成');
  preview.openFind();
  await preview.refresh();
  assert.equal(on(), true, 'refresh 保留');
  await preview.open('b.txt');
  assert.equal(on(), false, 'open 换文件');
  preview.openFind();
  await preview.reload();
  assert.equal(on(), false, 'reload');
  await preview.open('a.txt');
  preview.openFind();
  preview.stop();
  assert.equal(on(), false, 'stop');
  await preview.open('a.txt');
  preview.openFind();
  preview.close();
  assert.equal(on(), false, 'close');
  files['x'] = 'x';
});

test('finding 类：长行不标高亮、不支持 Highlight API 时随查找条开关照旧（类只管样式规则生不生效）', async t => {
  const { preview, el, files } = await mounted(t);
  const body = () => el.find(n => n.classList.contains('pbody'))[0];
  files['long.txt'] = `${'ab '.repeat(3000)}\n`;
  await preview.open('long.txt');
  preview.openFind();
  assert.equal(body().classList.contains('finding'), true);
  preview.closeFind();
  assert.equal(body().classList.contains('finding'), false);
});

test('样式表：两条 ::highlight 规则都带 .pbody.finding 前缀，没有不带前缀的（查找关着时不生效）', async () => {
  const sheet = await (await import('node:fs/promises')).readFile(new URL('../view/style.css', import.meta.url), 'utf8');
  const rules = [...sheet.matchAll(/^([^\n{]*)::highlight\((find[\w-]*)\)/gm)];
  assert.equal(rules.length, 2);
  for (const [, selector] of rules) assert.match(selector, /^\.pbody\.finding $/);
});

// 整页重读（非静默）：同一个文件再 open 不关查找，接着 load(false)：开始读取就清标记、计数写「—」，失败后仍是「—」并显示说明和重试，
// 重试成功后重建查找。页面里没有真实入口会对同一路径再 open（侧栏和窗口都只在路径变了才 open），所以这里直接拿预览调 open。
test('整页重读：读取中清标记、计数「—」；失败后仍是「—」、查找条和搜索词留着、有重试；重试成功后重新找', async t => {
  const { env, preview, el, type, tick, mode } = await mounted(t);
  const count = () => el.find(n => n.classList.contains('fcount'))[0].textContent;
  const input = () => el.find(n => n.classList.contains('finput'))[0];
  const body = () => el.find(n => n.classList.contains('pbody'))[0];
  await preview.open('a.txt');
  preview.openFind();
  type('foo');
  tick(150);
  assert.deepEqual([env.registry.get('find').size, env.registry.get('find-current').size, count()], [2, 1, '1/2']);
  // 同一个文件再 open，读取被扣住
  mode.hold = deferred();
  const reopening = preview.open('a.txt');
  assert.equal(preview.findOpen, true, '同一个文件 open 不关查找');
  assert.equal(env.registry.size, 0, '读取中：标记已清');
  assert.equal(count(), '—', '读取中：计数写「—」');
  // 读取失败
  mode.fail = { code: 'io_error', message: '读不了' };
  mode.hold.resolve();
  await reopening;
  await flush();
  assert.equal(env.registry.size, 0, '失败后：标记仍是清的');
  assert.equal(count(), '—');
  assert.equal(preview.findOpen, true, '查找条还开着');
  assert.equal(input().value, 'foo', '搜索词还在');
  assert.match(body().textContent, /读不到这个文件.*读不了/, '显示读取失败的说明');
  const retry = body().find(n => n.tagName === 'BUTTON' && n.textContent === '重试')[0];
  assert.ok(retry, '说明里有重试按钮');
  // 恢复：重试成功后重建查找
  mode.fail = null;
  mode.hold = null;
  retry.dispatch('click');
  await flush();
  assert.equal(count(), '1/2', '重试成功：计数恢复');
  assert.deepEqual([env.registry.get('find').size, env.registry.get('find-current').size], [2, 1], 'find 和 find-current 重新注册');
});
