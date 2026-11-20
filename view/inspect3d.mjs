// 3D 模型检视模式（不碰 DOM）：线框与法线、材质单通道、UV 通道着色。
// 所有检视材质在切换模式或 dispose 时只释放自己，绝不释放原材质持有的贴图与几何体。

export const UV_CHANNELS = ['uv', 'uv1', 'uv2', 'uv3'];

export const PBR_CHANNELS = [
  { id: 'baseColor', label: '基色' },
  { id: 'roughness', label: '粗糙度' },
  { id: 'metalness', label: '金属度' },
  { id: 'emissive', label: '自发光' },
  { id: 'ao', label: '环境遮蔽' },
  { id: 'opacity', label: '透明度' },
];

export const UV_MODES = [
  { id: 'checker', label: '棋盘格' },
  { id: 'value', label: '数值' },
  { id: 'stripes', label: '方向条纹' },
];

export const UV_DENSITIES = [
  { id: 'low', label: '低', value: 8 },
  { id: 'mid', label: '中', value: 16 },
  { id: 'high', label: '高', value: 32 },
];

const OVERLAY_FLAG = '__inspectOverlay';
const PBR_FORMATS = new Set(['glb', 'gltf']);

const fmtNum = n => {
  if (!Number.isFinite(n)) return '0';
  const clean = Math.abs(n) < 1e-6 ? 0 : Number(n.toFixed(3));
  return Object.is(clean, -0) ? '0' : String(clean);
};

// UV 检视模式追加到元信息行的文本：通道名、U 和 V 的实际范围。
export const formatUvMeta = info => `${info.name} U[${fmtNum(info.minU)}, ${fmtNum(info.maxU)}] V[${fmtNum(info.minV)}, ${fmtNum(info.maxV)}]`;

// 扫描模型能力：是否有网格（线框）、是否有法线、是否有 PBR 材质、有哪些 UV 通道及各通道在全模型上的实际 min/max。
// 同时支持 Mesh 与 Points（如点云 PLY）。
export function analyzeModel(root, ext) {
  let hasWireframe = false;
  let hasNormal = false;
  let hasPBR = false;
  const stats = new Map();
  const isPbrFormat = PBR_FORMATS.has(ext);

  root.traverse(o => {
    if ((!o.isMesh && !o.isPoints) || o.userData?.[OVERLAY_FLAG]) return;
    if (o.isMesh) {
      hasWireframe = true;
      hasNormal = true;
      if (isPbrFormat) {
        for (const m of [o.material].flat()) {
          if (m && !m.userData?.__neutral) { hasPBR = true; break; }
        }
      }
    } else if (o.isPoints && o.geometry?.getAttribute?.('normal')) {
      hasNormal = true;
    }
    const geometry = o.geometry;
    if (!geometry?.getAttribute) return;
    for (const name of UV_CHANNELS) {
      const attr = geometry.getAttribute(name);
      if (!attr || attr.count === 0) continue;
      let entry = stats.get(name);
      if (!entry) {
        entry = { name, minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity, count: 0 };
        stats.set(name, entry);
      }
      for (let i = 0; i < attr.count; i++) {
        const u = attr.getX(i), v = attr.getY(i);
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        if (u < entry.minU) entry.minU = u;
        if (u > entry.maxU) entry.maxU = u;
        if (v < entry.minV) entry.minV = v;
        if (v > entry.maxV) entry.maxV = v;
        entry.count++;
      }
    }
  });

  const uvChannels = UV_CHANNELS
    .map(name => stats.get(name))
    .filter(entry => entry && entry.count > 0)
    .map(({ name, minU, maxU, minV, maxV }) => ({ name, minU, maxU, minV, maxV }));

  return { hasWireframe, hasNormal, hasPBR, uvChannels };
}

// 顶点变换公共片段：支持静态网格、SkinnedMesh 蒙皮、MorphTarget 变形、InstancedMesh 实例化。
const SKINNED_VERTEX_HEAD = `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
`;

