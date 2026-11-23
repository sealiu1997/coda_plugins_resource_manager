// 模块和页面共用的消息格式与上限。只用浏览器和 Node 都有的东西。
import {
  DOCKERFILE_NAMES, ENV_NAMES, GIT_NAMES, LICENSE_NAMES, MAKEFILE_NAMES, MARKDOWN_EXTS, RUBY_NAMES,
  basenameLower, isEnvName,
} from './lookup.mjs';

// 宿主按 JSON.stringify({ message }).length 计量，超过的消息会被丢弃。
export const MESSAGE_LIMIT = 128 * 1024;
export const CHUNK_BYTES = 64 * 1024;
// 目录一页的上限（序列化后的 UTF-8 字节，含信封）；信封（类型、代次、请求号、游标）留给下面这些字节。
export const PAGE_BYTES = 96 * 1024;
export const ENVELOPE_BYTES = 4096;
export const TEXT_LIMIT = 1024 * 1024;
export const IMAGE_LIMIT = 8 * 1024 * 1024;
// 前这么多字节里有 NUL 就当二进制（照 Coda 判断二进制的惯例）。
export const SNIFF_BYTES = 8000;
export const REQUEST_ID_MAX = 64;
// 输入框草稿的文字上限（UTF-16 单元）；拼完超过就不写。
export const DRAFT_LIMIT = 100_000;
// 文件名搜索（设计见 docs/design/phase-3.md 第 18 节）：搜索词去掉首尾空白后的长度上限（UTF-16 单元）、结果条数上限。
export const QUERY_MAX = 256;
export const SEARCH_RESULTS = 500;

export const Type = Object.freeze({
  HELLO: 'hello', REFRESH: 'refresh', LIST: 'list', READ: 'read', STAT: 'stat', DIR_SIZE: 'dir_size', ADD_TEXT: 'add_text',
  SEARCH: 'search', MEDIA: 'media',
  DIR_SIZE_CANCEL: 'dir_size_cancel', SEARCH_CANCEL: 'search_cancel', // 没有回答
  SESSION: 'session', ROOT: 'root', CHANGED: 'changed',
  LISTED: 'listed', CHUNK: 'chunk', STATTED: 'statted', SIZED: 'sized', ADDED: 'added', SEARCHED: 'searched', MEDIA_GRANTED: 'media_granted',
});

// 请求 → 回答的类型。模块回答、页面分发都查这一张。
export const ReplyOf = Object.freeze({
  [Type.LIST]: Type.LISTED, [Type.READ]: Type.CHUNK, [Type.STAT]: Type.STATTED,
  [Type.DIR_SIZE]: Type.SIZED, [Type.ADD_TEXT]: Type.ADDED, [Type.SEARCH]: Type.SEARCHED, [Type.MEDIA]: Type.MEDIA_GRANTED,
});
export const isReply = type => Object.values(ReplyOf).includes(type);

export const RootState = Object.freeze({ READY: 'ready', NONE: 'none', PREPARING: 'preparing', GONE: 'gone' });

export const ErrorCode = Object.freeze({
  NO_ROOT: 'no_root', INVALID_PATH: 'invalid_path', OUTSIDE_ROOT: 'outside_root', NOT_FOUND: 'not_found',
  NOT_DIR: 'not_dir', NOT_FILE: 'not_file', DENIED: 'denied', CURSOR_EXPIRED: 'cursor_expired',
  INVALID_OFFSET: 'invalid_offset', INVALID_SORT: 'invalid_sort', TOO_LARGE: 'too_large', IO: 'io_error',
  DRAFT_FAILED: 'draft_failed', DRAFT_TOO_LONG: 'draft_too_long', INVALID_QUERY: 'invalid_query',
});

// 目录排序：值是下面四种之一，缺省（请求不带 sort）是名称。方向由排序键决定，只在 lib/tree.mjs 里定义一处。
export const SortKey = Object.freeze({ NAME: 'name', KIND: 'kind', DATE: 'date', SIZE: 'size' });
export const DEFAULT_SORT = SortKey.NAME;
// 是四种之一的返回它，否则 null（含旧版本保存过的 { key, desc } 对象）。
export const parseSort = raw => (Object.values(SortKey).includes(raw) ? raw : null);

