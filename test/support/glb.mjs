// 构造合法的二进制 .glb 供测试用（真实 GLTFLoader 解析）：支持多套 TEXCOORD 通道和骨骼蒙皮动画。

function packGlb(jsonObj, binBuf) {
  const jsonRaw = Buffer.from(JSON.stringify(jsonObj));
  const json = Buffer.concat([jsonRaw, Buffer.alloc((4 - (jsonRaw.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat([binBuf, Buffer.alloc((4 - (binBuf.length % 4)) % 4, 0)]);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  const all = Buffer.concat([head, jh, json, bh, bin]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

// 一个三角形 + 指定的 TEXCOORD 通道数据（每通道 6 个 float）。
export function buildGlbWithUvs(uvSets = {}, material = { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.4, 0.2, 1], roughnessFactor: 0.35, metallicFactor: 0.7 } }) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const chunks = [Buffer.from(positions.buffer)];
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }];
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }];
  const attributes = { POSITION: 0 };

  let offset = positions.byteLength;
  for (const [semantic, values] of Object.entries(uvSets)) {
    const buf = Buffer.from(new Float32Array(values).buffer);
    chunks.push(buf);
    const bvIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34962 });
    const accIndex = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: 5126, count: 3, type: 'VEC2' });
    attributes[semantic] = accIndex;
    offset += buf.length;
  }

  const bin = Buffer.concat(chunks);
  return packGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [material],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    buffers: [{ byteLength: bin.length + ((4 - (bin.length % 4)) % 4) }],
    bufferViews,
    accessors,
  }, bin);
}

// 带 2 根骨骼与平移关键帧动画（1 秒内 tipBone 从 x=0 移到 x=2）的合法 .glb。
export function buildSkinnedAnimatedGlb() {
  const positions = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]);
  const uvs = new Float32Array([0, 0, 0, 1, 1, 0]);
  const joints = new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const ibm = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
  ]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 1, 0, 2, 1, 0]);

  const parts = [positions, uvs, joints, weights, ibm, times, translations].map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const bufferViews = [];
  let offset = 0;
  for (const buf of parts) {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) offset += pad;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    offset += buf.length;
  }
  const bin = Buffer.alloc(offset);
  parts.forEach((buf, i) => buf.copy(bin, bufferViews[i].byteOffset));

  return packGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, skin: 0 },
      { name: 'rootBone', children: [2], translation: [0, 0, 0] },
      { name: 'tipBone', translation: [0, 1, 0] },
    ],
    skins: [{ inverseBindMatrices: 4, joints: [1, 2], skeleton: 1 }],
    animations: [{
      name: 'moveTip',
      samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }],
    }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.7, 0.9, 1], roughnessFactor: 0.4, metallicFactor: 0.2 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, material: 0 }] }],
    buffers: [{ byteLength: bin.length + ((4 - (bin.length % 4)) % 4) }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 5, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 6, componentType: 5126, count: 2, type: 'VEC3' },
    ],
  }, bin);
}
