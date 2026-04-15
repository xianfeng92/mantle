import SwiftUI

// MARK: - Copy Toast
//
// Lightweight overlay that confirms a clipboard copy action.
// Shows "Copied!" with a checkmark, then auto-dismisses.

struct CopyToast: View {
    @Binding var isShowing: Bool

    var body: some View {
        if isShowing {
            Label("Copied!", systemImage: "checkmark.circle.fill")
                .font(.callout)
                .fontWeight(.medium)
                .foregroundStyle(.primary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
                .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onAppear {
                    Task {
                        try? await Task.sleep(for: .seconds(Design.toastDuration))
                        withAnimation(.easeOut(duration: Design.transitionDuration)) {
                            isShowing = false
                        }
                    }
                }
                .accessibilityLabel("Copied to clipboard")
        }
    }
}

// MARK: - View Modifier for Toast Overlay

extension View {
    /// Adds a copy toast overlay anchored to the bottom of this view.
    func copyToastOverlay(isShowing: Binding<Bool>) -> some View {
        self.overlay(alignment: .bottom) {
            CopyToast(isShowing: isShowing)
                .padding(.bottom, 16)
                .animation(.spring(duration: Design.transitionDuration), value: isShowing.wrappedValue)
        }
    }
}
