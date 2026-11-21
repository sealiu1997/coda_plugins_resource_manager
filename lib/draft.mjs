// 把文字追加到会话的输入框草稿：经 coda/thread@1 的操作 append-draft。
// 服务端在同一个事务里读草稿、拼接并按版本保存，保留现有附件，拼完超过上限（10 万字）就拒绝。
import { DRAFT_LIMIT, ErrorCode, fail } from '../view/protocol.mjs';

const failed = () => fail(ErrorCode.DRAFT_FAILED, '读写草稿失败');
const tooLong = () => fail(ErrorCode.DRAFT_TOO_LONG, '草稿太长，放不下');

function isTooLong(error) {
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  if (code === ErrorCode.DRAFT_TOO_LONG || code === ErrorCode.TOO_LARGE || code === 'too_long' || code === 'payload_too_large') return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /too[_ ]?long|limit|上限|太长|过长|超出|超过/i.test(message);
}

// 追加成功返回 true；valid() 变假（会话换了、视图关了）静默结束，返回 false：不写、不报。
// block 为 true（内容）时传 line: true，false（路径、位置）时传 line: false。
// 失败抛 draft_failed，拼完超过上限抛 draft_too_long，不截断。
export async function addText(coda, session, { text, block }, { valid = () => true } = {}) {
  if (typeof text !== 'string' || text.includes('\0') || typeof block !== 'boolean') throw failed();
  if (text.length > DRAFT_LIMIT) throw tooLong();
  if (!valid()) return false;
  try {
    await coda.call({ kind: 'coda/thread@1', id: session }, 'append-draft', { text, line: block });
  } catch (error) {
    if (!valid()) return false;
    if (isTooLong(error)) throw tooLong();
    throw failed();
  }
  return valid();
}