const SKINNED_POSITION_BODY = `
#include <begin_vertex>
#include <morphtarget_vertex>
#include <skinning_vertex>
#include <project_vertex>
`;

const uvChannelName = tex => UV_CHANNELS[tex?.channel ?? 0] ?? 'uv';
const uvAttrDecl = name => (name === 'uv' ? '' : `attribute vec2 ${name};\n`);

// 世界空间法线检视材质：正面按 normal * 0.5 + 0.5 上色；背面用醒目洋红斜条纹标识翻面。
function makeNormalMaterial(THREE) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `${SKINNED_VERTEX_HEAD}
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 worldN = objectNormal;
  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    worldN /= max(vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])), vec3(1e-12));
    worldN = im * worldN;
  #endif
  mat3 mm = mat3(modelMatrix);
  worldN /= max(vec3(dot(mm[0], mm[0]), dot(mm[1], mm[1]), dot(mm[2], mm[2])), vec3(1e-12));
  vWorldNormal = mm * worldN;
  ${SKINNED_POSITION_BODY}
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  vWorldPos = (modelMatrix * wp).xyz;
}`,
    fragmentShader: `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main() {
  if (!gl_FrontFacing) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
    vec3 backCol = mix(vec3(0.32, 0.03, 0.22), vec3(1.0, 0.12, 0.58), stripe);
    gl_FragColor = vec4(backCol, 1.0);
    return;
  }
  float len = length(vWorldNormal);
  vec3 n = len > 1e-5 ? vWorldNormal / len : normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
  });
}

// 材质单通道（平涂无光照）：根据通道和原材质构造 ShaderMaterial，支持贴图 UV 通道与纹理变换、顶点色和蒙皮。
function makePbrChannelMaterial(THREE, channel, origMat, geometry) {
  const side = origMat?.side ?? THREE.FrontSide;
  const hasGeoUv = name => Boolean(geometry?.getAttribute?.(name));
  const useTex = tex => {
    if (!tex?.isTexture) return null;
    const ch = uvChannelName(tex);
    if (!hasGeoUv(ch)) return null;
    tex.updateMatrix?.();
    return { tex, ch, matrix: tex.matrix.clone() };
  };

  if (channel === 'baseColor') {
    const t = useTex(origMat?.map);
    const useVC = Boolean(origMat?.vertexColors && geometry?.getAttribute?.('color'));
    const color = origMat?.color ? origMat.color.clone() : new THREE.Color(1, 1, 1);
    return new THREE.ShaderMaterial({
      side,
      vertexColors: useVC,
      uniforms: {
        uColor: { value: color },
        uHasMap: { value: t ? 1 : 0 },
        uMap: { value: t?.tex ?? null },
        uMapMatrix: { value: t?.matrix ?? new THREE.Matrix3() },
      },
      vertexShader: `${SKINNED_VERTEX_HEAD}
