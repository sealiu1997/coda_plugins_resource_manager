// 3D 模型检视模式（view/inspect3d.mjs）：真实 GLTFLoader / STLLoader 解析、UV 通道范围统计、材质单通道、蒙皮支持与释放不泄漏。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../view/vendor/three/build/three.module.mjs';
import { GLTFLoader } from '../view/vendor/three/jsm/loaders/GLTFLoader.mjs';
import { STLLoader } from '../view/vendor/three/jsm/loaders/STLLoader.mjs';
import { PBR_CHANNELS, analyzeModel, createInspector, formatUvMeta } from '../view/inspect3d.mjs';

// 构造合法的二进制 .glb，包含一个三角形和指定的 TEXCOORD 通道数据（数组形式，每通道 6 个 float）。
function buildGlbWithUvs(uvSets = {}, material = { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.4, 0.2, 1], roughnessFactor: 0.35, metallicFactor: 0.7 } }) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const chunks = [Buffer.from(positions.buffer)];
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }];
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }];
  const attributes = { POSITION: 0 };

  let offset = positions.byteLength;
  for (const [semantic, values] of Object.entries(uvSets)) {
    const arr = new Float32Array(values);
    const buf = Buffer.from(arr.buffer);
    chunks.push(buf);
    const bvIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.byteLength, target: 34962 });
    const accIndex = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: 5126, count: 3, type: 'VEC2' });
    attributes[semantic] = accIndex;
    offset += buf.byteLength;
  }

  const binRaw = Buffer.concat(chunks);
  const binPad = Buffer.alloc((4 - (binRaw.length % 4)) % 4, 0);
  const bin = Buffer.concat([binRaw, binPad]);

  const jsonObj = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [material],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  const jsonRaw = Buffer.from(JSON.stringify(jsonObj));
  const jsonPad = Buffer.alloc((4 - (jsonRaw.length % 4)) % 4, 0x20);
  const json = Buffer.concat([jsonRaw, jsonPad]);

  const total = 12 + 8 + json.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(json.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);

  const all = Buffer.concat([head, jsonHead, json, binHead, bin]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

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

  // 线框：原材质不动，叠加一个 wireframe 子网格
  inspector.apply({ mode: 'wireframe' });
  assert.equal(inspector.state.mode, 'wireframe');
  assert.equal(mesh.material, neutral);
  assert.equal(mesh.children.length, 1);
  assert.equal(mesh.children[0].material.wireframe, true);

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

  for (const mode of ['normal', 'pbr:baseColor', 'uv:uv']) {
    inspector.apply({ mode });
    assert.match(skinned.material.vertexShader, /#include <skinning_pars_vertex>/, mode);
    assert.match(skinned.material.vertexShader, /#include <skinning_vertex>/, mode);
  }

  inspector.dispose();
  assert.equal(skinned.material, orig);
  assert.equal(skinned.children.find(c => c.userData?.__inspectOverlay), undefined);
});
