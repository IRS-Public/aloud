import SwiftUI
import UIKit

struct FixedFontControl: UIViewRepresentable {
  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .custom)
    button.setTitle("!", for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 17)
    button.titleLabel?.adjustsFontForContentSizeCategory = false
    button.backgroundColor = .black
    button.accessibilityLabel = "Fixed-font control"
    return button
  }
  func updateUIView(_ uiView: UIButton, context: Context) {}
}

@main
struct AuditFixture: App {
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 32) {
        Text("Aloud native audit fixture").font(.title).accessibilityAddTraits(.isHeader)
        Text("The button below deliberately uses a fixed font that does not scale with Dynamic Type.")
        FixedFontControl().frame(width: 8, height: 8)
        Button("Continue") {}
      }.padding()
    }
  }
}
