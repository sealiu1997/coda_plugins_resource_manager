// 文件名搜索在页面这一侧的状态（设计见 docs/design/phase-3.md 第 18.3 节）：搜索词、搜索轮次、防抖、在途的请求、结果和它所属的搜索词、结果的选中。
// 不碰 DOM，请求由 call 发。
//
// 每个异步机制的五样：
// - 搜索轮次 round：由这里持有。输入、清空、隐藏开关切换、changed 和手动刷新的重搜、换会话、换根目录、根目录不可用都立刻加一（bump），
//   同时取消防抖计时器和在途的请求（link 在请求已发出时发 search_cancel）。只有当前轮次的回答能提交，旧轮次迟到的成功和失败都作废。
// - 防抖计时器：输入或重搜时开始，停顿 DEBOUNCE_MS 才发；到点先核对轮次，不是这一轮就不发；发出时、轮次变了时结束；换会话后不会用新会话发旧词。
// - 在途的请求：发出时开始，回答、失败、被 bump 取消时结束；超时由 link 的 30 秒兜底（算失败，显示原因和重试）；回答回来时还核对会话和根目录的身份。
// - 结果 shown：和它所属的搜索词存在一起；新结果到来之前旧结果留着，状态写「正在搜索…」；加粗用旧结果自己的词。
import { ErrorCode, SEARCH_RESULTS, foldName, matchSpan } from './protocol.mjs';

export const DEBOUNCE_MS = 300;

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = path => path.slice(path.lastIndexOf('/') + 1);

const STOPS = {
  count: `结果太多，只显示先找到的 ${SEARCH_RESULTS} 个`,
  bytes: '结果太多，只显示一部分',
  items: '没搜完（超过 20 万项），只显示已找到的',
  time: '没搜完（超过 5 秒），只显示已找到的',
  queue: '没搜完（目录太多），只显示已找到的',
};

// 状态行（结果上面一行）：{ text, retry? }。
export function statusOf({ status, error, shown }) {
  if (status === 'error') return { text: `搜索失败：${error}`, retry: true };
  if (status === 'searching') return { text: '正在搜索…' };
  if (!shown) return { text: '' };
  const base = shown.stop === 'done' ? (shown.items.length === 0 ? '没有找到' : `共 ${shown.items.length} 个`) : STOPS[shown.stop] ?? '';
  return { text: shown.unreadable > 0 ? `${base} · ${shown.unreadable} 项读不到` : base };
}

// call(fields, signal) → Promise<searched 回答>；hidden()：现在是不是显示隐藏文件；identity()：会话和根目录的身份串；
// onChange()：状态变了，页面据此重画。
export function createSearch({ call, hidden, identity, onChange, timers = globalThis }) {
  let text = '', round = 0, timer = null, inflight = null;
  let shown = null; // { term, folded, items, stop, scanned, unreadable }：结果和它所属的搜索词
  let status = 'idle', error = '', selected = null, suspended = false;
  let cache = null; // rows() 的缓存：同一份结果只算一次行

  const bump = () => {
    round++;
    timers.clearTimeout(timer);
    timer = null;
    inflight?.abort();
    inflight = null;
  };

  function send(mine) {
    const term = text.trim(), controller = new AbortController(), id = identity();
    inflight = controller;
    status = 'searching';
    onChange();
    const current = () => round === mine && identity() === id;
    call({ query: term, hidden: hidden() }, controller.signal).then(reply => {
      if (!current()) return;
      inflight = null;
      shown = { term, folded: foldName(term), items: reply.results, stop: reply.stop, scanned: reply.scanned, unreadable: reply.unreadable };
      cache = null;
      status = 'idle';
      if (selected !== null && !reply.results.some(item => item.path === selected)) selected = null;
      onChange();
    }, failure => {
      if (failure?.stale || !current()) return;
      inflight = null;
      status = 'error';
      error = failure?.code === ErrorCode.INVALID_QUERY ? '搜索词无效' : failure?.message ?? '未知原因';
      onChange();
    });
  }

  // 防抖：停顿才发。回调里核对轮次，不是这一轮就不发。
  function schedule() {
    const mine = round;
    status = 'searching';
    timer = timers.setTimeout(() => { timer = null; if (round === mine) send(mine); }, DEBOUNCE_MS);
  }

  return {
    get text() { return text; },
    get active() { return text.trim() !== ''; },
    get status() { return status; },
    get error() { return error; },
    get shown() { return shown; },
    get round() { return round; },
    get selected() { return selected; },
    get suspended() { return suspended; },
    statusLine: () => statusOf({ status, error, shown }),

    // 用户输入（含清空）：换了词，旧结果留到新结果来；空词立刻回到浏览。
    input(value) {
      text = value;
      bump();
      if (text.trim() === '') { shown = null; cache = null; selected = null; status = 'idle'; }
      else schedule();
      onChange();
    },
    // changed、手动刷新、隐藏开关切换：有搜索词就重搜，旧结果留到新结果来。
    research() {
      if (text.trim() === '') return;
      bump();
      schedule();
      onChange();
    },
    // 根目录暂不可用（scope 没变）：取消，丢结果，留搜索词；再就绪时 resume。
    suspend() {
      bump();
      shown = null; cache = null; selected = null; status = 'idle';
      suspended = true;
      onChange();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      this.research();
    },
    // 换会话、换根目录、定位开始、用户清空：搜索词、结果、选中都清掉。
    reset() {
      bump();
      text = ''; shown = null; cache = null; selected = null; status = 'idle'; error = ''; suspended = false;
      onChange();
    },
    // 结果的选中：只改这里，不重画；返回是不是变了。
    select(path) {
      if (selected === path) return false;
      selected = path;
      return true;
    },
    // 结果列表的行（mountTree 复用的行格式）：加粗用结果自己的词。
    rows() {
      if (!shown) return [];
      if (cache?.shown !== shown) {
        cache = { shown, rows: shown.items.map(item => {
          const name = baseOf(item.path);
          return { type: 'entry', path: item.path, name, depth: 0, kind: item.kind, link: item.link === true, open: false,
            bold: matchSpan(name, shown.folded), place: dirOf(item.path) || '工作目录', chevron: false };
        }) };
      }
      return cache.rows;
    },
    dispose() { bump(); },
  };
}
