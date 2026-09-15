import SwiftUI

@main
struct VoiceOverFixture: App {
  var body: some Scene { WindowGroup { FixtureScreen() } }
}

struct FixtureScreen: View {
  @State private var mode = "launch"
  @State private var modal = false
  @State private var count = 0
  let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(spacing: 24) {
      Text("Fixture \(mode)").accessibilityAddTraits(.isHeader)
      if mode == "repeated" {
        Button("Same label") {}.accessibilityIdentifier("first")
        Button("Same label") {}.accessibilityIdentifier("second")
        Text("Balance $1,234.50; rate 2.5%")
        Toggle("Notifications", isOn: .constant(true))
      } else if mode == "scroll" {
        ScrollView {
          VStack(spacing: 60) {
            ForEach(1...30, id: \.self) { index in
              Button("Scroll row \(index)") {}.frame(height: 44)
            }
          }
        }
      } else if mode == "dynamic" {
        Text("Live count \(count)")
        Button("Stable control") {}
      } else {
        Text("Launch screen must not be substituted for the navigated screen")
      }
    }
    .padding()
    .sheet(isPresented: $modal) {
      VStack(spacing: 24) {
        Text("Modal details").accessibilityAddTraits(.isHeader)
        Button("Dismiss modal") { modal = false }
        Text("Modal value 12.50")
      }.padding()
    }
    .onOpenURL { url in
      mode = url.host ?? "launch"
      modal = mode == "modal"
    }
    .onReceive(timer) { _ in if mode == "dynamic" { count += 1 } }
  }
}
