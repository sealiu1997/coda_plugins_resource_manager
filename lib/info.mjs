// 属性和文件夹大小（设计见 docs/design/phase-3.md 第 13.3、13.4 节）。
// 只读：都经视图共用的读取状态（lib/tree.mjs 的 createListing）的 fs 和并发上限，不另起一套。
import { basename, join, relative, sep } from 'node:path';
import { EntryKind } from '../view/protocol.mjs';
import { fromFsError, parseRelative, resolveInRoot } from './paths.mjs';
import { classifyLink } from './tree.mjs';
import { startWalk } from './walk.mjs';

export const DIR_SIZE_ITEMS = 200_000;
export const DIR_SIZE_MS = 5000;

const integer = value => (Number.isFinite(value) ? Math.floor(value) : undefined);

// 一个条目自己的元数据：size 只有文件有，读不到的不带。
function metaOf(info, kind) {
  const meta = {};
  const mtimeMs = integer(info.mtimeMs), birthtimeMs = integer(info.birthtimeMs), mode = integer(info.mode);
  if (kind === EntryKind.FILE && integer(info.size) !== undefined) meta.size = integer(info.size);
  if (mtimeMs !== undefined) meta.mtimeMs = mtimeMs;
  if (birthtimeMs !== undefined && birthtimeMs > 0) meta.birthtimeMs = birthtimeMs; // 0 是文件系统没有这个值
  if (mode !== undefined) meta.mode = mode & 0o7777;
  return meta;
}

const kindOf = info => (info.isDirectory() ? EntryKind.DIR : info.isFile() ? EntryKind.FILE : EntryKind.OTHER);

// 先解析父目录，再 lstat 最后一级，不跟随链接。
// 指向工作目录内的链接按目标显示（target 是目标的相对路径）；指向外面或已失效的链接只给自己的元数据，不给目标路径。
export async function statPath(listing, root, path) {
  const segments = parseRelative(path);
  const { fs } = listing;
  let name, dir, item;
  try {
    if (segments.length === 0) {
      name = basename(root);
      item = { kind: EntryKind.DIR, info: await listing.run(() => fs.lstat(root)) };
    } else {
      name = segments[segments.length - 1];
      dir = await resolveInRoot(root, segments.slice(0, -1).join('/'));
      const own = await listing.run(() => fs.lstat(join(dir, name)));
      if (own.isSymbolicLink()) {
        const linked = await listing.run(() => classifyLink(fs, root, dir, name));
        item = linked.link
          ? { kind: linked.kind, info: linked.info, link: true, target: relative(root, linked.real).split(sep).join('/') }
          : { kind: EntryKind.LINK, info: own, link: true };
      } else item = { kind: kindOf(own), info: own };
    }
  } catch (error) { throw fromFsError(error); }
  const { kind, info, link, target } = item;
  const body = { name, kind };
  if (link) body.link = true;
  if (target !== undefined) body.target = target;
  return { ...body, ...metaOf(info, kind) };
}

// 文件夹大小：边读边统计，走树的部分在 lib/walk.mjs（深度优先、什么目录都进，包括 .git）。
// - 不跟随链接：链接算一项，不计大小。
// - 项数到 limit 或用时到 timeoutMs，立刻回答 complete: false，已发出的读取结果不再计入；
//   signal 中止、valid() 为假（会话、根目录变了或视图关了）静默停止，返回 null，不回答。
// - 5 秒从收到请求算起：计时和取消监听先建，解析起点（resolve，默认 resolveInRoot）与它们竞速；
//   解析回来先核对 valid() 和 signal，才读。到点还没解析完回答 items: 0、complete: false；解析失败按错误回答。
// - 子目录读不到、条目 lstat 失败都计入 unreadable；起点读不到才算错误。
export async function dirSize(listing, root, path, { valid, signal, limit = DIR_SIZE_ITEMS, timeoutMs = DIR_SIZE_MS, resolve } = {}) {
  let size = 0;
  const walk = startWalk(listing, root, path, {
    valid, signal, limit, timeoutMs, resolve,
    visit: ({ info }) => { if (info.isFile()) size += Math.max(0, Math.floor(info.size) || 0); return true; },
  });
  const done = await walk.result;
  return done && { size, items: done.items, unreadable: done.unreadable, complete: done.reason === 'done' };
}
