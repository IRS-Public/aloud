import SwiftUI

// XCTest's host is deliberately separate from the capture target.
@main
struct HostApp: App {
  var body: some Scene {
    WindowGroup { Text("Aloud test host — never capture this screen") }
  }
}