// 目录条目的 kind：dir、file；link 是指向工作目录外或已失效的链接；other 是不能打开的（套接字、名字含控制字符等）。
// 指向工作目录内的链接按目标显示成 dir 或 file，并带 link: true。
// 条目还可带整数 size（只有文件有）和 mtimeMs（向下取整）；读不到时不带。
export const EntryKind = Object.freeze({ DIR: 'dir', FILE: 'file', LINK: 'link', OTHER: 'other' });
// 文件块的 kind。
export const ContentKind = Object.freeze({ TEXT: 'text', IMAGE: 'image', BINARY: 'binary' });

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

// 按扩展名给出图片的 MIME 类型，不是图片返回 null。
export function imageType(name) {
  const dot = String(name).lastIndexOf('.');
  return dot < 0 ? null : IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

// 音视频和图片走模块的本机流式服务（设计见 docs/design/phase-3.md 第 20 节）：扩展名 → [种类, MIME 类型]，页面决定怎么显示、模块决定服务哪些，都查这一张。
const MEDIA_TYPES = {
  mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], aac: ['audio', 'audio/aac'], wav: ['audio', 'audio/wav'], flac: ['audio', 'audio/flac'],
  ogg: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], aiff: ['audio', 'audio/aiff'], aif: ['audio', 'audio/aiff'], caf: ['audio', 'audio/x-caf'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/x-m4v'], mov: ['video', 'video/quicktime'], webm: ['video', 'video/webm'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'],
  svg: ['image', 'image/svg+xml'], avif: ['image', 'image/avif'], heic: ['image', 'image/heic'], heif: ['image', 'image/heif'],
  bmp: ['image', 'image/bmp'], tif: ['image', 'image/tiff'], tiff: ['image', 'image/tiff'],
  // 3D 模型（第 21 节）：页面用 three.js 画，字节同样经流式服务取。
  glb: ['model', 'model/gltf-binary'], gltf: ['model', 'model/gltf+json'], stl: ['model', 'model/stl'], obj: ['model', 'model/obj'],
  ply: ['model', 'model/ply'], '3mf': ['model', 'model/3mf'],
};
// 模型的伴随文件：服务要供应（gltf 的 .bin、obj 的 .mtl），但页面不把它们当媒体预览（.mtl 仍是文本，.bin 仍是二进制）。
const COMPANION_TYPES = { bin: 'application/octet-stream', mtl: 'text/plain; charset=utf-8' };
// 文件打开偏好的类别（按类别记忆默认打开方式，初始全部走资源管理器页内预览）。
export const OpenCategory = Object.freeze({
  MARKDOWN: 'markdown',
  HTML: 'html',
  DOCUMENT: 'document', // PDF / Office / iWork
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  MODEL: 'model',
  TEXT: 'text', // 代码、纯文本及其他文件
});
export const OpenWith = Object.freeze({ INLINE: 'inline', CODA: 'coda' });
// 经 Coda 的 coda.open 预览的文档类型：统一经插件本机流式服务供应，复用 resolveInRoot 与 O_NOFOLLOW 校验，防止越出工作目录。
const MARKDOWN_TYPES = Object.fromEntries(MARKDOWN_EXTS.map(ext => [ext, 'text/markdown; charset=utf-8']));
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
};
// 常见目录内文本/代码文件：供流式服务响应 Markdown 相对链接以及用户手动选「在 Coda 中打开」；不改变媒体预览判定。
const TEXT_SERVED_TYPES = {
  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  rtf: 'text/plain; charset=utf-8', // 页内按纯文本显示，Coda 打开 rtf 也只显示源码
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonc: 'application/json; charset=utf-8',
  json5: 'application/json; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  xml: 'text/plain; charset=utf-8',
  xhtml: 'application/xhtml+xml; charset=utf-8',
  plist: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  scss: 'text/plain; charset=utf-8',
  sass: 'text/plain; charset=utf-8',
  less: 'text/plain; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  mts: 'text/plain; charset=utf-8',
  cts: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  pyw: 'text/plain; charset=utf-8',
  pyi: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  swift: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  kt: 'text/plain; charset=utf-8',
  kts: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  cc: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  cxx: 'text/plain; charset=utf-8',
  hpp: 'text/plain; charset=utf-8',
  hh: 'text/plain; charset=utf-8',
  m: 'text/plain; charset=utf-8',
  mm: 'text/plain; charset=utf-8',
  cs: 'text/plain; charset=utf-8',
  php: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8',
  erb: 'text/plain; charset=utf-8',
  lua: 'text/plain; charset=utf-8',
  r: 'text/plain; charset=utf-8',
  pl: 'text/plain; charset=utf-8',
  pm: 'text/plain; charset=utf-8',
  dart: 'text/plain; charset=utf-8',
  scala: 'text/plain; charset=utf-8',
  vue: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  bash: 'text/plain; charset=utf-8',
  zsh: 'text/plain; charset=utf-8',
  fish: 'text/plain; charset=utf-8',
  mk: 'text/plain; charset=utf-8',
  dockerfile: 'text/plain; charset=utf-8',
  diff: 'text/plain; charset=utf-8',
  patch: 'text/plain; charset=utf-8',
  graphql: 'text/plain; charset=utf-8',
  gql: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  cfg: 'text/plain; charset=utf-8',
  mod: 'text/plain; charset=utf-8',
  sum: 'text/plain; charset=utf-8',
  gradle: 'text/plain; charset=utf-8',
  lock: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
};
// 常见无后缀或点开头的文本/配置文件名（共享部分来自 view/lookup.mjs，与 icons.mjs / languages.mjs 同一事实来源）。
const TEXT_SERVED_NAMES = new Set([
  ...GIT_NAMES, ...ENV_NAMES, ...LICENSE_NAMES, ...RUBY_NAMES, ...MAKEFILE_NAMES, ...DOCKERFILE_NAMES,
  'readme', 'changelog', 'contributing', 'authors', 'vagrantfile', 'procfile',
  '.editorconfig', '.npmrc', '.nvmrc', '.dockerignore', '.prettierrc', '.eslintrc', '.babelrc',
]);
// 查证过 Coda 播放器不支持的视频：按扩展名直接不预览，不读字节（mkv 容器不支持，avi 的 canPlayType 说 maybe 但实际报错）。
const NO_PREVIEW = new Set(['mkv', 'avi']);

