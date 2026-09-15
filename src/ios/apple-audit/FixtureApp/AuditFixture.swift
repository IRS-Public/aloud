import SwiftUI
import UIKit

struct TinyControl: UIViewRepresentable {
  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .custom)
    button.setTitle("!", for: .normal)
    button.backgroundColor = .black
    button.accessibilityLabel = "Tiny target"
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
        Text("The tiny button below intentionally fails Apple's hit-region audit.")
        TinyControl().frame(width: 8, height: 8)
        Button("Continue") {}
      }.padding()
    }
  }
}
