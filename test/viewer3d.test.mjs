// 3D 查看器（view/viewer3d.mjs，第 21 节）：真实的 three 的数学和动画，渲染器、控件、环境、fetch、帧都是假的（Node 里没有 WebGL）。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as REAL from '../view/vendor/three/build/three.module.mjs';
import { mountViewer } from '../view/viewer3d.mjs';
import { Element } from './support/dom.mjs';
import { flush } from './support/fake.mjs';

const MIB = 1024 * 1024;

// 全局：假的 document（可见性事件）和 ResizeObserver。
function installGlobals(t) {
  const listeners = new Set(), observers = [];
  const doc = { hidden: false, createElement: tag => new Element(tag), addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn),
    show(hidden) { doc.hidden = hidden; for (const fn of [...listeners]) fn(); }, listeners };
  const saved = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver') };
  globalThis.document = doc;
  globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { doc, observers };
}

// 一个带几何体、材质、贴图的场景，释放时每一样都要被 dispose。
function sceneWith({ clips = 0 } = {}) {
  const geometry = new REAL.BoxGeometry(1, 2, 3), texture = new REAL.Texture(), material = new REAL.MeshStandardMaterial({ map: texture });
  const disposed = { geometry: 0, material: 0, texture: 0 };
  geometry.dispose = () => disposed.geometry++; material.dispose = () => disposed.material++; texture.dispose = () => disposed.texture++;
  const scene = new REAL.Group();
  scene.add(new REAL.Mesh(geometry, material));
  const animations = Array.from({ length: clips }, (_, i) => new REAL.AnimationClip(i === 0 ? '' : `clip${i}`, 1, [new REAL.NumberKeyframeTrack('.position[x]', [0, 1], [0, i + 1])]));
  return { scene, animations, disposed };
}

// 搭一个查看器：calls 记着假渲染器、控件、环境、fetch 被怎么用；frames 是手动的 requestAnimationFrame。
function setup(t, { path = 'm/a.glb', size = 10, clips = 0, reduced = false, webgl = true, failRenderer = false, fetchResult, parse, extraModules = {} } = {}) {
  const globals = installGlobals(t);
  const body = new Element('div'), calls = { fetch: [], imports: [], parse: 0, renders: 0, renderers: [], controls: [], env: [], metas: [], rooms: 0 };
  const made = sceneWith({ clips });
  const frames = new Map();
  let next = 0, clock = 0;
  const fake = {
    WebGLRenderer: class {
      constructor(options) { if (failRenderer) throw new Error('no context'); this.options = options; this.counts = { dispose: 0, forceContextLoss: 0 }; this.failRender = null; calls.renderers.push(this); }
      setPixelRatio(ratio) { this.ratio = ratio; }
      setSize(w, h) { this.size = [w, h]; }
      render() { calls.renders++; if (this.failRender) throw new Error(this.failRender); }
      dispose() { this.counts.dispose++; }
      forceContextLoss() { this.counts.forceContextLoss++; }
    },
    PMREMGenerator: class { fromScene() { const target = { texture: { id: 'env' }, disposed: 0, dispose() { target.disposed++; } }; calls.env.push(target); return target; } dispose() { this.disposed = true; } },
  };
  const THREE = { ...REAL, ...fake };
  class Controls {
    constructor(camera, dom) { this.target = new REAL.Vector3(); this.listeners = {}; this.disposed = 0; this.dom = dom; calls.controls.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    update() {}
    dispose() { this.disposed++; }
  }
  const modules = {
    'controls/OrbitControls': { OrbitControls: Controls },
    'environments/RoomEnvironment': { RoomEnvironment: class { constructor() { calls.rooms++; } dispose() { this.gone = true; } } },
    'loaders/GLTFLoader': { GLTFLoader: class { parse(data, base, ok, no) { calls.parse++; calls.base = base; if (parse) return parse(data, base, ok, no); ok({ scene: made.scene, animations: made.animations }); } } },
    ...extraModules,
  };
  const engine = { three: async () => { calls.imports.push('three'); return THREE; }, module: async name => { calls.imports.push(name); return modules[name]; } };
  const bytes = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
  const env = {
    engine, hasWebGL: () => webgl, reducedMotion: () => reduced, paint: async () => {}, now: () => clock,
    raf: fn => { frames.set(++next, fn); return next; }, caf: id => frames.delete(id),
    fetch: async (url, init) => {
      calls.fetch.push(url);
      if (fetchResult) return fetchResult(url, init);
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => (path.endsWith('.glb') ? glbBytes() : bytes.buffer) };
    },
  };
  const viewer = mountViewer({ body, token: 'tok', path, size, version: '10-1', onMeta: parts => calls.metas.push(parts), env });
  // 手动的帧：跑当前排着的每一帧一次，时间前进 ms（帧里新排的下一轮不跑）。
  const pump = (ms = 16) => { clock += ms; const batch = [...frames]; frames.clear(); for (const [, fn] of batch) fn(); };
  const find = predicate => body.find(predicate);
  const button = label => find(n => n.tagName === 'BUTTON' && n.textContent === label)[0];
  const status = () => find(n => n.classList.contains('mstatus'))[0];
  return { body, calls, made, frames, viewer, pump, find, button, status, globals, bytes, advance: ms => { clock += ms; } };
}

