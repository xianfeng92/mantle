import Foundation
import Network
import os

// MARK: - ComputerUseServer
//
// Minimal HTTP server on localhost that exposes ComputerUseService actions
// to agent-core. Runs on a dedicated port (default 19816).
//
// Routes:
//   POST /ui_tree        → getUITree
//   POST /screenshot     → screenshot
//   POST /click          → click
//   POST /type_text      → type
//   POST /key_press      → keyPress
//   POST /scroll         → scroll
//   POST /click_element  → clickElement
//   POST /set_value      → setElementValue

@MainActor
final class ComputerUseServer {

    static let defaultPort: UInt16 = 19816

    private var listener: NWListener?
    private let service: ComputerUseService
    private let port: UInt16

    /// Twitter bookmark 存储。可选：未注入时 /bookmarks/* 路由返回 503。
    var bookmarkStore: TwitterBookmarkStore?
    /// 若为 true，/bookmarks/* 路由会校验 X-Mantle-Token header。
    var requireExtensionToken: Bool = true

    init(service: ComputerUseService, port: UInt16 = ComputerUseServer.defaultPort) {
        self.service = service
        self.port = port
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                MantleLog.computerUse.info("[Server] listening on 127.0.0.1:\(self.port)")
            case .failed(let error):
                MantleLog.computerUse.error("[Server] failed: \(error)")
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            Task { @MainActor [weak self] in
                self?.handleConnection(conn)
            }
        }
        listener.start(queue: DispatchQueue(label: "mantle.computer-use.server"))
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        MantleLog.computerUse.info("[Server] stopped")
    }

    // MARK: - Connection Handling

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: DispatchQueue(label: "mantle.computer-use.conn"))

        // Read up to 1MB (screenshots can be large in response, but requests are small)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, isComplete, error in
            guard let self, let data else {
                conn.cancel()
                return
            }

            guard let requestStr = String(data: data, encoding: .utf8) else {
                self.sendResponse(conn: conn, status: 400, body: ["error": "invalid request encoding"])
                return
            }

            // Parse minimal HTTP: "POST /path HTTP/1.1\r\n...headers...\r\n\r\nbody"
            let parts = requestStr.components(separatedBy: "\r\n\r\n")
            let headerSection = parts[0]
            let bodyStr = parts.count > 1 ? parts[1] : ""

            let headerLines = headerSection.components(separatedBy: "\r\n")
            guard let firstLine = headerLines.first else {
                self.sendResponse(conn: conn, status: 400, body: ["error": "malformed request"])
                return
            }

            let tokens = firstLine.split(separator: " ")
            guard tokens.count >= 2 else {
                self.sendResponse(conn: conn, status: 400, body: ["error": "malformed request line"])
                return
            }

            let method = String(tokens[0])
            let rawPath = String(tokens[1])
            // split path 和 query string
            let pathAndQuery = rawPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            let path = String(pathAndQuery[0])
            var queryParams: [String: String] = [:]
            if pathAndQuery.count > 1 {
                let qs = String(pathAndQuery[1])
                for pair in qs.split(separator: "&") {
                    let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                    if kv.count == 2 {
                        // application/x-www-form-urlencoded：+ 代表空格，先换再 URL decode
                        let rawKey = String(kv[0]).replacingOccurrences(of: "+", with: " ")
                        let rawVal = String(kv[1]).replacingOccurrences(of: "+", with: " ")
                        let key = rawKey.removingPercentEncoding ?? rawKey
                        let val = rawVal.removingPercentEncoding ?? rawVal
                        queryParams[key] = val
                    }
                }
            }

            // Parse headers（lowercase 键，方便不区分大小写查找）
            var headers: [String: String] = [:]
            for line in headerLines.dropFirst() {
                guard let colonIdx = line.firstIndex(of: ":") else { continue }
                let name = line[..<colonIdx].lowercased()
                let value = line[line.index(after: colonIdx)...].trimmingCharacters(in: .whitespaces)
                headers[String(name)] = value
            }

            // CORS preflight：Chrome 扩展带 X-Mantle-Token 会触发 OPTIONS
            if method == "OPTIONS" {
                self.sendCORSPreflightResponse(conn: conn)
                return
            }

            // Allow GET and POST
            guard method == "POST" || method == "GET" else {
                self.sendResponse(conn: conn, status: 405, body: ["error": "method not allowed"])
                return
            }

            // Parse JSON body
            let params: [String: Any]
            if bodyStr.isEmpty {
                params = [:]
            } else if let bodyData = bodyStr.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any] {
                params = json
            } else {
                params = [:]
            }

            // Route and execute on MainActor
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.route(path: path, params: params, queryParams: queryParams, headers: headers, conn: conn)
            }
        }
    }

    // MARK: - Routing

    private func route(path: String, params: [String: Any], queryParams: [String: String], headers: [String: String], conn: NWConnection) async {
        switch path {

        // MARK: - Twitter Bookmarks

        case "/bookmarks/ingest":
            await handleBookmarksIngest(params: params, headers: headers, conn: conn)

        case "/bookmarks/status":
            await handleBookmarksStatus(headers: headers, conn: conn)

        case "/bookmarks/ingest-via-url":
            // GET endpoint：绕过 x.com 的 CSP，bookmarklet 通过 window.open 走 URL 导航
            // 参数全部走 query string；token 也在 query（本机单用户可接受）
            await handleBookmarksIngestViaUrl(queryParams: queryParams, conn: conn)

        // MARK: - Computer Use

        case "/ui_tree":
            let maxDepth = params["max_depth"] as? Int ?? 6
            let text = await service.getUITreeText(maxDepth: maxDepth)
            sendResponse(conn: conn, status: 200, body: ["result": text])

        case "/screenshot":
            do {
                let targetStr = params["target"] as? String ?? "fullscreen"
                let target: ComputerUseService.ScreenshotTarget
                switch targetStr {
                case "fullscreen":
                    target = .fullScreen
                case "app":
                    guard let bundleID = params["app_bundle_id"] as? String else {
                        sendResponse(conn: conn, status: 400, body: ["error": "app_bundle_id required"])
                        return
                    }
                    target = .app(bundleID)
                default:
                    target = .fullScreen
                }
                let base64 = try await service.screenshot(target: target)
                sendResponse(conn: conn, status: 200, body: ["result": base64])
            } catch {
                sendResponse(conn: conn, status: 500, body: ["error": error.localizedDescription])
            }

        case "/click":
            guard let x = params["x"] as? Int, let y = params["y"] as? Int else {
                sendResponse(conn: conn, status: 400, body: ["error": "x, y required"])
                return
            }
            let button = (params["button"] as? String) == "right"
                ? ComputerUseService.MouseButton.right
                : .left
            let clickCount = params["click_count"] as? Int ?? 1
            service.click(x: x, y: y, button: button, clickCount: clickCount)
            sendResponse(conn: conn, status: 200, body: ["result": "ok"])

        case "/type_text":
            guard let text = params["text"] as? String else {
                sendResponse(conn: conn, status: 400, body: ["error": "text required"])
                return
            }
            service.type(text: text)
            sendResponse(conn: conn, status: 200, body: ["result": "ok"])

        case "/key_press":
            guard let key = params["key"] as? String else {
                sendResponse(conn: conn, status: 400, body: ["error": "key required"])
                return
            }
            let modifiers = params["modifiers"] as? [String] ?? []
            service.keyPress(key: key, modifiers: modifiers)
            sendResponse(conn: conn, status: 200, body: ["result": "ok"])

        case "/scroll":
            guard let x = params["x"] as? Int,
                  let y = params["y"] as? Int,
                  let deltaY = params["delta_y"] as? Int else {
                sendResponse(conn: conn, status: 400, body: ["error": "x, y, delta_y required"])
                return
            }
            let deltaX = params["delta_x"] as? Int ?? 0
            service.scroll(x: x, y: y, deltaY: deltaY, deltaX: deltaX)
            sendResponse(conn: conn, status: 200, body: ["result": "ok"])

        case "/click_element":
            guard let index = params["index"] as? Int else {
                sendResponse(conn: conn, status: 400, body: ["error": "index required"])
                return
            }
            let ok = await service.clickElement(index: index)
            sendResponse(conn: conn, status: 200, body: ["result": ok ? "ok" : "element not found"])

        case "/set_value":
            guard let index = params["index"] as? Int,
                  let value = params["value"] as? String else {
                sendResponse(conn: conn, status: 400, body: ["error": "index, value required"])
                return
            }
            let ok = await service.setElementValue(index: index, value: value)
            sendResponse(conn: conn, status: 200, body: ["result": ok ? "ok" : "failed"])

        case "/open_app":
            let appName = params["app_name"] as? String
            let bundleId = params["bundle_id"] as? String
            guard appName != nil || bundleId != nil else {
                sendResponse(conn: conn, status: 400, body: ["error": "app_name or bundle_id required"])
                return
            }
            let ok = await service.openApp(name: appName, bundleId: bundleId)
            sendResponse(conn: conn, status: 200, body: ["result": ok ? "ok" : "app not found"])

        case "/status":
            let ax = service.isAccessibilityGranted
            let sc = await service.isScreenCaptureGranted()
            sendResponse(conn: conn, status: 200, body: [
                "accessibility": ax,
                "screen_capture": sc,
            ])

        default:
            sendResponse(conn: conn, status: 404, body: ["error": "not found: \(path)"])
        }
    }

    // MARK: - Bookmark Handlers

    /// 校验 X-Mantle-Token header（若 requireExtensionToken=true）。
    /// 返回 nil 表示通过；否则已发出 401 响应，调用方应直接 return。
    private func checkExtensionToken(headers: [String: String], conn: NWConnection) -> Void? {
        guard requireExtensionToken else { return nil }
        let candidate = headers["x-mantle-token"]
        if ExtensionTokenManager.shared.validate(candidate) {
            return nil
        }
        sendResponse(conn: conn, status: 401, body: ["error": "invalid or missing X-Mantle-Token"])
        return ()
    }

    private func handleBookmarksIngest(params: [String: Any], headers: [String: String], conn: NWConnection) async {
        if checkExtensionToken(headers: headers, conn: conn) != nil { return }

        guard let store = bookmarkStore else {
            sendResponse(conn: conn, status: 503, body: ["error": "bookmark store not initialized"])
            return
        }

        guard let tweetId = params["tweetId"] as? String, !tweetId.isEmpty,
              let url = params["url"] as? String, !url.isEmpty,
              let author = params["author"] as? String, !author.isEmpty,
              let text = params["text"] as? String
        else {
            sendResponse(conn: conn, status: 400, body: [
                "error": "tweetId/url/author/text required",
            ])
            return
        }

        let quotedText = params["quotedText"] as? String
        let mediaUrls = params["mediaUrls"] as? [String] ?? []

        // capturedAt：ISO8601；不传则用 now
        let capturedAt: Date
        if let isoStr = params["capturedAt"] as? String,
           let parsed = ISO8601DateFormatter().date(from: isoStr) {
            capturedAt = parsed
        } else {
            capturedAt = .now
        }

        do {
            let result = try store.insert(
                tweetId: tweetId,
                url: url,
                authorHandle: author,
                text: text,
                quotedText: quotedText,
                mediaUrls: mediaUrls,
                capturedAt: capturedAt
            )
            sendResponse(conn: conn, status: 200, body: [
                "ok": true,
                "deduped": result.deduped,
                "id": result.bookmark.id,
            ])
        } catch {
            MantleLog.app.error("[/bookmarks/ingest] insert failed: \(error.localizedDescription, privacy: .public)")
            sendResponse(conn: conn, status: 500, body: ["error": error.localizedDescription])
        }
    }

    /// GET /bookmarks/ingest-via-url?token=xxx&tweetId=...&url=...&author=@handle&text=...
    /// 为 bookmarklet 绕过 x.com CSP 设计：通过 window.open 导航到这里。
    /// 返回 HTML 页面（而非 JSON），展示"已保存"后自动关闭 tab。
    private func handleBookmarksIngestViaUrl(queryParams: [String: String], conn: NWConnection) async {
        // token 校验（从 query 读）
        if requireExtensionToken && !ExtensionTokenManager.shared.validate(queryParams["token"]) {
            sendHtmlResponse(conn: conn, status: 401, html: htmlPage(
                title: "❌ Mantle 鉴权失败",
                body: "token 错误或缺失。重新检查 bookmarklet 配置。"
            ))
            return
        }

        guard let store = bookmarkStore else {
            sendHtmlResponse(conn: conn, status: 503, html: htmlPage(
                title: "❌ Mantle 未就绪",
                body: "bookmark store 未初始化。重启 Mantle。"
            ))
            return
        }

        guard let tweetId = queryParams["tweetId"], !tweetId.isEmpty,
              let url = queryParams["url"], !url.isEmpty,
              let author = queryParams["author"], !author.isEmpty,
              let text = queryParams["text"]
        else {
            sendHtmlResponse(conn: conn, status: 400, html: htmlPage(
                title: "❌ 参数不全",
                body: "tweetId/url/author/text 缺失"
            ))
            return
        }

        let quotedText = queryParams["quotedText"]
        let mediaUrls = queryParams["mediaUrls"]?
            .split(separator: ",")
            .map { String($0) }
            .filter { !$0.isEmpty } ?? []

        do {
            let result = try store.insert(
                tweetId: tweetId,
                url: url,
                authorHandle: author,
                text: text,
                quotedText: quotedText,
                mediaUrls: mediaUrls,
                capturedAt: .now
            )
            let statusLine = result.deduped ? "已存在（deduped）" : "已保存"
            let preview = "\(author)：\(String(text.prefix(60)))\(text.count > 60 ? "…" : "")"
            sendHtmlResponse(conn: conn, status: 200, html: htmlPage(
                title: "✓ Mantle：\(statusLine)",
                body: preview,
                autoCloseMs: 1500
            ))
        } catch {
            MantleLog.app.error("[/bookmarks/ingest-via-url] insert failed: \(error.localizedDescription, privacy: .public)")
            sendHtmlResponse(conn: conn, status: 500, html: htmlPage(
                title: "❌ Mantle 内部错误",
                body: error.localizedDescription
            ))
        }
    }

    private func htmlPage(title: String, body: String, autoCloseMs: Int? = nil) -> String {
        let closeScript = autoCloseMs.map {
            "<script>setTimeout(()=>window.close(), \($0));</script>"
        } ?? ""
        return """
        <!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8"><title>Mantle</title>
        <style>
          body{font-family:-apple-system,"PingFang SC",system-ui;max-width:480px;margin:80px auto;padding:0 24px;color:#222;text-align:center}
          h1{font-size:20px;margin-bottom:12px}
          p{color:#555;line-height:1.6;font-size:14px}
        </style></head>
        <body>
          <h1>\(title)</h1>
          <p>\(body)</p>
          \(closeScript)
        </body></html>
        """
    }

    private nonisolated func sendHtmlResponse(conn: NWConnection, status: Int, html: String) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 500: statusText = "Internal Server Error"
        case 503: statusText = "Service Unavailable"
        default:  statusText = "Unknown"
        }
        let bodyData = Data(html.utf8)
        let headers = [
            "HTTP/1.1 \(status) \(statusText)",
            "Content-Type: text/html; charset=utf-8",
            "Access-Control-Allow-Origin: *",
            "Content-Length: \(bodyData.count)",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")
        var data = Data(headers.utf8)
        data.append(bodyData)
        conn.send(content: data, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func handleBookmarksStatus(headers: [String: String], conn: NWConnection) async {
        if checkExtensionToken(headers: headers, conn: conn) != nil { return }

        guard let store = bookmarkStore else {
            sendResponse(conn: conn, status: 503, body: ["error": "bookmark store not initialized"])
            return
        }

        do {
            let total = try store.totalCount()
            let undigested = try store.undigestedCount()
            sendResponse(conn: conn, status: 200, body: [
                "ok": true,
                "total": total,
                "undigested": undigested,
            ])
        } catch {
            sendResponse(conn: conn, status: 500, body: ["error": error.localizedDescription])
        }
    }

    // MARK: - Response

    private nonisolated func sendCORSPreflightResponse(conn: NWConnection) {
        // `Access-Control-Allow-Private-Network: true` 是 Chrome Private Network
        // Access 规范要求：从 public origin（如 x.com）往 localhost 发 fetch 时必需。
        // 不加这个浏览器会在 preflight 阶段 "Failed to fetch"。
        let headers = [
            "HTTP/1.1 204 No Content",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: POST, GET, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, X-Mantle-Token",
            "Access-Control-Allow-Private-Network: true",
            "Access-Control-Max-Age: 86400",
            "Content-Length: 0",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")

        conn.send(content: Data(headers.utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private nonisolated func sendResponse(conn: NWConnection, status: Int, body: [String: Any]) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 405: statusText = "Method Not Allowed"
        case 500: statusText = "Internal Server Error"
        case 503: statusText = "Service Unavailable"
        default:  statusText = "Unknown"
        }

        let jsonData = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()

        let headers = [
            "HTTP/1.1 \(status) \(statusText)",
            "Content-Type: application/json",
            "Access-Control-Allow-Origin: *",
            "Content-Length: \(jsonData.count)",
            "Connection: close",
            "",
            "",
        ].joined(separator: "\r\n")

        var responseData = Data(headers.utf8)
        responseData.append(jsonData)

        conn.send(content: responseData, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }
}
