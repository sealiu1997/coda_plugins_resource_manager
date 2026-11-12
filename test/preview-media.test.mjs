// 预览里的音视频和图片（第 20 节）：真实的 file-app.mjs 和 preview.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { flush } from './support/fake.mjs';
import { open, start } from './support/filepage.mjs';

const MIB = 1024 * 1024;
const find = (page, tag) => page.preview.find(node => node.tagName === tag)[0];
const meta = page => page.preview.find(node => node.classList.contains('pmeta'))[0];
const reads = host => host.sent.filter(message => message.type === 'read');
const medias = host => host.sent.filter(message => message.type === 'media');
const retry = page => page.preview.find(node => node.tagName === 'BUTTON' && ['重试', '重载'].includes(node.textContent))[0];

test('图片：<img> 直接指向流式服务，不发 read，没有 8 MiB 的上限；元信息是目录和大小', async t => {
  const { page, host } = await start(t, { path: 'pics/my photo.heic', files: { 'pics/my photo.heic': { kind: 'binary', size: 20 * MIB, mtimeMs: 5 } } });
  const img = find(page, 'IMG');
  assert.equal(img.src, `coda-view://service/media/tok/pics/my%20photo.heic?v=${20 * MIB}-5`);
  assert.equal(reads(host).length, 0, '不经分块读取');
  assert.equal(medias(host).length, 1);
  assert.equal(meta(page).textContent, 'pics · 20 MiB');
  assert.match(meta(page).title, /^修改于 /);
});

test('音频、视频：<audio>、<video> 带系统控件，只预取元数据；时长到了写进元信息行', async t => {
  const audio = await start(t, { path: 'a/song.flac', files: { 'a/song.flac': { kind: 'binary', size: 3 * MIB } } });
  const el = find(audio.page, 'AUDIO');
  assert.equal(el.src, `coda-view://service/media/tok/a/song.flac?v=${3 * MIB}-1`);
  assert.equal(el.getAttribute('controls'), '');
  assert.equal(el.getAttribute('preload'), 'metadata');
  assert.equal(meta(audio.page).textContent, 'a · 3.0 MiB');
  el.duration = 187.4;
  el.dispatch('loadedmetadata');
  assert.equal(meta(audio.page).textContent, 'a · 3.0 MiB · 3:07');
  assert.equal(reads(audio.host).length, 0);

  const video = await start(t, { path: 'clip.MOV', files: { 'clip.MOV': { kind: 'binary', size: 5 * MIB } } });
  const v = find(video.page, 'VIDEO');
  assert.equal(v.getAttribute('playsinline'), '');
  v.duration = 3725;
  v.dispatch('loadedmetadata');
  assert.equal(meta(video.page).textContent, '5.0 MiB · 1:02:05');
  v.duration = NaN;
  v.dispatch('loadedmetadata');
  assert.equal(meta(video.page).textContent, '5.0 MiB · 1:02:05', '时长不明时不改');
});

test('mkv、avi：按扩展名直接不预览，不读字节，给大小和修改时间', async t => {
  for (const path of ['v/old.mkv', 'x.AVI']) {
    const { page, host } = await start(t, { path, files: { [path]: { kind: 'binary', size: 2048, mtimeMs: 0 } } });
    assert.match(page.preview.textContent, /这种格式不能预览/);
    assert.match(page.preview.textContent, /2\.0 KiB，修改于 /);
    assert.equal(find(page, 'VIDEO'), undefined);
    assert.equal(reads(host).length, 0, path);
  }
});

test('播放器或图片报错：兜底提示「这台设备放不了这种格式」，元素撤掉，元信息还在', async t => {
  for (const [path, tag] of [['a.mp3', 'AUDIO'], ['a.avif', 'IMG'], ['a.mp4', 'VIDEO']]) {
    const { page } = await start(t, { path, files: { [path]: { kind: 'binary', size: 10 } } });
    find(page, tag).dispatch('error');
    assert.match(page.preview.textContent, /这台设备放不了这种格式/, path);
    assert.match(page.preview.textContent, /10 B，修改于 /);
    assert.equal(find(page, tag), undefined);
    assert.equal(meta(page).textContent, '10 B');
  }
});

