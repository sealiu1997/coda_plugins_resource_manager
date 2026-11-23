// 把文件交给 Coda 打开（经流式服务取口令，再 coda.open）：资源页和独立窗口共用这一套串行与作废逻辑。
// 同一时刻只允许一个 coda.open 在途，在途期间的新意图合并到最新一次；cancel() 递增序号并清空待执行的意图，
// 换会话、换根目录、换文件、关预览时调用，旧请求晚完成或晚失败都不再碰页面。
// grant(path) → Promise<{ token }>；open(url) → Promise；fallback(task, error)：请求仍有效时失败了才调用，由页面决定怎么办。
import { serviceUrl } from './protocol.mjs';

export function createExternalOpener({ grant, open, fallback }) {
  let seq = 0, busy = false, queued = null;
  const cancel = () => { seq++; queued = null; };
  async function drain(first) {
    busy = true;
    let current = first;
    try {
      while (current) {
        const { task, mine } = current;
        current = null;
        if (mine === seq) {
          try {
            const granted = await grant(task.path);
            if (mine === seq) {
              if (!granted?.token) throw new Error('没有可用的本机服务');
              await open(serviceUrl(granted.token, task.path));
            }
          } catch (error) {
            if (mine === seq) fallback(task, error);
          }
        }
        if (queued) {
          current = queued;
          queued = null;
        }
      }
    } finally {
      busy = false;
    }
  }
  return {
    cancel,
    // 请求打开 task（{ path, ... }）：先作废之前的，再排队。
    request(task) {
      cancel();
      const next = { task, mine: seq };
      if (busy) queued = next;
      else drain(next);
    },
  };
}