// 最小的合法 glb：JSON 块里只有 asset。
function glbBytes(json = { asset: { version: '2.0' } }) {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + padded.length, 8); head.writeUInt32LE(padded.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const all = Buffer.concat([head, padded]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const renderer = ctx => ctx.calls.renderers[0];

test('加载：只在这时才导入 three；渲染器带 antialias、像素比不超过 2；首帧画一次，状态隐藏，复位视角出现；元信息交给预览', async t => {
  globalThis.devicePixelRatio = 3;
  t.after(() => { delete globalThis.devicePixelRatio; });
  const ctx = setup(t);
  await flush();
  assert.equal(ctx.calls.imports[0], 'three');
  assert.deepEqual(ctx.calls.fetch, ['coda-view://service/media/tok/m/a.glb?v=10-1']);
  assert.equal(renderer(ctx).options.antialias, true);
  assert.equal(renderer(ctx).ratio, 2);
  assert.equal(ctx.calls.renders, 1);
  assert.equal(ctx.status().hidden, true);
  assert.equal(ctx.button('复位视角').hidden, false);
  assert.ok(ctx.body.classList.contains('model'));
  assert.deepEqual(ctx.calls.metas, [['12 面', '']], 'BoxGeometry 12 个三角面，没有动画');
  assert.equal(ctx.calls.rooms, 1, '环境光用 RoomEnvironment');
  assert.equal(ctx.frames.size, 0, '没有动画：不连续渲染');
  assert.equal(ctx.calls.base, 'coda-view://service/media/tok/m/', 'gltf 的相对路径接在文件所在目录后面');
});

test('按需渲染：控件变化和尺寸变化各排一帧，同一时刻只排一帧', async t => {
  const ctx = setup(t);
  await flush();
  const controls = ctx.calls.controls[0];
  controls.listeners.change(); controls.listeners.change();
  assert.equal(ctx.frames.size, 1);
  ctx.pump();
  assert.equal(ctx.calls.renders, 2);
  assert.equal(ctx.frames.size, 0);
  ctx.globals.observers[0].fn();
  assert.equal(ctx.frames.size, 1, '尺寸变化');
  ctx.pump();
  assert.equal(ctx.calls.renders, 3);
});

test('释放：dispose 一次释放几何体、材质、贴图、控件、环境、渲染器（dispose 加 forceContextLoss）、画布和监听', async t => {
  const ctx = setup(t);
  await flush();
  const r = renderer(ctx), canvas = ctx.find(n => n.tagName === 'CANVAS')[0];
  assert.ok(canvas);
  ctx.viewer.dispose();
  assert.deepEqual(ctx.made.disposed, { geometry: 1, material: 1, texture: 1 });
  assert.equal(ctx.calls.controls[0].disposed, 1);
  assert.equal(ctx.calls.env[0].disposed, 1);
  assert.deepEqual(r.counts, { dispose: 1, forceContextLoss: 1 });
  assert.equal(canvas.parent, null, '画布摘掉');
  assert.equal(canvas.width, 0);
  assert.equal(ctx.globals.observers[0].disconnected, true);
  assert.equal(ctx.globals.doc.listeners.size, 0, 'visibilitychange 监听撤掉');
  assert.ok(!ctx.body.classList.contains('model'));
  ctx.viewer.dispose();
  assert.deepEqual(r.counts, { dispose: 1, forceContextLoss: 1 }, '再释放不重复');
});

test('停止（cancel）只停加载和动画，画面留着；之后释放才清', async t => {
  const ctx = setup(t, { clips: 1 });
  await flush();
  assert.equal(ctx.frames.size, 1, '在播');
  ctx.viewer.cancel();
  assert.equal(ctx.frames.size, 0, '停止：循环停了');
  assert.equal(renderer(ctx).counts.dispose, 0, '画面还在');
  ctx.pump();
  assert.equal(ctx.frames.size, 0);
  ctx.viewer.dispose();
  assert.equal(renderer(ctx).counts.dispose, 1);
});

test('加载中途切走：下载还没回来就释放，之后到的结果丢弃——不解析、不建渲染器', async t => {
  let release;
  const ctx = setup(t, { fetchResult: () => new Promise(done => { release = () => done({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => glbBytes() }); }) });
  await flush();
  assert.equal(ctx.calls.fetch.length, 1);
  ctx.viewer.dispose();
  release();
  await flush();
  assert.equal(ctx.calls.parse, 0);
  assert.equal(ctx.calls.renderers.length, 0);
  assert.equal(ctx.calls.metas.length, 0);
  assert.ok(!ctx.body.classList.contains('model'));
});

test('加载中途切走：解析已经开始，结果丢弃并释放已创建的几何体', async t => {
  let finish;
  const ctx = setup(t, { parse: (_data, _base, ok) => { finish = () => ok({ scene: ctx.made.scene, animations: [] }); } });
  await flush();
  assert.equal(ctx.calls.parse, 1);
  ctx.viewer.cancel(); // 预览停止
  finish();
  await flush();
  assert.equal(ctx.calls.renderers.length, 0, '不建渲染器');
  assert.equal(ctx.made.disposed.geometry, 1, '解析出来的几何体释放掉');
});

test('WebGL 不可用：写「这台设备不能显示 3D 模型」，不导入 three、不下载', async t => {
  const ctx = setup(t, { webgl: false });
  await flush();
  assert.match(ctx.status().textContent, /这台设备不能显示 3D 模型/);
  assert.equal(ctx.status().hidden, false);
  assert.deepEqual(ctx.calls.imports, []);
  assert.deepEqual(ctx.calls.fetch, []);
});

test('创建渲染器失败：写不能显示，已解析的几何体释放，没有留下渲染器', async t => {
  const ctx = setup(t, { failRenderer: true });
  await flush();
  assert.match(ctx.status().textContent, /这台设备不能显示 3D 模型/);
  assert.match(ctx.status().textContent, /创建 WebGL 渲染器失败/);
  assert.equal(ctx.made.disposed.geometry, 1);
  assert.equal(ctx.calls.renderers.length, 0);
});

test('大文件：超过 64 MiB 先问，点「仍然加载」才导入和下载；问的时候释放不加载', async t => {
  const ctx = setup(t, { size: 65 * MIB });
  await flush();
  assert.match(ctx.status().textContent, /这个模型有 65 MiB/);
  assert.deepEqual(ctx.calls.imports, []);
  assert.deepEqual(ctx.calls.fetch, []);
  ctx.button('仍然加载').dispatch('click');
  await flush();
  assert.equal(ctx.calls.fetch.length, 1);
  assert.equal(ctx.calls.renderers.length, 1);

  const small = setup(t, { size: 64 * MIB });
  await flush();
  assert.equal(small.calls.fetch.length, 1, '正好 64 MiB 不问');

  const away = setup(t, { size: 100 * MIB });
  await flush();
  away.viewer.dispose();
  await flush();
  assert.deepEqual(away.calls.fetch, [], '问的时候切走：不加载');
  assert.deepEqual(away.calls.imports, []);
});

test('下载失败：HTTP 状态和网络错误都写出原因', async t => {
  const http = setup(t, { fetchResult: () => ({ ok: false, status: 404, headers: { get: () => null } }) });
  await flush();
  assert.match(http.status().textContent, /取不到模型文件/);
  assert.match(http.status().textContent, /HTTP 404/);
  const net = setup(t, { fetchResult: () => { throw new TypeError('Failed to fetch'); } });
  await flush();
  assert.match(net.status().textContent, /取不到模型文件/);
  assert.match(net.status().textContent, /Failed to fetch/);
  assert.equal(net.calls.renderers.length, 0);
});

test('解析失败：写原因；损坏的 glb 写文件被截断；用了 Draco 的写不能预览；都不建渲染器', async t => {
  const parseFail = setup(t, { parse: (_d, _b, _ok, no) => no(new Error('bad accessor')) });
  await flush();
  assert.match(parseFail.status().textContent, /模型解析失败/);
  assert.match(parseFail.status().textContent, /bad accessor/);
  assert.equal(parseFail.calls.renderers.length, 0);

  const truncated = glbBytes();
  const cut = truncated.slice(0, truncated.byteLength - 4);
  const broken = setup(t, { fetchResult: () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => cut }) });
  await flush();
  assert.match(broken.status().textContent, /模型文件损坏/);
  assert.match(broken.status().textContent, /截断/);
  assert.equal(broken.calls.parse, 0);

  const notGlb = setup(t, { fetchResult: () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(30).buffer }) });
  await flush();
  assert.match(notGlb.status().textContent, /文件头不是 glTF/);

  const draco = setup(t, { fetchResult: () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => glbBytes({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }) }) });
  await flush();
  assert.match(draco.status().textContent, /这种压缩的模型不能预览/);
  assert.match(draco.status().textContent, /KHR_draco_mesh_compression/);
  assert.equal(draco.calls.parse, 0);
});

