import XCTest

// Used only by the simulator smoke script, never selected by the capturer.
final class FixtureTests: XCTestCase {
  @MainActor
  func testNavigateFixture() throws {
    continueAfterFailure = false
    let mode = try XCTUnwrap(ProcessInfo.processInfo.environment["ALOUD_VO_FIXTURE_MODE"])
    let app = XCUIApplication(bundleIdentifier: "org.aloud.voiceover.VoiceOverFixture")
    app.launch()
    let button = app.buttons["fixture-\(mode)"]
    XCTAssertTrue(button.waitForExistence(timeout: 15))
    button.tap()
    let label = mode == "modal" ? "Modal details" : "Fixture \(mode)"
    XCTAssertTrue(app.staticTexts[label].waitForExistence(timeout: 15))
  }
}
