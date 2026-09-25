import XCTest

final class DueGoodDesktopUITests: XCTestCase {
    private let productionBundleIdentifier = "com.zerodelta.duegood"

    func testFirstRunCalendarConnectionWithoutLegacyImport() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let appPath = environment["DUEGOOD_TEST_APP_PATH"],
              let dataRoot = environment["DUEGOOD_TEST_DATA_ROOT"],
              !appPath.isEmpty, !dataRoot.isEmpty else {
            XCTFail("The smoke runner must supply the test app and private synthetic root.")
            return
        }

        let app = XCUIApplication(url: URL(fileURLWithPath: appPath))
        app.launchEnvironment["DUEGOOD_TEST_DATA_ROOT"] = dataRoot
        app.launch()
        defer { if app.state != .notRunning { app.terminate() } }

        XCTAssertTrue(app.staticTexts["Connect your Canvas calendar"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Connect calendar"].exists)
        XCTAssertFalse(app.buttons["Choose legacy folder…"].exists)
        XCTAssertFalse(app.buttons["Refresh"].exists)
        app.terminate()
        app.launchEnvironment["DUEGOOD_TEST_DATA_ROOT"] = dataRoot
        app.launch()
        XCTAssertTrue(app.staticTexts["Connect your Canvas calendar"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Choose legacy folder…"].exists)
    }

    func testProductionIdentifierLaunchOnly() throws {
        guard let expectedDisplayRoot = ProcessInfo.processInfo.environment["DUEGOOD_EXPECTED_PRODUCTION_DISPLAY_ROOT"],
              !expectedDisplayRoot.isEmpty else {
            XCTFail("The production launch runner must supply the expected display folder.")
            return
        }

        let app = XCUIApplication(bundleIdentifier: productionBundleIdentifier)
        XCTAssertNotEqual(app.state, .notRunning, "The runner must launch the explicit staged app path first.")
        app.activate()
        defer { if app.state != .notRunning { app.terminate() } }

        XCTAssertTrue(app.staticTexts["Connect your Canvas calendar"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Connect calendar"].exists)
        XCTAssertFalse(app.buttons["Choose legacy folder…"].exists)
        XCTAssertFalse(app.buttons["Refresh"].exists)
        // WebKit exposes setup copy as AX values and truncates this path visually.
        // The runner separately verifies the helper's full canonical data-root report.
        XCTAssertTrue(expectedDisplayRoot.hasPrefix("~/Library/"))
        let displayedRoot = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "~/Library/")).firstMatch
        XCTAssertTrue(displayedRoot.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", "separate from a Canvas API token")).firstMatch.exists)
    }

}
