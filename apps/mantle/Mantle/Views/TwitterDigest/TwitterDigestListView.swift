import SwiftUI
import SwiftData

// MARK: - TwitterDigestListView
//
// Ambient 阅读系统的最小 UI：按"日期"分组列出所有 bookmark，
// 点击推文行打开原始 x.com 链接。
// 故意保持极简——Mantle 的核心体验是"通知 push"，UI 只是回查工具。

struct TwitterDigestListView: View {

    /// 初始高亮的日期（从通知 deep link 带过来）。默认 nil = 不高亮。
    let highlightDate: Date?

    @Query(sort: \TwitterBookmark.capturedAt, order: .reverse)
    private var bookmarks: [TwitterBookmark]

    var body: some View {
        List {
            if bookmarks.isEmpty {
                emptyState
            } else {
                ForEach(groupedByDay, id: \.0) { (day, items) in
                    Section(header: header(for: day, count: items.count)) {
                        ForEach(items, id: \.id) { bm in
                            row(for: bm)
                                .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                        }
                    }
                }
            }
        }
        .listStyle(.inset)
        .navigationTitle("Bookmarks")
    }

    // MARK: - Grouping

    /// [(day, bookmarks)] 倒序（最新在前）。
    private var groupedByDay: [(Date, [TwitterBookmark])] {
        let cal = Calendar.current
        let grouped = Dictionary(grouping: bookmarks) { cal.startOfDay(for: $0.capturedAt) }
        return grouped.sorted { $0.key > $1.key }
    }

    // MARK: - Components

    @ViewBuilder
    private func header(for day: Date, count: Int) -> some View {
        let isHighlighted = highlightDate.map { Calendar.current.isDate($0, inSameDayAs: day) } ?? false
        HStack(spacing: 8) {
            if isHighlighted {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
            }
            Text(formatDay(day))
                .font(.title3).bold()
                .foregroundStyle(isHighlighted ? Color.accentColor : .primary)
            Text("\(count)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Color.secondary.opacity(0.15), in: Capsule())
            Spacer()
        }
        .padding(.vertical, 6)
        .textCase(nil)  // 禁止 List 默认大写
    }

    @ViewBuilder
    private func row(for bm: TwitterBookmark) -> some View {
        Button {
            openOriginalTweet(bm)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                qualityBadge(bm.qualityScore)
                    .frame(width: 32, alignment: .leading)  // 固定宽度防挤

                VStack(alignment: .leading, spacing: 6) {
                    // 作者 + 时间
                    HStack(spacing: 8) {
                        Text(bm.authorHandle)
                            .font(.subheadline).bold()
                            .foregroundStyle(.primary)
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(formatClock(bm.capturedAt))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Spacer(minLength: 0)
                    }
                    // Summary
                    Text(bm.summary ?? bm.text)
                        .font(.body)
                        .foregroundStyle(bm.summary == nil ? .secondary : .primary)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    // Tags 单独一行
                    if !bm.tags.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(bm.tags, id: \.self) { tag in
                                Text("#\(tag)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(Color.secondary.opacity(0.12), in: Capsule())
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func qualityBadge(_ score: Int?) -> some View {
        let val = score ?? 0
        let (color, label): (Color, String) = {
            switch val {
            case 8...10: return (.green, "\(val)")
            case 5...7:  return (.blue, "\(val)")
            case 1...4:  return (.gray, "\(val)")
            default:     return (.secondary, "?")
            }
        }()
        Text(label)
            .font(.system(.caption, design: .rounded, weight: .bold))
            .frame(width: 28, height: 28)
            .background(color.opacity(0.20), in: Circle())
            .overlay(Circle().stroke(color.opacity(0.4), lineWidth: 1))
            .foregroundStyle(color)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bookmark.slash")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("还没有 mark 过的推文")
                .font(.headline)
            Text("在 x.com 上 bookmark 推文，Mantle 会自动消化并每晚 22:00 推送精选。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(32)
    }

    // MARK: - Actions

    private func openOriginalTweet(_ bm: TwitterBookmark) {
        guard let url = URL(string: bm.url) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - Formatting

    private func formatDay(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "今天" }
        if cal.isDateInYesterday(date) { return "昨天" }
        let df = DateFormatter()
        df.locale = Locale(identifier: "zh_CN")
        df.dateFormat = "M月d日 EEEE"
        return df.string(from: date)
    }

    private func formatClock(_ date: Date) -> String {
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        return df.string(from: date)
    }
}
