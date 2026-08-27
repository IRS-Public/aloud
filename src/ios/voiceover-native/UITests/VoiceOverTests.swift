// Experimental harness: drive REAL VoiceOver in the iOS Simulator with the
// Xcode 27 XCUIVoiceOverService API and capture what it speaks on the
// target app's launch screen.
//
// API (Apple docs, Xcode 27 beta):
//   XCUIDevice.shared.voiceOverService          -> XCUIVoiceOverService
//   try service.enable() / disable()
//   try service.currentSpeech() -> Output        (speech for focused element)
//   try service.moveForward() / moveBackward()   -> Output for next element
//   output.utterance: String                     e.g. "Add Favorites, button"
//
// Deliberately tolerant: the point is to prove the plumbing works, not to
// gate on content. Maximum diagnostics — every utterance goes to stdout
// between VOICEOVER-UTTERANCES-BEGIN/END markers, to an XCTest attachment,
// and to the file named by env VOICEOVER_OUT_FILE (passed by the workflow
// via TEST_RUNNER_VOICEOVER_OUT_FILE; simulator processes can write host
// paths).
//
// Requires: Xcode 27, an iOS 27 simulator, and the target app already
// installed on the booted simulator (simctl install). Pass the target's
// bundle id as TEST_RUNNER_TARGET_BUNDLE_ID to xcodebuild; it reaches the
// test as TARGET_BUNDLE_ID.
//
// Hard-won constraints (keep in mind when adapting):
// - Build the TARGET app against a pre-iOS-27 SDK, then install it on the
//   Xcode 27 simulator. Apps built with the iOS 27 SDK can fail to launch
//   there (UIScene lifecycle trap); the harness targets fall back below.
// - Real utterances differ from aloud's computed format ("Order status
//   Heading" vs "Order status, heading") — normalize before comparing
//   against computed baselines.
// - moveForward() can throw ("No speech available") mid-walk; treat it as
//   end-of-screen, not a failure.

import XCTest

final class VoiceOverTests: XCTestCase {

  override func setUpWithError() throws {
    continueAfterFailure = true
  }

  @MainActor
  func testCaptureVoiceOverUtterancesOnLaunchScreen() throws {
    guard #available(iOS 27.0, *) else {
      throw XCTSkip("XCUIVoiceOverService needs iOS 27 / Xcode 27")
    }

    guard let bundleId = ProcessInfo.processInfo.environment["TARGET_BUNDLE_ID"],
      !bundleId.isEmpty
    else {
      XCTFail(
        "TARGET_BUNDLE_ID is not set — pass TEST_RUNNER_TARGET_BUNDLE_ID=<your.bundle.id> "
          + "to xcodebuild so the harness knows which installed app to drive")
      return
    }

    let app = XCUIApplication(bundleIdentifier: bundleId)
    app.launch()
    var foreground = app.wait(for: .runningForeground, timeout: 60)
    print("VOICEOVER-HARNESS foreground after launch(): \(foreground), state=\(app.state.rawValue)")
    if !foreground {
      // Do not fail here — earlier runs showed the target app can die on
      // launch while VoiceOver capture itself works fine. Retry once via
      // activate(), then proceed and let VoiceOver read whatever screen
      // is frontmost; a separate smoke-launch step should diagnose the app.
      app.activate()
      foreground = app.wait(for: .runningForeground, timeout: 30)
      print("VOICEOVER-HARNESS foreground after activate(): \(foreground), state=\(app.state.rawValue)")
    }

    // A debug React Native build loads its JS bundle from the bundler; the
    // first request can take a while even when the workflow prewarms it.
    // Wait for real rendered content, but do not fail on it — VoiceOver
    // will speak *something* either way, and that still proves capture.
    if foreground {
      let gotContent = app.staticTexts.firstMatch.waitForExistence(timeout: 180)
      print("VOICEOVER-HARNESS app rendered text content: \(gotContent)")
    }

    // Earlier runs showed the app can be killed during launch while the
    // bundler's first compile is in flight. Prewarm the bundle in the
    // workflow; if the app still went away, one relaunch against the warm
    // bundle is cheap and gives VoiceOver the app screen instead of the
    // home screen.
    if app.state != .runningForeground {
      print("VOICEOVER-HARNESS app state=\(app.state.rawValue) before VoiceOver — relaunching once")
      app.launch()
      _ = app.wait(for: .runningForeground, timeout: 30)
      let gotContent = app.staticTexts.firstMatch.waitForExistence(timeout: 120)
      print("VOICEOVER-HARNESS after relaunch: state=\(app.state.rawValue) rendered=\(gotContent)")
    }

    // Last-resort target: the harness's own SwiftUI host app. Spike runs
    // found a target app built with the iOS 27 SDK cannot launch (UIScene
    // lifecycle trap), so without a fallback VoiceOver reads the home
    // screen. The host has labeled controls, which still proves real
    // per-element utterance capture (label + trait word).
    if app.state != .runningForeground {
      print("VOICEOVER-HARNESS target app unavailable — falling back to the harness host app")
      let host = XCUIApplication()
      host.launch()
      _ = host.wait(for: .runningForeground, timeout: 30)
      print("VOICEOVER-HARNESS host app state=\(host.state.rawValue)")
    }

    let service = XCUIDevice.shared.voiceOverService
    print("VOICEOVER-HARNESS service before enable: \(service.debugDescription)")

    var utterances: [String] = []
    defer {
      // Always emit whatever was captured, even if a step above threw.
      let text = utterances.joined(separator: "\n")
      print("VOICEOVER-UTTERANCES-BEGIN")
      print(text)
      print("VOICEOVER-UTTERANCES-END")
      let attachment = XCTAttachment(string: text)
      attachment.name = "voiceover-utterances"
      attachment.lifetime = .keepAlways
      add(attachment)
      if let outPath = ProcessInfo.processInfo.environment["VOICEOVER_OUT_FILE"] {
        do {
          try text.write(toFile: outPath, atomically: true, encoding: .utf8)
          print("VOICEOVER-HARNESS wrote \(utterances.count) utterances to \(outPath)")
        } catch {
          print("VOICEOVER-HARNESS could not write \(outPath): \(error)")
        }
      }
      try? service.disable()
    }

    do {
      try service.enable()
    } catch {
      XCTFail("VoiceOver enable() failed: \(error)")
      return
    }
    print("VOICEOVER-HARNESS VoiceOver enabled, isEnabled=\(service.isEnabled)")

    if let current = try? service.currentSpeech() {
      print("VOICEOVER[0]: \(current.utterance)")
      utterances.append(current.utterance)
    } else {
      print("VOICEOVER[0]: currentSpeech() produced nothing (tolerated)")
    }

    for step in 1...20 {
      do {
        let output = try service.moveForward()
        print("VOICEOVER[\(step)]: \(output.utterance)")
        utterances.append(output.utterance)
      } catch {
        // moveForward() can throw "No speech available" at end of screen —
        // tolerated, it just ends the walk.
        print("VOICEOVER-HARNESS moveForward() stopped at step \(step): \(error)")
        break
      }
    }

    let nonEmpty = utterances.filter {
      !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    XCTAssertGreaterThan(
      nonEmpty.count, 0,
      "expected at least one non-empty VoiceOver utterance")
  }
}
