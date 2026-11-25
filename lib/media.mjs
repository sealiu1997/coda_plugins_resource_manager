// 音视频、图片和 3D 模型的本机流式服务（设计见 docs/design/phase-3.md 第 20、21 节）：页面的 <audio>、<video>、<img> 指向 coda-view://service/media/<口令>/<相对路径>，3D 查看器用 fetch 取字节。
// 口令由主模块按视图发，映射到那个视图当时的根目录；根目录变了、换会话、视图关了就作废。只接 GET、HEAD，只读文件，路径校验同 READ。
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ErrorCode, HTML_HEAD_BYTES, htmlContentType, servedType } from '../view/protocol.mjs';
import { fromFsError, resolveInRoot } from './paths.mjs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, etag' };

const SVG_TYPE = 'image/svg+xml';
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const STATUS = {
  [ErrorCode.INVALID_PATH]: 400, [ErrorCode.OUTSIDE_ROOT]: 403, [ErrorCode.DENIED]: 403,
  [ErrorCode.NOT_FOUND]: 404, [ErrorCode.NOT_DIR]: 404, [ErrorCode.NOT_FILE]: 404,
};

// 'bytes=a-b' | 'bytes=a-' | 'bytes=-n' → { start, end }（含 end）；不认得的写法（含多段）当作没带 Range，越界返回 'bad'。
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

export function createMedia() {
  const grants = new Map(); // 口令 → 根目录

  const grant = root => {
    const token = randomUUID().replaceAll('-', '');
    grants.set(token, root);
    return token;
  };
  const revoke = token => { if (token) grants.delete(token); };

  async function handler(req, res) {
    // 所有回答（成功、206、304、HEAD、预检、各种错误）统一在这里加：writeHead 会合并 setHeader 的头。
    res.setHeader('x-content-type-options', 'nosniff');
    const end = status => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...CORS }); res.end(); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range, if-none-match, if-range' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405);
    const [, token, ...rest] = new URL(req.url, 'http://x').pathname.split('/');
    const root = grants.get(token);
    if (root === undefined) return end(404);
    let path;
    try { path = rest.map(decodeURIComponent).join('/'); } catch { return end(400); }
    const type = servedType(path);
    if (!type) return end(415);
    // SVG 直接打开时不让里面的脚本执行；作为 <img> 和 Markdown 图片显示不受影响（设计 27.5，待真机确认）。
    if (type === SVG_TYPE) res.setHeader('content-security-policy', SVG_CSP);
    let handle;
    try {
      // 加 O_NONBLOCK：避免指向命名管道（FIFO）时在 open 阶段永久阻塞，随后由 info.isFile() 及时拒绝。
      handle = await open(await resolveInRoot(root, path), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile()) return end(404);
      const { size } = info;
      // 不缓存：每次都问（no-cache）；内容没变回 304，续传带的 If-Range 对不上就整份重来。
      const etag = `"${size}-${Math.floor(info.mtimeMs)}"`;
      // 跨源头：3D 模型页面用 fetch 取字节、WebGL 贴图要带 crossOrigin 的 <img>，都需要。口令本身就是授权，所以放开来源。
      const headers = { 'content-type': type, 'accept-ranges': 'bytes', etag, 'cache-control': 'no-cache', ...CORS };
      if (String(req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache', ...CORS });
        return res.end();
      }
      const ifRange = req.headers['if-range'];
      const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, size);
      if (range === 'bad') { res.writeHead(416, { 'content-range': `bytes */${size}`, ...CORS }); return res.end(); }
      // HTML 的 content-type 按文件开头的实际编码写 charset：宿主把响应的 charset 交给渲染引擎，响应头优先于文件里的 meta，写死 utf-8 会让 GBK 页面乱码。
      // 按文件开头判断，与是否 Range 无关；读失败走下面的错误路径（此时还没写响应头）。
      if (type.startsWith('text/html')) {
        const head = Buffer.alloc(Math.min(HTML_HEAD_BYTES, size));
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        headers['content-type'] = htmlContentType(head.subarray(0, bytesRead));
      }
      const [status, start, last] = range ? [206, range.start, range.end] : [200, 0, size - 1];
      if (range) headers['content-range'] = `bytes ${start}-${last}/${size}`;
      headers['content-length'] = String(size === 0 ? 0 : last - start + 1);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || size === 0) return res.end();
      // 客户端中途断开：pipeline 随 res 关闭销毁读流。
      await pipeline(handle.createReadStream({ start, end: last, autoClose: false }), res).catch(() => {});
    } catch (error) {
      // 被 O_NOFOLLOW 拒绝说明校验后被换成了链接，同读文本按越界处理。
      const code = NOFOLLOW && (error?.code === 'ELOOP' || error?.code === 'EMLINK') ? ErrorCode.OUTSIDE_ROOT : fromFsError(error).code;
      if (!res.headersSent) end(STATUS[code] ?? 500); else res.destroy();
    } finally { await handle?.close().catch(() => {}); }
  }

  return { handler, grant, revoke };
}
