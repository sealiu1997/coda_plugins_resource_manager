// 查找条的生命周期：预览自己判断，不靠调用方先 stop()（第 18.6 节「由预览自己持有」）。直接挂 mountPreview，不经页面入口。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';
import { installHighlights } from './support/highlights.mjs';

async function mounted(t) {
  const env = installHighlights(t);
  await open(t, { path: 'x.txt', files: {} }); // 只为装好假 DOM 的全局
  const files = { 'a.txt': 'foo foo', 'b.txt': 'foo bar' };
  const reads = [];
  const read = async path => {
    reads.push(path);
    const data = Buffer.from(files[path]);
    return { data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, kind: 'text', eof: true };
  };
  const el = new Element('div'), preview = mountPreview(el, { read, copy() {} });
  const type = text => { const input = el.find(n => n.classList.contains('finput'))[0]; input.value = text; input.dispatch('input'); };
  return { env, preview, el, files, type, tick: ms => t.mock.timers.tick(ms) };
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