#include <color_pars_vertex>
${t ? uvAttrDecl(t.ch) : ''}
uniform mat3 uMapMatrix;
varying vec2 vTexUv;
void main() {
  #include <color_vertex>
  ${t ? `vTexUv = (uMapMatrix * vec3(${t.ch}, 1.0)).xy;` : 'vTexUv = vec2(0.0);'}
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
      fragmentShader: `
#include <color_pars_fragment>
uniform vec3 uColor;
uniform int uHasMap;
uniform sampler2D uMap;
varying vec2 vTexUv;
void main() {
  vec3 col = uColor;
  if (uHasMap == 1) col *= texture2D(uMap, vTexUv).rgb;
  #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
    col *= vColor.rgb;
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
    });
  }

  if (channel === 'emissive') {
    const t = useTex(origMat?.emissiveMap);
    const emissive = origMat?.emissive ? origMat.emissive.clone() : new THREE.Color(0, 0, 0);
    const intensity = origMat?.emissiveIntensity ?? 1.0;
    emissive.multiplyScalar(intensity);
    return new THREE.ShaderMaterial({
      side,
      uniforms: {
        uEmissive: { value: emissive },
        uHasMap: { value: t ? 1 : 0 },
        uMap: { value: t?.tex ?? null },
        uMapMatrix: { value: t?.matrix ?? new THREE.Matrix3() },
      },
      vertexShader: `${SKINNED_VERTEX_HEAD}
${t ? uvAttrDecl(t.ch) : ''}
uniform mat3 uMapMatrix;
varying vec2 vTexUv;
void main() {
  ${t ? `vTexUv = (uMapMatrix * vec3(${t.ch}, 1.0)).xy;` : 'vTexUv = vec2(0.0);'}
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
      fragmentShader: `
uniform vec3 uEmissive;
uniform int uHasMap;
uniform sampler2D uMap;
varying vec2 vTexUv;
void main() {
  vec3 col = uEmissive;
  if (uHasMap == 1) col *= texture2D(uMap, vTexUv).rgb;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
    });
  }

  if (channel === 'opacity') {
    const baseT = useTex(origMat?.map);
    const alphaT = useTex(origMat?.alphaMap);
    const opacity = origMat?.opacity ?? 1.0;
    const decls = new Set();
    if (baseT && baseT.ch !== 'uv') decls.add(`attribute vec2 ${baseT.ch};`);
    if (alphaT && alphaT.ch !== 'uv') decls.add(`attribute vec2 ${alphaT.ch};`);
    return new THREE.ShaderMaterial({
      side,
      uniforms: {
        uOpacity: { value: opacity },
        uHasBase: { value: baseT ? 1 : 0 },
        uBaseMap: { value: baseT?.tex ?? null },
        uBaseMatrix: { value: baseT?.matrix ?? new THREE.Matrix3() },
        uHasAlpha: { value: alphaT ? 1 : 0 },
        uAlphaMap: { value: alphaT?.tex ?? null },
        uAlphaMatrix: { value: alphaT?.matrix ?? new THREE.Matrix3() },
      },
      vertexShader: `${SKINNED_VERTEX_HEAD}
${[...decls].join('\n')}
uniform mat3 uBaseMatrix;
uniform mat3 uAlphaMatrix;
varying vec2 vBaseUv;
varying vec2 vAlphaUv;
void main() {
  ${baseT ? `vBaseUv = (uBaseMatrix * vec3(${baseT.ch}, 1.0)).xy;` : 'vBaseUv = vec2(0.0);'}
  ${alphaT ? `vAlphaUv = (uAlphaMatrix * vec3(${alphaT.ch}, 1.0)).xy;` : 'vAlphaUv = vec2(0.0);'}
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
      fragmentShader: `
uniform float uOpacity;
uniform int uHasBase;
uniform sampler2D uBaseMap;
uniform int uHasAlpha;
uniform sampler2D uAlphaMap;
varying vec2 vBaseUv;
varying vec2 vAlphaUv;
void main() {
  float a = uOpacity;
  if (uHasBase == 1) a *= texture2D(uBaseMap, vBaseUv).a;
  if (uHasAlpha == 1) a *= texture2D(uAlphaMap, vAlphaUv).g;
  float v = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(vec3(v), 1.0);
}`,
    });
  }

  // roughness (.g), metalness (.b), ao (.r) 都是单标量 + 单贴图灰度通道。
  const spec = channel === 'roughness'
    ? { scalar: origMat?.roughness ?? 1.0, tex: origMat?.roughnessMap, swizzle: 'g', isAo: false }
    : channel === 'metalness'
      ? { scalar: origMat?.metalness ?? 0.0, tex: origMat?.metalnessMap, swizzle: 'b', isAo: false }
      : { scalar: origMat?.aoMapIntensity ?? 1.0, tex: origMat?.aoMap, swizzle: 'r', isAo: true };
  const t = useTex(spec.tex);
  return new THREE.ShaderMaterial({
    side,
    uniforms: {
      uScalar: { value: spec.scalar },
      uHasMap: { value: t ? 1 : 0 },
      uMap: { value: t?.tex ?? null },
      uMapMatrix: { value: t?.matrix ?? new THREE.Matrix3() },
    },
    vertexShader: `${SKINNED_VERTEX_HEAD}
${t ? uvAttrDecl(t.ch) : ''}
uniform mat3 uMapMatrix;
varying vec2 vTexUv;
void main() {
  ${t ? `vTexUv = (uMapMatrix * vec3(${t.ch}, 1.0)).xy;` : 'vTexUv = vec2(0.0);'}
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
    fragmentShader: `
uniform float uScalar;
uniform int uHasMap;
uniform sampler2D uMap;
varying vec2 vTexUv;
void main() {
  float v = ${spec.isAo ? 'uHasMap == 1 ? mix(1.0, texture2D(uMap, vTexUv).r, uScalar) : 1.0' : `uScalar * (uHasMap == 1 ? texture2D(uMap, vTexUv).${spec.swizzle} : 1.0)`};
  v = clamp(v, 0.0, 1.0);
  gl_FragColor = vec4(vec3(v), 1.0);
}`,
  });
}

// UV 通道着色材质：支持棋盘格（0）、数值（1，按模型 min/max 归一化且负值区分色相）、方向条纹（2，沿 U 方向）。
function makeUvMaterial(THREE, channelInfo, uvMode, density) {
  const modeIndex = uvMode === 'value' ? 1 : uvMode === 'stripes' ? 2 : 0;
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uMode: { value: modeIndex },
      uDensity: { value: density },
      uMin: { value: new THREE.Vector2(channelInfo.minU, channelInfo.minV) },
      uMax: { value: new THREE.Vector2(channelInfo.maxU, channelInfo.maxV) },
    },
    vertexShader: `${SKINNED_VERTEX_HEAD}
${uvAttrDecl(channelInfo.name)}
varying vec2 vUvVal;
void main() {
  vUvVal = ${channelInfo.name};
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
    fragmentShader: `
uniform int uMode;
uniform float uDensity;
uniform vec2 uMin;
uniform vec2 uMax;
varying vec2 vUvVal;
void main() {
  if (uMode == 0) {
    vec2 cell = floor(vUvVal * uDensity);
    float parity = mod(cell.x + cell.y, 2.0);
    vec3 col = mix(vec3(0.22, 0.24, 0.28), vec3(0.86, 0.88, 0.90), parity);
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  if (uMode == 1) {
    vec2 span = max(uMax - uMin, vec2(1e-6));
    vec2 norm = clamp((vUvVal - uMin) / span, 0.0, 1.0);
    vec3 col;
    if (vUvVal.x < 0.0 && vUvVal.y < 0.0) {
      col = vec3(0.14, 0.52 + 0.38 * norm.y, 0.72 + 0.28 * norm.x);
    } else if (vUvVal.x < 0.0) {
      col = vec3(0.12, 0.26 + 0.54 * norm.y, 0.65 + 0.35 * norm.x);
    } else if (vUvVal.y < 0.0) {
      col = vec3(0.55 + 0.45 * norm.x, 0.14, 0.65 + 0.35 * norm.y);
    } else {
      col = vec3(norm.x, norm.y, 0.12);
    }
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float fv = fract(vUvVal.y * uDensity);
  float fw = max(fwidth(vUvVal.y * uDensity), 0.01);
  float line = 1.0 - smoothstep(0.08 - fw, 0.08 + fw, min(fv, 1.0 - fv));
  vec3 col = mix(vec3(0.18, 0.22, 0.28), vec3(0.95, 0.78, 0.22), line);
  gl_FragColor = vec4(col, 1.0);
}`,
  });
}

