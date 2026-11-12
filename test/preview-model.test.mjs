// 预览里的 3D 模型（第 21 节）：文本切换、文件已变化和重载、停止和释放、没有流式服务时的退路。直接挂 mountPreview，查看器用假的。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { deferred, flush } from './support/fake.mjs';
import { open, start } from './support/filepage.mjs';

async function mounted(t, files) {
  await open(t, { path: 'x.txt', files: {} }); // 只为装好假 DOM 的全局
  const calls = { read: [], media: [], models: [] }, host = { token: 'tok', files, holdMedia: null, failRead: null };
  const chunk = (path, offset) => {
    const file = host.files[path];
    if (!file) throw Object.assign(new Error('没有这个文件'), { code: 'not_found' });
    const data = Buffer.from(file.text ?? '');
    return { data: data.toString('base64'), offset, size: file.size ?? data.length, mtimeMs: file.mtimeMs ?? 1, kind: file.kind ?? 'text', eof: true };
  };
  const read = async (path, offset) => { calls.read.push(`${path}:${offset}`); if (host.failRead) throw Object.assign(new Error(host.failRead), { code: 'io' }); return chunk(path, offset); };
  const media = async path => {
    calls.media.push(path);
    if (host.holdMedia) await host.holdMedia.promise;
    const file = host.files[path];
    if (!file) throw Object.assign(new Error('没有这个文件'), { code: 'not_found' });
    return { token: host.token, size: file.size ?? Buffer.byteLength(file.text ?? ''), mtimeMs: file.mtimeMs ?? 1 };
  };
  const mountModel = options => {
    const model = { options, cancelled: 0, disposed: 0, cancel() { model.cancelled++; }, dispose() { model.disposed++; } };
    calls.models.push(model);
    return model;
  };
  const el = new Element('div'), preview = mountPreview(el, { read, copy() {}, media, mountModel });
  const meta = () => el.find(n => n.classList.contains('pmeta'))[0];
  const button = label => el.find(n => n.tagName === 'BUTTON' && n.textContent === label)[0];
  const modeBar = () => el.find(n => n.classList.contains('pmode'))[0];
  const retry = () => el.find(n => n.tagName === 'BUTTON' && ['重试', '重载'].includes(n.textContent))[0];
  return { preview, el, calls, host, meta, button, modeBar, retry };
}

const MIB = 1024 * 1024;

test('模型走查看器：不发 read（二进制的），参数是口令、路径、大小和 v；元信息是目录 · 大小，解析后补上面数和动画段数', async t => {
  const { preview, calls, meta } = await mounted(t, { 'm/car.glb': { kind: 'binary', size: 3 * MIB, mtimeMs: 7 } });
  await preview.open('m/car.glb');
  assert.equal(calls.read.length, 0, 'glb 一定是二进制，不用读来判断');
  assert.equal(calls.models.length, 1);
  const { options } = calls.models[0];
  assert.deepEqual([options.token, options.path, options.size, options.version], ['tok', 'm/car.glb', 3 * MIB, `${3 * MIB}-7`]);
  assert.equal(meta().textContent, 'm · 3.0 MiB');
  assert.match(meta().title, /^修改于 /);
  options.onMeta(['12,408 面', '2 段动画']);
  assert.equal(meta().textContent, 'm · 3.0 MiB · 12,408 面 · 2 段动画');
  options.onMeta(['3 个点', '']);
  assert.equal(meta().textContent, 'm · 3.0 MiB · 3 个点');
});

test('换了文件，旧查看器晚到的元信息不改新的元信息行', async t => {
  const { preview, calls, meta } = await mounted(t, { 'a.glb': { kind: 'binary', size: 10 }, 'b.glb': { kind: 'binary', size: 20 } });
  await preview.open('a.glb');
  const old = calls.models[0];
  await preview.open('b.glb');
  assert.equal(old.disposed, 1);
  old.options.onMeta(['999 面', '']);
  assert.equal(meta().textContent, '20 B');
});

