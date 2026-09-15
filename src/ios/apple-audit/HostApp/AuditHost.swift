// Test-bundle host and an explicit CI fixture. Production audits never
// fall back to this app if the requested target is unavailable.
import SwiftUI

@main
struct AuditHost: App {
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 24) {
        Text("Aloud audit fixture").font(.title).accessibilityAddTraits(.isHeader)
        Button("Continue") {}
        Toggle("Notifications", isOn: .constant(true))
      }.padding()
    }
  }
}
