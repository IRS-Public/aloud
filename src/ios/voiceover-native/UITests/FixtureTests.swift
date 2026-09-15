import XCTest

// Used only by the simulator smoke script, never selected by the capturer.
final class FixtureTests: XCTestCase {
  @MainActor
  func testNavigateFixture() throws {
    continueAfterFailure = false
    let mode = try XCTUnwrap(ProcessInfo.processInfo.environment["ALOUD_VO_FIXTURE_MODE"])
    if #available(iOS 27.0, *), XCUIDevice.shared.voiceOverService.isEnabled {
      try XCUIDevice.shared.voiceOverService.disable()
    }
    let app = XCUIApplication(bundleIdentifier: "org.aloud.voiceover.VoiceOverFixture")
    app.launch()
    let button = app.buttons["fixture-\(mode)"]
    XCTAssertTrue(button.waitForExistence(timeout: 15))
    button.tap()
    let label = mode == "modal" ? "Modal details" : "Fixture \(mode)"
    XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: 15))
    // Exercise capture's preservation of both initial service states.
    if #available(iOS 27.0, *), mode == "repeated" {
      try XCUIDevice.shared.voiceOverService.enable()
    }
  }
}
