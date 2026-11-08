// 走树：文件夹大小（lib/info.mjs 的 dirSize）和文件名搜索（lib/search.mjs）共用的一份遍历（设计见 docs/design/phase-3.md 第 18.2 节）。
// 只读：都经视图共用的读取状态（lib/tree.mjs 的 createListing）的 fs 和并发上限。
// - 同一时间只读一个目录，用只取名字的 readdir（不用 opendir、withFileTypes：文件系统不报类型时它们可能同步 lstat）；
//   readdir 和 lstat 都经并发上限排队，排到名额后先核对停止条件再读。条目的 lstat 一批最多 BATCH 个，等回来才排下一批。
// - 不跟随链接：只有 lstat 说是目录才进；进一个目录之前再 lstat 它一次，已经不是目录（被换成链接）就跳过，读不到计入 unreadable。
//   这只缩小「校验和使用之间」的窗口，不声称根治（docs/backlog.md 已接受的那一条）。起点由 resolve（默认 resolveInRoot）解析，不再 lstat。
// - 项数到 limit、用时到 timeoutMs、待访问目录的路径总字节到 queueBytes、调用方自己 stop(reason)：立刻结算，已发出的读取不再计入；
//   signal 中止、valid() 为假（会话、根目录变了或视图关了）静默结算为 null，不回答。
// - 子目录读不到、进目录前的 lstat、条目的 lstat 失败都计入 unreadable；起点读不到才算错误。
//
// 两个信号：result 是「请求结算了」，drained 是「读取排空了」。已经发出去的读取撤不回，结算（中止、超时、走完、出错）之后只是不再发新的：
// drained 要等已经停止派发、并且这次走树启动过的所有读取（起点解析、进目录前的 lstat、readdir、条目的 lstat，
// 加上调用方用 track 登记的）都结束。走树中途在途个数暂时为 0（一批读完、下一批还没发）不算。
import { join } from 'node:path';
import { fromFsError, resolveInRoot } from './paths.mjs';

export const WALK_ITEMS = 200_000;
export const QUEUE_BYTES = 32 * 1024 * 1024;
// 一批同时排进并发上限的 lstat 数；等它们回来才排下一批。
const BATCH = 4;

// 待访问的目录。depth 是栈（后进先出，文件夹大小用），breadth 是队列（先浅后深，搜索用）：
// 带头部下标的数组，取过的元素释放，不用 shift()；头部过半再整理一次。路径的总字节超过 maxBytes，push 返回 false。
function createQueue(order, maxBytes) {
  let items = [], head = 0, bytes = 0;
  return {
    get size() { return items.length - head; },
    push(item) {
      bytes += Buffer.byteLength(item.dir);
      if (bytes > maxBytes) return false;
      items.push(item);
      return true;
    },
    take() {
      let item;
      if (order === 'breadth') {
        item = items[head];
        items[head++] = undefined;
        if (head >= 1024 && head * 2 >= items.length) { items = items.slice(head); head = 0; }
      } else item = items.pop();
      bytes -= Buffer.byteLength(item.dir);
      return item;
    },
  };
}

