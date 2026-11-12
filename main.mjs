// 资源管理器的模块：跟踪侧栏的会话、代次和根目录，把页面的请求交给 lib/*，把变化推给页面。
// 协议见 docs/design/phase-1.md 第 6 节，消息格式见 view/protocol.mjs。
import { createListing, listDirectory } from './lib/tree.mjs';
import { readChunk } from './lib/content.mjs';
import { addText } from './lib/draft.mjs';
import { dirSize, statPath } from './lib/info.mjs';
import { createMedia } from './lib/media.mjs';
import { createSearcher } from './lib/search.mjs';
import { NO_ROOT, queryRoot, sameRoot } from './lib/root.mjs';
import {
  EntryKind, ErrorCode, MESSAGE_LIMIT, REQUEST_ID_MAX, ReplyOf, RootState, Type, fail, messageSize,
} from './view/protocol.mjs';

const POLL_MS = 2000;

// 按视图解析会话（设计见 docs/design/phase-2.md 第 6 节）：
// 树只跟随侧栏旁的会话，不看 args；文件视图只取 args.session，须是非空字符串，否则当作没有会话。
const sessionOfTree = context => context?.session ?? null;
const sessionOfFile = context => {
  const session = context?.args?.session;
  return typeof session === 'string' && session !== '' ? session : null;
};

// options 只给测试用，运行时不传：makeListing 换成带假文件系统的读取状态；sizeLimits 调文件夹大小的项数、用时上限；searchLimits 调文件名搜索的条数、项数、用时、队列字节、回答字节上限。
export function activate(coda, { makeListing = createListing, sizeLimits = {}, searchLimits = {} } = {}) {
  // 音视频和图片的本机流式服务，所有视图共用一个，口令按视图发。宿主没有这个接口（旧版本）或登记失败时 service.on 为假，页面退回分块读取。
  const media = createMedia(), service = { on: true };
  try { Promise.resolve(coda.services.register('media', media.handler)).catch(() => { service.on = false; }); } catch { service.on = false; }
  const options = { makeListing, sizeLimits, searchLimits, media, service };
  coda.views.register('files', { open: view => serve(coda, view, sessionOfTree, options) });
  coda.views.register('file', { open: view => serve(coda, view, sessionOfFile, options) });
}

const validRequestId = id => (typeof id === 'string' && id.length <= REQUEST_ID_MAX) || Number.isSafeInteger(id);
const errorOf = error => (error?.protocol ? { code: error.code, message: error.message } : { code: ErrorCode.IO, message: '读取失败' });