test('空模型：没有可显示的几何体', async t => {
  const ctx = setup(t, { parse: (_d, _b, ok) => ok({ scene: new REAL.Group(), animations: [] }) });
  await flush();
  assert.match(ctx.status().textContent, /模型里没有可显示的几何体/);
  assert.equal(ctx.calls.renderers.length, 0);
});

test('动画：自动循环播放第一段；播放时每帧都画并排下一帧；暂停停循环；再播放接着', async t => {
  const ctx = setup(t, { clips: 2 });
  await flush();
  assert.deepEqual(ctx.calls.metas, [['12 面', '2 段动画']]);
  assert.equal(ctx.button('暂停').hidden, false);
  assert.equal(ctx.frames.size, 1, '自动播放');
  const rendersBefore = ctx.calls.renders;
  ctx.pump(); ctx.pump();
  assert.equal(ctx.calls.renders, rendersBefore + 2);
  assert.equal(ctx.frames.size, 1, '还在循环');
  ctx.button('暂停').dispatch('click');
  assert.equal(ctx.frames.size, 0, '暂停：循环停');
  assert.ok(ctx.button('播放'));
  ctx.pump();
  assert.equal(ctx.calls.renders, rendersBefore + 2, '暂停后不再画');
  ctx.button('播放').dispatch('click');
  assert.equal(ctx.frames.size, 1);
  assert.ok(ctx.button('暂停'));
});

