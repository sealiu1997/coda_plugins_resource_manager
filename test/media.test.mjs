// 音视频和图片的本机流式服务（lib/media.mjs，设计见第 20 节）：真实 http 服务器 + 真实临时目录。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMedia } from '../lib/media.mjs';
import { mediaOf } from '../view/protocol.mjs';
import { tempDir } from './support/fake.mjs';

const BODY = Buffer.from('0123456789abcdefghij'); // 20 字节

async function serving(t) {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.mp3'), BODY);
  await writeFile(join(root, 'sub', 'v 1.mp4'), BODY);
  await writeFile(join(root, 'empty.wav'), '');
  await writeFile(join(root, 'notes.txt'), 'x');
  await writeFile(join(root, 'old.mkv'), BODY);
  await writeFile(join(root, 'old.avi'), BODY);
  await writeFile(join(base, 'secret.mp3'), 'SECRET');
  await symlink(join(base, 'secret.mp3'), join(root, 'leak.mp3'));
  await symlink('a.mp3', join(root, 'inner.mp3'));
  await mkdir(join(root, 'dir.mp3'));
  const media = createMedia(), server = createServer(media.handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const token = media.grant(root);
  const url = (path, tok = token) => `http://127.0.0.1:${server.address().port}/${tok}/${path}`;
  const get = async (path, { method = 'GET', headers = {}, tok } = {}) => {
    const res = await fetch(url(path, tok), { method, headers });
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  };
  return { root, base, media, token, get, url, server };
}

test('类型表：音频、视频、图片按扩展名（不分大小写），mkv、avi 认得但不预览，别的不是媒体', () => {
  assert.deepEqual(mediaOf('a/b.MP3'), { kind: 'audio', type: 'audio/mpeg', preview: true });
  assert.deepEqual(mediaOf('x.mov'), { kind: 'video', type: 'video/quicktime', preview: true });
  assert.deepEqual(mediaOf('x.HEIC'), { kind: 'image', type: 'image/heic', preview: true });
  for (const ext of ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'caf', 'mp4', 'm4v', 'mov', 'webm', 'png', 'jpg', 'gif', 'webp', 'svg', 'avif', 'heic', 'bmp', 'tiff']) {
    assert.equal(mediaOf(`f.${ext}`)?.preview, true, ext);
  }
  for (const name of ['clip.mkv', 'old.AVI']) assert.deepEqual(mediaOf(name), { kind: 'video', type: null, preview: false }, name);
  for (const name of ['a.txt', 'mp3', 'mkv', 'noext', '.gitignore', 'a.mp3x', '']) assert.equal(mediaOf(name), null, name);
});

test('整份读取：200，类型、长度、接受 Range、no-cache 加 ETag，不是 immutable', async t => {
  const { get } = await serving(t);
  const { res, body } = await get('a.mp3');
  assert.equal(res.status, 200);
  assert.ok(body.equals(BODY));
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('content-length'), '20');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('etag'), /^"20-\d+"$/);
  assert.equal((await get('sub/v%201.mp4')).res.headers.get('content-type'), 'video/mp4', '路径逐段解码');
});

test('Range：a-b、a-、-n、越过末尾截到末尾；越界 416；多段当作整份；空文件', async t => {
  const { get } = await serving(t);
  const range = async value => get('a.mp3', { headers: { range: value } });
  let r = await range('bytes=2-5');
  assert.deepEqual([r.res.status, r.res.headers.get('content-range'), r.res.headers.get('content-length'), r.body.toString()], [206, 'bytes 2-5/20', '4', '2345']);
  r = await range('bytes=15-');
  assert.deepEqual([r.res.status, r.body.toString()], [206, 'fghij']);
  r = await range('bytes=-3');
  assert.deepEqual([r.res.status, r.res.headers.get('content-range'), r.body.toString()], [206, 'bytes 17-19/20', 'hij']);
  r = await range('bytes=18-99');
  assert.deepEqual([r.res.status, r.res.headers.get('content-range'), r.body.toString()], [206, 'bytes 18-19/20', 'ij']);
  r = await range('bytes=20-');
  assert.deepEqual([r.res.status, r.res.headers.get('content-range')], [416, 'bytes */20']);
  r = await range('bytes=5-2');
  assert.equal(r.res.status, 416);
  r = await range('bytes=0-1,5-6');
  assert.deepEqual([r.res.status, r.body.length], [200, 20]);
  const empty = await get('empty.wav');
  assert.deepEqual([empty.res.status, empty.res.headers.get('content-length'), empty.body.length], [200, '0', 0]);
});

