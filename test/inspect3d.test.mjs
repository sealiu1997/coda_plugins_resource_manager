// 3D 模型检视模式（view/inspect3d.mjs）：真实 GLTFLoader / STLLoader 解析、UV 通道范围统计、材质单通道、蒙皮支持与释放不泄漏。
import assert from 'node:assert/strict';
import test from 'node:test';
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

  // 线框：原材质与深度不改动，叠加重心坐标三角形 ShaderMaterial（LessEqualDepth），退出时释放检视几何体且不动原几何体
  let origGeoDisposed = 0;
  const realGeoDispose = geometry.dispose.bind(geometry);
  geometry.dispose = () => { origGeoDisposed++; realGeoDispose(); };
  inspector.apply({ mode: 'wireframe' });
  assert.equal(inspector.state.mode, 'wireframe');
  assert.equal(mesh.material, neutral);
  assert.equal(neutral.polygonOffset, false);
  assert.equal(mesh.children.length, 1);
  const wireOverlay = mesh.children[0];
  let wireGeoDisposed = 0;
  const realWireGeoDispose = wireOverlay.geometry.dispose.bind(wireOverlay.geometry);
  wireOverlay.geometry.dispose = () => { wireGeoDisposed++; realWireGeoDispose(); };
  assert.ok(wireOverlay.geometry.getAttribute('aBary'), '线框几何体带重心坐标 aBary');
  assert.equal(wireOverlay.material.isShaderMaterial, true);
  assert.equal(wireOverlay.material.depthTest, true);
  assert.equal(wireOverlay.material.depthWrite, false);
  assert.equal(wireOverlay.material.depthFunc, THREE.LessEqualDepth);

  // 法线：替换成 ShaderMaterial，清除线框叠加层并释放检视几何体（原几何体不释放）
  inspector.apply({ mode: 'normal' });
  assert.equal(inspector.state.mode, 'normal');
  assert.equal(wireGeoDisposed, 1, '退出线框释放检视几何体');
  assert.equal(origGeoDisposed, 0, '不释放原几何体');
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

  for (const mode of ['normal', 'pbr:baseColor', 'uv:uv']) {
    inspector.apply({ mode });
    const vs = skinned.material.vertexShader;
    assert.match(vs, /#include <skinning_pars_vertex>/, mode);
    assert.ok(vs.indexOf('#include <skinning_vertex>') > 0 && vs.indexOf('#include <skinning_vertex>') < vs.indexOf('#include <project_vertex>'), `${mode} 蒙皮变换位于投影之前`);
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