test('动画：多于一段才有下拉；选一段从它开始播，暂停时选也播；一段的没有下拉', async t => {
  const one = setup(t, { clips: 1 });
  await flush();
  assert.equal(one.find(n => n.tagName === 'SELECT')[0].hidden, true);

  const ctx = setup(t, { clips: 3 });
  await flush();
  const select = ctx.find(n => n.tagName === 'SELECT')[0];
  assert.equal(select.hidden, false);
  assert.deepEqual(ctx.find(n => n.tagName === 'OPTION').slice(-3).map(n => n.textContent), ['动画 1', 'clip1', 'clip2'], '没有名字的写「动画 序号」');
  ctx.button('暂停').dispatch('click');
  assert.equal(ctx.frames.size, 0);
  select.value = '2';
  select.dispatch('change');
  assert.equal(select.value, '2');
  assert.ok(ctx.button('暂停'), '选段之后在播');
  assert.ok(ctx.frames.size >= 1);
});

test('动画：页面不可见就停循环，可见了接着；用户暂停过的，可见了也不自己播', async t => {
  const ctx = setup(t, { clips: 1 });
  await flush();
  assert.equal(ctx.frames.size, 1);
  ctx.globals.doc.show(true);
  assert.equal(ctx.frames.size, 0, '不可见：停');
  ctx.globals.doc.show(false);
  assert.ok(ctx.frames.size >= 1, '可见：接着播');
  ctx.button('暂停').dispatch('click');
  assert.equal(ctx.frames.size, 0);
  ctx.globals.doc.show(true);
  ctx.globals.doc.show(false);
  const rendersBefore = ctx.calls.renders;
  ctx.pump();
  assert.equal(ctx.calls.renders, rendersBefore + 1, '重新可见补画一帧');
  assert.equal(ctx.frames.size, 0, '但没有循环');
});

test('减弱动态效果：不自动播放，按钮写「播放」，点了才播', async t => {
  const ctx = setup(t, { clips: 2, reduced: true });
  await flush();
  assert.equal(ctx.frames.size, 0);
  assert.equal(ctx.calls.renders, 1, '画了第一帧，停在第 0 帧的姿势');
  assert.ok(ctx.button('播放'));
  ctx.button('播放').dispatch('click');
  assert.equal(ctx.frames.size, 1);
});

test('没有动画：没有播放控件', async t => {
  const ctx = setup(t);
  await flush();
  assert.equal(ctx.find(n => n.classList.contains('mbar'))[0].hidden, true);
});

