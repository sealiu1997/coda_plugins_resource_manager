// 页面到模块的连接：请求与回答（Link）、hello 握手与超时、按代次分发协议消息。
// 树页和文件页共用。只管连接：树的 Model、状态保存、提示文案和 DOM 都在各自的页面里。
import { ErrorCode, REQUEST_ID_MAX, ReplyOf, Type, isReply, messageSize } from './protocol.mjs';

export const TIMEOUT_MS = 30_000;

// 会话已经换了，请求作废。调用方一律吞掉，不显示。
export class Stale extends Error { constructor() { super('已过期'); this.stale = true; } }
// 页面自己取消了请求：和 Stale 一样静默，调用方吞掉。
export class Cancelled extends Stale { constructor() { super(); this.cancelled = true; } }
export class RequestError extends Error { constructor(code, message) { super(message); this.code = code; } }

// 页面实例的请求号前缀：页面加载时生成一次。重建后的新页面请求号从 1 重新数，没有前缀就会和旧页面还在路上的回答撞上。
export const newPrefix = () => Math.random().toString(36).slice(2, 10);

// 请求与回答按 requestId 对应。回答要代次相同、请求号还在等待、类型是这个请求该收的那种才算；换会话时 reset 作废所有等待并停掉超时。
// 一个请求只在 #finish 里结算：回答、发送失败、超时、代次失效、取消都走它，只结算一次，同时清掉定时器和取消监听。
export class Link {
  generation = null;
  pending = new Map();
  #next = 1;

  // prefix：请求号带它（<前缀>-q1），总长不超过 REQUEST_ID_MAX；不给就是 q1，测试和手动传输用。
  constructor({ post, timers = globalThis, timeoutMs = TIMEOUT_MS, prefix = '' }) {
    Object.assign(this, { post, timers, timeoutMs });
    this.prefix = prefix === '' ? '' : `${prefix.slice(0, REQUEST_ID_MAX - 12)}-`;
  }

  #id(n) { return `${this.prefix}q${n}`; }

  // 结算 requestId 对应的等待：还在等才算，返回是否结算了。
  #finish(requestId, settle) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    this.timers.clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    settle(entry);
    return true;
  }

  reset(generation) {
    this.generation = generation;
    for (const requestId of [...this.pending.keys()]) this.#finish(requestId, entry => entry.reject(new Stale()));
  }

  // 这条请求发出去的消息有多大（含信封）：用下一个请求号算，和 call 真正发出的一致。页面用它在发之前判断会不会超过消息上限。
  size(type, fields) {
    return messageSize({ type, generation: this.generation, requestId: this.#id(this.#next), ...fields });
  }

  // options.signal：中止后请求静默作废（Cancelled）。options.cancel：中止时还要告诉模块的消息类型，带 generation 和 requestId；
  // 请求还没发出就中止的，两条都不发。
  call(type, fields, { signal, cancel } = {}) {
    if (this.generation === null) return Promise.reject(new Stale());
    if (signal?.aborted) return Promise.reject(new Cancelled());
    const { generation } = this, requestId = this.#id(this.#next++);
    return new Promise((resolve, reject) => {
      const fire = error => this.#finish(requestId, entry => entry.reject(error));
      const timer = this.timers.setTimeout(() => fire(new RequestError('timeout', '30 秒没有回答')), this.timeoutMs);
      const entry = { resolve, reject, timer, signal, posted: false, type };
      entry.onAbort = () => {
        const { posted } = entry;
        if (fire(new Cancelled()) && cancel && posted) this.#notify({ type: cancel, generation, requestId });
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.pending.set(requestId, entry);
      Promise.resolve().then(() => {
        if (signal?.aborted) return; // 发出之前就中止了：不发，也不用告诉模块
        entry.posted = true;
        return this.post({ type, generation, requestId, ...fields });
      }).catch(() => fire(new RequestError(ErrorCode.IO, '消息发不出去')));
    });
  }

  // 没有回答的消息，发不出去也不影响页面。
  #notify(message) {
    try { Promise.resolve(this.post(message)).catch(() => {}); } catch { /* 宿主不可用 */ }
  }

  receive(message) {
    if (message.generation !== this.generation) return false;
    // 回答的类型不是这个请求该收的（别的页面实例的旧回答撞上了同一个请求号）：不结算，请求继续等它自己的回答。
    const entry = this.pending.get(message.requestId);
    if (entry && ReplyOf[entry.type] !== message.type) return false;
    return this.#finish(message.requestId, entry => {
      if (message.error) entry.reject(new RequestError(message.error.code, message.error.message));
      else entry.resolve(message);
    });
  }
}

// 建立连接并开始监听模块的消息；调用 hello() 才发出握手。
// handlers：session、root、changed。session 先作废旧代次的请求再交给页面；
// root、changed 只在代次等于当前时才交出；各种回答（见 protocol 的 ReplyOf）直接对应请求，页面不用管。
// 握手的结束条件是收到首个 root；之后不再提示超时。
// onStatus：握手状态变了（开始、失败、重试）时调用，页面据此重画说明。
export function connect(coda, { handlers, onStatus = () => {} }) {
  const link = new Link({ post: message => coda.postMessage(message), prefix: newPrefix() });
  let answered = false, timer = null, failure = null;

  function fail(reason) {
    if (answered) return;
    clearTimeout(timer);
    failure = reason;
    onStatus();
  }

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case Type.SESSION:
        link.reset(data.generation);
        return handlers.session(data);
      case Type.ROOT: case Type.CHANGED:
        if (data.generation !== link.generation) return;
        if (data.type === Type.ROOT) { // 首个 root 才算模块回答了：只收到 session 时页面还是空的，照样要提示
          answered = true;
          clearTimeout(timer);
          failure = null;
        }
        return handlers[data.type](data);
      default:
        if (isReply(data.type)) link.receive(data);
    }
  });

  return {
    link,
    // 握手失败的原因，没有失败时为 null。
    get failure() { return failure; },
    async hello() {
      clearTimeout(timer);
      failure = null;
      timer = setTimeout(() => fail('30 秒没有收到回答'), TIMEOUT_MS);
      onStatus();
      try { await coda.postMessage({ type: Type.HELLO }); } catch { fail('消息发不出去'); }
    },
    // 用户手动刷新：让模块先重新查询根目录。还没有代次（没收到 session）时无事可做。
    refresh() {
      if (link.generation === null) return;
      try { Promise.resolve(coda.postMessage({ type: Type.REFRESH, generation: link.generation })).catch(() => {}); } catch { /* 宿主不可用 */ }
    },
  };
}