function extensionOf(name) {
  const str = String(name);
  const base = str.slice(str.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? null : base.slice(dot + 1).toLowerCase();
}

// 按扩展名给出 { kind: 'audio' | 'video' | 'image' | 'model', type, preview }；不是媒体文件返回 null。preview 为 false 的没有 type，不经服务。
export function mediaOf(name) {
  const ext = extensionOf(name);
  if (!ext) return null;
  if (NO_PREVIEW.has(ext)) return { kind: 'video', type: null, preview: false };
  const entry = Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : null;
  return entry ? { kind: entry[0], type: entry[1], preview: true } : null;
}

// 按扩展名归类用于记忆打开方式（OpenCategory 之一）。
export function openCategoryOf(name) {
  const ext = extensionOf(name);
  if (ext) {
    if (Object.hasOwn(MARKDOWN_TYPES, ext)) return OpenCategory.MARKDOWN;
    if (HTML_EXTS.has(ext)) return OpenCategory.HTML;
    if (Object.hasOwn(DOCUMENT_TYPES, ext)) return OpenCategory.DOCUMENT;
  }
  const media = mediaOf(name);
  if (media) return media.kind; // 'image' | 'audio' | 'video' | 'model' 与 OpenCategory 一致
  return OpenCategory.TEXT;
}

// 流式服务肯供应的文件的 MIME 类型：能预览的媒体、模型的伴随文件、文档、Markdown 和常见文本/代码；其余返回 null（服务回 415）。
// 精确文件名（如 .env、Makefile）优先；带已知扩展名（如 .env.json、.env.md、.env.pdf）按扩展名返回准确 MIME；其余 .env.* 以 text/plain 兜底。
export function servedType(name) {
  const media = mediaOf(name);
  if (media) return media.preview ? media.type : null;
  const base = basenameLower(name);
  if (TEXT_SERVED_NAMES.has(base)) return 'text/plain; charset=utf-8';
  const ext = extensionOf(name);
  if (ext) {
    if (Object.hasOwn(COMPANION_TYPES, ext)) return COMPANION_TYPES[ext];
    if (Object.hasOwn(MARKDOWN_TYPES, ext)) return MARKDOWN_TYPES[ext];
    if (Object.hasOwn(DOCUMENT_TYPES, ext)) return DOCUMENT_TYPES[ext];
    if (Object.hasOwn(TEXT_SERVED_TYPES, ext)) return TEXT_SERVED_TYPES[ext];
  }
  if (isEnvName(base)) return 'text/plain; charset=utf-8';
  return null;
}

// 能不能交给 Coda 打开（行菜单的切换项、「不预览」页的按钮、独立窗口的退路、按记下的偏好自动打开）：流式服务肯供应才行。宿主有没有 coda.open、根目录是否就绪由各页面自己查。
export const canOpenInCoda = path => servedType(path) !== null;

// 相对路径的规则只在这一处：模块（lib/paths.mjs）校验请求，页面恢复保存的 cwd 时用同一个函数。
// 空串是根目录；拒绝过长、控制字符、绝对路径和 `..`。返回 { segments }（去掉空段和 `.`）或 { problem }（给人看的原因）。
export const MAX_PATH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const hasControl = text => CONTROL.test(text);
export function splitRelative(path) {
  if (typeof path !== 'string' || path.length > MAX_PATH) return { problem: '路径无效' };
  if (hasControl(path)) return { problem: '路径含控制字符' };
  if (path.startsWith('/')) return { problem: '只接受相对路径' };
  const segments = path.split('/').filter(part => part !== '' && part !== '.');
  if (segments.includes('..')) return { problem: '路径不能含 ..' };
  return { segments };
}

// 相对路径接在目录后面：合并 ./ 和 ../，不让它跑出根目录（跑出去返回 null）。3D 模型与 Markdown 共用这一处。
export function joinRelative(dir, rel) {
  const out = dir ? dir.split('/').filter(Boolean) : [];
  for (const part of String(rel).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length === 0) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

// 流式服务里文件的地址：逐段编码相对路径，可选带 ?v= 版本参数。预览、3D 模型与 coda.open 共用这一处。
export const encodeServicePath = path => String(path).split('/').map(encodeURIComponent).join('/');
export const serviceUrl = (token, path, version = '') => `coda-view://service/media/${token}/${encodeServicePath(path)}${version ? `?v=${version}` : ''}`;

// 隐藏名单：按全名比。目录树、图标视图的「显示隐藏文件」和文件名搜索（模块和页面）共用这一处。
const HIDDEN = new Set(['.git', '.DS_Store']);
export const isHidden = name => HIDDEN.has(name);

// 文件名搜索的比较：名字和搜索词都先 NFC 规范化再 toLowerCase，包含就算。模块判断匹配、页面加粗用同一个函数。
export const foldName = text => text.normalize('NFC').toLowerCase();

// 页面加粗：搜索词（已 foldName）在名字里第一次出现的位置，返回原名字里的 [起点, 终点)（UTF-16 下标），没有或映射不出来返回 null。
// 比较是在规范化后的串上做的：把原名字切成「一个基字符加它的组合符号」，每段各自规范化、变小写，拼起来要等于整串的结果，
// 这样才能建「规范化后的位置 → 原名字的位置」的对照；拼不起来（如谚文字母的组合）、命中段的两端落在一段中间（一个字符变小写后变成两个）都不加粗。
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
export function matchSpan(name, folded) {
  const whole = foldName(name), at = whole.indexOf(folded);
  if (at < 0 || folded === '') return null;
  const starts = new Map(), ends = new Map(); // 规范化后的位置 → 原名字的位置
  let from = 0, to = 0, out = '';
  for (const [piece] of name.matchAll(CLUSTER)) {
    const folding = foldName(piece);
    starts.set(from, to);
    from += folding.length;
    to += piece.length;
    ends.set(from, to);
    out += folding;
  }
  if (out !== whole || !starts.has(at) || !ends.has(at + folded.length)) return null;
  return [starts.get(at), ends.get(at + folded.length)];
}

export const messageSize = message => JSON.stringify({ message }).length;

// 带 code 的错误，模块里到处抛，主模块转成回答里的 error。
export function fail(code, message) {
  return Object.assign(new Error(message), { code, protocol: true });
}
