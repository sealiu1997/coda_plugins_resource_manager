// 搜索框：目录树和图标视图顶上常驻的一行（设计见 docs/design/phase-3.md 第 18.3 节）。只管这一个输入框和它的清除按钮，搜索词归 view/search.mjs。
import { h } from './dom.mjs';
import { icon } from './icons.mjs';
import { QUERY_MAX } from './protocol.mjs';

// onInput(text)：用户输入；onClear()：点清除按钮；onKey(event)：输入框里的按键（Esc、↓ 由页面按分派表处理）；
// onEnter()：回车或 iPhone 键盘的「搜索」键。字号不小于 16 点（style.css）：iPhone 上小于 16 点聚焦时页面会放大。
export function mountSearchbar(el, { onInput, onClear, onKey, onEnter }) {
  const input = h('input', {
    id: 'q', type: 'search', placeholder: '搜索文件名', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    maxlength: QUERY_MAX, 'aria-label': '搜索文件名',
    oninput: () => onInput(input.value), onkeydown: event => { if (event.key === 'Enter' && !event.isComposing) onEnter(); else onKey(event); },
  });
  const clear = h('button', { class: 'icon sclear', 'aria-label': '清除', title: '清除', onclick: onClear }, icon('clear', 16));
  clear.hidden = true;
  el.replaceChildren(h('div', { class: 'sfield' }, h('span', { class: 'sico', 'aria-hidden': 'true' }, icon('search', 16)), input, clear));
  return {
    input,
    // 页面把搜索词写回输入框（清空、换会话）；有字时显示清除按钮。
    set(text) { if (input.value !== text) input.value = text; clear.hidden = text === ''; },
    focus() { input.focus(); },
    // 聚焦并选中里面的字。
    select() { input.focus(); input.select?.(); },
    blur() { input.blur?.(); },
    get focused() { return document.activeElement === input; },
  };
}
