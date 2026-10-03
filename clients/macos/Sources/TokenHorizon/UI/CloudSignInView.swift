import SwiftUI

struct CloudSignInView: View {
    @ObservedObject var controller: CloudSignInController

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .font(.system(size: 30, weight: .light)).foregroundStyle(.cyan)
                Spacer()
                Button { controller.cancel() } label: {
                    Image(systemName: "xmark").frame(width: 28, height: 28)
                }.buttonStyle(.plain).accessibilityLabel("Cancel sign-in")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(controller.isWaiting ? "Finish connecting in your browser" : "Connect this Mac")
                    .font(.system(size: 24, weight: .semibold))
                Text(controller.message)
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                Image(systemName: "at").foregroundStyle(.cyan)
                VStack(alignment: .leading, spacing: 3) {
                    Text("@\(controller.handle)").font(.system(size: 14, weight: .semibold))
                    Text("Keep this handle or choose another in your browser.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 9) {
                Label("Your account owns the profile you connect.", systemImage: "checkmark.shield")
                Label("Sync follows your sharing preferences.", systemImage: "slider.horizontal.3")
                Label(SettingsStore.shared.leaderboardSharePrompts ? "Session titles are shared by your current settings." : "Prompt and session titles stay private.", systemImage: "lock")
            }.font(.system(size: 12)).foregroundStyle(.secondary)
            if let error = controller.error {
                Text(error).font(.system(size: 12)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Sign-in error: \(error)")
            }
            HStack(spacing: 12) {
                if controller.isWaiting {
                    ProgressView().controlSize(.small)
                    Text("Waiting for your approval…").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Open browser again") { controller.reopenBrowser() }.buttonStyle(.bordered)
                } else {
                    Button("Cancel") { controller.cancel() }.buttonStyle(.plain)
                    Spacer()
                    Button("Continue in browser") { controller.begin() }
                        .buttonStyle(.borderedProminent).tint(.cyan).foregroundStyle(.black)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }.padding(28).frame(width: 440).preferredColorScheme(.dark)
    }
}
