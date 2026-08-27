// Minimal host app for the real-VoiceOver UI-test bundle. Never the main
// target — the test drives the target app by bundle identifier. The host
// carries a few labeled controls so that, if the real app cannot launch,
// VoiceOver still has known content to read and the harness still proves
// per-element utterance capture (label + trait word).
import SwiftUI

@main
struct HostApp: App {
  var body: some Scene {
    WindowGroup {
      VStack(alignment: .leading, spacing: 24) {
        Text("VoiceOver Harness")
          .font(.title)
          .accessibilityAddTraits(.isHeader)
        Text("Host app for the XCUIVoiceOverService harness.")
        Button("Check Order Status") {}
        Toggle("Notifications", isOn: .constant(true))
        Link("Example.org", destination: URL(string: "https://example.org")!)
      }
      .padding()
    }
  }
}
