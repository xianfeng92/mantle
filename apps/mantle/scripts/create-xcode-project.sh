#!/bin/bash
# Creates a proper Xcode project for Cortex using swift package generate-xcodeproj
# or guides user to create one manually in Xcode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Cortex Xcode Project Setup ==="
echo ""
echo "Since Cortex needs a .app bundle for MenuBarExtra to work,"
echo "please create the Xcode project manually:"
echo ""
echo "  1. Open Xcode"
echo "  2. File > New > Project"
echo "  3. Choose: macOS > App"
echo "  4. Settings:"
echo "     - Product Name: Cortex"
echo "     - Organization Identifier: com.xforg"
echo "     - Interface: SwiftUI"
echo "     - Language: Swift"
echo "     - Storage: None"
echo "  5. Save to: ~/AI_SPACE/Cortex-App/"
echo "  6. Delete the auto-generated ContentView.swift and CortexApp.swift"
echo "  7. Drag all files from ~/AI_SPACE/Cortex/Cortex/ into the Xcode project"
echo "  8. Add swift-markdown SPM package: https://github.com/apple/swift-markdown.git"
echo "  9. In Info.plist, add: Application is agent (LSUIElement) = YES"
echo ""
echo "Or wait — we have a better approach below..."
