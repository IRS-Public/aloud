import XCTest

final class AppleAuditTests: XCTestCase {
  @MainActor
  func testCurrentScreen() throws {
    continueAfterFailure = false
    let env = ProcessInfo.processInfo.environment
    let requestID = try XCTUnwrap(env["ALOUD_AUDIT_REQUEST_ID"])
    let screen = try XCTUnwrap(env["ALOUD_AUDIT_SCREEN"])
    let bundleID = try XCTUnwrap(env["ALOUD_AUDIT_BUNDLE_ID"])
    XCTAssertFalse(requestID.isEmpty)
    XCTAssertFalse(screen.isEmpty)
    XCTAssertFalse(bundleID.isEmpty)

    let app = XCUIApplication(bundleIdentifier: bundleID)
    // The walker already navigated to the requested screen. Do not call
    // launch(), which would erase that state, or capture a fallback app.
    XCTAssertTrue(app.state == .runningForeground || app.state == .runningBackground ||
      app.state == .runningBackgroundSuspended, "Target app must already be running")
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Target app is not foreground")

    var issues: [[String: Any]] = []
    try app.performAccessibilityAudit(for: .all) { issue in
      var element: Any = NSNull()
      if let el = issue.element {
        let frame = el.frame
        element = ["label": el.label, "identifier": el.identifier,
          "frame": ["x": frame.origin.x, "y": frame.origin.y,
            "width": frame.size.width, "height": frame.size.height]] as [String: Any]
      }
      let known: [(XCUIAccessibilityAuditType, String)] = [
        (.contrast, "contrast"), (.elementDetection, "elementDetection"),
        (.hitRegion, "hitRegion"), (.sufficientElementDescription, "sufficientElementDescription"),
        (.dynamicType, "dynamicType"), (.textClipped, "textClipped"), (.trait, "trait")
      ]
      let types = known.filter { issue.auditType.contains($0.0) }.map { $0.1 }
      issues.append([
        "typeMask": String(issue.auditType.rawValue),
        "types": types.isEmpty ? ["unknown"] : types,
        "compactDescription": issue.compactDescription,
        "detailedDescription": issue.detailedDescription, "element": element
      ])
      // We retain every issue as report-only evidence. Returning true
      // handles the issue in XCTest; infrastructure errors still throw.
      return true
    }
    XCTAssertEqual(app.state, .runningForeground, "Target app left the foreground during the audit")
    let result: [String: Any] = [
      "schemaVersion": 1, "source": "apple-accessibility-audit", "status": "completed",
      "requestId": requestID, "screen": screen, "bundleId": bundleID,
      "auditTypes": "all", "issues": issues
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "aloud-apple-audit"
    attachment.lifetime = .keepAlways
    add(attachment)
    print("ALOUD-APPLE-AUDIT:\(requestID):\(data.base64EncodedString())")
  }
}