test('ETag：If-None-Match 对上回 304 不带内容；If-Range 对不上忽略 Range 整份重来，对上照常 206', async t => {
  const { get } = await serving(t);
  const { res } = await get('a.mp3');
  const etag = res.headers.get('etag');
  const same = await get('a.mp3', { headers: { 'if-none-match': etag } });
  assert.deepEqual([same.res.status, same.body.length, same.res.headers.get('etag')], [304, 0, etag]);
  assert.equal((await get('a.mp3', { headers: { 'if-none-match': '"other"' } })).res.status, 200);
  const stale = await get('a.mp3', { headers: { range: 'bytes=0-3', 'if-range': '"1-1"' } });
  assert.deepEqual([stale.res.status, stale.body.length], [200, 20]);
  const fresh = await get('a.mp3', { headers: { range: 'bytes=0-3', 'if-range': etag } });
  assert.deepEqual([fresh.res.status, fresh.body.toString()], [206, '0123']);
});

test('HEAD 只有头；POST 等其他方法 405', async t => {
  const { get } = await serving(t);
  const head = await get('a.mp3', { method: 'HEAD' });
  assert.deepEqual([head.res.status, head.res.headers.get('content-length'), head.body.length], [200, '20', 0]);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get('a.mp3', { method })).res.status, 405, method);
});

test('口令：不认得和已作废的 404；换成别的视图的口令读不到这个根目录', async t => {
  const { get, media, token, root } = await serving(t);
  assert.equal((await get('a.mp3', { tok: 'nope' })).res.status, 404);
  assert.equal((await get('a.mp3')).res.status, 200);
  media.revoke(token);
  assert.equal((await get('a.mp3')).res.status, 404, '作废后不能再读');
  const other = media.grant(root), another = media.grant(root);
  assert.notEqual(other, another);
  assert.match(other, /^[0-9a-f]{32}$/);
  media.revoke(undefined);
});

test('路径：不是媒体扩展名、mkv、avi 415；越界（..、绝对路径、外链）不给字节；目录、不存在；链接指向里面的可读', async t => {
  const { get, url } = await serving(t);
  assert.equal((await get('notes.txt')).res.status, 415);
  assert.equal((await get('old.mkv')).res.status, 415, 'mkv 不经服务');
  assert.equal((await get('old.avi')).res.status, 415, 'avi 不经服务');
  assert.equal((await get('..%2Fsecret.mp3')).res.status, 400);
  assert.equal((await get('sub%2F..%2F..%2Fsecret.mp3')).res.status, 400);
  const leak = await get('leak.mp3');
  assert.equal(leak.res.status, 403);
  assert.ok(!leak.body.toString().includes('SECRET'));
  assert.equal((await get('dir.mp3')).res.status, 404);
  assert.equal((await get('missing.mp3')).res.status, 404);
  assert.equal((await get('%E0%A4%A.mp3')).res.status, 400, '解码失败');
  assert.equal((await get('inner.mp3')).body.toString(), BODY.toString());
  assert.equal((await fetch(url('a.mp3').replace(/\/[^/]+\/a\.mp3$/, ''))).status, 404, '没有口令');
});

test('中途断开（大文件读到一半）：之后的请求照常', async t => {
  const { root, get, url } = await serving(t);
  await writeFile(join(root, 'big.mp4'), Buffer.alloc(8 * 1024 * 1024, 1));
  const controller = new AbortController();
  const res = await fetch(url('big.mp4'), { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await utimes(join(root, 'a.mp3'), 1, 1);
  assert.equal((await get('a.mp3')).res.status, 200);
});
