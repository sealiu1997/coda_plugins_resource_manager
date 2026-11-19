// 3D 模型检视模式（view/inspect3d.mjs）：真实 GLTFLoader / STLLoader 解析、UV 通道范围统计、材质单通道、蒙皮支持与真实 WebGL2 渲染验收。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from '../view/vendor/three/build/three.module.mjs';
import { GLTFLoader } from '../view/vendor/three/jsm/loaders/GLTFLoader.mjs';
import { STLLoader } from '../view/vendor/three/jsm/loaders/STLLoader.mjs';
import { PBR_CHANNELS, analyzeModel, createInspector, formatUvMeta } from '../view/inspect3d.mjs';
import { buildGlbWithUvs, buildSkinnedAnimatedGlb } from './support/glb.mjs';

const parseGlb = buffer => new Promise((ok, no) => new GLTFLoader().parse(buffer, '', ok, no));

test('带 TEXCOORD_0~3 的真实 glb：四个 UV 通道全部检出，min/max 与文件内实际值一致', async () => {
  const glb = buildGlbWithUvs({
    TEXCOORD_0: [0, 0, 1, 0, 0.5, 1],
    TEXCOORD_1: [-2.5, 0.25, 4.0, -1.5, 1.0, 2.75],
    TEXCOORD_2: [10, 20, 30, 40, 20, 25],
    TEXCOORD_3: [-0.5, -0.25, 0, 0, 0.5, 0.25],
  });
  const gltf = await parseGlb(glb);
  const caps = analyzeModel(gltf.scene, 'glb');
  assert.equal(caps.hasPBR, true);
  assert.deepEqual(caps.uvChannels.map(c => c.name), ['uv', 'uv1', 'uv2', 'uv3']);
  assert.deepEqual(caps.uvChannels[0], { name: 'uv', minU: 0, maxU: 1, minV: 0, maxV: 1 });
  assert.deepEqual(caps.uvChannels[1], { name: 'uv1', minU: -2.5, maxU: 4, minV: -1.5, maxV: 2.75 });
  assert.deepEqual(caps.uvChannels[2], { name: 'uv2', minU: 10, maxU: 30, minV: 20, maxV: 40 });
  assert.deepEqual(caps.uvChannels[3], { name: 'uv3', minU: -0.5, maxU: 0.5, minV: -0.25, maxV: 0.25 });

  const inspector = createInspector(THREE, gltf.scene, 'glb');
  const res = inspector.apply({ mode: 'uv:uv1', uvMode: 'value' });
  assert.equal(res.meta, 'uv1 U[-2.5, 4] V[-1.5, 2.75]');
  assert.equal(formatUvMeta(caps.uvChannels[1]), 'uv1 U[-2.5, 4] V[-1.5, 2.75]');
  inspector.dispose();
});

test('只有 TEXCOORD_0 的真实 glb：只列出 uv', async () => {
  const glb = buildGlbWithUvs({ TEXCOORD_0: [0, 0, 1, 0, 0, 1] });
  const gltf = await parseGlb(glb);
  const caps = analyzeModel(gltf.scene, 'glb');
  assert.equal(caps.hasPBR, true);
  assert.deepEqual(caps.uvChannels.map(c => c.name), ['uv']);
});

test('STL：材质通道和 UV 通道不可用，线框和法线可用', () => {
  const stl = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  const buf = Buffer.from(stl);
  const geometry = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  geometry.computeVertexNormals();
  const neutral = new THREE.MeshStandardMaterial({ color: 0xb8bcc4 });
  neutral.userData.__neutral = true;
  const mesh = new THREE.Mesh(geometry, neutral);
  const root = new THREE.Group();
  root.add(mesh);

  const inspector = createInspector(THREE, root, 'stl');
  assert.equal(inspector.caps.hasPBR, false);
  assert.deepEqual(inspector.caps.uvChannels, []);

  // 尝试切 PBR 或 UV 通道会回退到材质
  inspector.apply({ mode: 'pbr:roughness' });
  assert.equal(inspector.state.mode, 'material');
  assert.equal(mesh.material, neutral);

  inspector.apply({ mode: 'uv:uv' });
  assert.equal(inspector.state.mode, 'material');

  // 线框：原材质不动，叠加一个带视图空间相对深度偏移的 wireframe ShaderMaterial 子网格
  inspector.apply({ mode: 'wireframe' });
  assert.equal(inspector.state.mode, 'wireframe');
  assert.equal(mesh.material, neutral);
  assert.equal(mesh.children.length, 1);
  assert.equal(mesh.children[0].material.isShaderMaterial, true);
  assert.equal(mesh.children[0].material.wireframe, true);
  assert.equal(mesh.children[0].material.depthTest, true);
  assert.equal(mesh.children[0].material.depthWrite, false);
  assert.ok(mesh.children[0].material.uniforms.uDepthBias.value > 0);
  assert.match(mesh.children[0].material.vertexShader, /mvPosition\.xyz \*= \(1\.0 - uDepthBias\)/);

  // 法线：替换成 ShaderMaterial，且清除之前的线框叠加层
  inspector.apply({ mode: 'normal' });
  assert.equal(inspector.state.mode, 'normal');
  assert.equal(mesh.children.length, 0);
  assert.equal(mesh.material.isShaderMaterial, true);
  assert.equal(mesh.material.side, THREE.DoubleSide);

  inspector.dispose();
  assert.equal(mesh.material, neutral);
});

