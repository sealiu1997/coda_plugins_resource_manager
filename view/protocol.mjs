// 模块和页面共用的消息格式与上限。只用浏览器和 Node 都有的东西。

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
  SEARCH: 'search',
  DIR_SIZE_CANCEL: 'dir_size_cancel', SEARCH_CANCEL: 'search_cancel', // 没有回答
  SESSION: 'session', ROOT: 'root', CHANGED: 'changed',
  LISTED: 'listed', CHUNK: 'chunk', STATTED: 'statted', SIZED: 'sized', ADDED: 'added', SEARCHED: 'searched',
});

// 请求 → 回答的类型。模块回答、页面分发都查这一张。
export const ReplyOf = Object.freeze({
  [Type.LIST]: Type.LISTED, [Type.READ]: Type.CHUNK, [Type.STAT]: Type.STATTED,
  [Type.DIR_SIZE]: Type.SIZED, [Type.ADD_TEXT]: Type.ADDED, [Type.SEARCH]: Type.SEARCHED,
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
