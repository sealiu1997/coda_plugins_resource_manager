// 真实 Chrome WebGL2 验收（同 test/harness/layout.mjs，不依赖默认 npm test 的纯 Node 环境，由 CI 和本地显式执行）：
// 1) near=0.01r 透视相机下，15.0r 前景不透明表面完全遮挡 15.01r 后层细分平面线框（零穿透），且倾斜共面细分平面边线连续；
// 2) 带骨骼动画的真实 glb 在 t=0 与 t=0.5 两个时刻的实际渲染像素质心明显位移，线框与蒙皮表面严格同步；
// 3) 360px 窄屏子目录文本 glTF 切到 UV 数值模式，两轴范围完整可读不水平溢出。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGlbWithUvs, buildSkinnedAnimatedGlb } from '../support/glb.mjs';

const CHROME_CANDIDATES = [
  process.argv[2],
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) {
  console.error('找不到可用的 Chrome / Chromium，可传路径参数或设置 CHROME_PATH');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

const nextFrame = () => new Promise(r => requestAnimationFrame(r));
async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const val = check();
    if (val) return val;
    await nextFrame();
  }
  throw new Error('等待超时：' + label);
}

try {
  // 1) 360px 窄屏子目录文本 glTF：条件等待 UV 选项就绪后切换数值模式，验证两轴范围可读不溢出
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
  const sel = await waitFor(() => p.querySelector('.pinspect:not([hidden])'), '检视选择器挂载');
  await waitFor(() => sel.querySelector('option[value="uv:uv"]'), 'UV 选项就绪');
  sel.value = 'uv:uv';
  sel.dispatchEvent(new Event('change'));
  const valueBtn = await waitFor(() => [...p.querySelectorAll('.muvmodes button')].find(b => b.textContent === '数值'), '数值模式按钮');
  valueBtn.click();
  const rangeEl = await waitFor(() => {
    const el = p.querySelector('.muvrange');
    return el && !el.hidden && el.textContent.includes('U[') && el.textContent.includes('V[') ? el : null;
  }, 'UV 范围条显示');
  await nextFrame();
  const layoutCheck = {
    hidden: rangeEl.hidden,
    text: rangeEl.textContent,
    scrollWidth: rangeEl.scrollWidth,
    clientWidth: rangeEl.clientWidth,
    height: rangeEl.getBoundingClientRect().height,
  };
  preview.close();

  // 2) 同一模型内双层 45° 倾斜遮挡（near = 0.01r，前层 15.0r 与后层 15.01r 同在 modelRoot 内）：
  // 前层为 2x2 红色不透明平面，后层为 16x16 密集细分平面；在避开前层自身边线的格子内部采样验证零穿透，
  // 同时验证前层自身 45° 倾斜边线与密集细分倾斜平面边线均连续可见。
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
  occCam.lookAt(0, 0, -15);

  const modelRoot = new THREE.Group();
  const backPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(10.0, 10.0, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xe8e8e8, side: THREE.DoubleSide })
  );
  backPlane.position.set(0, 0, -15.01);
  backPlane.rotation.x = -Math.PI / 4;

  const frontPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(24.0, 24.0, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide })
  );
  frontPlane.position.set(0, 0, -15.0);
  frontPlane.rotation.x = -Math.PI / 4;

  // 前后两层放在同一个检视根节点内！
  modelRoot.add(backPlane, frontPlane);
  occScene.add(modelRoot);

  const occInspector = createInspector(THREE, modelRoot, 'glb');
  occInspector.apply({ mode: 'wireframe' });
  renderer.render(occScene, occCam);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // 前层 24x24 1x1 平面完全覆盖整个视口且只有一条主对角线；在中心左右两块避开对角线的象限采样（x:[50..85], y:[115..145] 与 x:[115..150], y:[115..145]），
  // 避开对角线的那一块内前层无内部边线，而后层 16x16 密集网格在此处布满边线。
  const countNonRed = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (!(px[i] > 240 && px[i + 1] < 15 && px[i + 2] < 15)) n++;
    }
    return n;
  };
  const patchA = countNonRed(50, 85, 115, 145);
  const patchB = countNonRed(115, 150, 115, 145);
  const bleedPixels = Math.min(patchA, patchB); // 避开前层单条对角线的那个象限块必须 0 穿透
  // 统计前层自身对角线线框像素（在整张图内红底叠加深色线框的像素）
  let frontWirePixels = 0;
  for (let y = 30; y < 170; y++) for (let x = 30; x < 170; x++) {
    const i = (y * W + x) * 4;
    if (px[i] < 230 && px[i] > 40 && px[i + 1] < 100 && px[i + 2] < 100) frontWirePixels++;
  }

  // 移走前层，验证倾斜 45° 密集细分平面的线框连续绘制
  frontPlane.visible = false;
  renderer.render(occScene, occCam);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let tiltedWirePixels = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] < 190 && px[i + 1] < 190 && px[i + 2] < 200) tiltedWirePixels++;
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

  // 4) 点云 PLY（带已知法线与 UV）在 WebGL2 中逐模式即时采样三个分离点的 RGB，验证着色结果有区分度且符合预期
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.7, 0, 0, 0, 0, 0, 0.7, 0, 0], 3));
  ptGeo.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  ptGeo.setAttribute('uv', new THREE.Float32BufferAttribute([-0.25, 0.01, 0.05, 0.05, 0.15, 0.05], 2));
  const ptGroup = new THREE.Group();
  ptGroup.add(new THREE.Points(ptGeo, new THREE.PointsMaterial({ size: 16, sizeAttenuation: false })));
  const ptScene = new THREE.Scene();
  ptScene.background = new THREE.Color(0xffffff);
  ptScene.add(ptGroup);
  const ptCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  ptCam.position.set(0, 0, 3);
  ptCam.lookAt(0, 0, 0);
  const samplePointPixels = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [-0.7, 0, 0.7].map(worldX => {
      const p = new THREE.Vector3(worldX, 0, 0).project(ptCam);
      const sx = Math.round((p.x * 0.5 + 0.5) * W);
      const sy = Math.round((p.y * 0.5 + 0.5) * H);
      const i = (sy * W + sx) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    });
  };
  const ptInspector = createInspector(THREE, ptGroup, 'ply');
  ptInspector.apply({ mode: 'normal' });
  renderer.render(ptScene, ptCam);
  const ptNormalRgb = samplePointPixels();

  const ptUvRgb = {};
  for (const uvMode of ['checker', 'value', 'stripes']) {
    ptInspector.apply({ mode: 'uv:uv', uvMode, uvDensity: 8 });
    renderer.render(ptScene, ptCam);
    ptUvRgb[uvMode] = samplePointPixels();
  }
  ptInspector.dispose();
  ptGeo.dispose();

  renderer.dispose();

  window.__RESULT__ = { layoutCheck, bleedPixels, frontWirePixels, tiltedWirePixels, animResults, ptNormalRgb, ptUvRgb, errors };
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