test('动画释放：混合器停掉并撤掉缓存的根，释放后没有排着的帧', async t => {
  const original = REAL.AnimationMixer.prototype.uncacheRoot;
  const uncached = [];
  REAL.AnimationMixer.prototype.uncacheRoot = function uncacheRoot(root) { uncached.push(root === this.getRoot()); return original.call(this, root); };
  t.after(() => { REAL.AnimationMixer.prototype.uncacheRoot = original; });
  const ctx = setup(t, { clips: 1 });
  await flush();
  ctx.viewer.dispose();
  assert.deepEqual(uncached, [true]);
  assert.equal(ctx.frames.size, 0);
  assert.equal(renderer(ctx).counts.dispose, 1);
});

test('渲染器创建失败时元信息不报面数', async t => {
  const ctx = setup(t, { failRenderer: true });
  await flush();
  assert.deepEqual(ctx.calls.metas, []);
});

test('渲染中途出错（贴图晚到后上传失败）：写「渲染出错」并释放，不再排帧', async t => {
  const ctx = setup(t, { clips: 1 });
  await flush();
  renderer(ctx).failRender = 'tainted texture';
  ctx.pump();
  assert.match(ctx.status().textContent, /渲染出错/);
  assert.match(ctx.status().textContent, /tainted texture/);
  assert.equal(ctx.frames.size, 0);
  assert.equal(renderer(ctx).counts.dispose, 1);
  assert.equal(ctx.button('复位视角').hidden, true);
});

test('WebGL 上下文丢失：写出原因并释放', async t => {
  const ctx = setup(t);
  await flush();
  let prevented = false;
  ctx.find(n => n.tagName === 'CANVAS')[0].dispatch('webglcontextlost', { preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.match(ctx.status().textContent, /WebGL 上下文丢失/);
  assert.equal(renderer(ctx).counts.dispose, 1);
});

test('复位视角：把相机放回取景的位置并排一帧', async t => {
  const ctx = setup(t);
  await flush();
  ctx.button('复位视角').dispatch('click');
  assert.equal(ctx.frames.size, 1);
});

test('obj：按 mtllib 取同目录（相对路径）的 .mtl；取不到就用中性灰，不当错误', async t => {
  const obj = 'mtllib ../mats/my model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
  const objects = [];
  const modules = {
    'loaders/OBJLoader': { OBJLoader: class { setMaterials() { this.withMaterials = true; } parse() { const mesh = new REAL.Mesh(new REAL.BufferGeometry().setAttribute('position', new REAL.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)), new REAL.MeshBasicMaterial()); const group = new REAL.Group(); group.add(mesh); objects.push(this.withMaterials ? 'mtl' : 'neutral'); return group; } } },
    'loaders/MTLLoader': { MTLLoader: class { parse(text, base) { objects.push(`mtl:${text}:${base}`); return { preload() {}, materialsInfo: {} }; } } },
  };
  const answer = status => url => (url.includes('.mtl') ? (status === 200 ? { ok: true, status, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('newmtl a').buffer } : { ok: false, status, headers: { get: () => null } }) : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(obj).buffer });
  const good = setup(t, { path: 'm/sub/a.obj', fetchResult: answer(200), extraModules: modules });
  await flush();
  assert.deepEqual(good.calls.fetch, ['coda-view://service/media/tok/m/sub/a.obj?v=10-1', 'coda-view://service/media/tok/m/mats/my%20model.mtl']);
  assert.deepEqual(objects, ['mtl:newmtl a:coda-view://service/media/tok/m/mats/', 'mtl']);
  assert.equal(good.calls.renderers.length, 1);

  objects.length = 0;
  const missing = setup(t, { path: 'm/sub/a.obj', fetchResult: answer(404), extraModules: modules });
  await flush();
  assert.deepEqual(objects, ['neutral']);
  assert.equal(missing.calls.renderers.length, 1, '找不到 .mtl 照样显示');

  const outside = setup(t, { path: 'a.obj', fetchResult: url => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('mtllib ../../x.mtl\n').buffer }), extraModules: modules });
  await flush();
  assert.deepEqual(outside.calls.fetch.length, 1, '指向工作目录外的 mtllib 不去取');
});

test('点云：没有面的写点数', async t => {
  const modules = { 'loaders/PLYLoader': { PLYLoader: class { parse() { return new REAL.BufferGeometry().setAttribute('position', new REAL.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 2, 0, 1], 3)); } } } };
  const ctx = setup(t, { path: 'c.ply', extraModules: modules });
  await flush();
  assert.deepEqual(ctx.calls.metas, [['3 个点', '']]);
});
