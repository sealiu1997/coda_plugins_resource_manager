// 读目录：文件夹在前，按排序键排序，按序列化字节数分页。模块回答全部条目，隐藏规则在页面。
// 名称、种类排序每页重读目录，游标是上一条的排序键，只读当前页条目的元数据；
// 日期、大小排序第一页读全部条目的元数据并建快照，之后的页从快照取，不再碰文件系统（设计见 docs/design/phase-3.md 第 12.3 节）。
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  DEFAULT_SORT, EntryKind, ENVELOPE_BYTES, ErrorCode, PAGE_BYTES, SortKey, fail, parseSort,
} from '../view/protocol.mjs';
import { fromFsError, isInside, isSafeName, parseRelative, resolveInRoot } from './paths.mjs';
import { createSnapshots } from './snapshots.mjs';

const MAX_ENTRIES = 100_000;
// 日期、大小排序要读全部条目的元数据，超过这个数的目录退回按名称排。
export const SORT_STAT_LIMIT = 20_000;
const CONCURRENCY = 8;
// 一条的元数据最多占的字节（两个都是 16 位整数），用来在读元数据之前保守地决定一页放几条。
const META_BYTES = Buffer.byteLength(',"size":9007199254740991,"mtimeMs":9007199254740991');

// 并发上限：每个视图一个，classify 和读元数据都经它，所以并行多个目录也不会超过 limit 个同时在读。
export function createLimiter(limit = CONCURRENCY) {
  let active = 0;
  const waiting = [];
  return async fn => {
    if (active < limit) active++; else await new Promise(resolve => waiting.push(resolve));
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--; // 有人等就把坑位直接交给它
    }
  };
}

const realFs = { lstat, readdir, realpath, stat };

// 一个视图的读取状态：文件系统、共用的并发上限、快照、进行中的第一页读取。
// refresh、changed 后 detach：进行中的读取不再被新请求共用；换会话、根目录变化、视图关闭后 clear。
// latest 记着每个身份最新发起的读取：只有它能存快照，旧的读取晚到也不会顶掉新快照。detach 不动它，clear 才清（清了之后谁都不能存）。
export function createListing({ fs = realFs, limit = CONCURRENCY, snapshots = createSnapshots() } = {}) {
  return {
    fs, snapshots, run: createLimiter(limit), reads: new Map(), latest: new Map(), started: 0,
    detach() { this.reads.clear(); },
    clear() { this.reads.clear(); this.latest.clear(); this.snapshots.clear(); },
  };
}

// ---- 排序 ----

const rank = entry => (entry.kind === EntryKind.DIR ? 0 : 1);
const extOf = name => extname(name).slice(1).toLowerCase();

// 排序键；undefined 是缺元数据（或文件夹没有大小），排在组内最后。
function keyOf(entry, key) {
  switch (key) {
    case SortKey.NAME: return entry.name.toLowerCase();
    case SortKey.KIND: return entry.kind === EntryKind.DIR ? '' : extOf(entry.name);
    case SortKey.DATE: return entry.mtimeMs;
    default: return entry.kind === EntryKind.DIR ? undefined : entry.size;
  }
}

// 每种排序的方向，只在这里定义：名称、种类升序，日期、大小降序（最新、最大在前）。
const DESCENDING = new Set([SortKey.DATE, SortKey.SIZE]);

// 名字的比较：不分大小写升序，平手按原名。目录列表的名称排序和搜索结果的路径排序共用。
export function compareNames(a, b) {
  const p = a.toLowerCase(), q = b.toLowerCase();
  if (p !== q) return p < q ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// 全序：文件夹在前（不随方向反向）；键按该排序的方向，缺的不管方向都在最后；平手按名字（不分大小写）升序，最后按原名。
function comparer(key) {
  const desc = DESCENDING.has(key);
  return (a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const x = keyOf(a, key), y = keyOf(b, key);
    if (x !== y) {
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return compareNames(a.name, b.name);
  };
}

// ---- 游标：名称、种类用排序键，日期、大小用快照编号加下标。解不开的一律当作过期。 ----

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const encodeKeyCursor = (sort, entry) => encode(['k', sort, rank(entry), entry.name]);
const encodeSnapshotCursor = (id, index) => encode(['s', id, index]);

function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Array.isArray(value)) {
      if (value[0] === 's' && Number.isSafeInteger(value[1]) && Number.isSafeInteger(value[2]) && value[2] > 0) {
        return { snapshot: value[1], index: value[2] };
      }
      const [tag, sort, group, name] = value;
      if (value.length === 4 && tag === 'k' && (sort === SortKey.NAME || sort === SortKey.KIND)
        && (group === 0 || group === 1) && typeof name === 'string') {
        return { sort, after: { name, kind: group === 0 ? EntryKind.DIR : EntryKind.FILE } };
      }
    }
  } catch { /* 下面统一报错 */ }
  throw fail(ErrorCode.CURSOR_EXPIRED, '游标已过期');
}

