// 3D 模型查看器（设计见 docs/design/phase-3.md 第 21 节）。three.js 只在打开模型时动态导入，不影响侧栏启动。
// 字节经模块的流式服务取（coda-view://service/media/<口令>/…），自己 fetch、自己 parse。
// 按需渲染：控件变化、尺寸变化、加载完成（和贴图晚到）时画一帧；有动画并在播放时才连续渲染（是否连续只看 createPlayback）。
// 释放登记在 held 里，建一个登记一个，中途失败、中途切走也释放得干净。
import { h } from './dom.mjs';
import { formatSize } from './format.mjs';
import { BIG_FILE, Z_UP, createPlayback, directoryUrl, extensionOf, gltfJson, joinRelative, mtllibOf, serviceUrl, unsupportedExtensions } from './model3d.mjs';

const VENDOR = './vendor/three';

// 带标题的错误：标题和说明显示在模型位置。
class Friendly extends Error {
  constructor(title, detail = '') { super(detail || title); this.title = title; this.detail = detail; }
}

const count = value => value.toLocaleString('zh-CN');
const mib = n => `${(n / 1048576).toFixed(1)} MiB`;

// 页面里用的实现；测试用 env 换掉（假的 three 渲染器、手动的帧、可控的 fetch）。
const browser = {
  engine: { three: () => import(`${VENDOR}/build/three.module.mjs`), module: name => import(`${VENDOR}/jsm/${name}.mjs`) },
  fetch: (...args) => fetch(...args),
  raf: fn => requestAnimationFrame(fn),
  caf: id => cancelAnimationFrame(id),
  now: () => performance.now(),
  paint: () => new Promise(go => requestAnimationFrame(go)), // 让「解析中」先画出来，再进入会卡住页面的解析
  // 不创建任何会长期占用的东西：开个临时的 webgl2 上下文问一遍，马上放掉。
  hasWebGL() {
    let gl = null;
    try { gl = document.createElement('canvas').getContext('webgl2'); } catch { /* 当作没有 */ }
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  },
  reducedMotion: () => typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches, // 拿不到 matchMedia 按减弱处理，同页面其他动画
};