// 线框叠加材质：与原网格同走 GL_TRIANGLES 光栅化，按重心坐标 + fwidth 绘制屏幕空间 1px 抗锯齿边线，
// 配合 LessEqualDepth、零深度偏移：共面片元深度与原面逐 bit 一致（倾斜共面连续不断线），
// 且保留原面未偏移的遮挡深度，同一模型内近贴合的双层斜面也绝不穿透前景。
function makeWireframeMaterial(THREE, side) {
  return new THREE.ShaderMaterial({
    side,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    uniforms: {
      uColor: { value: new THREE.Color(0x111827) },
      uOpacity: { value: 0.6 },
    },
    vertexShader: `${SKINNED_VERTEX_HEAD}
attribute vec3 aBary;
varying vec3 vBary;
void main() {
  vBary = aBary;
  #include <skinbase_vertex>
  ${SKINNED_POSITION_BODY}
}`,
    fragmentShader: `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vBary;
void main() {
  vec3 d = fwidth(vBary);
  vec3 a3 = smoothstep(vec3(0.0), d * 1.25, vBary);
  float edge = 1.0 - min(min(a3.x, a3.y), a3.z);
  if (edge < 0.05) discard;
  gl_FragColor = vec4(uColor, uOpacity * edge);
}`,
  });
}

