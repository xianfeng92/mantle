import Foundation
import os

// MARK: - ExtensionTokenManager
//
// 管理 Mantle 与 Chrome 扩展之间的共享密钥。
// 目的：避免任意本地进程往 19816 端口 POST bookmark 污染用户数据。
//
// 存储位置：~/Library/Application Support/Mantle/extension-token
// 权限：0600（只有当前 user 可读写）
// 分发：用户在 Mantle 设置页看到 token，复制粘贴到 Chrome 扩展的 options 页。
//
// 注意：不用 Keychain。Chrome 扩展从本地文件无法直接读 Keychain，强制用户手动复制一次更简单。

@MainActor
final class ExtensionTokenManager {

    static let shared = ExtensionTokenManager()

    private let fileURL: URL
    private var cachedToken: String?

    private init() {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("Mantle")
        self.fileURL = dir.appendingPathComponent("extension-token")
    }

    /// 读取或生成 token。首次调用会创建文件。
    func token() -> String {
        if let cached = cachedToken {
            return cached
        }

        // 尝试从文件读
        if let data = try? Data(contentsOf: fileURL),
           let existing = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            cachedToken = existing
            return existing
        }

        // 生成新 token 并落盘
        let newToken = UUID().uuidString.lowercased()
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try newToken.data(using: .utf8)!.write(to: fileURL, options: [.atomic])
            // 设置 0600 权限
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: fileURL.path
            )
            MantleLog.app.info("[ExtensionToken] generated new token at \(self.fileURL.path, privacy: .public)")
        } catch {
            MantleLog.app.error("[ExtensionToken] failed to persist token: \(error.localizedDescription, privacy: .public)")
        }
        cachedToken = newToken
        return newToken
    }

    /// 常量时间比较，避免 timing attack。
    func validate(_ candidate: String?) -> Bool {
        guard let candidate, !candidate.isEmpty else { return false }
        let expected = token()
        // 先比长度（长度不同视作不匹配）
        guard candidate.utf8.count == expected.utf8.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(candidate.utf8, expected.utf8) {
            diff |= (a ^ b)
        }
        return diff == 0
    }

    /// 获取文件路径（供 UI 显示）。
    var tokenFilePath: String { fileURL.path }
}
