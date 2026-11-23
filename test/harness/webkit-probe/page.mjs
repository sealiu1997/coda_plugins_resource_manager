// WebKit 探针的测试页：真实的 view/html.mjs 经 coda-view: 加载（和宿主一样，脚本来自 coda-view:）。
// 由 probe.swift 逐步调用 window.__P 上的函数，每一步返回 JSON 字符串；请求计数在 Swift 一侧（自定义 scheme 的处理器）。
import { renderHtml } from '/view/html.mjs';

const BASE = 'coda-view://service';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let rafOk = true;
// 观察窗口：两帧 requestAnimationFrame 再加 500 ms。rAF 不触发（窗口被遮住等）就记下来，由 Swift 判失败。
const frames = () => new Promise(resolve => {
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; rafOk = false; resolve(); } }, 3000);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!done) { done = true; clearTimeout(timer); resolve(); } }));
});
const observe = async () => { await frames(); await sleep(500); };

window.__BEACON = [];
const violations = [];
document.addEventListener('securitypolicyviolation', event => violations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));

const u = id => `${BASE}/probe/PROBE-${id}~.png`; // 指向 coda-view: 的探针地址
const corpus = [];
const add = (id, html) => corpus.push({ id, html });
add('img', `<img src="${u('img')}"><p>x</p>`);
add('img-relative', `<img src="img/LEGIT-rel.png" alt="r">`); // 相对地址：只解析时落在 coda-view://service/img/…（不在流式服务路径下，真发请求会成「意外请求」）；挂载后是合法的本地图片
add('img-lazy', `<img loading="lazy" src="${u('img-lazy')}">`);
add('img-srcset', `<img src="${u('srcset-main')}" srcset="${u('srcset-1')} 1x, ${u('srcset-2')} 2x">`);
add('picture', `<picture><source srcset="${u('picture-source')}"><img src="${u('picture-img')}"></picture>`);
add('input-image', `<input type="image" src="${u('input-image')}">`);
add('video', `<video poster="${u('video-poster')}" src="${u('video-src')}"><source src="${u('video-source')}"><track src="${u('video-track')}"></video>`);
add('audio', `<audio src="${u('audio')}"><source src="${u('audio-source')}"></audio>`);
add('link', `<link rel="stylesheet" href="${u('link-css')}"><link rel="icon" href="${u('link-icon')}"><link rel="preload" as="image" href="${u('link-preload')}"><p>x</p>`);
add('script-src', `<script src="${u('script-src')}"></script><p>x</p>`);
add('iframe', `<iframe src="${u('iframe')}"></iframe><iframe srcdoc="&lt;img src='${u('iframe-srcdoc')}'&gt;"></iframe>`);
add('object-embed', `<object data="${u('object')}"></object><embed src="${u('embed')}">`);
add('background', `<body background="${u('body-bg')}"><table background="${u('table-bg')}"><tr><td background="${u('td-bg')}">x</td></tr></table></body>`);
add('style', `<style>@import url(${u('style-import')}); p { background: url(${u('style-url')}) }</style><p style="background:url(${u('style-attr')})">x</p>`);
add('svg', `<svg><image href="${u('svg-image')}"/><image xlink:href="${u('svg-xlink')}"/><use href="${u('svg-use')}#a"/><filter><feImage href="${u('svg-feimage')}"/></filter></svg>`);
add('math', `<math href="${u('math')}"><mtext>x</mtext></math>`);
add('a-ping', `<a href="${u('a-href')}" ping="${u('a-ping')}">x</a>`);
add('meta-refresh', `<meta http-equiv="refresh" content="0;url=${u('meta-refresh')}"><p>x</p>`);
add('base', `<base href="${BASE}/probe/PROBE-base~/"><img src="img/LEGIT-base.png" alt="b"><a href="y.html">y</a>`);
add('form', `<form action="${u('form')}"><button formaction="${u('formaction')}">b</button></form>`);
add('handlers', `<img src="x" onerror="window.__BEACON.push('onerror')"><svg onload="window.__BEACON.push('svg-onload')"></svg><a href="javascript:window.__BEACON.push('javascript')">x</a>`);
add('entity', `<img src="&#99;oda-view://service/probe/PROBE-entity~.png">`);
add('noscript', `<noscript><img src="${u('noscript')}"></noscript>`);
add('template', `<template><img src="${u('template')}"></template>`);
add('data-svg', `<img src="data:image/svg+xml,&lt;svg xmlns='http://www.w3.org/2000/svg'&gt;&lt;image href='${u('data-svg')}'/&gt;&lt;/svg&gt;">`);
// 正对照：合法的本地图片（相对路径，经 resolveImage 变成 coda-view: 上的流式服务地址）和允许的 data: 位图。
add('control-local', `<p>正文</p><img src="img/LEGIT-a.png" alt="a"><img src="./img/LEGIT-b.png" alt="b">`);
add('control-data', `<img src="data:image/png;base64,${PNG_B64}" alt="d">`);

