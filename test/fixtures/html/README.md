# HTML 预览的真机样例

给页内 HTML 预览（设计 `docs/design/phase-3.md` 第 27 节）在 Mac 和 iPhone 上手动验收用。CI 里的真实 Chrome 测试在 `test/harness/html-preview.mjs`，WebKit 的解析和请求行为在 `test/harness/webkit-probe/`，这里只放要人眼看的。

## 怎么用

1. 用「从仓库添加…」装上这个分支，或把本目录放进某个会话的工作目录，在资源管理器里打开下面的文件。
2. 小样例已提交。大样例不进仓库，先生成：

   ```sh
   node test/fixtures/html/generate.mjs
   ```

   输出到 `test/fixtures/html/generated/`（已在 `.gitignore` 里），每次先清空再生成，不装依赖。想在 iPhone 上看，把这个目录拷进会话的工作目录。
3. 打开方式默认是页内「预览」；头部可切「源码」，行菜单里有「在 Coda 中打开」。预览顶部的元信息行会追加「静态预览」。
4. 下面「通过」写的是预期，没有写到的都按「正文显示、没有脚本弹框、没有页面跳走」判断。数字（节点数）是 2026-11-24 在 Chrome 里用 `renderHtml` 量的，iPhone 上只看表现。

## 小样例（已提交）

| 文件 | 看什么 | 通过 |
|---|---|---|
| `static-doc.html` | 静态文档：标题、行内格式、嵌套列表、`dl`、引用、代码块、`figure` | 样式和 Markdown 预览一致；文件里 `style` 的深色背景、绿字、红标题不出现；代码块按 JavaScript 上色；点「跳到说明一节」（中间隔着 30 段过渡文字）滚到「说明」，不导航 |
| `table.html` | 表格：带表头表尾和标题、跨行跨列、12 列宽表、四层嵌套 | 表格不撑破页面（宽表可横向滚动或放得下）；前三层嵌套是表，第四层整张降级成文字，两格之间有「 \| 」 |
| `data-image.html` | `data:` 图片 | PNG、JPEG、GIF（动图）、WebP 和带换行的 PNG 共 5 张显示；SVG、非 base64、`data:text/html` 3 处是占位 |
| `local-image.html` | 本地图片，经本机流式服务 | PNG、JPEG、WebP 显示；`img/missing.png` 在加载失败后换成占位「[图片：不存在的图]」；`static-doc.html`、外链图、越界路径 3 处是占位且不发请求；图片没到之前正文已经显示 |
| `animated-gif.html` | 64×64、8 帧的本地 GIF | 在循环播放 |
| `gbk.html` | GBK 编码（文件是 GBK 字节，`meta` 声明了 `gbk`） | 预览和源码里中文都不乱码；开着查找来回切换，两边都能找到「编码样例」，高亮落在当前显示的那份正文里 |
| `script-generated.html` | 内容全靠脚本生成 | 正文几乎空白，顶部有「静态预览里内容很少，页面的脚本没有运行」和「看源码」按钮；点按钮切到源码 |
| `script-static-long.html` | 有统计脚本，但静态正文超过 80 字 | 正文完整，**没有**上面的提示 |
| `nav-sidebar.html` | 导航和侧栏 | 6 个链接的 `nav` 折叠成默认收起的「导航（6 项）」，主体外的 `aside` 折叠成「侧栏」，2 个链接的面包屑和 `article` 里的 `aside` 不折叠；查找「导航里的词」（只在折叠的导航里，1 处）、「侧栏里的词」（只在折叠的侧栏里，1 处）时对应的折叠区自动展开，命中处可见。iPhone 上：系统选中、复制不应带出收起的文字 |
| `math.html` | 公式 | KaTeX 风格的行内公式显示成行内代码 `E = mc^2`，不重复出现一遍；`display="block"` 的显示成独立代码块；没有 TeX 注释的 MathML 退回文字；`script type="math/tex"` 的内容不出现 |
| `cross-node.html` | 被拆在多个节点里的句子 | 这三个词都只在拆开的句子里才连得上，页面里没有一处是连着写的：查找「跨越多个节点的句子」「代码和按键混在一句话」「相邻的几个行内元素」各 1 处，都能命中整句；选中复制出来是连续的一句 |
| `details-nested.html` | 两层收起的 `details`，查找高亮会不会重绘 | 查找「嵌套词」共 3 处（可见段落、外层、内层各 1 处，页面里别处没有这个词）；按「下一个」依次走到外层、内层，对应 `details` 自动展开，已经出现的高亮不闪、不整页重画；再换成「内层里」（1 处），关掉查找条后没有残留高亮。iPhone 上：系统复制不应带出收起的文字 |
| `external-links.html` | 外链，长按和 ⌘ 点击会不会绕过 Coda | 点击、⌘ 点击、中键点击（Mac）、长按后选「打开」（iPhone），https 和 http 链接都只由 Coda 打开，页面里不直接导航，也不打开系统浏览器；邮箱是「复制邮箱」按钮，`javascript:`、`//host`、`data:` 只剩文字；相对链接在侧栏切到那个文件；页内锚点滚到页尾（中间隔着 40 段填充文字）。**只要有一种方式绕过 Coda，就记下来**：设计 27.5 的备选是把链接改成 `href="#"` 并拦截 `auxclick` |
| `xss-summary.html` | 17 条小型 XSS 汇总（完整语料在 harness 里） | 不弹任何提示框，页面不跳走，能正常滚动；每条只看到文字或占位 |
| `svg/` | 直接打开带脚本的 SVG 的对照 | 见 [svg/README.md](svg/README.md) |

