// 文件名搜索（设计见 docs/design/phase-3.md 第 18.2 节）：按层走完整棵工作目录，只比名字，不分大小写，包含就算。
// 走树本身在 lib/walk.mjs（和文件夹大小共用）；这里管请求校验、单槽、排空屏障、匹配、收集、排序和字节上限。
//
// 每个异步机制的五样（谁持有、何时开始、何时结束、超时、被替换或作废）：
// - 搜索槽 slot：{ generation, requestId, root, abort }，由这个视图的 searcher 持有。search 请求收到时开始，回答（或静默）时结束；
//   新的 search 先中止旧的（旧的静默结束）；search_cancel 要代次和请求号都对上才中止；hello（页面重建）、换会话、根目录变化、视图关闭时 clear。
//   回答前（成功和出错两个出口）都核对 alive()：槽里还是我、没被中止、valid()（代次、根目录）仍成立，不是就静默结束。
// - 排空屏障 barrier：上一次走树的 drained。走树启动时换成它自己的，到排空（已停止派发且启动过的读取全部结束）才算数；
//   它独立于槽：被替换、hello 清槽都只让旧走树停止派发，屏障留着，新的搜索照样要等。
// - 待启动：收到请求之后、屏障排空之前，请求在这里等。位置只有一个：更新的请求先中止它，它醒来发现自己不是最新就退出，不回答、不取得读取权。
// - 5 秒计时 deadline：请求收到时开始（含等屏障），结算时清掉。到点还在等屏障就回答空结果和 stop: 'time'、scanned: 0；已经在走就 stop('time')，回答已收集的。
//   被替换、取消、作废时和请求一起结束，不回答。
import { Buffer } from 'node:buffer';
import { EntryKind, ErrorCode, MAX_PATH, PAGE_BYTES, QUERY_MAX, SEARCH_RESULTS, Type, fail, foldName, hasControl, isHidden } from '../view/protocol.mjs';
import { classifyLink, compareNames } from './tree.mjs';
import { QUEUE_BYTES, WALK_ITEMS, startWalk } from './walk.mjs';

export const SEARCH_MS = 5000;
// 搜索自己的规则：始终不进这两种目录（它们自己可以作为结果）；不是隐藏名单，不随「显示隐藏文件」。
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// 请求校验：query 是字符串，去掉首尾空白后 1～QUERY_MAX 个字符（UTF-16 单元），不含控制字符；hidden 是布尔值。
function parse(message) {
  const query = typeof message.query === 'string' ? message.query.trim() : null;
  if (query === null || query === '' || query.length > QUERY_MAX || hasControl(query) || typeof message.hidden !== 'boolean') {
    throw fail(ErrorCode.INVALID_QUERY, '搜索词无效');
  }
  return { folded: foldName(query), hidden: message.hidden };
}

const depthOf = path => path.split('/').length;
function comparePaths(a, b) {
  const x = a.split('/'), y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = compareNames(x[i], y[i]);
    if (order !== 0) return order;
  }
  return x.length - y.length;
}

// 排序：名字以搜索词开头的在前；同一组里浅的在前；再按路径逐段用目录列表的名称比较。
function sortResults(results, folded) {
  const keyed = results.map(item => {
    const name = item.path.slice(item.path.lastIndexOf('/') + 1);
    return { item, starts: foldName(name).startsWith(folded) ? 0 : 1, depth: depthOf(item.path) };
  });
  keyed.sort((a, b) => a.starts - b.starts || a.depth - b.depth || comparePaths(a.item.path, b.item.path));
  return keyed.map(({ item }) => item);
}

// 最终回答（含信封）的 JSON UTF-8 字节不超过 pageBytes：排好序后从尾部去掉放不下的。返回保留的条数。
function fit(results, envelope, pageBytes) {
  let used = Buffer.byteLength(JSON.stringify({ ...envelope, results: [] })), count = 0;
  for (const item of results) {
    const size = Buffer.byteLength(JSON.stringify(item)) + (count > 0 ? 1 : 0);
    if (used + size > pageBytes) break;
    used += size;
    count++;
  }
  return count;
}

