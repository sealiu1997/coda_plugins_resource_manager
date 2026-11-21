// 把文字交给对话（页面这一侧）：写进输入框；写不进去、放不下就改成复制并提示。树页和文件页共用。
// 写草稿本身在模块里（lib/draft.mjs），页面只发 add_text 并看回答。
import { MESSAGE_LIMIT, Type } from './protocol.mjs';

// 选区的位置文字：src/app.ts:12-18，只有一行时是 src/app.ts:12。
export const positionText = (path, startLine, endLine) => (endLine > startLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`);

export const MESSAGES = {
  added: '已添加到输入框',
  failed: '没能写入输入框，已复制',
  tooLong: '选中内容太长，已复制',
  copyFailed: '没能写入，也没能复制',
};

// link：连接层的 Link；copy(text)：复制到剪贴板；hint：view/hint.mjs 的提示。
export function createChat({ link, copy, hint }) {
  // 等复制的结果再提示：剪贴板同步抛错、异步拒绝都算失败。回来时会话换过了（generation 变了，A→B→A 也算）就什么都不提示，那条提示属于上一个会话。
  const copied = async (text, message) => {
    const { generation } = link;
    let ok = true;
    try { await copy(text); } catch { ok = false; }
    if (link.generation === generation) hint.show(ok ? message : MESSAGES.copyFailed);
  };

  // block：true 是内容（另起一行），false 是路径和位置（接在后面）。
  // 会话换了、视图关了（Stale、Cancelled）静默：不提示、不复制。别的失败（含 draft_too_long、超时）都改成复制。
  async function add(text, { block = false } = {}) {
    const fields = { text, block };
    // 按完整信封算：超过消息上限的发了会被宿主丢掉，页面只能等到超时。
    if (link.size(Type.ADD_TEXT, fields) > MESSAGE_LIMIT) return copied(text, MESSAGES.tooLong);
    try {
      await link.call(Type.ADD_TEXT, fields);
      hint.show(MESSAGES.added, { warn: false });
    } catch (error) {
      if (error?.stale) return;
      copied(text, MESSAGES.failed);
    }
  }

  return {
    add,
    // 选中文字的菜单项。内容和位置在打开菜单前就取好了（selection），点菜单时不再读选区。
    // 富文本预览（如 Markdown 预览模式）没有源码行号，仅提供「添加到聊天（内容）」和「复制」。
    selectionItems: ({ path, text, startLine, endLine }) => [
      { label: '添加到聊天（内容）', run: () => add(text, { block: true }) },
      ...(Number.isInteger(startLine) ? [{ label: '添加到聊天（位置）', run: () => add(positionText(path, startLine, endLine)) }] : []),
      { label: '复制', run: () => copy(text) },
    ],
  };
}
