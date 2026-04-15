# Twitter Ambient Stage A — Mantle 侧实施说明

**日期**：2026-04-14  
**Spec**：`docs/specs/2026-04-14-twitter-ambient-spec.md`  
**范围**：Stage A 的 Mantle 后端部分（数据模型 + Store + HTTP 路由 + Token 管理），**不含** Chrome 扩展和 agent-core 集成。

## 变更清单

### 新建

| 文件 | 作用 |
|---|---|
| `Mantle/Services/TwitterBookmarkStore.swift` | SwiftData CRUD 封装：`insert`（幂等）、`fetchUndigested`、`fetchForDay/Week`、`applyDigest`/`applyWeeklyCluster`、`totalCount`/`undigestedCount` |
| `Mantle/Services/ExtensionTokenManager.swift` | 单例 token 管理器：首次启动生成 UUID，写入 `~/Library/Application Support/Mantle/extension-token`（0600 权限），`validate` 用常量时间比较 |
| `docs/specs/2026-04-14-twitter-ambient-spec.md` | 方案 spec（status: ready） |

### 修改

| 文件 | 改动 |
|---|---|
| `Mantle/Models/PersistentModels.swift` | 新增 `@Model TwitterBookmark`：`tweetId` 唯一，字段含 `summary`/`qualityScore`/`tags`/`digestedAt`/`weeklyCluster`。`mediaUrls`/`tags` 用 JSON 字符串存（SwiftData 不直接支持 `[String]`），暴露便捷访问器 |
| `Mantle/MantleApp.swift` | `ModelContainer(for:...)` 两处 schema 加入 `TwitterBookmark.self`（正常 + in-memory fallback） |
| `Mantle/Services/ComputerUseServer.swift` | ① 注入点：`var bookmarkStore: TwitterBookmarkStore?` + `var requireExtensionToken: Bool`；② 路由：`POST /bookmarks/ingest` + `GET /bookmarks/status`；③ Header 解析：`handleConnection` 解出 headers dict 并传给 `route`；④ CORS：`OPTIONS` 预检 + 所有响应加 `Access-Control-Allow-Origin: *`（Chrome 扩展必需）；⑤ 状态码：401/503 补全 |
| `Mantle/ViewModels/AppViewModel.swift` | 字段加 `let twitterBookmarkStore: TwitterBookmarkStore`，`init` 中实例化；`startComputerUseServer()` 注入 store 并预生成 token |
| `Mantle.xcodeproj/project.pbxproj` | 两个新 .swift 文件注册到 PBXBuildFile / PBXFileReference / Services group / Sources phase |

## 关键协议实现

### `POST /bookmarks/ingest`
- Headers 必须：`X-Mantle-Token: <token>`；缺失或错误返回 401
- Body JSON 字段：`tweetId`（必填）、`url`（必填）、`author`（必填）、`text`（必填）、`quotedText`（可选）、`mediaUrls`（可选 `[String]`）、`capturedAt`（可选 ISO8601，缺省用 now）
- 响应：`{"ok": true, "deduped": bool, "id": "<uuid>"}`
- 幂等：以 `tweetId` 查重，已存在则返回 `deduped: true`，不覆盖 AI 字段，仅在旧 `capturedAt` 早于新值时刷新

### `GET /bookmarks/status`
- 同样要求 `X-Mantle-Token`
- 响应：`{"ok": true, "total": int, "undigested": int}`

## 设计决策记录

1. **Token 用文件而非 Keychain**：Chrome 扩展无法访问 Keychain，让用户手动复制一次到扩展 options 更简单，且 token 只对本机同用户有效，Application Support 的 0600 权限足够
2. **mediaUrls/tags 用 JSON string**：SwiftData `@Model` 不直接支持 `[String]`，若做子 entity 会引入不必要的 cascade 复杂度；JSON 编码后用计算属性暴露更轻量
3. **bookmarkStore 可选注入**：未来若 server 需要脱离 AppViewModel 单独测试，store 可以 nil 时路由返回 503 而不是 crash
4. **CORS `*`**：Chrome MV3 扩展的 origin 是 `chrome-extension://<id>/`，无法预知扩展 ID，用 `*` 最省事；token 校验独立于 CORS，双保险
5. **常量时间 token 比较**：UUID token 变动一位不至于构成 timing attack 的现实威胁，但成本近乎零
6. **TwitterBookmarkDaemon 独立于 ContextDaemon**：后者是"环境感知"维度（活跃 App / Focus Mode / 空闲），bookmark 消化是"数据处理"维度，语义不同，独立更清晰

## 验证结果

- ✅ `xcodebuild -scheme Mantle -configuration Debug build` **BUILD SUCCEEDED**
- ⏸ 运行时端到端：待 Stage A 的 Chrome 扩展完成后一起验证
- ✅ 单点验证可用：`curl -X POST http://127.0.0.1:19816/bookmarks/ingest -H "Content-Type: application/json" -H "X-Mantle-Token: <token>" -d @sample.json`（需 Mantle 运行中）

## 下一步

1. **Stage A 收尾**：fork `prinsss/twitter-web-exporter` 到 `Mantle/extensions/twitter-capture/`，裁剪成只抓 bookmark 并 POST 到 `/bookmarks/ingest`。options 页做 token 粘贴 + 连接状态
2. **Stage B**：agent-core 新建 `twitter-digest` subagent + `POST /twitter/digest` route；Mantle 侧新建 `TwitterBookmarkDaemon` 轮询调用
3. Stage C/D：通知调度、UI、Spotlight、周报