test('材质单通道：覆盖全部 6 通道；释放检视材质时不误释放原材质贴图', () => {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const map = new THREE.Texture();
  const roughMap = new THREE.Texture();
  roughMap.channel = 0;
  let texDisposed = 0;
  map.dispose = () => { texDisposed++; };
  roughMap.dispose = () => { texDisposed++; };

  const orig = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.5, 0.25, 0.75),
    map,
    roughness: 0.4,
    roughnessMap: roughMap,
    metalness: 0.8,
    emissive: new THREE.Color(0.2, 0.1, 0),
    opacity: 0.6,
  });
  const mesh = new THREE.Mesh(geo, orig);
  const root = new THREE.Group();
  root.add(mesh);

  const inspector = createInspector(THREE, root, 'glb');
  assert.equal(inspector.caps.hasPBR, true);

  const created = [];
  for (const { id } of PBR_CHANNELS) {
    inspector.apply({ mode: `pbr:${id}` });
    assert.equal(mesh.material.isShaderMaterial, true, id);
    const m = mesh.material;
    let disposed = 0;
    const realDispose = m.dispose.bind(m);
    m.dispose = () => { disposed++; realDispose(); };
    created.push({ id, get disposed() { return disposed; } });
  }
  // 验证 roughness / metalness 标量与贴图状态
  inspector.apply({ mode: 'pbr:roughness' });
  assert.equal(mesh.material.uniforms.uScalar.value, 0.4);
  assert.equal(mesh.material.uniforms.uHasMap.value, 1);
  assert.equal(mesh.material.uniforms.uMap.value, roughMap);

  inspector.apply({ mode: 'pbr:metalness' });
  assert.equal(mesh.material.uniforms.uScalar.value, 0.8);
  assert.equal(mesh.material.uniforms.uHasMap.value, 0);

  inspector.dispose();
  assert.equal(mesh.material, orig, 'dispose 后恢复原材质');
  assert.equal(inspector.ownedCount, 0);
  for (const entry of created) assert.equal(entry.disposed, 1, `${entry.id} 的检视材质被释放`);
  assert.equal(texDisposed, 0, '原材质贴图绝不能被检视器误释放');
});

test('蒙皮网格：线框叠加绑定同一骨架；法线、材质单通道和 UV 着色器均包含蒙皮顶点片段', () => {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const count = geo.attributes.position.count;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));

  const bone = new THREE.Bone();
  const skeleton = new THREE.Skeleton([bone]);
  const orig = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const skinned = new THREE.SkinnedMesh(geo, orig);
  skinned.add(bone);
  skinned.bind(skeleton);

  const root = new THREE.Group();
  root.add(skinned);

  const inspector = createInspector(THREE, root, 'glb');

  inspector.apply({ mode: 'wireframe' });
  const overlay = skinned.children.find(c => c.userData?.__inspectOverlay);
  assert.ok(overlay?.isSkinnedMesh, '线框叠加对象是 SkinnedMesh');
  assert.equal(overlay.skeleton, skeleton, '线框叠加对象共享同一骨架');

  for (const mode of ['wireframe', 'normal', 'pbr:baseColor', 'uv:uv']) {
    inspector.apply({ mode });
    const mat = mode === 'wireframe' ? skinned.children.find(c => c.userData?.__inspectOverlay).material : skinned.material;
    assert.match(mat.vertexShader, /#include <skinning_pars_vertex>/, mode);
    assert.match(mat.vertexShader, /#include <skinning_vertex>/, mode);
  }

  inspector.dispose();
  assert.equal(skinned.material, orig);
  assert.equal(skinned.children.find(c => c.userData?.__inspectOverlay), undefined);
});