test('「3D / 文本」切换：gltf、obj、stl、ply 内容是文本才有；二进制的、glb、3mf 没有', async t => {
  const files = {
    'a.gltf': { kind: 'text', text: '{"asset":{}}' }, 'b.obj': { kind: 'text', text: 'v 0 0 0' }, 'c.stl': { kind: 'text', text: 'solid x' }, 'd.ply': { kind: 'text', text: 'ply' },
    'e.stl': { kind: 'binary', size: 84 }, 'f.ply': { kind: 'binary', size: 90 }, 'g.glb': { kind: 'binary', size: 9 }, 'h.3mf': { kind: 'binary', size: 9 },
  };
  const { preview, modeBar, calls } = await mounted(t, files);
  for (const path of ['a.gltf', 'b.obj', 'c.stl', 'd.ply']) {
    await preview.open(path);
    assert.equal(modeBar().hidden, false, path);
  }
  for (const path of ['e.stl', 'f.ply', 'g.glb', 'h.3mf']) {
    await preview.open(path);
    assert.equal(modeBar().hidden, true, path);
  }
  assert.ok(!calls.read.some(entry => entry.startsWith('g.glb') || entry.startsWith('h.3mf')), 'glb、3mf 不读');
  assert.ok(calls.read.includes('e.stl:0'), '别的格式读第一块判断是不是文本');
  assert.equal(calls.models.length, 8, '都按 3D 显示');
});

test('切到文本：释放查看器，走文本预览（行号、高亮外的内容、查找）；切回 3D 重新挂查看器', async t => {
  const { preview, el, calls, button, meta } = await mounted(t, { 'm/a.gltf': { kind: 'text', text: '{\n  "asset": {}\n}\n', size: 18 } });
  await preview.open('m/a.gltf');
  assert.equal(button('3D').getAttribute('aria-pressed'), 'true');
  assert.equal(button('文本').getAttribute('aria-pressed'), 'false');
  assert.equal(preview.canFind, false, '3D 没有查找');
  const first = calls.models[0];
  button('文本').dispatch('click');
  await flush();
  assert.equal(first.disposed, 1);
  assert.ok(el.find(n => n.classList.contains('text'))[0], '文本预览');
  assert.match(el.find(n => n.classList.contains('text'))[0].textContent, /"asset"/);
  assert.equal(meta().textContent, 'm · 3 行 · 18 B');
  assert.equal(preview.canFind, true, '文本可以查找');
  assert.equal(button('文本').getAttribute('aria-pressed'), 'true');
  assert.equal(button('3D').getAttribute('aria-pressed'), 'false');
  assert.equal(calls.models.length, 1);
  button('3D').dispatch('click');
  await flush();
  assert.equal(calls.models.length, 2);
  assert.equal(el.find(n => n.classList.contains('text')).length, 0);
  assert.equal(preview.canFind, false);
  button('3D').dispatch('click');
  await flush();
  assert.equal(calls.models.length, 2, '已经是 3D：再点不重载');
});

test('文本模式下刷新走文本的刷新（直接换内容，没有「文件已变化」）；换文件回到 3D', async t => {
  const { preview, el, host, meta, button, modeBar, retry } = await mounted(t, { 'a.stl': { kind: 'text', text: 'solid a', mtimeMs: 1 }, 'b.glb': { kind: 'binary', size: 5 } });
  await preview.open('a.stl');
  button('文本').dispatch('click');
  await flush();
  host.files['a.stl'] = { kind: 'text', text: 'solid changed', mtimeMs: 2 };
  await preview.refresh();
  assert.match(el.find(n => n.classList.contains('text'))[0].textContent, /changed/);
  assert.equal(retry().hidden, true);
  assert.notEqual(meta().textContent, '文件已变化');
  await preview.open('b.glb');
  assert.equal(modeBar().hidden, true);
  await preview.open('a.stl');
  assert.equal(el.find(n => n.classList.contains('text')).length, 0, '再打开 stl 回到 3D');
});

test('文件已变化：不打断，元信息行写提示、「重试」变「重载」，点了才重新加载；改回来提示消失', async t => {
  const { preview, calls, host, meta, retry } = await mounted(t, { 'a.glb': { kind: 'binary', size: 100, mtimeMs: 1 } });
  await preview.open('a.glb');
  const first = calls.models[0];
  calls.models[0].options.onMeta(['12 面', '']);
  await preview.refresh();
  assert.equal(calls.models.length, 1, '没变化什么都不做');
  assert.equal(retry().hidden, true);
  assert.equal(meta().textContent, '100 B · 12 面');

  host.files['a.glb'].mtimeMs = 2;
  await preview.refresh();
  assert.equal(calls.models.length, 1, '变了也不换查看器');
  assert.equal(first.disposed, 0);
  assert.equal(meta().textContent, '文件已变化');
  assert.equal(retry().textContent, '重载');
  assert.equal(retry().hidden, false);

  host.files['a.glb'].mtimeMs = 1;
  await preview.refresh();
  assert.equal(meta().textContent, '100 B · 12 面', '改回来了：提示消失');
  assert.equal(retry().hidden, true);

  host.files['a.glb'] = { kind: 'binary', size: 200, mtimeMs: 3 };
  await preview.refresh();
  assert.equal(meta().textContent, '文件已变化');
  retry().dispatch('click');
  await flush();
  assert.equal(first.disposed, 1, '重载：旧的释放');
  assert.equal(calls.models.length, 2);
  assert.equal(calls.models[1].options.version, '200-3');
  assert.equal(retry().hidden, true);
  assert.equal(meta().textContent, '200 B');
});

