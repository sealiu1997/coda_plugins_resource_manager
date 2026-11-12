// 音视频和图片的本机流式服务（设计见 docs/design/phase-3.md 第 20 节）：页面的 <audio>、<video>、<img> 指向 coda-view://service/media/<口令>/<相对路径>。
// 口令由主模块按视图发，映射到那个视图当时的根目录；根目录变了、换会话、视图关了就作废。只接 GET、HEAD，只读文件，路径校验同 READ。
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ErrorCode, mediaOf } from '../view/protocol.mjs';
import { fromFsError, resolveInRoot } from './paths.mjs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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
    const end = status => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405);
    const [, token, ...rest] = new URL(req.url, 'http://x').pathname.split('/');
    const root = grants.get(token);
    if (root === undefined) return end(404);
    let path;
    try { path = rest.map(decodeURIComponent).join('/'); } catch { return end(400); }
    const media = mediaOf(path);
    if (!media?.preview) return end(415);
    let handle;
    try {
      handle = await open(await resolveInRoot(root, path), constants.O_RDONLY | NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) return end(404);
      const { size } = info;
      // 不缓存：每次都问（no-cache）；内容没变回 304，续传带的 If-Range 对不上就整份重来。
      const etag = `"${size}-${Math.floor(info.mtimeMs)}"`;
      const headers = { 'content-type': media.type, 'accept-ranges': 'bytes', etag, 'cache-control': 'no-cache' };
      if (String(req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        return res.end();
      }
      const ifRange = req.headers['if-range'];
      const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, size);
      if (range === 'bad') { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
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