test('带骨骼动画的真实 glb：各检视模式下姿势随动画持续变化，线框与蒙皮表面严格同步', async () => {
  const gltf = await parseGlb(buildSkinnedAnimatedGlb());
  let skinned = null;
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) skinned = o; });
  assert.ok(skinned, '真实解析出 SkinnedMesh');
  assert.equal(gltf.animations.length, 1);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  const samplePos = mesh => {
    gltf.scene.updateMatrixWorld(true);
    mesh.skeleton.update();
    const v = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 1);
    return mesh.applyBoneTransform(1, v);
  };

  mixer.setTime(0);
  const bindPos = samplePos(skinned);
  assert.ok(Math.abs(bindPos.x - 0) < 1e-5, 't=0 在绑定姿势 x=0');

  const inspector = createInspector(THREE, gltf.scene, 'glb');
  let prevX = bindPos.x;
  for (const [mode, t] of [['wireframe', 0.2], ['normal', 0.4], ['pbr:baseColor', 0.6], ['uv:uv', 0.8]]) {
    inspector.apply({ mode });
    mixer.setTime(t);
    const pos = samplePos(skinned);
    assert.ok(pos.x > prevX + 0.1, `${mode} 在 t=${t} 姿势继续前移（${prevX} -> ${pos.x}）`);
    assert.ok(Math.abs(pos.x - t * 2) < 1e-4, `${mode} 顶点随骨骼准确位移到 x=${t * 2}`);
    if (mode === 'wireframe') {
      const overlay = skinned.children.find(c => c.userData?.__inspectOverlay);
      assert.ok(overlay?.isSkinnedMesh);
      const wirePos = samplePos(overlay);
      assert.ok(wirePos.distanceTo(pos) < 1e-6, '线框叠加层顶点与蒙皮表面严格同步');
    }
    prevX = pos.x;
  }
  inspector.dispose();
});

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find(p => existsSync(p)) ?? null;
}

// 启动无头 Chrome（WebGL2 SwiftShader）执行真实渲染与布局断言：
// 1) 5.0r vs 5.3r（near=0.01r）前后两层遮挡零穿透 + 倾斜共面细分平面线框连续可见；
// 2) 真实骨骼动画 glb 在 t=0 与 t=0.5 两个时刻的实际渲染像素质心位移，且线框与蒙皮表面同步；
// 3) 360px 窄屏子目录文本 glTF 切到 UV 数值模式，两轴范围完整可读不溢出。
test('真实 Chrome WebGL2：线框深度偏移不穿透遮挡、骨骼动画像素位移同步、360px UV 范围不截断', async t => {
  const chromePath = findChrome();
  assert.ok(chromePath, '需要可用的 Chrome / Chromium 执行真实 WebGL2 渲染验收');

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary' };
  const glbUv = Buffer.from(buildGlbWithUvs({ TEXCOORD_0: [-12.5, -3.25, 48.75, 19.5, 0, 1] }));
  const glbRig = Buffer.from(buildSkinnedAnimatedGlb());

  const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/view/style.css"></head>
<body class="coda-ios" style="margin:0;width:360px;height:640px;display:flex;flex-direction:column">
<div id="p" class="preview" style="flex:1;min-height:0"></div>
<script type="module">
import * as THREE from '/view/vendor/three/build/three.module.mjs';
import { GLTFLoader } from '/view/vendor/three/jsm/loaders/GLTFLoader.mjs';
import { createInspector } from '/view/inspect3d.mjs';
import { mountPreview } from '/view/preview.mjs';
import { mountViewer } from '/view/viewer3d.mjs';

const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origErr(...a); };

try {
// 1) 360px 窄屏 UV 范围可读性
const p = document.getElementById('p');
const preview = mountPreview(p, {
  read: async () => ({ kind: 'text', data: btoa('{}'), offset: 0, size: 12345, mtimeMs: 1, eof: true }),
  copy: () => {},
  media: async () => ({ token: 'tok', size: 12345, mtimeMs: 1 }),
  mountModel: opts => mountViewer({
    ...opts,
    env: {
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => (await fetch('/uv.glb')).arrayBuffer() }),
    },
  }),
});
await preview.open('models/sub/character.glb');
await new Promise(r => setTimeout(r, 300));
const sel = p.querySelector('.pinspect');
sel.value = 'uv:uv';
sel.dispatchEvent(new Event('change'));
await new Promise(r => setTimeout(r, 100));
p.querySelectorAll('.muvmodes button')[1].click();
await new Promise(r => setTimeout(r, 100));
const rangeEl = p.querySelector('.muvrange');
const layoutCheck = {
  hidden: rangeEl.hidden,
  text: rangeEl.textContent,
  scrollWidth: rangeEl.scrollWidth,
  clientWidth: rangeEl.clientWidth,
  height: rangeEl.getBoundingClientRect().height,
};
preview.close();