// 在 body 里挂一个模型视图。size 是文件大小（超过 64 MiB 先问）；onMeta(parts)：把「N 面」「K 段动画」交给预览头部的元信息行。
// 返回 { cancel, dispose }：cancel 只停加载和动画循环（预览逻辑关闭时），dispose 释放一切（画面退场后）。
export function mountViewer({ body, token, path, size, version, onMeta = () => {}, env = {} }) {
  const { engine, fetch: get, raf, caf, now, paint, hasWebGL, reducedMotion } = { ...browser, ...env };
  const ext = extensionOf(path);

  const status = h('div', { class: 'mstatus' });
  const resetButton = h('button', { class: 'mbtn mreset', hidden: true }, '复位视角');
  const playButton = h('button', { class: 'mbtn' }, '暂停');
  const clipSelect = h('select', { class: 'mclip', 'aria-label': '动画' });
  const bar = h('div', { class: 'mbar', hidden: true }, playButton, clipSelect);
  const stage = h('div', { class: 'mstage' }, status, resetButton, bar);
  body.classList.add('model');
  body.replaceChildren(h('div', { class: 'mview' }, stage));

  const abort = new AbortController();
  let dead = false, disposed = false, gate = null, playback = null, requestRender = () => {}, sync = () => {};
  const held = { wrapper: null, canvas: null, renderer: null, controls: null, observer: null, frame: 0, mixer: null, envTarget: null };
  const stopFrame = () => { if (held.frame) caf(held.frame); held.frame = 0; };
  const onVisibility = () => { playback?.setVisible(!document.hidden); sync(); if (!document.hidden) requestRender(); };
  document.addEventListener('visibilitychange', onVisibility);
  const release = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    stopFrame();
    held.observer?.disconnect();
    held.controls?.dispose();
    if (held.mixer && held.wrapper) { held.mixer.stopAllAction(); held.mixer.uncacheRoot(held.wrapper); }
    held.envTarget?.dispose();
    if (held.wrapper) disposeObject(held.wrapper);
    held.renderer?.dispose();
    held.renderer?.forceContextLoss();
    if (held.canvas) { held.canvas.width = held.canvas.height = 0; held.canvas.remove(); } // 连画布的后备存储一起还掉（iOS 上不还会攒着）
    Object.assign(held, { wrapper: null, canvas: null, renderer: null, controls: null, observer: null, mixer: null, envTarget: null });
  };
  const say = (text, ...extra) => { status.hidden = false; status.replaceChildren(h('p', {}, text), ...extra.filter(Boolean)); }; // 真 DOM 的 replaceChildren 会把 null 变成文字「null」
  const fail = (title, detail) => {
    resetButton.hidden = bar.hidden = true;
    say(title, detail ? h('p', { class: 'secondary caption' }, detail) : null);
  };

  // 整份读进一个预先按 content-length 分配的缓冲区，边读边报进度。
  async function download(url, label, progress) {
    let res;
    try { res = await get(url, { signal: abort.signal }); } catch (error) {
      if (dead) throw error;
      throw new Friendly('取不到模型文件', `${label}：${error?.message ?? error}`);
    }
    if (!res.ok) throw new Friendly('取不到模型文件', `${label}：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!(res.body && total)) return new Uint8Array(await res.arrayBuffer());
    let bytes = new Uint8Array(total), got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > bytes.length) { const grown = new Uint8Array(got + value.length); grown.set(bytes.subarray(0, got)); bytes = grown; }
      bytes.set(value, got);
      got += value.length;
      progress?.(got, total);
    }
    return got === bytes.length ? bytes : bytes.slice(0, got);
  }

  async function run() {
    // 1. WebGL 能不能用：不行就不必加载库。
    if (!hasWebGL()) throw new Friendly('这台设备不能显示 3D 模型', '没有 WebGL 2');
    // 2. 太大的先问。
    if (size > BIG_FILE) {
      await new Promise(go => { gate = go; say(`这个模型有 ${formatSize(size)}，加载可能耗尽这台设备的内存。`, h('button', { class: 'link', onclick: () => go() }, '仍然加载')); });
      gate = null;
      if (dead) return;
    }
    // 3. 加载库（动态导入，侧栏启动时不碰）。
    say('加载 3D 库…');
    const [THREE, { OrbitControls }, { RoomEnvironment }] = await Promise.all([engine.three(), engine.module('controls/OrbitControls'), engine.module('environments/RoomEnvironment')]);
    if (dead) return;
    // 4. 下载。
    let lastPaint = 0;
    let bytes = await download(serviceUrl(token, path, version), path, (got, total) => {
      if (now() - lastPaint > 150) { lastPaint = now(); say(`下载中 ${mib(got)} / ${mib(total)}`); }
    });
    if (dead) return;
    // 5. 解析（在主线程）。
    say('解析中…');
    await paint();
    if (dead) return;
    const manager = new THREE.LoadingManager();
    let parsed;
    try { parsed = await parseModel({ THREE, engine, manager, bytes, ext, token, path, download }); } catch (error) {
      if (dead || error instanceof Friendly) throw error;
      throw new Friendly('模型解析失败', String(error?.message ?? error));
    }
    bytes = null;
    if (dead) { disposeObject(parsed.object); return; }

    // 6. 场景和首帧。到这里以后不再有 await，建一个登记一个。
    const wrapper = new THREE.Group();
    held.wrapper = wrapper;
    wrapper.add(parsed.object);
    if (Z_UP.has(ext)) wrapper.rotation.x = -Math.PI / 2;
    wrapper.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrapper);
    if (box.isEmpty()) throw new Friendly('模型里没有可显示的几何体');
    const stats = measure(wrapper);
    const clips = parsed.animations;
    onMeta([stats.triangles > 0 || stats.points === 0 ? `${count(stats.triangles)} 面` : `${count(stats.points)} 个点`, clips.length ? `${clips.length} 段动画` : '']);

    const canvas = h('canvas', { class: 'mcanvas' });
    held.canvas = canvas;
    let renderer;
    try { renderer = held.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); } catch (error) {
      throw new Friendly('这台设备不能显示 3D 模型', `创建 WebGL 渲染器失败：${error?.message ?? error}`);
    }
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    scene.add(camera);
    // 环境光：RoomEnvironment 烤成一张环境贴图，金属材质才不发黑；再加一盏跟着相机走的主光，转到哪一面都有光。
    const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    held.envTarget = pmrem.fromScene(room, 0.04);
    scene.environment = held.envTarget.texture;
    scene.environmentIntensity = 0.6; // 默认的 1 会把中性灰的亮面照成一片白
    room.dispose();
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1.5, 1);
    camera.add(key);
    scene.add(wrapper);
    stage.prepend(canvas);
    const controls = held.controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false; // 阻尼需要常驻循环，这里只在播放动画时才有循环

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1e-6), center = sphere.center.clone();
    const resize = () => {
      const w = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
      renderer.setSize(w, height, false);
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
    };
    const fit = () => {
      const vfov = camera.fov * Math.PI / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.1;
      camera.near = radius / 100; camera.far = distance + radius * 100;
      camera.updateProjectionMatrix();
      camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.7, 1).normalize(), distance);
      controls.target.copy(center);
      controls.minDistance = radius * 0.05; controls.maxDistance = radius * 30;
      controls.update();
    };

    // 动画：只有播放时才连续渲染。
    playback = createPlayback({ clips: clips.length, reducedMotion: reducedMotion() });
    playback.setVisible(!document.hidden);
    let last = 0;
    const playClip = index => {
      held.mixer.stopAllAction();
      held.mixer.clipAction(clips[index]).reset().play();
      held.mixer.update(0); // 先摆到第 0 帧的姿势
    };
    const paintBar = () => {
      bar.hidden = clips.length === 0;
      clipSelect.hidden = clips.length < 2;
      playButton.textContent = playback.playing ? '暂停' : '播放';
      clipSelect.value = String(playback.clip);
    };
    const frame = () => {
      held.frame = 0;
      if (disposed) return;
      const t = now();
      if (playback.running) { held.mixer.update((t - last) / 1000); last = t; }
      try { renderer.render(scene, camera); } catch (error) {
        // 贴图晚到后上传失败（比如跨源的贴图被污染）会在这里抛。
        release();
        return fail('渲染出错', String(error?.message ?? error));
      }
      if (playback.running) held.frame = raf(frame);
    };
    requestRender = () => { if (!held.frame && !disposed) held.frame = raf(frame); };
    sync = () => {
      if (playback.running) { if (!held.frame) { last = now(); held.frame = raf(frame); } } else stopFrame();
    };
    if (clips.length) {
      held.mixer = new THREE.AnimationMixer(parsed.object);
      for (const [index, clip] of clips.entries()) clipSelect.append(h('option', { value: String(index) }, clip.name || `动画 ${index + 1}`));
      playClip(0);
      playButton.addEventListener('click', () => { playback.toggle(); paintBar(); sync(); });
      clipSelect.addEventListener('change', () => { playback.select(Number(clipSelect.value)); playClip(playback.clip); paintBar(); sync(); requestRender(); });
      paintBar();
    }

    resize();
    fit();
    controls.addEventListener('change', requestRender);
    held.observer = new ResizeObserver(() => { resize(); requestRender(); });
    held.observer.observe(stage);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (disposed) return;
      release();
      fail('WebGL 上下文丢失', '系统收回了显卡资源（可能同时开了太多 3D 页面），关掉再打开');
    });
    manager.onLoad = () => requestRender(); // 贴图晚到（obj 的 mtl 里的贴图）：到了就重画

    renderer.render(scene, camera);
    status.hidden = true;
    resetButton.hidden = false;
    resetButton.addEventListener('click', () => { fit(); requestRender(); });
    sync();
  }

  run().catch(error => {
    if (dead) return;
    release(); // 失败了就不占着显卡
    if (error instanceof Friendly) return fail(error.title, error.detail);
    fail('加载出错', String(error?.message ?? error));
  });

  const cancel = () => { dead = true; abort.abort(); gate?.(); playback?.stop(); stopFrame(); };
  return {
    cancel,
    dispose() {
      if (disposed) return;
      cancel();
      disposed = true;
      release();
      body.classList.remove('model');
    },
  };
}

// 按格式解析成 three 的对象。返回 { object, animations }；失败抛 Friendly 或原样的错误。
async function parseModel({ THREE, engine, manager, bytes, ext, token, path, download }) {
  const neutral = () => new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
  const exact = view => (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view.buffer : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  const done = (object, animations = []) => ({ object, animations });

  if (ext === 'glb' || ext === 'gltf') {
    let json;
    try { json = gltfJson(bytes, ext); } catch (error) { throw new Friendly('模型文件损坏，读不出来', error.message); }
    const bad = unsupportedExtensions(json);
    if (bad.length) throw new Friendly('这种压缩的模型不能预览', `用到了 ${bad.join('、')}`);
    const { GLTFLoader } = await engine.module('loaders/GLTFLoader');
    const data = ext === 'glb' ? exact(bytes) : new TextDecoder().decode(bytes);
    const gltf = await new Promise((ok, no) => new GLTFLoader(manager).parse(data, directoryUrl(token, path), ok, no)).catch(error => { throw new Error(String(error?.message ?? error)); });
    return done(gltf.scene, gltf.animations ?? []);
  }
  if (ext === 'stl') {
    const { STLLoader } = await engine.module('loaders/STLLoader');
    const geometry = new STLLoader(manager).parse(exact(bytes));
    geometry.computeVertexNormals(); // 不信文件里的面法线：很多导出工具写成 0 0 0，会画成一片白；没有索引，算出来的是每个面自己的法线
    const material = neutral();
    if (geometry.hasColors === true) material.vertexColors = true;
    return done(new THREE.Mesh(geometry, material));
  }
  if (ext === 'ply') {
    const { PLYLoader } = await engine.module('loaders/PLYLoader');
    const geometry = new PLYLoader(manager).parse(exact(bytes));
    const colored = !!geometry.getAttribute('color');
    if (!geometry.index) { // 没有面：点云
      return done(new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: colored, color: colored ? 0xffffff : 0xb8bcc4 })));
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const material = neutral();
    if (colored) material.vertexColors = true;
    return done(new THREE.Mesh(geometry, material));
  }
  if (ext === 'obj') {
    const { OBJLoader } = await engine.module('loaders/OBJLoader');
    const text = new TextDecoder().decode(bytes);
    const loader = new OBJLoader(manager);
    let withMaterials = false;
    const mtlName = mtllibOf(text);
    const mtlPath = mtlName && joinRelative(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', mtlName);
    if (mtlPath) { // 找不到 .mtl（或指向工作目录外）就用中性灰，不当错误
      try {
        const mtl = await download(serviceUrl(token, mtlPath), mtlPath);
        const { MTLLoader } = await engine.module('loaders/MTLLoader');
        const creator = new MTLLoader(manager).parse(new TextDecoder().decode(mtl), directoryUrl(token, mtlPath));
        creator.preload();
        loader.setMaterials(creator);
        withMaterials = true;
      } catch (error) { if (error?.name === 'AbortError') throw error; }
    }
    const object = loader.parse(text);
    object.traverse(o => {
      if (!o.isMesh) return;
      if (!withMaterials) o.material = neutral();
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
    });
    return done(object);
  }
  if (ext === '3mf') {
    const { ThreeMFLoader } = await engine.module('loaders/3MFLoader');
    return done(new ThreeMFLoader(manager).parse(exact(bytes)));
  }
  throw new Friendly('这种格式不能预览');
}

// 面数（按绘制计，含重复使用的几何体）和点数。
function measure(root) {
  const out = { triangles: 0, points: 0 };
  root.traverse(o => {
    const geometry = o.geometry, position = geometry?.getAttribute?.('position');
    if (!position) return;
    if (o.isMesh) out.triangles += (geometry.index ? geometry.index.count : position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    else if (o.isPoints) out.points += position.count;
  });
  out.triangles = Math.round(out.triangles);
  return out;
}

// 释放：几何体、材质、材质上的每张贴图（含 ImageBitmap）、骨架。
function disposeObject(root) {
  root.traverse(o => {
    o.geometry?.dispose();
    o.skeleton?.dispose?.();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const value of Object.values(m)) if (value?.isTexture) { value.dispose(); value.image?.close?.(); }
      m.dispose();
    }
  });
}