// 构造带重心坐标 aBary 的非索引几何体副本（不改动原 geometry，退出线框或 dispose 时由检视器释放）。
function makeBarycentricGeometry(THREE, geometry) {
  const wireGeo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const count = wireGeo.attributes.position?.count ?? 0;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const corner = i % 3;
    bary[i * 3 + corner] = 1;
  }
  wireGeo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return wireGeo;
}

// 为一个网格创建与原网格同步变形的线框叠加对象（共享 skeleton / morph / instanceMatrix，使用独立重心几何体）。
function makeWireOverlay(THREE, mesh, wireGeo, wireMat) {
  let overlay;
  if (mesh.isSkinnedMesh) {
    overlay = new THREE.SkinnedMesh(wireGeo, wireMat);
    overlay.bindMode = mesh.bindMode;
    overlay.bind(mesh.skeleton, mesh.bindMatrix);
  } else if (mesh.isInstancedMesh) {
    overlay = new THREE.InstancedMesh(wireGeo, wireMat, mesh.count);
    overlay.instanceMatrix = mesh.instanceMatrix;
  } else {
    overlay = new THREE.Mesh(wireGeo, wireMat);
  }
  if (mesh.morphTargetInfluences) {
    overlay.morphTargetInfluences = mesh.morphTargetInfluences;
    overlay.morphTargetDictionary = mesh.morphTargetDictionary;
  }
  overlay.raycast = () => {};
  overlay.renderOrder = (mesh.renderOrder ?? 0) + 1;
  overlay.userData = { [OVERLAY_FLAG]: true };
  return overlay;
}