// ---- 读条目 ----

// 只有符号链接要额外解析：目标在根目录内按目标显示（目标的 lstat 带回去给读元数据用，不解析第二次），在外或已失效显示为 link。
// 校验之后用 lstat 读目标，不跟随链接：realpath 之后目标被换成别的链接，读到的就是符号链接，按 link 处理，不带外面的元数据。
export async function classifyLink(fs, root, dir, name) {
  try {
    const real = await fs.realpath(join(dir, name));
    if (!isInside(root, real)) return { name, kind: EntryKind.LINK };
    const info = await fs.lstat(real);
    if (info.isSymbolicLink()) return { name, kind: EntryKind.LINK };
    const kind = info.isDirectory() ? EntryKind.DIR : info.isFile() ? EntryKind.FILE : EntryKind.OTHER;
    return { name, kind, link: true, info, real };
  } catch { return { name, kind: EntryKind.LINK }; }
}

function classifyPlain(dirent) {
  const { name } = dirent;
  if (!isSafeName(name)) return { name, kind: EntryKind.OTHER };
  if (dirent.isDirectory()) return { name, kind: EntryKind.DIR };
  if (dirent.isFile()) return { name, kind: EntryKind.FILE };
  return { name, kind: EntryKind.OTHER };
}

const needsResolve = dirent => dirent.isSymbolicLink() && isSafeName(dirent.name);
// 不是链接的不碰文件系统，不占并发坑位。
const classify = (listing, root, dir, dirent) => (needsResolve(dirent)
  ? listing.run(() => classifyLink(listing.fs, root, dir, dirent.name))
  : classifyPlain(dirent));

// 读失败（刚被删、没权限）不算错误，这个条目不带字段。普通条目用 lstat，不跟随链接：
// 条目在 readdir 之后被换成指向外面的链接，lstat 读到的也只是链接自己，类型对不上就不带字段。
// link: true 的用 classify 校验时拿到的目标 lstat。link、other 不读。size、mtimeMs 取整后只有这一份值。
async function addMeta(listing, dir, item) {
  if (item.kind !== EntryKind.DIR && item.kind !== EntryKind.FILE) return;
  try {
    const info = item.link ? item.info : await listing.fs.lstat(join(dir, item.name));
    const isDir = info.isDirectory();
    if (isDir !== (item.kind === EntryKind.DIR) || (!isDir && !info.isFile())) return;
    const mtimeMs = Math.floor(info.mtimeMs), size = Math.floor(info.size);
    if (Number.isFinite(mtimeMs)) item.mtimeMs = mtimeMs;
    if (!isDir && Number.isFinite(size)) item.size = size;
  } catch { /* 不带字段 */ }
}

function toEntry({ name, kind, link, size, mtimeMs }) {
  const entry = { name, kind };
  if (link) entry.link = true;
  if (size !== undefined) entry.size = size;
  if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
  return entry;
}

const entryBytes = entry => Buffer.byteLength(JSON.stringify(entry)) + 1;

// 从 start 起取一页，至少一条；返回下一页的下标。
function cut(entries, start, pageBytes) {
  let end = start, used = 0;
  while (end < entries.length) {
    const size = entryBytes(entries[end]);
    if (end > start && used + size > pageBytes - ENVELOPE_BYTES) break;
    used += size;
    end++;
  }
  return { entries: entries.slice(start, end), end };
}

async function readDirents(listing, dir) {
  try { return await listing.fs.readdir(dir, { withFileTypes: true }); } catch (error) { throw fromFsError(error); }
}

// 名称、种类（和退回名称的日期、大小）：读目录、classify 全部，排序，找到游标之后，只读这一页的元数据。
// 元数据的字节数在读之前不知道，所以按最大可能的字节数决定放几条，一页不会超。
async function pageByKey(listing, root, dir, dirents, sort, after, pageBytes) {
  const items = await Promise.all(dirents.map(dirent => classify(listing, root, dir, dirent)));
  const compare = comparer(sort);
  items.sort(compare);
  let index = 0;
  if (after) while (index < items.length && compare(items[index], after) <= 0) index++;
  const picked = [];
  let used = 0;
  while (index < items.length) {
    const size = entryBytes(toEntry(items[index])) + META_BYTES;
    if (picked.length && used + size > pageBytes - ENVELOPE_BYTES) break;
    used += size;
    picked.push(items[index++]);
  }
  await Promise.all(picked.map(item => listing.run(() => addMeta(listing, dir, item))));
  return { entries: picked.map(toEntry), nextCursor: index < items.length ? encodeKeyCursor(sort, picked[picked.length - 1]) : null };
}

