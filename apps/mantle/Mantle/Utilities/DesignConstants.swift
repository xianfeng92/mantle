import SwiftUI

// MARK: - Design Constants
//
// Apple-inspired design tokens for Mantle.
// Single accent color (Apple Blue), tight typography, minimal shadows.

enum Design {
    // MARK: - Sizing
    static let cornerRadius: CGFloat = 8
    static let cardCornerRadius: CGFloat = 10
    static let panelCornerRadius: CGFloat = 12
    static let avatarSize: CGFloat = 28

    // MARK: - Spacing
    static let messageSpacing: CGFloat = 8
    static let containerPadding: CGFloat = 10
    static let panelPadding: CGFloat = 14
    static let messagePadding: CGFloat = 4
    static let sidebarRowPadding: CGFloat = 4
    static let sectionSpacing: CGFloat = 12
    static let blockSpacing: CGFloat = 16
    static let heroSectionPadding: CGFloat = 20
    static let launchCardMinHeight: CGFloat = 132
    static let compactLaunchCardMinHeight: CGFloat = 104
    static let starterCardMinHeight: CGFloat = 98
    static let compactStarterCardMinHeight: CGFloat = 84

    // MARK: - Animation
    static let toastDuration: TimeInterval = 1.5
    static let pulseDuration: TimeInterval = 0.6
    static let transitionDuration: TimeInterval = 0.25

    // MARK: - Colors — Apple Palette

    /// Apple Blue #0071e3 — the ONLY chromatic accent
    static let accent = Color(red: 0/255, green: 113/255, blue: 227/255)

    /// Surfaces
    static let surfaceLight = Color(red: 245/255, green: 245/255, blue: 247/255) // #F5F5F7
    static let surfaceDark = Color(red: 39/255, green: 39/255, blue: 41/255)     // #272729
    static let surfaceDarkAlt = Color(red: 42/255, green: 42/255, blue: 45/255)  // #2A2A2D

    /// Adaptive surface — light gray in light mode, dark gray in dark mode
    static func surface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? surfaceDark : surfaceLight
    }

    /// Adaptive elevated surface
    static func surfaceElevated(for scheme: ColorScheme) -> Color {
        scheme == .dark ? surfaceDarkAlt : Color.white
    }

    /// Text
    static let textPrimaryLight = Color(red: 29/255, green: 29/255, blue: 31/255) // #1D1D1F
    static let textPrimaryDark = Color.white

    static func textPrimary(for scheme: ColorScheme) -> Color {
        scheme == .dark ? textPrimaryDark : textPrimaryLight
    }

    static func textSecondary(for scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.56) : Color.black.opacity(0.56)
    }

    /// Borders — minimal, used sparingly
    static let borderSubtle = Color(nsColor: .separatorColor).opacity(0.4)

    /// Semantic status — only for functional indicators
    static let stateSuccess = Color(nsColor: .systemGreen)  // connection dots only
    static let stateDanger = Color(red: 220/255, green: 61/255, blue: 61/255)  // destructive actions

    // MARK: - Legacy Aliases (for gradual migration)
    // These map old token names to the new palette so existing code compiles.

    static let accentLaunch = accent
    static let accentContext = accent
    static let stateWarning = Color(nsColor: .systemOrange)
    static let stateInfo = accent
    static let surfaceBase = Color(nsColor: .windowBackgroundColor)
    static let surfaceElevated = Color(nsColor: .controlBackgroundColor)
    static let surfaceMuted = Color(nsColor: .underPageBackgroundColor)
    static let borderStrong = Color(nsColor: .separatorColor).opacity(0.7)
    static let textPrimary = Color.primary
    static let textSecondary = Color.secondary

    // MARK: - Shadow — one and only
    static let softShadowColor = Color.black.opacity(0.22)
    static let softShadowRadius: CGFloat = 15
    static let softShadowY: CGFloat = 3
}

// MARK: - Apple Typography View Modifiers

extension View {
    /// Headline: SF Pro Display, tight line-height, negative tracking
    func appleHeadline(_ size: CGFloat = 28) -> some View {
        self
            .font(.system(size: size, weight: .semibold))
            .tracking(size * -0.02)
            .lineSpacing(size * 0.07)
    }

    /// Body: SF Pro Text, comfortable line-height, subtle negative tracking
    func appleBody(_ size: CGFloat = 17) -> some View {
        self
            .font(.system(size: size, weight: .regular))
            .tracking(size * -0.01)
            .lineSpacing(size * 0.47)
    }

    /// Caption: SF Pro Text, compact
    func appleCaption(_ size: CGFloat = 12) -> some View {
        self
            .font(.system(size: size, weight: .regular))
            .tracking(size * -0.01)
    }
}