// 2) 线框深度偏移：near = 0.01 * r，前景 5.0r 不透明遮挡后层 5.3r 细分平面（零穿透）+ 倾斜共面线框连续性
const W = 200, H = 200;
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
const gl = renderer.getContext();
const px = new Uint8Array(W * H * 4);

const occScene = new THREE.Scene();
occScene.background = new THREE.Color(0xffffff);
const occCam = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
occCam.position.set(0, 0, 0);
occCam.lookAt(0, 0, -5);

const backGroup = new THREE.Group();
const backPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(2.4, 2.4, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xe8e8e8, side: THREE.DoubleSide })
);
backPlane.position.set(0, 0, -5.3);
backGroup.add(backPlane);

const frontOccluder = new THREE.Mesh(
  new THREE.PlaneGeometry(3.0, 3.0),
  new THREE.MeshBasicMaterial({ color: 0xff0000 })
);
frontOccluder.position.set(0, 0, -5.0);
occScene.add(backGroup, frontOccluder);

const occInspector = createInspector(THREE, backGroup, 'glb');
occInspector.apply({ mode: 'wireframe' });
renderer.render(occScene, occCam);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
let bleedPixels = 0;
for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) {
  const i = (y * W + x) * 4;
  if (!(px[i] > 240 && px[i + 1] < 15 && px[i + 2] < 15)) bleedPixels++;
}

// 移走遮挡并倾斜细分平面，验证共面线框连续绘制（对比零偏移）
occScene.remove(frontOccluder);
backPlane.position.set(0, 0, -3.2);
backPlane.rotation.x = -Math.PI / 2.6;
renderer.render(occScene, occCam);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
let tiltedWirePixels = 0;
for (let i = 0; i < px.length; i += 4) {
  if (px[i] < 180 && px[i + 1] < 180 && px[i + 2] < 190) tiltedWirePixels++;
}
occInspector.dispose();

// 3) 真实骨骼动画 glb 在 WebGL2 里的像素质心位移与线框同步
const rigBuf = await (await fetch('/rig.glb')).arrayBuffer();
const gltf = await new Promise((ok, no) => new GLTFLoader().parse(rigBuf, '', ok, no));
const rigScene = new THREE.Scene();
rigScene.background = new THREE.Color(0xffffff);
const rigCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
rigCam.position.set(1.0, 0.5, 4.0);
rigCam.lookAt(1.0, 0.5, 0);
rigScene.add(gltf.scene);

let skinned = null;
gltf.scene.traverse(o => { if (o.isSkinnedMesh) skinned = o; });
// 原材质改高对比绿色，便于区分表面像素与深色线框像素
skinned.material = new THREE.MeshBasicMaterial({ color: 0x00cc44, side: THREE.DoubleSide });
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations[0]).play();

const measureCentroid = predicate => {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sumX = 0, count = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (predicate(px[i], px[i + 1], px[i + 2])) { sumX += x; count++; }
  }
  return { count, cx: count ? sumX / count : -1 };
};

const rigInspector = createInspector(THREE, gltf.scene, 'glb');
const isNonBg = (r, g, b) => r < 245 || g < 245 || b < 245;
const isSurfaceGreen = (r, g, b) => g > 180 && r < 40 && b < 100;
const isDarkWire = (r, g, b) => g < 160 && r < 150 && b < 150;

const animResults = {};
for (const mode of ['wireframe', 'normal', 'pbr:baseColor', 'uv:uv']) {
  rigInspector.apply({ mode });
  mixer.setTime(0);
  renderer.render(rigScene, rigCam);
  const t0 = mode === 'wireframe'
    ? { surface: measureCentroid(isSurfaceGreen), wire: measureCentroid(isDarkWire) }
    : measureCentroid(isNonBg);
  mixer.setTime(0.5);
  renderer.render(rigScene, rigCam);
  const t1 = mode === 'wireframe'
    ? { surface: measureCentroid(isSurfaceGreen), wire: measureCentroid(isDarkWire) }
    : measureCentroid(isNonBg);
  animResults[mode] = { t0, t1 };
}
rigInspector.dispose();
renderer.dispose();