const resolveImage = rel => `${BASE}/img/legit/${rel.split('/').map(encodeURIComponent).join('/')}`;
const options = { basePath: '', resolveImage, isCurrent: () => true, onViewSource() {}, onOpenExternal() {}, onOpenRelative() {}, onCopyEmail() {} };
const casesEl = document.getElementById('cases');
const rendered = new Map();
const json = value => JSON.stringify(value);
const imageState = img => ({ complete: img.complete, width: img.naturalWidth });

window.__P = {
  // 被测模块已经运行的标记：Swift 先等它，没有它，后面的「零请求」不算数。
  boot: () => json({ ok: typeof renderHtml === 'function', cases: corpus.length, beacon: window.__BEACON.length, visibility: document.visibilityState }),
  // CSP 是否真的生效：两个必然被宿主策略挡掉的请求（img-src、connect-src 都不放行 http:），必须上报违规事件。
  async cspProbe() {
    new Image().src = 'http://127.0.0.1:9/PROBE-csp-img~.png';
    fetch('http://127.0.0.1:9/PROBE-csp-fetch~.json').catch(() => {});
    await observe();
    return json({ violations: violations.map(v => `${v.directive} ${v.blocked}`) });
  },
  // 金丝雀：一个确定会发往 coda-view: 的图片请求，用来证明 Swift 一侧的计数灵敏。
  async canary() {
    new Image().src = u('canary');
    await observe();
    return json({});
  },
  // 只解析：DOMParser，不挂载。
  async parseOnly() {
    const docs = corpus.map(c => new DOMParser().parseFromString(c.html, 'text/html'));
    await observe();
    return json({ parsed: docs.length, beacon: window.__BEACON.slice(), rafOk });
  },
  // 挂载：清洗之后挂进页面（每条叠在左上角，让懒加载的图都落在可视区里），等观察窗口，再等图片加载完。
  async mount() {
    const failed = [];
    for (const c of corpus) {
      const section = document.createElement('section');
      section.dataset.case = c.id;
      casesEl.append(section);
      try {
        const result = renderHtml(c.html, options);
        section.append(result.node);
        rendered.set(c.id, section);
      } catch (error) { failed.push(`${c.id}: ${error}`); }
    }
    await observe();
    const deadline = performance.now() + 10000;
    while (![...document.images].every(img => img.complete) && performance.now() < deadline) await sleep(20);
    await frames();
    const html = casesEl.innerHTML;
    const leaks = [...html.matchAll(/PROBE-[a-z0-9-]+/g)].map(m => m[0]);
    const forbidden = [...casesEl.querySelectorAll('script, iframe, link, object, embed, style, video, audio, source, track, picture, input, form, svg, base, meta, [srcset], [background], [ping], [onerror], [onload]')].map(el => el.localName);
    const local = [...rendered.get('control-local').querySelectorAll('img')].map(imageState);
    const data = [...rendered.get('control-data').querySelectorAll('img')].map(imageState);
    const text = rendered.get('control-local').textContent;
    return json({ mounted: rendered.size, failed, leaks, forbidden, local, data, textOk: text.includes('正文'), beacon: window.__BEACON.slice(), rafOk });
  },
  // SVG：带 CSP 头的 svg 放在 <img> 里（直接建的，和经 renderHtml 挂载的两种）仍要显示；必然失败的图作负对照。
  async svg() {
    const direct = new Image();
    direct.src = `${BASE}/img/legit/svg/a.svg`;
    const out = { direct: null, viaRender: null, missing: null, pixel: null };
    try { await direct.decode(); out.direct = { width: direct.naturalWidth, height: direct.naturalHeight }; } catch (error) { out.direct = { error: String(error) }; }
    const section = document.createElement('section');
    section.dataset.case = 'svg-render';
    casesEl.append(section);
    const result = renderHtml('<p>svg</p><img src="svg/a.svg" alt="s">', options);
    section.append(result.node);
    const img = section.querySelector('img.md-img');
    if (img) {
      try { await img.decode(); out.viaRender = { width: img.naturalWidth, height: img.naturalHeight }; } catch (error) { out.viaRender = { error: String(error) }; }
    } else out.viaRender = { error: '没有 img.md-img' };
    const missing = new Image();
    missing.src = `${BASE}/img/legit/svg/missing.svg`;
    try { await missing.decode(); out.missing = { width: missing.naturalWidth }; } catch (error) { out.missing = { error: String(error) }; }
    try { // 读一个像素：黄底（#fff8e1）上 (50,70) 是绿圆（#2e7d32）；画布被污染读不出来时只记下来，不判失败
      const canvas = document.createElement('canvas');
      canvas.width = 360; canvas.height = 140;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(direct, 0, 0);
      out.pixel = [...ctx.getImageData(50, 70, 1, 1).data];
    } catch (error) { out.pixel = { unavailable: String(error) }; }
    await observe();
    out.rafOk = rafOk;
    return json(out);
  },
};
document.body.dataset.boot = 'ready';