// options：
// - visit({ dir, tag, name, info, stop })：每个 lstat 成功的条目一次，info 是 lstat 的结果；返回要不要进（info 是目录才进）。
//   真值是 true 或 { tag }：tag 带给进去之后这个目录里条目的 visit。ordered 为真时 visit 可以是异步的，等它回来才处理下一个条目。
// - ordered：为真时一批 lstat 全回来后，按 readdir 的名字顺序逐个 visit（搜索用）；为假时每个 lstat 一回来就 visit（文件夹大小保留现在的样子）。
// - order：'depth'（默认）或 'breadth'。
// - timeoutMs：给了才在这里计时；搜索的 5 秒从请求算起，含等屏障，由调用方自己计时再 stop('time')。
// 返回 { result, drained, stop, track, done, total }：done() 是已经结算了没有；result 解析为 { reason, items, unreadable }（reason：done、items、time、queue 或调用方给的），
// 静默结算是 null，起点读不到或解析失败是拒绝；stop(reason) 结算；track(fn) 把调用方自己的读取登记进在途个数。
export function startWalk(listing, root, path, {
  visit, ordered = false, order = 'depth', tag = '', valid = () => true, signal, limit = WALK_ITEMS, timeoutMs = null,
  queueBytes = QUEUE_BYTES, resolve: resolvePath = resolveInRoot,
}) {
  const { fs } = listing;
  const total = { items: 0, unreadable: 0 };
  let over = false, inflight = 0, timer = null, finish;
  const drained = new Promise(done => { finish = done; });
  const maybeDrained = () => { if (over && inflight === 0) finish(); };
  async function track(fn) {
    inflight++;
    try { return await fn(); } finally { inflight--; maybeDrained(); }
  }

  const api = { result: null, drained, track, total, stop: () => {}, done: () => over };
  api.result = new Promise((resolve, reject) => {
    // 结算一次：之后的一切读取结果、定时器、中止都不再有影响，也不再派发新的读取。
    const settle = done => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done();
      maybeDrained();
    };
    const end = reason => settle(() => resolve({ reason, ...total }));
    const onAbort = () => settle(() => resolve(null));
    // 停了没有。valid() 为假或已中止的在这里顺便结算成静默停止。
    const stopped = () => {
      if (over) return true;
      if (signal?.aborted || !valid()) { settle(() => resolve(null)); return true; }
      return false;
    };
    api.stop = end;

    // 排队读一次：排到名额后先核对停止条件，停了就不读（返回 undefined）。
    const read = fn => track(() => listing.run(() => (stopped() ? undefined : fn())));

    if (signal?.aborted) return settle(() => resolve(null));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== null) timer = setTimeout(() => end('time'), timeoutMs);

    async function run() {
      // 解析慢时由计时和中止先结算；这里回来之后 stopped() 再核对一遍，已经停了就不读。
      const start = await track(() => resolvePath(root, path));
      if (stopped()) return;
      const queue = createQueue(order, queueBytes);
      queue.push({ dir: start, tag, start: true });

      // 处理一个 lstat 回来的条目：计数，交给 visit，要进的目录入队。
      async function accept(dir, parentTag, name, info) {
        if (stopped()) return; // 已经停了，回来的结果不再计入
        total.items++;
        if (!info) { total.unreadable++; return; }
        const entered = await visit({ dir, tag: parentTag, name, info, stop: end });
        if (stopped() || !entered || !info.isDirectory()) return;
        if (!queue.push({ dir: join(dir, name), tag: entered?.tag ?? '' })) end('queue');
      }

      while (queue.size > 0 && !stopped()) {
        const item = queue.take();
        if (!item.start) {
          let info = null, failed = false;
          try { info = await read(() => fs.lstat(item.dir)); } catch { failed = true; }
          if (stopped()) return;
          if (failed) { total.unreadable++; continue; }
          if (!info.isDirectory()) continue; // 已经不是目录了（被换成链接）：不进
        }
        let names;
        try { names = await read(() => fs.readdir(item.dir)); } catch (error) {
          if (item.start) throw fromFsError(error);
          if (stopped()) return;
          total.unreadable++;
          continue;
        }
        if (stopped()) return;
        let at = 0;
        while (at < names.length) {
          if (stopped()) return;
          if (total.items >= limit) return end('items');
          const batch = names.slice(at, at + Math.min(BATCH, limit - total.items));
          at += batch.length;
          const infos = new Array(batch.length);
          await Promise.all(batch.map((name, i) => read(async () => {
            let info = null;
            try { info = await fs.lstat(join(item.dir, name)); } catch { /* 下面计入 unreadable */ }
            if (ordered) infos[i] = info; else await accept(item.dir, item.tag, name, info);
          })));
          if (ordered) for (let i = 0; i < batch.length; i++) { if (stopped()) return; await accept(item.dir, item.tag, batch[i], infos[i] ?? null); }
        }
        if (!stopped() && total.items >= limit && queue.size > 0) return end('items');
      }
      end('done');
    }

    run().catch(error => settle(() => reject(error)));
  });

  return api;
}