// 日期、大小的第一页：读全部条目的元数据，排序，存快照。一页放得下就不存。
// 读完核对代次和根路径：对不上说明读的时候会话或根目录换了，不存快照也不回答内容。
// isLatest：这次读取是不是同身份最新发起的；不是的照常回答，但不存快照（回答里的游标指向编号 0，永远查不到，页面丢弃这份回答）。
async function firstSnapshotPage(listing, root, rel, path, sort, { pageBytes, maxEntries, statLimit, valid, isLatest }) {
  const dir = await resolveInRoot(root, path);
  const dirents = await readDirents(listing, dir);
  if (dirents.length > maxEntries) throw fail(ErrorCode.TOO_LARGE, `目录条目超过 ${maxEntries} 个`);
  if (dirents.length > statLimit) {
    return { ...await pageByKey(listing, root, dir, dirents, DEFAULT_SORT, null, pageBytes), sortFallback: true };
  }
  const items = await Promise.all(dirents.map(dirent => listing.run(async () => {
    // 已经占着坑位，直接解析链接；再经 run 会等自己占的坑位。
    const item = needsResolve(dirent) ? await classifyLink(listing.fs, root, dir, dirent.name) : classifyPlain(dirent);
    await addMeta(listing, dir, item);
    return item;
  })));
  const entries = items.map(toEntry).sort(comparer(sort));
  if (!valid()) throw fail(ErrorCode.NO_ROOT, '工作目录已变化');
  const page = cut(entries, 0, pageBytes);
  if (page.end >= entries.length) return { entries, nextCursor: null };
  if (!isLatest()) return { entries: page.entries, nextCursor: encodeSnapshotCursor(0, page.end) };
  const snapshot = listing.snapshots.put({ identity: JSON.stringify([root, rel, sort]), root, path: rel, entries });
  return { entries: page.entries, nextCursor: encodeSnapshotCursor(snapshot.id, page.end) };
}

function pageOfSnapshot(listing, root, rel, { snapshot: id, index }, pageBytes) {
  const snapshot = listing.snapshots.get(id);
  if (!snapshot || snapshot.root !== root || snapshot.path !== rel || index >= snapshot.entries.length) {
    throw fail(ErrorCode.CURSOR_EXPIRED, '游标已过期');
  }
  const page = cut(snapshot.entries, index, pageBytes);
  if (page.end < snapshot.entries.length) return { entries: page.entries, nextCursor: encodeSnapshotCursor(id, page.end) };
  listing.snapshots.release(id);
  return { entries: page.entries, nextCursor: null };
}

// options：sort（只对第一页有效，有游标时只认游标里的）、listing（视图共用的读取状态）、valid（回答前是否仍然有效，
// 由主模块按代次和根路径判断）、maxEntries、pageBytes、statLimit（测试可调）。
export async function listDirectory(root, path, cursor, options = {}) {
  const {
    listing = createListing(), maxEntries = MAX_ENTRIES, pageBytes = PAGE_BYTES, statLimit = SORT_STAT_LIMIT, valid = () => true,
  } = options;
  const requested = options.sort == null ? DEFAULT_SORT : parseSort(options.sort);
  if (!requested) throw fail(ErrorCode.INVALID_SORT, '排序无效');
  const rel = parseRelative(path).join('/');
  const at = cursor == null ? null : decodeCursor(cursor);
  if (at?.snapshot !== undefined) return pageOfSnapshot(listing, root, rel, at, pageBytes);

  if (!at && (requested === SortKey.DATE || requested === SortKey.SIZE)) {
    // 同身份的第一页并发时共用同一次读取。
    const identity = JSON.stringify([root, rel, requested]);
    let read = listing.reads.get(identity);
    if (!read) {
      const order = ++listing.started;
      listing.latest.set(identity, order);
      const isLatest = () => listing.latest.get(identity) === order;
      read = firstSnapshotPage(listing, root, rel, path, requested, { pageBytes, maxEntries, statLimit, valid, isLatest })
        .finally(() => {
          if (listing.reads.get(identity) === read) listing.reads.delete(identity);
          if (isLatest()) listing.latest.delete(identity);
        });
      listing.reads.set(identity, read);
    }
    return read;
  }

  const dir = await resolveInRoot(root, path);
  const dirents = await readDirents(listing, dir);
  if (dirents.length > maxEntries) throw fail(ErrorCode.TOO_LARGE, `目录条目超过 ${maxEntries} 个`);
  return pageByKey(listing, root, dir, dirents, at ? at.sort : requested, at?.after ?? null, pageBytes);
}