window.__RESULT__ = { layoutCheck, bleedPixels, tiltedWirePixels, animResults, errors };
} catch (err) {
  window.__RESULT__ = { fatal: String(err?.stack ?? err), errors };
}
</script></body></html>`;

  const srv = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pageHtml); }
    if (url === '/uv.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); return res.end(glbUv); }
    if (url === '/rig.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); return res.end(glbRig); }
    try {
      const data = await readFile(path.join(repoRoot, url));
      res.writeHead(200, { 'content-type': mime[path.extname(url)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=360,640', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  t.after(() => { chrome.kill(); srv.close(); });

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome 启动超时: ${stderr}`)), 15000);
    chrome.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 (${code}): ${stderr}`)); });
  });

  const targetListUrl = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '/json/list');
  const targets = await (await fetch(targetListUrl)).json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (method, params = {}) => new Promise((ok, no) => {
    const mine = ++seq;
    const onMsg = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id === mine) { ws.removeEventListener('message', onMsg); msg.error ? no(new Error(msg.error.message)) : ok(msg.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

  let result = null;
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__RESULT__', returnByValue: true });
    if (r.result?.value) { result = r.result.value; break; }
    await new Promise(r => setTimeout(r, 150));
  }
  ws.close();
  assert.ok(result, '无头 Chrome 应返回渲染验收结果');
  assert.equal(result.fatal, undefined, `页面脚本报错: ${result.fatal}`);
  assert.deepEqual(result.errors, [], 'WebGL2 着色器编译与渲染零错误');

  // 断言 1：360px 窄屏 UV 范围两轴完整可读
  assert.equal(result.layoutCheck.hidden, false);
  assert.equal(result.layoutCheck.text, 'uv U[-12.5, 48.75] V[-3.25, 19.5]');
  assert.ok(result.layoutCheck.scrollWidth <= result.layoutCheck.clientWidth + 1, '360px 宽度下 UV 范围不水平溢出截断');
  assert.ok(result.layoutCheck.height > 10);

  // 断言 2：前景 5.0r 不透明遮挡后层 5.3r 线框零穿透，倾斜共面线框连续可见
  assert.equal(result.bleedPixels, 0, '5.0r 前景不透明表面完全遮挡 5.3r 后层线框，零穿透');
  assert.ok(result.tiltedWirePixels > 1000, `倾斜细分平面线框连续可见（实际 ${result.tiltedWirePixels} 像素）`);

  // 断言 3：真实 WebGL2 渲染的蒙皮表面与线框随骨骼动画真实位移并保持同步
  const wf = result.animResults.wireframe;
  assert.ok(wf.t0.surface.count > 100 && wf.t1.surface.count > 100, 'wireframe 表面正常渲染');
  assert.ok(wf.t0.wire.count > 40 && wf.t1.wire.count > 40, 'wireframe 线框正常渲染');
  assert.ok(wf.t1.surface.cx - wf.t0.surface.cx > 8, `wireframe 表面质心随动画右移（${wf.t0.surface.cx.toFixed(1)} -> ${wf.t1.surface.cx.toFixed(1)}）`);
  assert.ok(wf.t1.wire.cx - wf.t0.wire.cx > 8, `wireframe 线框质心随动画右移（${wf.t0.wire.cx.toFixed(1)} -> ${wf.t1.wire.cx.toFixed(1)}）`);
  assert.ok(Math.abs(wf.t1.wire.cx - wf.t1.surface.cx) < 4, `wireframe 线框与表面质心同步（wire=${wf.t1.wire.cx.toFixed(1)}, surface=${wf.t1.surface.cx.toFixed(1)}）`);

  for (const mode of ['normal', 'pbr:baseColor', 'uv:uv']) {
    const r = result.animResults[mode];
    assert.ok(r.t0.count > 100 && r.t1.count > 100, `${mode} 正常渲染`);
    assert.ok(r.t1.cx - r.t0.cx > 8, `${mode} 渲染质心随骨骼动画右移（${r.t0.cx.toFixed(1)} -> ${r.t1.cx.toFixed(1)}）`);
  }
});