test('宿主没有流式服务（旧 Coda）：图片退回分块读取（blob），音视频不预览并说明', async t => {
  const image = await start(t, { path: 'logo.png', files: { 'logo.png': { kind: 'image', text: 'png', size: 3 } } }); // 先确认默认有服务
  assert.match(find(image.page, 'IMG').src, /^coda-view:/);
  const files = { 'logo.png': { kind: 'image', text: 'png', size: 3 }, 'a.mp3': { kind: 'text', text: 'x', size: 3 }, 'b.avif': { kind: 'binary', size: 9 } };
  const noService = async path => {
    const ctx = await open(t, { path, files });
    ctx.host.service = false;
    ctx.host.start();
    await flush();
    return ctx;
  };
  const { page, host } = await noService('logo.png');
  assert.equal(reads(host).length, 1, '退回分块读取');
  assert.ok(find(page, 'IMG'));
  assert.doesNotMatch(find(page, 'IMG').src, /^coda-view:/);
  assert.equal(meta(page).textContent, '3 B');

  const audio = await noService('a.mp3');
  assert.match(audio.page.preview.textContent, /这个版本的 Coda 不能预览音视频/);
  assert.equal(reads(audio.host).length, 0, '音视频不读字节');
  assert.equal(find(audio.page, 'AUDIO'), undefined);
});

test('刷新：没变化不动；音视频变了不打断，元信息行提示「文件已变化」，点「重载」才换；改回来提示消失', async t => {
  const { page, host } = await start(t, { path: 'a.mp3', files: { 'a.mp3': { kind: 'binary', size: 100, mtimeMs: 1 } } });
  const el = find(page, 'AUDIO');
  host.changed();
  await flush();
  assert.equal(find(page, 'AUDIO'), el, '没变化不重画');
  assert.equal(meta(page).textContent, '100 B');
  assert.ok(retry(page).hidden);

  host.files['a.mp3'].mtimeMs = 2;
  host.changed();
  await flush();
  assert.equal(find(page, 'AUDIO'), el, '变了也不换元素，不打断播放');
  assert.equal(meta(page).textContent, '文件已变化');
  assert.equal(retry(page).textContent, '重载');
  assert.equal(retry(page).hidden, false);
  assert.equal(el.src.endsWith('?v=100-1'), true);

  host.files['a.mp3'].mtimeMs = 1;
  host.changed();
  await flush();
  assert.equal(meta(page).textContent, '100 B', '改回来了：提示消失');
  assert.ok(retry(page).hidden);

  host.files['a.mp3'] = { kind: 'binary', size: 200, mtimeMs: 3 };
  host.changed();
  await flush();
  retry(page).dispatch('click');
  await flush();
  assert.equal(retry(page).hidden, true);
  const next = find(page, 'AUDIO');
  assert.notEqual(next, el);
  assert.equal(next.src, 'coda-view://service/media/tok/a.mp3?v=200-3');
  assert.equal(meta(page).textContent, '200 B');
  assert.equal(reads(host).length, 0);
});

test('刷新：图片和不能预览的提示页变了直接换；文件没了写「文件已不存在」', async t => {
  const image = await start(t, { path: 'a.png', files: { 'a.png': { kind: 'image', size: 10, mtimeMs: 1 } } });
  const before = find(image.page, 'IMG');
  image.host.files['a.png'].mtimeMs = 2;
  image.host.changed();
  await flush();
  const after = find(image.page, 'IMG');
  assert.notEqual(after, before);
  assert.equal(after.src, 'coda-view://service/media/tok/a.png?v=10-2');
  assert.equal(retry(image.page).hidden, true);

  const mkv = await start(t, { path: 'a.mkv', files: { 'a.mkv': { kind: 'binary', size: 10 } } });
  mkv.host.files['a.mkv'].size = 99;
  mkv.host.changed();
  await flush();
  assert.match(mkv.page.preview.textContent, /99 B，修改于 /);

  delete image.host.files['a.png'];
  image.host.changed();
  await flush();
  assert.match(image.page.preview.textContent, /文件已不存在/);
});

test('换了根目录：旧元素暂停并撤掉地址（不再向服务要）', async t => {
  const { page, host } = await start(t, { path: 'a.mp4', files: { 'a.mp4': { kind: 'binary', size: 10 } } });
  const el = find(page, 'VIDEO');
  let paused = 0;
  el.pause = () => paused++;
  host.start('/B'); // 换了根目录：预览重载，旧元素先停掉
  await flush();
  assert.ok(paused >= 1);
  assert.equal(el.src, '');
});