test('停止只停加载和动画（cancel）；释放才 dispose；关闭两样都做；换文件释放旧的', async t => {
  const { preview, calls } = await mounted(t, { 'a.glb': { kind: 'binary', size: 10 }, 'b.glb': { kind: 'binary', size: 10 } });
  await preview.open('a.glb');
  const [a] = calls.models;
  preview.stop();
  assert.deepEqual([a.cancelled, a.disposed], [1, 0], '停止：画面留着');
  preview.release();
  assert.equal(a.disposed, 1);

  await preview.open('a.glb');
  const b = calls.models[1];
  preview.close();
  assert.deepEqual([b.cancelled, b.disposed], [1, 1]);

  await preview.open('a.glb');
  const c = calls.models[2];
  await preview.reload();
  assert.equal(c.disposed, 1, '重载（根目录换了位置）：旧的释放');
  assert.equal(calls.models.length, 4);
});

test('加载中途切走：领口令还没回来就换了文件，旧的结果丢弃，不挂查看器', async t => {
  const { preview, calls, host } = await mounted(t, { 'a.glb': { kind: 'binary', size: 10 }, 'b.glb': { kind: 'binary', size: 10 } });
  host.holdMedia = deferred();
  const slow = preview.open('a.glb');
  await flush();
  const held = host.holdMedia;
  host.holdMedia = null;
  await preview.open('b.glb');
  held.resolve();
  await slow;
  await flush();
  assert.deepEqual(calls.models.map(model => model.options.path), ['b.glb']);
});

test('读第一块之前就切走：不显示切换，不挂查看器', async t => {
  const { preview, calls, modeBar } = await mounted(t, { 'a.stl': { kind: 'text', text: 'solid a' }, 'b.glb': { kind: 'binary', size: 10 } });
  const slow = preview.open('a.stl');
  await preview.open('b.glb'); // 同一个微任务批里换了文件
  await slow;
  assert.deepEqual(calls.models.map(model => model.options.path), ['b.glb']);
  assert.equal(modeBar().hidden, true);
});

test('宿主没有流式服务（旧 Coda）：不走查看器；文本的模型当文本显示，二进制的写「二进制文件，不预览」，没有切换', async t => {
  const { preview, el, calls, host, modeBar } = await mounted(t, { 'a.obj': { kind: 'text', text: 'v 0 0 0\n' }, 'b.glb': { kind: 'binary', size: 9 } });
  host.token = null;
  await preview.open('a.obj');
  assert.equal(calls.models.length, 0);
  assert.match(el.find(n => n.classList.contains('text'))[0].textContent, /v 0 0 0/);
  assert.equal(modeBar().hidden, true);
  await preview.open('b.glb');
  assert.equal(calls.models.length, 0);
  assert.match(el.textContent, /二进制文件，不预览/);
});

test('文件被删：查看器先释放再写「文件已不存在」', async t => {
  const { preview, el, calls, host } = await mounted(t, { 'a.glb': { kind: 'binary', size: 10 } });
  await preview.open('a.glb');
  delete host.files['a.glb'];
  await preview.refresh();
  assert.equal(calls.models[0].disposed, 1);
  assert.match(el.textContent, /文件已不存在/);
});

test('读第一块失败：写「读不到这个文件」和原因，没有查看器', async t => {
  const { preview, el, calls, host } = await mounted(t, { 'a.stl': { kind: 'text', text: 'x' } });
  host.failRead = '读不了';
  await preview.open('a.stl');
  assert.match(el.textContent, /读不到这个文件/);
  assert.match(el.textContent, /读不了/);
  assert.equal(calls.models.length, 0);
});

test('文件页里打开模型（真实的查看器，假 DOM 没有 WebGL）：写「这台设备不能显示 3D 模型」，元信息是目录 · 大小，正文是模型的布局', async t => {
  const { page } = await start(t, { path: 'x/a.glb', files: { 'x/a.glb': { kind: 'binary', size: 5 } } });
  assert.match(page.preview.textContent, /这台设备不能显示 3D 模型/);
  assert.equal(page.preview.find(node => node.classList.contains('pmeta'))[0].textContent, 'x · 5 B');
  assert.ok(page.preview.find(node => node.classList.contains('pbody'))[0].classList.contains('model'));
});
