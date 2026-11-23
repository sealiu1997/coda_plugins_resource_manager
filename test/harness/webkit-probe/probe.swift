// WebKit 探针（设计 27.8「WebKit 探针」）：macOS 上的 WKWebView 加载真实的 view/html.mjs，套宿主等价的 CSP，用自定义 scheme coda-view: 统计请求。
// 只在本机手动跑（见 README.md），不进 CI。用法：probe <仓库根> <宿主 CSP> <svg 的 CSP>，由 run.sh 传参；任何一条不符，退出码非 0。
import AppKit
import WebKit

struct ProbeError: Error, CustomStringConvertible { let description: String; init(_ text: String) { description = text } }

let args = CommandLine.arguments
guard args.count == 4 else { FileHandle.standardError.write("用法：probe <仓库根> <宿主 CSP> <svg 的 CSP>\n".data(using: .utf8)!); exit(64) }
let repoRoot = args[1], hostCSP = args[2], svgCSP = args[3]
let probeDir = repoRoot + "/test/harness/webkit-probe"
let svgDir = repoRoot + "/test/fixtures/html/svg"
let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!

// ---- 请求计数：自定义 scheme 的处理器按路径分类 ----

struct Counts {
    var page = 0, modules = 0
    var legit: [String: Int] = [:]
    var probes: [String: Int] = [:]
    var svgServed: [String: Int] = [:]
    var svgMissing: [String: Int] = [:]
    var unexpected: [String] = []
    var other: Int { probes.values.reduce(0, +) + unexpected.count }
}
var counts = Counts()

func mime(_ path: String) -> String {
    switch (path as NSString).pathExtension {
    case "mjs", "js": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "html": return "text/html; charset=utf-8"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    default: return "application/octet-stream"
    }
}

final class Handler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        let full = url.absoluteString, path = url.path
        func reply(_ status: Int, _ type: String, _ body: Data, _ extra: [String: String] = [:]) {
            var headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"]
            for (key, value) in extra { headers[key] = value }
            task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(body)
            task.didFinish()
        }
        func file(_ dir: String, _ rel: String, _ extra: [String: String] = [:]) -> Bool {
            guard !rel.contains(".."), let data = FileManager.default.contents(atPath: dir + "/" + rel) else { return false }
            reply(200, mime(rel), data, extra)
            return true
        }
        let missing = { reply(404, "text/plain", Data("not found".utf8)) }
        // 泄漏的请求也答 200：让泄漏看得见。
        if let range = full.range(of: #"PROBE-[a-z0-9-]+"#, options: .regularExpression) {
            counts.probes[String(full[range]), default: 0] += 1
            return reply(200, "image/png", png)
        }
        if full.contains("svg-script-probe") { counts.probes["svg-script-probe", default: 0] += 1; return reply(200, "image/png", png) }
        if path == "/page.html" { counts.page += 1; return file(probeDir, "page.html", ["Content-Security-Policy": hostCSP]) ? () : missing() }
        if path.hasPrefix("/_page/") { counts.page += 1; return file(probeDir, String(path.dropFirst(7))) ? () : missing() }
        if path.hasPrefix("/view/") { counts.modules += 1; return file(repoRoot + "/view", String(path.dropFirst(6))) ? () : missing() }
        if path.hasPrefix("/img/legit/svg/") {
            let name = String(path.dropFirst(15))
            // 回答头照 lib/media.mjs：svg 的 MIME、CSP、nosniff。
            if file(svgDir, name, ["Content-Security-Policy": svgCSP]) { counts.svgServed[name, default: 0] += 1; return }
            counts.svgMissing[name, default: 0] += 1
            return missing()
        }
        if path.hasPrefix("/img/legit/") {
            counts.legit[path, default: 0] += 1
            return path.contains("LEGIT-broken") ? missing() : reply(200, "image/png", png)
        }
        counts.unexpected.append(full)
        missing()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// ---- 窗口和页面 ----

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let config = WKWebViewConfiguration()
config.setURLSchemeHandler(Handler(), forURLScheme: "coda-view")
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 800), configuration: config)
let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = webView
window.title = "WebKit 探针"
// 屏幕锁定或窗口被遮住时，WebKit 把页面当成不可见：requestAnimationFrame 不触发、框架延迟加载，观察窗口就没有意义。
// 用 WKWebView 的 SPI 关掉遮挡检测（SPI 不在了就只打印提示，由后面「requestAnimationFrame 正常触发」那一项把关）。
let occlusionSetter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if webView.responds(to: occlusionSetter) { typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void; unsafeBitCast(webView.method(for: occlusionSetter), to: Setter.self)(webView, occlusionSetter, false) } else { print("· 没有遮挡检测的开关，窗口被遮住时观察窗口可能无效") }
window.level = .floating
window.center()
window.orderFrontRegardless()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

