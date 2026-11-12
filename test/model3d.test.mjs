// 3D 预览里不碰 DOM、不碰 three 的部分（第 21 节）：地址、glb 头和压缩扩展检测、mtllib、相对路径、文本切换的条件、动画的播放状态。
import assert from 'node:assert/strict';
import test from 'node:test';
import { BIG_FILE, Z_UP, createPlayback, directoryUrl, extensionOf, gltfJson, joinRelative, mayBeText, mtllibOf, offersTextView, serviceUrl, unsupportedExtensions } from '../view/model3d.mjs';

function glb(json, { magic = 0x46546c67, type = 0x4e4f534a, claim } = {}) {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(magic, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + padded.length, 8);
  head.writeUInt32LE(claim ?? padded.length, 12); head.writeUInt32LE(type, 16);
  return new Uint8Array(Buffer.concat([head, padded]));
}

test('常量：64 MiB 的门槛；stl、ply、3mf 按 Z 轴朝上', () => {
  assert.equal(BIG_FILE, 64 * 1024 * 1024);
  assert.deepEqual([...Z_UP].sort(), ['3mf', 'ply', 'stl']);
});

test('地址：逐段编码，目录带结尾斜杠，v 可选', () => {
  assert.equal(serviceUrl('tok', 'a b/模型.glb', '12-34'), 'coda-view://service/media/tok/a%20b/%E6%A8%A1%E5%9E%8B.glb?v=12-34');
  assert.equal(serviceUrl('tok', 'x.stl'), 'coda-view://service/media/tok/x.stl');
  assert.equal(directoryUrl('tok', 'a b/c/x.gltf'), 'coda-view://service/media/tok/a%20b/c/');
  assert.equal(directoryUrl('tok', 'x.gltf'), 'coda-view://service/media/tok/');
  assert.equal(extensionOf('a/B.GLB'), 'glb');
  assert.equal(extensionOf('noext'), '');
});

test('glb 的 JSON 块和压缩扩展（extensionsUsed、extensionsRequired 里的 Draco、meshopt、basisu）', () => {
  const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_unlit', 'KHR_draco_mesh_compression'], extensionsRequired: ['EXT_meshopt_compression'] };
  assert.deepEqual(gltfJson(glb(json), 'glb'), json);
  assert.deepEqual(unsupportedExtensions(json), ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']);
  assert.deepEqual(unsupportedExtensions({ extensionsUsed: ['KHR_texture_basisu'] }), ['KHR_texture_basisu']);
  assert.deepEqual(unsupportedExtensions({ extensionsRequired: ['KHR_draco_mesh_compression'] }), ['KHR_draco_mesh_compression']);
  assert.deepEqual(unsupportedExtensions({ extensionsUsed: ['KHR_materials_unlit', 'EXT_texture_webp'] }), []);
  assert.deepEqual(unsupportedExtensions({}), []);
  assert.deepEqual(gltfJson(new TextEncoder().encode(JSON.stringify(json)), 'gltf'), json);
});

test('损坏的 glb 抛带原因的错：文件头不对、第一块不是 JSON、被截断、JSON 读不出来', () => {
  assert.throws(() => gltfJson(new Uint8Array(10), 'glb'), /不是有效的 glb/);
  assert.throws(() => gltfJson(glb({}, { magic: 1 }), 'glb'), /不是有效的 glb/);
  assert.throws(() => gltfJson(glb({}, { type: 1 }), 'glb'), /第一块不是 JSON/);
  assert.throws(() => gltfJson(glb({}, { claim: 9999 }), 'glb'), /截断/);
  const whole = glb({ asset: { version: '2.0' } });
  assert.throws(() => gltfJson(whole.subarray(0, whole.length - 8), 'glb'), /总长度.*被截断/, '头里的总长度大于文件');
  assert.throws(() => gltfJson(new TextEncoder().encode('{oops'), 'gltf'), /JSON 读不出来/);
});

test('mtllib 和相对路径', () => {
  assert.equal(mtllibOf('# x\nmtllib my model.mtl \nv 0 0 0\n'), 'my model.mtl');
  assert.equal(mtllibOf('mtllib sub\\a.mtl\r\n'), 'sub/a.mtl');
  assert.equal(mtllibOf('  mtllib\tindented.mtl'), 'indented.mtl');
  assert.equal(mtllibOf('v 0 0 0\nf 1 2 3'), null);
  assert.equal(mtllibOf('# mtllib commented.mtl'), null, '注释里的不算');
  assert.equal(joinRelative('a/b', '../c.mtl'), 'a/c.mtl');
  assert.equal(joinRelative('', './c.mtl'), 'c.mtl');
  assert.equal(joinRelative('a', 'sub//d/./e.png'), 'a/sub/d/e.png');
  assert.equal(joinRelative('a', '../../c.mtl'), null, '跑出根目录');
  assert.equal(joinRelative('', '../c.mtl'), null);
});

test('「3D / 文本」切换的显示条件：gltf、obj、stl、ply 且内容是文本；二进制、glb、3mf 和别的文件不显示', () => {
  for (const path of ['a/x.gltf', 'x.OBJ', 'x.stl', 'x.ply']) {
    assert.equal(offersTextView(path, 'text'), true, `${path} 文本`);
    assert.equal(offersTextView(path, 'binary'), false, `${path} 二进制`);
  }
  for (const path of ['x.glb', 'x.3mf', 'x.mtl', 'x.bin', 'x.txt']) assert.equal(offersTextView(path, 'text'), false, path);
  assert.deepEqual(['a.gltf', 'a.OBJ', 'a.stl', 'a.ply', 'a.glb', 'a.3mf'].map(mayBeText), [true, true, true, true, false, false], 'glb、3mf 不用读来判断');
});

test('动画状态：有动画且没开减弱动态效果就自动播放；暂停、选段、不可见、停止', () => {
  const none = createPlayback({ clips: 0, reducedMotion: false });
  assert.deepEqual([none.playing, none.running], [false, false], '没有动画不跑');
  none.toggle();
  assert.equal(none.running, false);

  const p = createPlayback({ clips: 3, reducedMotion: false });
  assert.deepEqual([p.playing, p.running, p.clip, p.clips], [true, true, 0, 3], '自动循环播放第一段');
  p.toggle();
  assert.deepEqual([p.playing, p.running], [false, false], '暂停');
  p.select(2);
  assert.deepEqual([p.clip, p.playing, p.running], [2, true, true], '选一段就从它开始播');
  p.select(3); p.select(-1); p.select(1.5);
  assert.equal(p.clip, 2, '越界的选择不理');
  p.setVisible(false);
  assert.deepEqual([p.playing, p.running], [true, false], '页面不可见：不跑，但没按暂停');
  p.setVisible(true);
  assert.equal(p.running, true, '可见了接着跑');
  p.toggle(); p.setVisible(false); p.setVisible(true);
  assert.equal(p.running, false, '用户暂停过的，可见了也不自己跑');
  p.toggle();
  p.stop();
  assert.equal(p.running, false, '停止之后不再跑');
  p.toggle(); p.select(0); p.setVisible(true);
  assert.equal(p.running, false, '停止是终态');
});

test('减弱动态效果：不自动播放；用户点播放或选段才播', () => {
  const p = createPlayback({ clips: 2, reducedMotion: true });
  assert.deepEqual([p.playing, p.running], [false, false]);
  p.toggle();
  assert.equal(p.running, true);
  const q = createPlayback({ clips: 2, reducedMotion: true });
  q.select(1);
  assert.deepEqual([q.clip, q.running], [1, true]);
});