// limits 只给测试用：results、items、timeoutMs、queueBytes、pageBytes、resolve（起点解析，默认 resolveInRoot）。
export function createSearcher(listing, limits = {}) {
  const {
    results: maxResults = SEARCH_RESULTS, items = WALK_ITEMS, timeoutMs = SEARCH_MS, queueBytes = QUEUE_BYTES, pageBytes = PAGE_BYTES, resolve,
  } = limits;
  let slot = null;
  let barrier = Promise.resolve();

  async function search(message, { root, valid, generation, requestId }) {
    const { folded, hidden } = parse(message);
    const mine = { generation, requestId, root, abort: new AbortController() };
    slot?.abort.abort();
    slot = mine;
    const alive = () => slot === mine && !mine.abort.signal.aborted && valid();

    let expired = false, walk = null, wake = () => {};
    const woken = new Promise(done => { wake = done; });
    const deadline = setTimeout(() => { expired = true; if (walk) walk.stop('time'); else wake(); }, timeoutMs);
    mine.abort.signal.addEventListener('abort', wake, { once: true });
    try {
      await Promise.race([barrier, woken]); // 待启动：等上一次走树排空
      if (!alive()) return null;
      if (expired) return { results: [], stop: 'time', scanned: 0, unreadable: 0 };

      const found = [];
      walk = startWalk(listing, root, '', {
        order: 'breadth', ordered: true, valid: alive, signal: mine.abort.signal, limit: items, queueBytes, resolve,
        async visit({ dir, tag, name, info, stop }) {
          const rel = tag === '' ? name : `${tag}/${name}`;
          if (rel.length > MAX_PATH) return false; // 路径放不进协议：不算结果，也不进
          const control = hasControl(name), hiddenName = !hidden && isHidden(name);
          if (!hiddenName && foldName(name).includes(folded)) {
            // 名字含控制字符的算 other（只显示，不能打开），不进
            let kind = control ? EntryKind.OTHER : info.isDirectory() ? EntryKind.DIR : info.isFile() ? EntryKind.FILE : EntryKind.OTHER, link = false;
            if (!control && info.isSymbolicLink()) {
              // 匹配上的链接按目录列表的规则分类（经并发上限，计入在途读取）
              const linked = await walk.track(() => listing.run(() => classifyLink(listing.fs, root, dir, name)));
              if (walk.done()) return false;
              ({ kind } = linked);
              link = linked.link === true;
            }
            found.push({ path: rel, kind, ...(link ? { link: true } : {}) });
            if (found.length >= maxResults) stop('count');
          }
          return !control && !hiddenName && info.isDirectory() && !SKIP_DIRS.has(name) ? { tag: rel } : false;
        },
      });
      barrier = walk.drained;
      const done = await walk.result;
      if (done === null || !alive()) return null;

      const sorted = sortResults(found, folded);
      const body = { stop: done.reason, scanned: done.items, unreadable: done.unreadable };
      const keep = fit(sorted, { type: Type.SEARCHED, generation, requestId, ...body }, pageBytes);
      if (keep < sorted.length && (body.stop === 'done' || body.stop === 'count')) body.stop = 'bytes';
      return { results: sorted.slice(0, keep), ...body };
    } catch (error) {
      if (!alive()) return null; // 出错的出口也核对身份
      throw error;
    } finally {
      clearTimeout(deadline);
      mine.abort.signal.removeEventListener('abort', wake);
      if (slot === mine) slot = null;
    }
  }

  return {
    search,
    // 取消：代次和请求号都对上才停，迟到的取消不会误伤新的搜索。
    cancel({ generation, requestId }) {
      if (slot?.generation === generation && slot.requestId === requestId) slot.abort.abort();
    },
    // 页面重建、换会话、根目录变化、视图关闭：中止当前搜索。屏障不清，旧走树的读取排空之前新的搜索照样要等。
    clear() { slot?.abort.abort(); slot = null; },
  };
}
