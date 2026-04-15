import SwiftUI

// MARK: - Permission Guide View
//
// Explains why a permission is needed, what happens without it,
// and provides a button to open System Settings.
// Follows Aura design doc §6.2: explain → deep link → never auto-retry.

struct PermissionGuideView: View {
    let description: PermissionManager.PermissionDescription
    let isGranted: Bool
    var onRequest: () -> Void

    private var statusColor: Color {
        isGranted ? Design.stateSuccess : Design.stateDanger
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 8) {
                Image(systemName: description.icon)
                    .font(.title3)
                    .foregroundStyle(statusColor)

                Text(description.title)
                    .font(.headline)

                Spacer()

                statusBadge
            }

            // Why
            infoRow(label: "Why", text: description.why)

            // Without it
            infoRow(label: "Without", text: description.without)

            // With it
            infoRow(label: "With it", text: description.withIt)

            // Action
            if !isGranted {
                Button {
                    onRequest()
                } label: {
                    Label("Open System Settings", systemImage: "gear")
                }
                .buttonStyle(.borderedProminent)
                .tint(Design.accent)
                .controlSize(.small)
            }
        }
        .padding(Design.containerPadding)
        .background(
            statusColor.opacity(0.04),
            in: RoundedRectangle(cornerRadius: Design.cornerRadius)
        )
    }

    private var statusBadge: some View {
        Text(isGranted ? "Granted" : "Not Granted")
            .font(.caption)
            .fontWeight(.medium)
            .foregroundStyle(statusColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                statusColor.opacity(0.08),
                in: Capsule()
            )
    }

    private func infoRow(label: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .frame(width: 55, alignment: .trailing)

            Text(text)
                .font(.callout)
                .foregroundStyle(.primary)
        }
    }
}
