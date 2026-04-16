import SwiftUI

// MARK: - InboxButton
//
// Header affordance that surfaces the Returns Plane unread count.
// Tap opens the InboxPopover. Badge updates live from ReturnsService.

struct InboxButton: View {
    let service: ReturnsService
    @State private var isPresented: Bool = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: service.unreadCount > 0 ? "tray.full" : "tray")
                if service.unreadCount > 0 {
                    Text("\(service.unreadCount)")
                        .font(.caption2).bold()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Color.accentColor, in: Capsule())
                        .offset(x: 8, y: -6)
                }
            }
        }
        .buttonStyle(.borderless)
        .help(service.unreadCount > 0
              ? "Inbox (\(service.unreadCount) unread)"
              : "Inbox")
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            InboxPopover(service: service)
                .frame(minWidth: 340, idealWidth: 380, minHeight: 320, idealHeight: 440)
        }
    }
}
