// 音视频和图片的本机流式服务（lib/media.mjs，设计见第 20 节）：真实 http 服务器 + 真实临时目录。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createMedia } from '../lib/media.mjs';
import { OpenCategory, canOpenInCoda, mediaOf, openCategoryOf, servedType } from '../view/protocol.mjs';
import { tempDir } from './support/fake.mjs';

const execFileAsync = promisify(execFile);

const BODY = Buffer.from('0123456789abcdefghij'); // 20 字节

async function serving(t) {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.mp3'), BODY);
  await writeFile(join(root, 'sub', 'v 1.mp4'), BODY);
  await writeFile(join(root, 'empty.wav'), '');
  await writeFile(join(root, 'archive.zip'), 'PK');
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

test('路径：未放行扩展名、mkv、avi 415；越界（..、绝对路径、外链）不给字节；目录、不存在；链接指向里面的可读', async t => {
  const { get, url } = await serving(t);
  assert.equal((await get('archive.zip')).res.status, 415);
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

test('3D 模型（第 21 节）：mediaOf 认 glb、gltf、stl、obj、ply、3mf；.bin、.mtl 不是媒体，但服务供应它们', async t => {
  for (const ext of ['glb', 'gltf', 'stl', 'obj', 'ply', '3mf']) assert.equal(mediaOf(`m.${ext.toUpperCase()}`)?.kind, 'model', ext);
  assert.deepEqual(mediaOf('a/x.glb'), { kind: 'model', type: 'model/gltf-binary', preview: true });
  for (const name of ['x.bin', 'x.mtl']) assert.equal(mediaOf(name), null, `${name} 页面不当媒体预览`);
  assert.equal(servedType('x.BIN'), 'application/octet-stream');
  assert.equal(servedType('x.mtl'), 'text/plain; charset=utf-8');
  assert.equal(servedType('x.png'), 'image/png');
  assert.equal(servedType('x.stl'), 'model/stl');
  assert.equal(servedType('x.mkv'), null);
  assert.equal(servedType('x.zip'), null);
  assert.equal(servedType('noext'), null);
  const { root, get } = await serving(t);
  await mkdir(join(root, 'm'), { recursive: true });
  await writeFile(join(root, 'm', 'scene.bin'), BODY);
  await writeFile(join(root, 'm', 'a b.mtl'), 'newmtl x\n');
  await writeFile(join(root, 'm', 'model.glb'), BODY);
  const bin = await get('m/scene.bin');
  assert.deepEqual([bin.res.status, bin.res.headers.get('content-type'), bin.body.equals(BODY)], [200, 'application/octet-stream', true]);
  const mtl = await get('m/a%20b.mtl');
  assert.deepEqual([mtl.res.status, mtl.res.headers.get('content-type'), mtl.body.toString()], [200, 'text/plain; charset=utf-8', 'newmtl x\n']);
  assert.equal((await get('m/model.glb')).res.headers.get('content-type'), 'model/gltf-binary');
  assert.equal((await get('m/scene.bin', { headers: { range: 'bytes=2-3' } })).body.toString(), '23');
  assert.equal((await get('archive.zip')).res.status, 415, '未放行扩展名仍然不供应');
});

test('跨源：所有响应（含 304、416 和各种错误）带 Access-Control-Allow-Origin: *；OPTIONS 回 204 并列出方法和请求头', async t => {
  const { get } = await serving(t);
  const origin = r => r.res.headers.get('access-control-allow-origin');
  const ok = await get('a.mp3');
  assert.equal(origin(ok), '*');
  assert.match(ok.res.headers.get('access-control-expose-headers'), /content-length.*content-range.*etag/);
  assert.equal(origin(await get('a.mp3', { headers: { 'if-none-match': ok.res.headers.get('etag') } })), '*', '304');
  const partial = await get('a.mp3', { headers: { range: 'bytes=2-3' } });
  assert.deepEqual([partial.res.status, origin(partial)], [206, '*']);
  const bad = await get('a.mp3', { headers: { range: 'bytes=99-' } });
  assert.deepEqual([bad.res.status, origin(bad)], [416, '*']);
  for (const [path, status, tok] of [['archive.zip', 415], ['nope.mp3', 404], ['a.mp3', 404, 'wrong'], ['..%2Fx.mp3', 400]]) {
    const res = await get(path, { tok });
    assert.deepEqual([res.res.status, origin(res)], [status, '*'], path);
  }
  const preflight = await get('a.mp3', { method: 'OPTIONS', headers: { origin: 'coda-view://plugin', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' } });
  assert.deepEqual([preflight.res.status, origin(preflight), preflight.res.headers.get('access-control-allow-methods')], [204, '*', 'GET, HEAD']);
  assert.match(preflight.res.headers.get('access-control-allow-headers'), /range/);
  assert.equal(preflight.body.length, 0);
  assert.equal((await get('a.mp3', { method: 'POST' })).res.status, 405);
});

test('打开偏好类别归类与嵌套 Markdown 相对链接：统一经流式服务供应并受工作目录校验约束', async t => {
  for (const ext of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key']) {
    assert.equal(openCategoryOf(`docs/file.${ext}`), OpenCategory.DOCUMENT, ext);
    assert.equal(openCategoryOf(`docs/FILE.${ext.toUpperCase()}`), OpenCategory.DOCUMENT, ext.toUpperCase());
    assert.equal(mediaOf(`docs/file.${ext}`), null, `${ext} 不当页内媒体预览`);
    assert.ok(servedType(`docs/file.${ext}`), `${ext} 流式服务放行`);
  }
  // rtf 归文本类：页内按纯文本显示，流式服务按 text/plain 供应（同 txt）
  for (const name of ['docs/file.rtf', 'docs/FILE.RTF']) {
    assert.equal(openCategoryOf(name), OpenCategory.TEXT, name);
    assert.equal(mediaOf(name), null, `${name} 不当页内媒体预览`);
    assert.equal(servedType(name), 'text/plain; charset=utf-8', name);
  }
  for (const ext of ['md', 'markdown', 'mdx']) {
    assert.equal(openCategoryOf(`docs/file.${ext}`), OpenCategory.MARKDOWN, ext);
    assert.equal(openCategoryOf(`docs/FILE.${ext.toUpperCase()}`), OpenCategory.MARKDOWN, ext.toUpperCase());
    assert.equal(mediaOf(`docs/file.${ext}`), null, `${ext} 不当页内媒体预览`);
    assert.equal(servedType(`docs/file.${ext}`), 'text/markdown; charset=utf-8', ext);
  }
  assert.equal(openCategoryOf('a.png'), OpenCategory.IMAGE);
  assert.equal(openCategoryOf('a.mp3'), OpenCategory.AUDIO);
  assert.equal(openCategoryOf('a.mp4'), OpenCategory.VIDEO);
  assert.equal(openCategoryOf('a.glb'), OpenCategory.MODEL);
  for (const name of ['a.txt', 'a.js', 'a.swift', 'a.json', 'README', 'Dockerfile', 'Makefile', '.gitignore', '.env.local', '.md', '.pdf', 'dir.pdf/README', 'a.toString', '']) {
    assert.equal(openCategoryOf(name), OpenCategory.TEXT, name);
  }
  for (const name of ['a.swift', 'README', 'Dockerfile', 'Makefile', '.gitignore', 'LICENSE', '.env', '.env.local']) {
    assert.equal(servedType(name), 'text/plain; charset=utf-8', name);
  }
  // 带已知扩展名的 .env.* 必须保留对应扩展名的 MIME，不被 .env.* 兜底覆盖
  assert.equal(servedType('.env.json'), 'application/json; charset=utf-8');
  assert.equal(servedType('.env.yaml'), 'text/yaml; charset=utf-8');
  assert.equal(servedType('.env.md'), 'text/markdown; charset=utf-8');
  assert.equal(servedType('.env.pdf'), 'application/pdf');
  const { root, base, url } = await serving(t);
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'docs', 'README.md'), '[pdf](./manual.pdf) [txt](./example.txt)\n');
  await writeFile(join(root, 'docs', 'manual.pdf'), '%PDF-1.7');
  await writeFile(join(root, 'docs', 'example.txt'), 'hello txt\n');
  await writeFile(join(root, 'docs', 'guide.md'), '# guide\n');
  await writeFile(join(root, 'docs', 'spec.docx'), 'PK-docx');
  await writeFile(join(root, 'docs', '.env.json'), '{"a":1}');
  await writeFile(join(root, 'docs', '.env.local'), 'KEY=1\n');
  await writeFile(join(root, 'assets', 'diagram.png'), 'PNGDATA');
  await writeFile(join(base, 'outside.pdf'), 'TOP-SECRET-PDF');
  await symlink(join(base, 'outside.pdf'), join(root, 'docs', 'escape.pdf'));

  const docBase = url('docs/README.md');
  const fetchRel = async rel => {
    const res = await fetch(new URL(rel, docBase));
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  };

  assert.deepEqual(await fetchRel('./manual.pdf'), { status: 200, type: 'application/pdf', text: '%PDF-1.7' });
  assert.deepEqual(await fetchRel('./example.txt'), { status: 200, type: 'text/plain; charset=utf-8', text: 'hello txt\n' });
  assert.deepEqual(await fetchRel('./guide.md'), { status: 200, type: 'text/markdown; charset=utf-8', text: '# guide\n' });
  assert.deepEqual(await fetchRel('./spec.docx'), {
    status: 200,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    text: 'PK-docx',
  });
  assert.deepEqual(await fetchRel('../assets/diagram.png'), { status: 200, type: 'image/png', text: 'PNGDATA' });
  assert.deepEqual(await fetchRel('./.env.json'), { status: 200, type: 'application/json; charset=utf-8', text: '{"a":1}' });
  assert.deepEqual(await fetchRel('./.env.local'), { status: 200, type: 'text/plain; charset=utf-8', text: 'KEY=1\n' });

  const escapeLink = await fetchRel('./escape.pdf');
  assert.equal(escapeLink.status, 403, '指向目录外的符号链接必须被拒绝');
  assert.equal(escapeLink.text.includes('TOP-SECRET-PDF'), false);

  const traverse = await fetchRel('../../outside.pdf');
  assert.notEqual(traverse.status, 200, '越出根目录的相对路径必须被拒绝');
  assert.equal(traverse.text.includes('TOP-SECRET-PDF'), false);

  if (process.platform !== 'win32') {
    await execFileAsync('mkfifo', [join(root, 'docs', 'pipe.txt')]);
    const fifo = await fetch(new URL('./pipe.txt', docBase), { signal: AbortSignal.timeout(2000) });
    assert.equal(fifo.status, 404, '命名管道（FIFO）必须以 O_NONBLOCK 及时拒绝，不能阻塞');
  }
});

test('供应类型：xml、plist、rtf 纯文本；html、htm、xhtml 照旧；这几类 Coda 仍可打开', () => {
  for (const ext of ['xml', 'plist', 'rtf']) {
    for (const name of [`a.${ext}`, `A.${ext.toUpperCase()}`]) {
      assert.equal(servedType(name), 'text/plain; charset=utf-8', name);
      assert.equal(canOpenInCoda(name), true, name);
    }
  }
  assert.equal(servedType('a.html'), 'text/html; charset=utf-8');
  assert.equal(servedType('a.htm'), 'text/html; charset=utf-8');
  assert.equal(servedType('a.xhtml'), 'application/xhtml+xml; charset=utf-8');
});

test('nosniff：成功、206、304、HEAD、OPTIONS 预检和 400、403、404、405、415、416 都带', async t => {
  const { root, get } = await serving(t);
  await writeFile(join(root, 'a.html'), '<p>x</p>');
  const etag = (await get('a.mp3')).res.headers.get('etag');
  const cases = [
    [200, 'a.mp3'], [200, 'a.html'], [206, 'a.mp3', { headers: { range: 'bytes=0-3' } }], [304, 'a.mp3', { headers: { 'if-none-match': etag } }],
    [200, 'a.mp3', { method: 'HEAD' }], [204, 'a.mp3', { method: 'OPTIONS' }],
    [400, '..%2Fsecret.mp3'], [400, '%E0%A4%A.mp3'], [403, 'leak.mp3'], [404, 'missing.mp3'], [404, 'a.mp3', { tok: 'wrong' }], [404, 'dir.mp3'],
    [405, 'a.mp3', { method: 'POST' }], [415, 'archive.zip'], [416, 'a.mp3', { headers: { range: 'bytes=99-' } }],
  ];
  for (const [status, path, options] of cases) {
    const { res } = await get(path, options);
    assert.deepEqual([res.status, res.headers.get('x-content-type-options')], [status, 'nosniff'], `${options?.method ?? 'GET'} ${path}`);
  }
});

test('SVG 的 CSP：200、206、304 各自带 MIME、CSP、nosniff，HEAD 同；别的类型不带 CSP', async t => {
  const { root, get } = await serving(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  await writeFile(join(root, 'a.svg'), svg);
  await writeFile(join(root, 'Logo.SVG'), svg);
  await writeFile(join(root, 'a.png'), 'x');
  await writeFile(join(root, 'a.html'), '<p>x</p>');
  const csp = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  const etag = (await get('a.svg')).res.headers.get('etag');
  const cases = [
    ['a.svg', undefined, 200, svg], ['Logo.SVG', undefined, 200, svg],
    ['a.svg', { method: 'HEAD' }, 200, ''],
    ['a.svg', { headers: { range: 'bytes=0-3' } }, 206, svg.slice(0, 4)],
    ['a.svg', { headers: { 'if-none-match': etag } }, 304, ''],
  ];
  for (const [path, options, status, body] of cases) {
    const r = await get(path, options), label = `${options?.method ?? 'GET'} ${path} ${JSON.stringify(options?.headers ?? {})}`;
    assert.equal(r.res.status, status, label);
    assert.equal(r.body.toString(), body, label);
    assert.equal(r.res.headers.get('content-security-policy'), csp, label);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff', label);
    assert.equal(r.res.headers.get('content-type'), status === 304 ? null : 'image/svg+xml', label); // 304 服务本来就不带 content-type
  }
  for (const name of ['a.png', 'a.html', 'a.mp3', 'missing.mp3']) assert.equal((await get(name)).res.headers.get('content-security-policy'), null, name);
});

test('HTML 的 content-type 按文件开头的实际编码写 charset：GBK、BOM、无声明、认不出、UTF-16 声明；200、206、HEAD、304', async t => {
  const { root, get } = await serving(t);
  const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const files = {
    'gbk.html': Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), GBK]),
    'Gb.HTM': Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=GB2312"><p>'), GBK]),
    'plain.html': Buffer.from('<p>没写声明</p>'),
    'bom.html': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<meta charset="gbk"><p>中文')]),
    'bogus.html': Buffer.from('<meta charset="no-such"><p>x'),
    'utf16.html': Buffer.from('<meta charset="utf-16le"><p>x'),
    'late.html': Buffer.concat([Buffer.from(`<!-- ${'x'.repeat(1100)} --><meta charset="gbk"><p>`), GBK]), // 声明在前 1024 字节之外：不算
    'empty.html': Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  const type = async (name, options) => (await get(name, options)).res.headers.get('content-type');
  assert.equal(await type('gbk.html'), 'text/html; charset=gbk');
  assert.equal(await type('Gb.HTM'), 'text/html; charset=gbk', 'gb2312 规范化成 gbk');
  assert.equal(await type('plain.html'), 'text/html; charset=utf-8');
  assert.equal(await type('bom.html'), 'text/html; charset=utf-8', 'BOM 优先于 meta');
  assert.equal(await type('bogus.html'), 'text/html; charset=utf-8');
  assert.equal(await type('utf16.html'), 'text/html; charset=utf-8', 'UTF-16 声明按 UTF-8');
  assert.equal(await type('late.html'), 'text/html; charset=utf-8');
  assert.equal(await type('empty.html'), 'text/html; charset=utf-8');
  // Range 按文件开头判断，不按请求的区间；HEAD 同
  const ranged = await get('gbk.html', { headers: { range: 'bytes=5-' } });
  assert.equal(ranged.res.status, 206);
  assert.equal(ranged.res.headers.get('content-type'), 'text/html; charset=gbk');
  assert.equal((await get('gbk.html', { method: 'HEAD' })).res.headers.get('content-type'), 'text/html; charset=gbk');
  // 304 照旧不带 content-type
  const etag = (await get('gbk.html')).res.headers.get('etag');
  const cached = await get('gbk.html', { headers: { 'if-none-match': etag } });
  assert.deepEqual([cached.res.status, cached.res.headers.get('content-type')], [304, null]);
  // 响应体原样，不转码
  assert.equal((await get('gbk.html')).body.equals(files['gbk.html']), true);
  // 其他类型的头不变
  await writeFile(join(root, 'a.xhtml'), '<meta charset="gbk">');
  await writeFile(join(root, 'a.md'), '# x');
  assert.equal(await type('a.xhtml'), 'application/xhtml+xml; charset=utf-8');
  assert.equal(await type('a.md'), 'text/markdown; charset=utf-8');
});

test('HTML 服务端判定与页内预览共用同一个函数：真实 gbk.html 样例', async t => {
  const { readFile } = await import('node:fs/promises');
  const { htmlEncodingOf } = await import('../view/charset.mjs');
  const { root, get } = await serving(t);
  const bytes = await readFile(new URL('./fixtures/html/gbk.html', import.meta.url));
  await writeFile(join(root, 'gbk.html'), bytes);
  assert.equal((await get('gbk.html')).res.headers.get('content-type'), `text/html; charset=${htmlEncodingOf(bytes)}`);
  assert.equal(htmlEncodingOf(bytes), 'gbk');
});