var failures: [String] = []
func ok(_ text: String) { print("✔ \(text)") }
func expect(_ condition: Bool, _ pass: String, _ fail: String) {
    if condition { ok(pass) } else { failures.append(fail); print("✘ \(fail)") }
}
func summary(_ map: [String: Int]) -> String { map.isEmpty ? "无" : map.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: "、") }

// 在页面里执行一段脚本，返回它 return 的值；限时，超时就抛错（观察窗口本身只有约 1 秒）。
@MainActor func js(_ body: String, timeout: TimeInterval = 30) async throws -> Any? {
    try await withCheckedThrowingContinuation { continuation in
        var done = false
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            if !done { done = true; continuation.resume(throwing: ProbeError("页面脚本超过 \(Int(timeout)) 秒没有返回：\(body.prefix(60))")) }
        }
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            if done { return }
            done = true
            switch result {
            case .success(let value): continuation.resume(returning: value)
            case .failure(let error): continuation.resume(throwing: error)
            }
        }
    }
}
@MainActor func step(_ name: String) async throws -> [String: Any] {
    guard let text = try await js("return await window.__P.\(name)()") as? String, let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw ProbeError("\(name) 没有返回 JSON 对象") }
    return object
}

@MainActor func run() async throws {
    print("WebKit 探针：\(ProcessInfo.processInfo.operatingSystemVersionString)，WKWebView，自定义 scheme coda-view:")
    print("宿主 CSP：\(hostCSP)")
    print("svg 的 CSP：\(svgCSP)")
    webView.load(URLRequest(url: URL(string: "coda-view://service/page.html")!))

    // 先断言启动：被测模块已经运行（页面写出启动标记），再看任何计数。
    var booted = false
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline && !booted {
        booted = (try? await js("return document.body?.dataset.boot === 'ready'")) as? Bool ?? false
        if !booted { try await Task.sleep(nanoseconds: 100_000_000) }
    }
    guard booted else { throw ProbeError("等不到被测模块的启动标记（15 秒）：没有启动，零请求不能算通过。已收到：页面文件 \(counts.page) 个、模块 \(counts.modules) 个、意外请求 \(counts.unexpected)") }
    let boot = try await step("boot")
    print("· 窗口：可见 \(window.isVisible)，遮挡状态含可见 \(window.occlusionState.contains(.visible))，页面 visibilityState \(boot["visibility"] ?? "?")，屏幕 \(NSScreen.screens.count) 块")
    expect(boot["ok"] as? Bool == true && counts.modules > 0, "被测模块已启动：view/html.mjs 等 \(counts.modules) 个模块文件经 coda-view: 加载，样例 \(boot["cases"] ?? "?") 条", "被测模块没有正常启动")

    // CSP 真的生效：必须挡住 http: 的图片和 fetch 并上报违规，否则「只请求合法图片」不说明任何事。
    let csp = try await step("cspProbe")
    let violations = csp["violations"] as? [String] ?? []
    expect(violations.contains { $0.hasPrefix("img-src") } && violations.contains { $0.hasPrefix("connect-src") }, "宿主 CSP 生效：http: 的图片和请求被挡并上报违规 \(violations)", "宿主 CSP 没有生效（没有上报 img-src、connect-src 的违规）：\(violations)；响应头里的 CSP 不被认时，改用 <meta http-equiv>")

    // 计数灵敏：金丝雀是一个必然发往 coda-view: 的图片请求。
    counts = Counts()
    _ = try await step("canary")
    expect(counts.probes["PROBE-canary"] == 1, "计数灵敏：金丝雀请求到达了 coda-view: 的处理器（PROBE-canary ×1）", "金丝雀请求没有被计到：\(summary(counts.probes))")

    // 1. 只解析：DOMParser，不挂载。
    counts = Counts()
    let parse = try await step("parseOnly")
    expect(counts.other == 0 && counts.legit.isEmpty && counts.svgServed.isEmpty && counts.svgMissing.isEmpty, "只解析 \(parse["parsed"] ?? "?") 条后（观察窗口两帧 + 500 ms），coda-view: 上的请求为 0（探针 0、图片 0、意外 0）", "只解析阶段有 coda-view: 请求：探针 \(summary(counts.probes))；图片 \(summary(counts.legit))；意外 \(counts.unexpected)")
    expect((parse["beacon"] as? [Any])?.isEmpty == true, "只解析：页面信标没有触发", "只解析阶段信标触发了：\(parse["beacon"] ?? "?")")
    expect(parse["rafOk"] as? Bool == true, "只解析：requestAnimationFrame 正常触发，观察窗口有效", "requestAnimationFrame 没有触发，观察窗口无效")

    // 2. 挂载：只请求合法的本地图片。
    counts = Counts()
    let mount = try await step("mount")
    let expectedLegit: Set<String> = ["/img/legit/img/LEGIT-a.png", "/img/legit/img/LEGIT-b.png", "/img/legit/img/LEGIT-rel.png", "/img/legit/img/LEGIT-base.png"]
    expect((mount["failed"] as? [Any])?.isEmpty == true, "挂载 \(mount["mounted"] ?? "?") 条，没有渲染错误", "渲染抛错：\(mount["failed"] ?? "?")")
    expect(counts.other == 0, "挂载后探针请求 0、意外请求 0", "挂载后有不该有的请求：探针 \(summary(counts.probes))；意外 \(counts.unexpected)")
    expect(Set(counts.legit.keys) == expectedLegit && counts.legit.values.allSatisfy { $0 == 1 }, "挂载后只请求合法的本地图片：\(summary(counts.legit))", "图片请求和预期不符：实际 \(summary(counts.legit))；预期 \(expectedLegit.sorted())")
    let local = mount["local"] as? [[String: Any]] ?? [], data = mount["data"] as? [[String: Any]] ?? []
    expect(local.count == 2 && local.allSatisfy { $0["complete"] as? Bool == true && ($0["width"] as? Int ?? 0) > 0 } && data.count == 1 && data.allSatisfy { ($0["width"] as? Int ?? 0) > 0 }, "正对照：合法的本地图片（control-local 里 2 张）和允许的 data: 位图（1 张）都显示出来（naturalWidth > 0）", "正对照图片没有显示：本地 \(local)；data \(data)")
    expect((mount["leaks"] as? [Any])?.isEmpty == true && (mount["forbidden"] as? [Any])?.isEmpty == true, "挂载后的输出里没有任何探针地址，也没有 script、iframe、link、object、embed、style、svg 等表外元素或 srcset、background、ping、事件属性", "输出里有泄漏：探针地址 \(mount["leaks"] ?? "?")；表外元素和属性 \(mount["forbidden"] ?? "?")")
    expect(mount["textOk"] as? Bool == true && (mount["beacon"] as? [Any])?.isEmpty == true && mount["rafOk"] as? Bool == true, "正文「正文」原样留着，信标没有触发，requestAnimationFrame 正常", "正文丢了、信标触发了，或 requestAnimationFrame 没有触发：\(mount)")

    // 3. svg 加了 CSP 头之后，放在 <img> 里仍能显示。
    counts = Counts()
    let svg = try await step("svg")
    let direct = svg["direct"] as? [String: Any] ?? [:], viaRender = svg["viaRender"] as? [String: Any] ?? [:], missingSvg = svg["missing"] as? [String: Any] ?? [:]
    expect(direct["width"] as? Int == 360 && direct["height"] as? Int == 140, "svg（带 CSP 头）放在 <img> 里显示：decode 成功，\(direct["width"] ?? "?")×\(direct["height"] ?? "?")", "svg 直接放在 <img> 里没有显示：\(direct)")
    expect(viaRender["width"] as? Int == 360, "svg 经 renderHtml 的 <img> 挂载后显示：\(viaRender["width"] ?? "?")×\(viaRender["height"] ?? "?")", "svg 经 renderHtml 挂载后没有显示：\(viaRender)")
    expect(missingSvg["error"] != nil, "负对照：不存在的 svg 加载失败（decode 被拒），说明「能显示」是有区分度的", "负对照没有失败：\(missingSvg)")
    expect(counts.svgServed["a.svg", default: 0] >= 2 && counts.probes.isEmpty && counts.unexpected.isEmpty, "svg 的回答带 CSP（\(svgCSP)）共 \(counts.svgServed["a.svg", default: 0]) 次；脚本探针（svg-script-probe）请求 0", "svg 请求不符：a.svg 回答 \(counts.svgServed)；探针 \(summary(counts.probes))；意外 \(counts.unexpected)")
    if let pixel = svg["pixel"] as? [Int] {
        expect(pixel.count == 4 && abs(pixel[0] - 0x2e) < 8 && abs(pixel[1] - 0x7d) < 8 && abs(pixel[2] - 0x32) < 8, "像素读数：(50,70) 是绿圆 \(pixel.prefix(3))", "(50,70) 不是绿圆：\(pixel)")
    } else { print("· 像素读数：\(svg["pixel"] ?? "?")（画布读不出来，只记录，不判失败）") }
    expect(svg["rafOk"] as? Bool == true, "svg：requestAnimationFrame 正常触发", "svg：requestAnimationFrame 没有触发")
}

DispatchQueue.main.asyncAfter(deadline: .now() + 120) { print("✘ 整体超时（120 秒）"); exit(2) }
Task { @MainActor in
    do { try await run() } catch { failures.append("\(error)"); print("✘ \(error)") }
    print(failures.isEmpty ? "全部通过" : "失败 \(failures.count) 项")
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