try {
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome 启动超时: ${stderr}`)), 20000);
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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: 'window.__RESULT__', returnByValue: true });
    if (r.result?.value) { result = r.result.value; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  ws.close();

  assert.ok(result, '无头 Chrome 应返回渲染验收结果');
  assert.equal(result.fatal, undefined, `页面脚本报错: ${result.fatal}`);
  assert.deepEqual(result.errors, [], 'WebGL2 着色器编译与渲染零错误');

  // 1) 360px 窄屏 UV 范围两轴完整可读
  assert.equal(result.layoutCheck.hidden, false);
  assert.equal(result.layoutCheck.text, 'uv U[-12.5, 48.75] V[-3.25, 19.5]');
  assert.ok(result.layoutCheck.scrollWidth <= result.layoutCheck.clientWidth + 1, '360px 宽度下 UV 范围不水平溢出截断');
  assert.ok(result.layoutCheck.height > 10);

  // 2) 同一模型内 15.0r 前层 45° 斜面完全遮挡 15.01r 后层 45° 斜面线框（零穿透），前层与倾斜细分平面边线均连续可见
  assert.equal(result.bleedPixels, 0, '同一模型内 15.0r 前层 45° 斜面完全遮挡 15.01r 后层线框，零穿透');
  assert.ok(result.frontWirePixels > 100, `前层 45° 斜面自身边线连续可见（实际 ${result.frontWirePixels} 像素）`);
  assert.ok(result.tiltedWirePixels > 1000, `倾斜 45° 密集细分平面线框连续可见（实际 ${result.tiltedWirePixels} 像素）`);

  // 3) 真实 WebGL2 渲染的蒙皮表面与线框随骨骼动画真实位移并保持同步
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
  // 4) 点云 PLY：法线三轴方向颜色准确；UV 三种模式各自即时采样且颜色区分明显
  const [nX, nY, nZ] = result.ptNormalRgb;
  assert.ok(nX[0] > 230 && Math.abs(nX[1] - 128) < 15 && Math.abs(nX[2] - 128) < 15, `法线 +X 着色准确（实际 ${nX}）`);
  assert.ok(nY[1] > 230 && Math.abs(nY[0] - 128) < 15 && Math.abs(nY[2] - 128) < 15, `法线 +Y 着色准确（实际 ${nY}）`);
  assert.ok(nZ[2] > 230 && Math.abs(nZ[0] - 128) < 15 && Math.abs(nZ[1] - 128) < 15, `法线 +Z 着色准确（实际 ${nZ}）`);

  const [, chkDark, chkLight] = result.ptUvRgb.checker;
  assert.ok(chkDark[0] < 90 && chkLight[0] > 200, `点云 UV 棋盘格区分深浅格（dark=${chkDark}, light=${chkLight}）`);

  const [valNeg, , valPos] = result.ptUvRgb.value;
  assert.ok(valNeg[2] > valNeg[0] + 80, `点云 UV 数值模式负值为冷蓝色相（实际 ${valNeg}）`);
  assert.ok(valPos[0] > 220 && valPos[2] < 50, `点云 UV 数值模式最大正值为高红暖色（实际 ${valPos}）`);

  const [strLine, strBase] = result.ptUvRgb.stripes;
  assert.ok(strLine[0] > 220 && strLine[1] > 180 && strLine[2] < 80, `点云 UV 方向条纹命中亮黄条纹（实际 ${strLine}）`);
  assert.ok(strBase[0] < 70 && strBase[1] < 80 && strBase[2] < 90, `点云 UV 方向条纹非条纹处为深灰底色（实际 ${strBase}）`);

  console.log('inspect3d WebGL2 验收通过:', JSON.stringify({
    layoutCheck: result.layoutCheck,
    bleedPixels: result.bleedPixels,
    frontWirePixels: result.frontWirePixels,
    tiltedWirePixels: result.tiltedWirePixels,
    wireframeSync: {
      surfaceShift: Number((wf.t1.surface.cx - wf.t0.surface.cx).toFixed(2)),
      wireShift: Number((wf.t1.wire.cx - wf.t0.wire.cx).toFixed(2)),
      gapAtT1: Number(Math.abs(wf.t1.wire.cx - wf.t1.surface.cx).toFixed(2)),
    },
  }));
} finally {
  chrome.kill();
  srv.close();
}