`img/` 是上面样例用的小图（`swatch.png`、`swatch.jpg`、`swatch.webp`、`anim-small.gif`），不是样例。

## 大样例（`node test/fixtures/html/generate.mjs` 生成）

| 文件 | 内容 | 看什么 | 通过 |
|---|---|---|---|
| `generated/big-0.5mib.html` | 约 0.5 MiB 正文，约 1.9 万输出节点 | iPhone 的首屏时间、滚动、内存；打开查找、找「长文本样例」 | 能打开、能滚、查找可用；不要求具体数字，iPhone 上记下首屏用时 |
| `generated/big-1mib.html` | 约 1 MiB（读取上限以内）正文，约 3.8 万输出节点 | 同上，更大 | 同上 |
| `generated/big-nodes-50k.html` | 约 0.31 MiB，约 5 万输出节点 | 设计 27.4：iPhone 上 5 万输出节点的排版和查找 | 能打开、能滚、查找可用 |
| `generated/big-nodes.html` | 约 0.55 MiB，约 8.8 万输出节点，未到上限 | iPhone 上接近 10 万节点的排版和查找；不行就按设计把输出上限降到 5 万 | 没有「内容太多」提示；iPhone 上不卡死、查找可用，卡就记下来 |
| `generated/big-capped.html` | 约 0.76 MiB，超过 10 万输出节点 | 触到输出上限 | 正文末尾有「内容太多，后面没有显示，可以切到源码看」 |
| `generated/local-image-large.html` | 6000×4000 的本地 PNG（`large.png`，文件约 76 KiB，解码后约 96 MiB） | 大的本地图 | 能显示；iPhone 上记下是否显示、页面是否被系统杀掉。本地图只受 200 张和懒加载约束，没有像素预算 |
| `generated/data-image-large.html` | 3900×3900（1521 万像素）和 4100×4100（1681 万像素）的 `data:` PNG | 单张 1600 万像素的预算 | 前一张显示，后一张是占位「[图片：4100×4100]」；iPhone 上记下前一张显示得怎么样，阈值据此定 |
| `generated/data-image-budget.html` | 8 张 3000×3000（各 900 万像素）的 `data:` PNG | 整页累计 6400 万像素的预算 | 前 7 张显示，第 8 张是占位「[图片：第 8 张]」；iPhone 上记下滚动和内存，阈值据此定 |
| `generated/animated-gif-large.html` | 800×800、100 帧的本地 GIF（`anim-large.gif`，约 1.5 MiB，解码后约 256 MiB） | 多帧动图的开销。预算不限制帧数，这里看实际表现，不够就记 backlog | 能播；iPhone 上记下是否卡、是否被杀 |
| `generated/many-images.html` | 250 张本地图（共用 `tiny.png`） | 多图：每页最多 200 张 | 前 200 张显示，第 201～250 张直接是占位；iPhone 上记下首屏和滚动 |

大样例里的像素尺寸是**声明**的尺寸。预算只限制声明值，不能证明解码内存有界，所以真机表现才是依据。

## 记录

iPhone 上的结果（首屏用时、卡不卡、被不被杀）请连同机型和系统版本记下来，定像素预算的阈值和输出节点的上限（设计 27.3、27.4）时用。
