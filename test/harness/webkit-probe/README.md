# WebKit 探针

设计 `docs/design/phase-3.md` 第 27.8 节「WebKit 探针」。真实 Chrome 的测试（`test/harness/html-preview.mjs`）管不到 Coda 客户端用的 WebKit，这里用 macOS 上的 `WKWebView` 补一遍。**只在 macOS 上手动跑，发布前必须跑一次，不进 CI。**

## 运行

```sh
test/harness/webkit-probe/run.sh
```

- 需要 `swiftc`（Xcode 或命令行工具）。`run.sh` 把 `probe.swift` 编译到系统临时目录，跑完删掉；不装依赖，仓库里不留产物。
- 会弹出一个 1000×800 的窗口，跑完自己退出。所有等待都限时（整体 120 秒），任何一项不符，退出码非 0；末尾打印「全部通过」或「失败 N 项」。
- 屏幕锁定或窗口被遮住时，WebKit 把页面当成不可见：`requestAnimationFrame` 不触发，观察窗口就没有意义。探针用 `WKWebView` 的私有方法 `_setWindowOcclusionDetectionEnabled:` 关掉遮挡检测，并在每个观察窗口之后核对 `requestAnimationFrame` 确实触发过。这是 SPI：以后系统里没有它时，探针会打印提示，窗口被遮住时「requestAnimationFrame 正常触发」那几项会失败，那时把窗口放到前台再跑。

## 做什么

| 文件 | 作用 |
|---|---|
| `run.sh` | 取宿主 CSP 和 svg 的 CSP，编译并运行 |
| `probe.swift` | 窗口、`coda-view:` 的 scheme 处理器（按路径统计请求）、逐步驱动页面、判定 |
| `page.html`、`page.mjs` | 测试页：从 `coda-view:` 加载真实的 `view/html.mjs`，样例语料和每一步的页面函数 |

- **CSP**：宿主 CSP 不另抄，`run.sh` 直接取 `test/harness/html-preview.mjs` 里的 `hostCsp`，只把 harness 为测试服务换掉的 `img-src` 路径换回 `coda-view:`，其余逐条照搬；svg 的 CSP 取 `lib/media.mjs` 的 `SVG_CSP`。入口页用响应头下发 CSP。
- **请求计数**：`coda-view:` 的 scheme 处理器按路径分类：页面和模块文件、合法的本地图片（`/img/legit/…`）、探针（`PROBE-…`）、svg，其余都算「意外请求」。泄漏的请求也答 200，让泄漏看得见。

## 验证的三件事

1. **只解析的阶段，`coda-view:` 上的请求为 0**：27 条样例（`img`、`srcset`、`picture`、`video`、`link`、`script`、`iframe`、`object`、`embed`、`style` 的 `url()`、SVG 的 `href`、`base` 之后的相对图、实体编码等，地址都指向 `coda-view:`）只过 `DOMParser`、不挂载，等一个观察窗口（两帧 `requestAnimationFrame` 再加 500 毫秒）。`coda-view:` 放行在宿主 CSP 里，所以这个 0 是真的没发请求，不是被 CSP 挡了。`data:` 看不到请求，只在挂载阶段断言输出。
2. **挂载后只请求合法的本地图片**：同样的样例过 `renderHtml` 并挂载，探针请求仍为 0，图片请求恰好是语料里 4 张合法的本地图片（各一次），输出里没有探针地址，也没有表外的元素和属性；允许的 `data:` 位图和本地图都要显示（`naturalWidth` 大于 0）。
3. **`svg` 加了 CSP 头之后，放在 `<img>` 里仍能显示**：回答头照 `lib/media.mjs`（`image/svg+xml`、`SVG_CSP`、`nosniff`），拿 `test/fixtures/html/svg/a.svg`，直接建的 `<img>` 和经 `renderHtml` 挂载的 `<img>` 都要 `decode()` 成功并有 360×140 的尺寸；再读 (50,70) 的像素确认是绿圆。脚本探针（`svg-script-probe`）请求为 0。

三件事之前先做三道防假通过：

- **启动标记**：页面写出「被测模块已启动」后才看任何计数，并核对 `view/` 下的模块确实经 `coda-view:` 加载过；
- **CSP 真的生效**：一个发往 `http:` 的图片和一个 `fetch` 必须被宿主 CSP 挡住并上报 `img-src`、`connect-src` 的违规事件；
- **计数灵敏**：一个发往 `coda-view:` 的金丝雀图片请求必须被处理器计到。

svg 一项另有负对照：不存在的 svg 必须加载失败，说明「能显示」有区分度。

## 不在这里

- 「在 Coda 里直接打开」svg 时脚本是否执行，要真机和 `b.svg` 对照，见 `test/fixtures/html/svg/README.md`。
- 外链长按、⌘ 点击，iPhone 的内存和滚动，见 `test/fixtures/html/README.md`。
