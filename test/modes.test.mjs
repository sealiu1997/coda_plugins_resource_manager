// 显示方式状态机（view/modes.mjs）：事件语义，以及经 mountPreview 的迁移断言（行为照 0.9.7，没变）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createModes } from '../view/modes.mjs';
import { OpenCategory } from '../view/protocol.mjs';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { deferred, flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';

test('modes：open 按类别定组、模式回默认、可用性待定；别的类别没有模式栏', () => {
  const modes = createModes();
  assert.deepEqual(modes.state(), { group: null, mode: null, available: false });
  modes.open(OpenCategory.MARKDOWN);
  assert.deepEqual(modes.state(), { group: 'rich', mode: 'preview', available: false });
  modes.open(OpenCategory.MODEL);
  assert.deepEqual(modes.state(), { group: 'model', mode: '3d', available: false });
  for (const category of [OpenCategory.TEXT, OpenCategory.IMAGE, OpenCategory.DOCUMENT]) {
    modes.open(category);
    modes.capability(true); modes.content(true);
    assert.deepEqual(modes.buttons(), [], category);
    assert.equal(modes.select('text'), false);
  }
});

test('modes：同类别换文件重置模式和可用性；refresh 什么都不变', () => {
  const modes = createModes();
  modes.open(OpenCategory.MARKDOWN); modes.content(true); modes.select('source');
  modes.refresh();
  assert.deepEqual(modes.state(), { group: 'rich', mode: 'source', available: true });
  modes.open(OpenCategory.MARKDOWN);
  assert.deepEqual(modes.state(), { group: 'rich', mode: 'preview', available: false });
  modes.open(OpenCategory.MODEL); modes.capability(true); modes.select('text');
  modes.open(OpenCategory.MODEL);
  assert.deepEqual(modes.state(), { group: 'model', mode: '3d', available: false });
});

test('modes：capability 只开关 model 组，不改模式；content 只开关 rich 组', () => {
  const modes = createModes();
  modes.open(OpenCategory.MODEL);
  modes.capability(true); modes.select('text');
  modes.capability(false); modes.capability(true);
  assert.equal(modes.state().mode, 'text', '探测迟到、反复都不改模式');
  modes.content(false);
  assert.equal(modes.state().available, true, 'content 不碰 model 组');
  modes.open(OpenCategory.MARKDOWN);
  modes.capability(true);
  assert.equal(modes.state().available, false, 'capability 不碰 rich 组');
});

test('modes：reload 让 rich 回预览、model 保持；content 从不可用变回可用才回预览', () => {
  const modes = createModes();
  modes.open(OpenCategory.MODEL); modes.capability(true); modes.select('text');
  modes.reload();
  assert.equal(modes.state().mode, 'text');
  modes.open(OpenCategory.MARKDOWN); modes.content(true); modes.select('source');
  modes.content(true);
  assert.equal(modes.state().mode, 'source', '一直是文本：刷新不改用户选的模式');
  modes.content(false);
  assert.deepEqual(modes.buttons(), []);
  assert.equal(modes.state().mode, 'source', '变二进制时不改模式，只收起');
  modes.content(true);
  assert.equal(modes.state().mode, 'preview');
  modes.select('source'); modes.reload();
  assert.equal(modes.state().mode, 'preview');
});

test('modes：select 只认当前可用组里的模式，返回有没有变；buttons 和 isRichPreview 跟着状态', () => {
  const modes = createModes();
  modes.open(OpenCategory.MARKDOWN);
  assert.equal(modes.select('source'), false, '不可用时不能选');
  assert.equal(modes.isRichPreview(), false);
  modes.content(true);
  assert.equal(modes.isRichPreview(), true);
  assert.equal(modes.select('3d'), false, '别的组的模式不认');
  assert.equal(modes.select('preview'), false, '已经是它');
  assert.equal(modes.select('source'), true);
  assert.equal(modes.isRichPreview(), false);
  assert.deepEqual(modes.buttons(), [{ value: 'preview', label: '预览', pressed: false }, { value: 'source', label: '源码', pressed: true }]);
  modes.open(OpenCategory.MODEL); modes.capability(true);
  assert.deepEqual(modes.buttons(), [{ value: '3d', label: '3D', pressed: true }, { value: 'text', label: '文本', pressed: false }]);
});

async function mounted(t, files) {
  await open(t, { path: 'x.txt', files: {} }); // 只为装好假 DOM 的全局
  const host = { files, holdRead: {}, holdMedia: null }, models = [];
  const read = async (path, offset) => {
    if (host.holdRead[path]) await host.holdRead[path].promise;
    const file = host.files[path], data = Buffer.from(file.text ?? '');
    return { data: data.toString('base64'), offset, size: data.length, mtimeMs: file.mtimeMs ?? 1, kind: file.kind ?? 'text', eof: true };
  };
  const media = async path => {
    if (host.holdMedia) await host.holdMedia.promise;
    return { token: 'tok', size: Buffer.byteLength(host.files[path].text ?? ''), mtimeMs: host.files[path].mtimeMs ?? 1 };
  };
  const mountModel = options => { const model = { options, dispose() {}, cancel() {} }; models.push(model); return model; };
  const el = new Element('div'), preview = mountPreview(el, { read, copy() {}, media, mountModel });
  const modeBar = () => el.find(n => n.classList.contains('pmode'))[0];
  const button = label => el.find(n => n.tagName === 'BUTTON' && n.textContent === label)[0];
  const pressed = () => modeBar().find(n => n.tagName === 'BUTTON').map(b => `${b.textContent}:${b.getAttribute('aria-pressed')}`);
  const rendered = () => el.find(n => n.classList.contains('md')).length === 1;
  return { preview, host, models, modeBar, button, pressed, rendered };
}

test('迁移：同类别换文件会重置模式（3D 选了文本、Markdown 选了源码，换同类别的文件都回默认）', async t => {
  const { preview, button, pressed, modeBar } = await mounted(t, {
    'a.stl': { text: 'solid a' }, 'b.stl': { text: 'solid b' }, 'a.md': { text: '# a' }, 'b.md': { text: '# b' },
  });
  await preview.open('a.stl');
  button('文本').dispatch('click'); await flush();
  assert.deepEqual(pressed(), ['3D:false', '文本:true']);
  await preview.open('b.stl');
  assert.deepEqual(pressed(), ['3D:true', '文本:false']);
  await preview.open('a.md');
  button('源码').dispatch('click');
  assert.deepEqual(pressed(), ['预览:false', '源码:true']);
  await preview.open('b.md');
  assert.deepEqual(pressed(), ['预览:true', '源码:false']);
  assert.equal(modeBar().hidden, false);
});

test('迁移：3D 的文本能力探测（读第一块）迟到：回来之前没有模式栏，回来后出现的是 3D，不乱动模式', async t => {
  const { preview, host, models, modeBar, pressed } = await mounted(t, { 'a.stl': { text: 'solid a' } });
  host.holdRead['a.stl'] = deferred();
  const opened = preview.open('a.stl');
  await flush();
  assert.equal(modeBar().hidden, true, '探测还没回来：没有模式栏');
  assert.equal(models.length, 0);
  host.holdRead['a.stl'].resolve();
  await opened; await flush();
  assert.deepEqual(pressed(), ['3D:true', '文本:false'], '探测迟到后出现的是 3D');
  assert.equal(models.length, 1);
});

test('迁移：3D 选了「文本」后重载，仍是文本', async t => {
  const { preview, button, pressed, models } = await mounted(t, { 'a.stl': { text: 'solid a' } });
  await preview.open('a.stl');
  button('文本').dispatch('click'); await flush();
  await preview.reload(); await flush();
  assert.deepEqual(pressed(), ['3D:false', '文本:true']);
  assert.equal(models.length, 1, '重载后没有重新挂 3D 查看器');
});

test('迁移：Markdown 选了「源码」后重载，回到预览', async t => {
  const { preview, button, pressed, rendered } = await mounted(t, { 'a.md': { text: '# a' } });
  await preview.open('a.md');
  button('源码').dispatch('click');
  assert.equal(rendered(), false);
  await preview.reload(); await flush();
  assert.deepEqual(pressed(), ['预览:true', '源码:false']);
  assert.equal(rendered(), true);
});

test('迁移：第一次打开就是二进制的 .md，不出模式栏', async t => {
  const { preview, modeBar } = await mounted(t, { 'a.md': { kind: 'binary', text: '' } });
  await preview.open('a.md');
  assert.equal(modeBar().hidden, true);
});

test('迁移：同一个 .md 在文本和二进制之间来回变，模式栏随之收起、恢复，恢复后是「预览」（先选了「源码」也一样）', async t => {
  const { preview, host, button, modeBar, pressed, rendered } = await mounted(t, { 'a.md': { text: '# a', mtimeMs: 1 } });
  await preview.open('a.md');
  button('源码').dispatch('click');
  assert.deepEqual(pressed(), ['预览:false', '源码:true']);
  host.files['a.md'] = { kind: 'binary', text: '', mtimeMs: 2 };
  await preview.refresh(); await flush();
  assert.equal(modeBar().hidden, true, '变成二进制：收起');
  host.files['a.md'] = { text: '# b', mtimeMs: 3 };
  await preview.refresh(); await flush();
  assert.equal(modeBar().hidden, false, '变回文本：恢复');
  assert.deepEqual(pressed(), ['预览:true', '源码:false'], '先选了源码也回到预览');
  assert.equal(rendered(), true);
  // 一直是文本时，后台刷新不改用户选的模式
  button('源码').dispatch('click');
  host.files['a.md'] = { text: '# c', mtimeMs: 4 };
  await preview.refresh(); await flush();
  assert.deepEqual(pressed(), ['预览:false', '源码:true']);
});
