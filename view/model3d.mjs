// 3D 模型预览里不碰 DOM、不碰 three 的部分（设计见 docs/design/phase-3.md 第 21 节）：服务地址、glTF 的头和压缩扩展检查、obj 的 mtllib、相对路径、文本切换的条件、动画的播放状态。Node 里能直接测。
import { ContentKind } from './protocol.mjs';

export const BIG_FILE = 64 * 1024 * 1024; // 超过这个大小先问一声再读（整份读进内存，iPhone 上可能直接崩掉页面）
export const Z_UP = new Set(['stl', 'ply', '3mf']); // 这几种格式多半是 Z 轴朝上，转成 three.js 的 Y 轴朝上

// 这三种压缩 three 自带的 GLTFLoader 不能直接解（要另外的解码器和 wasm），不带，提示不能预览。
export const UNSUPPORTED_GLTF = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
// 流式服务里文件的地址；v 只用来在文件变了之后换地址。
export const serviceUrl = (token, path, version = '') => `coda-view://service/media/${token}/${encodePath(path)}${version ? `?v=${version}` : ''}`;
// 一个文件所在目录的地址，带结尾的斜杠：gltf 的 .bin、贴图和 obj 的 .mtl 按相对路径接在它后面。
export const directoryUrl = (token, path) => {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return `coda-view://service/media/${token}/${dir ? `${encodePath(dir)}/` : ''}`;
};
export const extensionOf = path => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');

// 「3D / 文本」切换：这四种格式既可以是文本也可以是二进制，要读一块看内容；内容是文本（模块按前 8000 字节没有 NUL 判断）才提供。glb、3mf 一定是二进制，不用读。
const TEXTUAL = new Set(['gltf', 'obj', 'stl', 'ply']);
export const mayBeText = path => TEXTUAL.has(extensionOf(path));
export const offersTextView = (path, contentKind) => mayBeText(path) && contentKind === ContentKind.TEXT;

// glTF 的 JSON：.gltf 是文本；.glb 是 12 字节头，后面第一块必须是 JSON 块。读不出来抛带原因的错。
export function gltfJson(bytes, ext) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text;
  if (ext === 'glb') {
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('不是有效的 glb（文件头不是 glTF）');
    const declared = view.getUint32(8, true), length = view.getUint32(12, true), type = view.getUint32(16, true);
    if (declared > bytes.byteLength) throw new Error(`glb 头里写的总长度是 ${declared} 字节，文件只有 ${bytes.byteLength} 字节（文件被截断）`);
    if (type !== 0x4e4f534a) throw new Error('glb 的第一块不是 JSON');
    if (20 + length > bytes.byteLength) throw new Error('glb 的 JSON 块超出文件末尾（文件被截断）');
    text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  } else text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text); } catch (error) { throw new Error(`glTF 的 JSON 读不出来：${error.message}`); }
}

// extensionsRequired 和 extensionsUsed 里有不支持的压缩，返回它们的名字（可能为空）。
export function unsupportedExtensions(json) {
  const names = new Set([...(json?.extensionsRequired ?? []), ...(json?.extensionsUsed ?? [])]);
  return UNSUPPORTED_GLTF.filter(name => names.has(name));
}

// obj 里第一行 mtllib 给的材质文件名（可以含空格）；没有返回 null。
export function mtllibOf(text) {
  const match = /^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/m.exec(text);
  return match ? match[1].replaceAll('\\', '/') : null;
}

// 相对路径接在目录后面：合并 ./ 和 ../，不让它跑出根目录（跑出去返回 null）。
export function joinRelative(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length === 0) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

// PLY 头里 element face 的个数（ASCII 和二进制都适用）；没有或读不出头返回 0，按点云处理。
export function plyFaceCount(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 65536));
  const end = /^end_header/m.exec(head);
  if (!end) return 0;
  const face = /^element[ \t]+face[ \t]+(\d+)/m.exec(head.slice(0, end.index));
  return face ? Number(face[1]) : 0;
}

// 动画的播放状态：是否在连续渲染（running）只看这里。clips 是动画段数；reducedMotion 为真时不自动播放。
// 选了一段就从头播；页面不可见时不跑，可见了接着跑（用户没按暂停的话）；停止之后不再跑。
export function createPlayback({ clips, reducedMotion }) {
  const state = { playing: clips > 0 && !reducedMotion, clip: 0, visible: true, stopped: false };
  return {
    get clips() { return clips; },
    get playing() { return state.playing; },
    get clip() { return state.clip; },
    get running() { return clips > 0 && state.playing && state.visible && !state.stopped; },
    toggle() { if (clips > 0) state.playing = !state.playing; },
    select(index) { if (Number.isInteger(index) && index >= 0 && index < clips) { state.clip = index; state.playing = true; } },
    setVisible(visible) { state.visible = visible; },
    stop() { state.stopped = true; },
  };
}