// 点云法线检视材质（Points）：按世界空间点法线 normal * 0.5 + 0.5 上色。
function makePointsNormalMaterial(THREE, pointSize = 2) {
  return new THREE.ShaderMaterial({
    uniforms: { uPointSize: { value: Math.max(2, pointSize) } },
    vertexShader: `
uniform float uPointSize;
varying vec3 vWorldNormal;
void main() {
  mat3 mm = mat3(modelMatrix);
  vec3 worldN = normal / max(vec3(dot(mm[0], mm[0]), dot(mm[1], mm[1]), dot(mm[2], mm[2])), vec3(1e-12));
  vWorldNormal = mm * worldN;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPointSize;
}`,
    fragmentShader: `
varying vec3 vWorldNormal;
void main() {
  float len = length(vWorldNormal);
  vec3 n = len > 1e-5 ? vWorldNormal / len : vec3(0.0, 1.0, 0.0);
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
  });
}

// 点云 UV 检视材质（Points）：棋盘格、数值归一化（区分正负色相）、方向条纹（点元无屏幕导数，按固定带宽度取线）。
function makePointsUvMaterial(THREE, channelInfo, uvMode, density, pointSize = 2) {
  const modeIndex = uvMode === 'value' ? 1 : uvMode === 'stripes' ? 2 : 0;
  return new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: modeIndex },
      uDensity: { value: density },
      uPointSize: { value: Math.max(2, pointSize) },
      uMin: { value: new THREE.Vector2(channelInfo.minU, channelInfo.minV) },
      uMax: { value: new THREE.Vector2(channelInfo.maxU, channelInfo.maxV) },
    },
    vertexShader: `
${uvAttrDecl(channelInfo.name)}
uniform float uPointSize;
varying vec2 vUvVal;
void main() {
  vUvVal = ${channelInfo.name};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPointSize;
}`,
    fragmentShader: `
uniform int uMode;
uniform float uDensity;
uniform vec2 uMin;
uniform vec2 uMax;
varying vec2 vUvVal;
void main() {
  if (uMode == 0) {
    vec2 cell = floor(vUvVal * uDensity);
    float parity = mod(cell.x + cell.y, 2.0);
    gl_FragColor = vec4(mix(vec3(0.22, 0.24, 0.28), vec3(0.86, 0.88, 0.90), parity), 1.0);
    return;
  }
  if (uMode == 1) {
    vec2 span = max(uMax - uMin, vec2(1e-6));
    vec2 norm = clamp((vUvVal - uMin) / span, 0.0, 1.0);
    vec3 col;
    if (vUvVal.x < 0.0 && vUvVal.y < 0.0) {
      col = vec3(0.14, 0.52 + 0.38 * norm.y, 0.72 + 0.28 * norm.x);
    } else if (vUvVal.x < 0.0) {
      col = vec3(0.12, 0.26 + 0.54 * norm.y, 0.65 + 0.35 * norm.x);
    } else if (vUvVal.y < 0.0) {
      col = vec3(0.55 + 0.45 * norm.x, 0.14, 0.65 + 0.35 * norm.y);
    } else {
      col = vec3(norm.x, norm.y, 0.12);
    }
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float fv = fract(vUvVal.y * uDensity);
  float line = step(min(fv, 1.0 - fv), 0.12);
  gl_FragColor = vec4(mix(vec3(0.18, 0.22, 0.28), vec3(0.95, 0.78, 0.22), line), 1.0);
}`,
  });
}

// 创建模型检视控制器：记住原始材质（同时支持 Mesh 与 Points），管理检视材质与叠加对象的生命周期。
export function createInspector(THREE, root, ext) {
  const caps = analyzeModel(root, ext);
  const uvMap = new Map(caps.uvChannels.map(info => [info.name, info]));
  const originals = new Map();
  root.traverse(o => {
    if ((o.isMesh || o.isPoints) && !o.userData?.[OVERLAY_FLAG]) originals.set(o, o.material);
  });

  const ownedMaterials = new Set();
  const ownedGeometries = new Set();
  const overlays = [];
  let state = { mode: 'material', uvMode: 'checker', uvDensity: 16 };
  let disposed = false;

  const track = mat => { ownedMaterials.add(mat); return mat; };
  const trackGeo = geo => { ownedGeometries.add(geo); return geo; };

  function clearInspect() {
    for (const { parent, overlay } of overlays) parent.remove(overlay);
    overlays.length = 0;
    for (const [obj, material] of originals) obj.material = material;
    for (const mat of ownedMaterials) mat.dispose();
    ownedMaterials.clear();
    for (const geo of ownedGeometries) geo.dispose();
    ownedGeometries.clear();
  }

  function apply(next = {}) {
    if (disposed) return { meta: '' };
    const mode = next.mode ?? state.mode;
    const uvMode = next.uvMode ?? state.uvMode;
    const uvDensity = next.uvDensity ?? state.uvDensity;

    // 校验不可用选项：无网格、无法线、无 PBR 或无对应 UV 通道时回退到材质。
    let resolved = mode;
    if (resolved === 'wireframe' && !caps.hasWireframe) resolved = 'material';
    if (resolved === 'normal' && !caps.hasNormal) resolved = 'material';
    if (resolved.startsWith('pbr:') && !caps.hasPBR) resolved = 'material';
    if (resolved.startsWith('uv:') && !uvMap.has(resolved.slice(3))) resolved = 'material';

    state = { mode: resolved, uvMode, uvDensity };
    clearInspect();

    if (resolved === 'material') return { meta: '' };

    if (resolved === 'wireframe') {
      const matBySide = new Map();
      const wireMatFor = orig => {
        const list = [orig].flat().filter(Boolean);
        const side = list.length === 1 ? (list[0].side ?? THREE.FrontSide) : THREE.DoubleSide;
        if (!matBySide.has(side)) matBySide.set(side, track(makeWireframeMaterial(THREE, side)));
        return matBySide.get(side);
      };
      for (const [obj, orig] of originals) {
        if (!obj.isMesh || !obj.geometry?.attributes?.position) continue;
        const wireGeo = trackGeo(makeBarycentricGeometry(THREE, obj.geometry));
        const overlay = makeWireOverlay(THREE, obj, wireGeo, wireMatFor(orig));
        obj.add(overlay);
        overlays.push({ parent: obj, overlay });
      }
      return { meta: '' };
    }

    if (resolved === 'normal') {
      let meshMat = null, pointsFallback = null;
      for (const [obj, orig] of originals) {
        if (obj.isMesh) {
          if (!meshMat) meshMat = track(makeNormalMaterial(THREE));
          obj.material = meshMat;
        } else if (obj.isPoints) {
          if (obj.geometry?.getAttribute?.('normal')) {
            obj.material = track(makePointsNormalMaterial(THREE, orig?.size));
          } else {
            if (!pointsFallback) pointsFallback = track(new THREE.PointsMaterial({ size: Math.max(1, orig?.size ?? 1), sizeAttenuation: false, color: 0x666666 }));
            obj.material = pointsFallback;
          }
        }
      }
      return { meta: '' };
    }

    if (resolved.startsWith('pbr:')) {
      const channel = resolved.slice(4);
      for (const [obj, orig] of originals) {
        if (!obj.isMesh) continue;
        if (Array.isArray(orig)) {
          obj.material = orig.map(m => track(makePbrChannelMaterial(THREE, channel, m, obj.geometry)));
        } else {
          obj.material = track(makePbrChannelMaterial(THREE, channel, orig, obj.geometry));
        }
      }
      return { meta: '' };
    }

    if (resolved.startsWith('uv:')) {
      const channelName = resolved.slice(3);
      const info = uvMap.get(channelName);
      let meshUvMat = null, meshFallback = null, pointsFallback = null;
      for (const [obj, orig] of originals) {
        const hasAttr = Boolean(obj.geometry?.getAttribute?.(channelName));
        if (obj.isMesh) {
          if (hasAttr) {
            if (!meshUvMat) meshUvMat = track(makeUvMaterial(THREE, info, uvMode, uvDensity));
            obj.material = meshUvMat;
          } else {
            if (!meshFallback) meshFallback = track(new THREE.MeshBasicMaterial({ color: 0x666666, side: THREE.DoubleSide }));
            obj.material = meshFallback;
          }
        } else if (obj.isPoints) {
          if (hasAttr) {
            obj.material = track(makePointsUvMaterial(THREE, info, uvMode, uvDensity, orig?.size));
          } else {
            if (!pointsFallback) pointsFallback = track(new THREE.PointsMaterial({ size: Math.max(1, orig?.size ?? 1), sizeAttenuation: false, color: 0x666666 }));
            obj.material = pointsFallback;
          }
        }
      }
      return { meta: formatUvMeta(info) };
    }

    return { meta: '' };
  }

  return {
    caps,
    get state() { return { ...state }; },
    get ownedCount() { return ownedMaterials.size; },
    apply,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInspect();
      originals.clear();
    },
  };
}
