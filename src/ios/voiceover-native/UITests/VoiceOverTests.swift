import XCTest

final class VoiceOverTests: XCTestCase {
  @MainActor
  func testCurrentScreen() throws {
    continueAfterFailure = false
    guard #available(iOS 27.0, *) else {
      XCTFail("Real VoiceOver requires Xcode 27 and an iOS 27+ simulator")
      return
    }
    let env = ProcessInfo.processInfo.environment
    let requestID = try XCTUnwrap(env["ALOUD_VO_REQUEST_ID"])
    let screen = try XCTUnwrap(env["ALOUD_VO_SCREEN"])
    let bundleID = try XCTUnwrap(env["ALOUD_VO_BUNDLE_ID"])
    let maxSteps = try XCTUnwrap(Int(env["ALOUD_VO_MAX_STEPS"] ?? ""))
    XCTAssertFalse(requestID.isEmpty)
    XCTAssertFalse(screen.isEmpty)
    XCTAssertFalse(bundleID.isEmpty)
    XCTAssertTrue((1...100).contains(maxSteps))

    let app = XCUIApplication(bundleIdentifier: bundleID)
    // Installing the separate test host must not restart the navigated app.
    XCTAssertTrue(app.state == .runningForeground || app.state == .runningBackground ||
      app.state == .runningBackgroundSuspended, "Target app must already be running")
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Target app is not foreground")
    let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    XCTAssertFalse(system.alerts.firstMatch.exists, "Dismiss system alerts before capturing the target")

    let service = XCUIDevice.shared.voiceOverService
    let wasEnabled = service.isEnabled
    // Restoration failures fail XCTest, including when capture throws. Never
    // publish a capture record before the original service state is restored.
    defer {
      do {
        if service.isEnabled != wasEnabled {
          if wasEnabled { try service.enable() } else { try service.disable() }
        }
      } catch {
        XCTFail("Could not restore VoiceOver state: \(error)")
      }
    }
    if !wasEnabled { try service.enable() }
    var steps: [[String: Any]] = []
    func recordStep(_ step: [String: Any]) throws {
      steps.append(step)
      // Keep speech already received in the log even if a later native
      // operation fails. Only the final capture marker is reportable data.
      let data = try JSONSerialization.data(withJSONObject: step, options: [.sortedKeys])
      print("ALOUD-VOICEOVER-STEP:\(requestID):\(data.base64EncodedString())")
    }
    var reason = "step-limit"
    let started = ProcessInfo.processInfo.systemUptime
    // Current focus plus at most maxSteps forward moves. Neither repeated
    // speech nor noSpeech proves the end: Output has no focus/end identity.
    for sequence in 0...maxSteps {
      if ProcessInfo.processInfo.systemUptime - started >= 120 {
        reason = "time-limit"
        break
      }
      XCTAssertEqual(app.state, .runningForeground, "Target app left foreground")
      XCTAssertFalse(system.alerts.firstMatch.exists, "System alert interrupted target speech")
      let action = sequence == 0 ? "current" : "forward"
      do {
        let output = try sequence == 0 ? service.currentSpeech() : service.moveForward()
        try recordStep(["sequence": sequence, "action": action, "utterance": output.utterance])
      } catch let error as XCUIVoiceOverService.Error where error.code == .noSpeech {
        // Retrying moveForward could silently skip a focused element. Keep
        // the timeout as evidence and stop, without claiming completion.
        try recordStep(["sequence": sequence, "action": action, "utterance": NSNull(),
          "error": ["domain": (error as NSError).domain, "code": (error as NSError).code,
            "description": error.localizedDescription]])
        reason = "speech-timeout"
        break
      }
      XCTAssertEqual(app.state, .runningForeground, "Target app left foreground")
    }
    XCTAssertEqual(app.state, .runningForeground, "Target app left foreground")
    XCTAssertFalse(system.alerts.firstMatch.exists, "System alert interrupted target speech")
    if service.isEnabled != wasEnabled {
      if wasEnabled { try service.enable() } else { try service.disable() }
    }
    let result: [String: Any] = [
      "schemaVersion": 1, "source": "voiceover", "status": "captured",
      "requestId": requestID, "screen": screen, "bundleId": bundleID,
      "runtime": ProcessInfo.processInfo.operatingSystemVersionString,
      "voiceOverWasEnabled": wasEnabled, "voiceOverRestored": service.isEnabled == wasEnabled,
      "coverage": ["complete": false, "start": "current-focus", "reason": reason,
        "maxSteps": maxSteps, "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000)],
      "steps": steps
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "aloud-voiceover"
    attachment.lifetime = .keepAlways
    add(attachment)
    print("ALOUD-VOICEOVER:\(requestID):\(data.base64EncodedString())")
  }
}