function serve(coda, view, sessionOf, { makeListing, sizeLimits, searchLimits, media, service }) {
  // 代次：每换一次会话加 1，所有异步出口回来后都要核对。
  const s = {
    session: sessionOf(view.context), generation: 1, root: NO_ROOT, sent: null,
    hello: false, closed: false, rootSeq: 0, poll: null,
    listing: makeListing(), // 这个视图共用的并发上限和快照；视图关闭、换会话、根目录变化时丢弃
  };
  const turns = new Map();
  const stale = generation => s.closed || generation !== s.generation;

  // 文件夹大小：每个视图同时只有一次统计。新的开始、换会话、根目录变化、视图关闭时旧的静默停止（不回答）。
  let sizing = null; // { generation, requestId, abort }
  const stopSizing = () => { sizing?.abort.abort(); sizing = null; };
  // 文件名搜索：同样每个视图同时只有一次，槽、待启动位和排空屏障都在 lib/search.mjs 的 searcher 里。
  const searcher = createSearcher(s.listing, searchLimits);
  // 媒体口令：这个视图第一次要放音视频或图片时发，映射到当时的根目录。
  let token = null;
  // 换会话、根目录变化、视图关闭：读取状态丢弃，统计和搜索也停，媒体口令作废。
  const resetReads = () => { s.listing.clear(); stopSizing(); searcher.clear(); media.revoke(token); token = null; };

  function post(message) {
    if (s.closed) return;
    if (messageSize(message) > MESSAGE_LIMIT) {
      // 兜底：各模块自己守着上限，到这里说明有遗漏；有请求号的换成错误，其余丢弃。
      if (message.requestId === undefined) return;
      const { type, generation, requestId } = message;
      message = { type, generation, requestId, error: { code: ErrorCode.TOO_LARGE, message: '回答超过消息上限' } };
    }
    try { view.postMessage(message); } catch { /* 视图已关 */ }
  }

  const postSession = () => post({ type: Type.SESSION, generation: s.generation, session: s.session });
  function postRoot() {
    s.sent = s.root;
    post({ type: Type.ROOT, generation: s.generation, state: s.root.state, path: s.root.path, project: s.root.project });
  }

  // 重新查询根目录。结果和上次推给页面的不同才推送；查询失败保留上一次的。
  // 被后发的查询取代的，结果丢掉，由后发的那个去推。
  async function refreshRoot() {
    const { generation } = s, seq = ++s.rootSeq;
    let next = null;
    try { next = await queryRoot(coda, s.session); } catch { /* 保留上一次 */ }
    if (stale(generation) || seq !== s.rootSeq) return;
    if (next) {
      if (next.path !== s.root.path) resetReads();
      s.root = next;
    }
    syncPoll();
    if (s.hello && !sameRoot(s.sent, s.root)) postRoot();
  }

  const stopPoll = () => { if (s.poll) clearTimeout(s.poll.handle); s.poll = null; };
  // 只有当前代次、没关闭、状态是 preparing 时才挂着一个计时器。
  function syncPoll() {
    if (s.closed || !s.session || s.root.state !== RootState.PREPARING) return stopPoll();
    if (s.poll?.generation === s.generation) return;
    stopPoll();
    const { generation } = s;
    const poll = { generation, handle: setTimeout(() => {
      if (s.poll === poll) s.poll = null;
      if (!stale(generation)) refreshRoot();
    }, POLL_MS) };
    s.poll = poll;
  }

  function switchSession(session) {
    stopPoll();
    s.session = session ?? null;
    s.generation++;
    resetReads();
    s.root = NO_ROOT;
    s.sent = null;
    if (s.hello) postSession();
    refreshRoot();
  }

  // 各种请求的处理：返回回答的内容；返回 null 表示静默结束，不回答。
  const handlers = {
    [Type.LIST]: (message, { root, valid }) => listDirectory(root, message.path, message.cursor, { listing: s.listing, sort: message.sort, valid }),
    [Type.READ]: (message, { root }) => readChunk(root, message.path, message.offset),
    [Type.STAT]: (message, { root }) => statPath(s.listing, root, message.path),
    async [Type.DIR_SIZE](message, { root, valid, generation, requestId }) {
      stopSizing();
      const mine = { generation, requestId, abort: new AbortController() };
      sizing = mine;
      try {
        return await dirSize(s.listing, root, message.path, { ...sizeLimits, valid, signal: mine.abort.signal });
      } finally { if (sizing === mine) sizing = null; }
    },
    [Type.SEARCH]: (message, { root, valid, generation, requestId }) => searcher.search(message, { root, valid, generation, requestId }),
    async [Type.MEDIA](message, { root, valid }) {
      const info = await statPath(s.listing, root, message.path);
      if (info.kind !== EntryKind.FILE) throw fail(ErrorCode.NOT_FILE, '不是文件');
      if (!valid()) throw fail(ErrorCode.NO_ROOT, '工作目录已变化');
      if (service.on) token ??= media.grant(root);
      return { token, size: info.size, mtimeMs: info.mtimeMs }; // token 为 null：没有流式服务，页面退回分块读取
    },
    async [Type.ADD_TEXT](message, { generation }) {
      if (!s.session) throw fail(ErrorCode.NO_ROOT, '没有会话');
      return await addText(coda, s.session, message, { valid: () => !stale(generation) }) ? {} : null;
    },
  };
  // 回答依赖根目录的：读完回来根目录换了，不能带旧根目录的内容。
  const rootBound = new Set([Type.LIST, Type.STAT]);
  // 统计和搜索：作废（会话、根目录变了或视图关了）一律静默，不回答。
  const silentWhenVoid = new Set([Type.DIR_SIZE, Type.SEARCH]);

  async function request(message) {
    const { type, generation, requestId } = message;
    if (stale(generation) || !validRequestId(requestId)) return;
    const reply = ReplyOf[type];
    try {
      if (s.root.state !== RootState.READY) throw fail(ErrorCode.NO_ROOT, '没有可浏览的工作目录');
      const root = s.root.path;
      // 读的途中根目录换了（同一会话从 A 换到 B），回答不能带 A 的内容。
      const valid = () => !stale(generation) && s.root.state === RootState.READY && s.root.path === root;
      const body = await handlers[type](message, { root, valid, generation, requestId });
      if (body === null || (silentWhenVoid.has(type) && !valid())) return; // 统计、搜索完成时根目录已变：不回答
      if (rootBound.has(type) && !valid() && !stale(generation)) throw fail(ErrorCode.NO_ROOT, '工作目录已变化');
      if (!stale(generation)) post({ type: reply, generation, requestId, ...body });
    } catch (error) {
      if (!stale(generation)) post({ type: reply, generation, requestId, error: errorOf(error) });
    }
  }

  // 取消统计：代次和请求号都对上才停，迟到的取消不会误伤新的统计。
  function cancelSizing({ generation, requestId }) {
    if (!stale(generation) && sizing?.generation === generation && sizing.requestId === requestId) stopSizing();
  }

  const cancelSearch = ({ generation, requestId }) => { if (!stale(generation)) searcher.cancel({ generation, requestId }); };

  view.onMessage(async message => {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      // 页面（重新）就绪：它什么都不知道，所以不管有没有变，下一次查询的结果都要推。
      // 旧页面发的统计和搜索不再有人要：中止并清空槽（走树的读取排空屏障照常留着）。
      case Type.HELLO: s.hello = true; s.sent = null; stopSizing(); searcher.clear(); postSession(); return refreshRoot();
      case Type.REFRESH:
        if (stale(message.generation)) return undefined;
        s.listing.detach();
        return refreshRoot();
      case Type.LIST: case Type.READ: case Type.STAT: case Type.DIR_SIZE: case Type.ADD_TEXT: case Type.SEARCH: case Type.MEDIA: return request(message);
      case Type.DIR_SIZE_CANCEL: return cancelSizing(message);
      case Type.SEARCH_CANCEL: return cancelSearch(message);
    }
  });

  view.onContext(context => {
    const session = sessionOf(context);
    if (session !== s.session) switchSession(session);
  });

  // 这个会话一轮开始或结束：根目录先更新；结束时再通知页面重新取。
  const watching = Promise.resolve(coda.watch('threads', ({ type, id, object }) => {
    const before = turns.get(id), after = type === 'DELETED' ? undefined : object?.turn ?? null;
    if (after === undefined) turns.delete(id); else turns.set(id, after);
    if (s.closed || id !== s.session || before === undefined || after === undefined || before === after) return;
    const { generation } = s;
    const refreshed = refreshRoot();
    if (before) {
      refreshed.then(() => {
        if (!s.hello || stale(generation)) return;
        s.listing.detach(); // 页面接着重新取，进行中的旧读取不能再被共用
        post({ type: Type.CHANGED, generation });
      });
    }
  })).catch(() => null);

  view.onClose(async () => {
    s.closed = true;
    resetReads();
    stopPoll();
    try { await (await watching)?.dispose(); } catch { /* 已经取消 */ }
  });

  refreshRoot();
}
