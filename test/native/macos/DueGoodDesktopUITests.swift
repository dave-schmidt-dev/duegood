import XCTest

final class DueGoodDesktopUITests: XCTestCase {
    private let productionBundleIdentifier = "com.zerodelta.duegood"

    func testFirstRunImportMutationRecoveryUnavailableRefreshAndRelaunch() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let appPath = environment["DUEGOOD_TEST_APP_PATH"],
              let dataRoot = environment["DUEGOOD_TEST_DATA_ROOT"],
              let legacyRoot = environment["DUEGOOD_SYNTHETIC_LEGACY_ROOT"],
              !appPath.isEmpty, !dataRoot.isEmpty, !legacyRoot.isEmpty else {
            XCTFail("The smoke runner must supply the test app and private synthetic roots.")
            return
        }

        let app = XCUIApplication(url: URL(fileURLWithPath: appPath))
        app.launchEnvironment["DUEGOOD_TEST_DATA_ROOT"] = dataRoot
        app.launch()
        defer { if app.state != .notRunning { app.terminate() } }

        XCTAssertTrue(app.staticTexts["Import existing coursework"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Choose legacy folder…"].exists)
        XCTAssertFalse(app.buttons["Refresh"].exists)

        app.buttons["Choose legacy folder…"].click()
        try chooseFolder(legacyRoot, in: app)

        XCTAssertTrue(app.staticTexts["Dry run"].waitForExistence(timeout: 20))
        let importButton = app.buttons["Import as preview copy"]
        XCTAssertTrue(importButton.waitForExistence(timeout: 10))
        XCTAssertTrue(importButton.isEnabled)
        importButton.click()

        XCTAssertTrue(app.staticTexts["Timeline"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Essay draft"].waitForExistence(timeout: 10))

        let grades = app.links["Grades"]
        XCTAssertTrue(grades.waitForExistence(timeout: 10))
        grades.click()
        XCTAssertTrue(app.staticTexts["Graded points are not a final course grade."].waitForExistence(timeout: 10))

        let timeline = app.links["Timeline"]
        XCTAssertTrue(timeline.exists)
        timeline.click()
        let completion = app.checkBoxes["Mark Essay draft done"]
        XCTAssertTrue(completion.waitForExistence(timeout: 10))
        completion.click()
        let done = app.links["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.click()
        XCTAssertTrue(app.staticTexts["Essay draft"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Mark not done"].exists)

        let more = app.links["More"]
        XCTAssertTrue(more.exists)
        more.click()
        XCTAssertTrue(app.staticTexts["Canvas refresh is unavailable for a preview copy."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Refresh"].exists)

        let recovery = app.buttons["Recovery"]
        XCTAssertTrue(recovery.exists)
        recovery.click()
        XCTAssertTrue(app.staticTexts["Recover or export coursework"].waitForExistence(timeout: 10))
        let back = app.buttons["Back to dashboard"]
        XCTAssertTrue(back.exists)
        back.click()
        XCTAssertTrue(app.staticTexts["More"].waitForExistence(timeout: 10))

        app.terminate()
        app.launchEnvironment["DUEGOOD_TEST_DATA_ROOT"] = dataRoot
        app.launch()
        XCTAssertTrue(app.links["Done"].waitForExistence(timeout: 30))
        app.links["Done"].click()
        XCTAssertTrue(app.staticTexts["Essay draft"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Mark not done"].exists)
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

        XCTAssertTrue(app.staticTexts["Import existing coursework"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Choose legacy folder…"].exists)
        XCTAssertFalse(app.buttons["Refresh"].exists)
        // WebKit exposes setup copy as AX values and truncates this path visually.
        // The runner separately verifies the helper's full canonical data-root report.
        XCTAssertTrue(expectedDisplayRoot.hasPrefix("~/Library/"))
        let displayedRoot = app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "~/Library/")).firstMatch
        XCTAssertTrue(displayedRoot.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "value BEGINSWITH %@", "It never refreshes")).firstMatch.exists)
    }

    private func chooseFolder(_ path: String, in app: XCUIApplication) throws {
        let panel = app.sheets.matching(identifier: "open-panel").firstMatch
        XCTAssertTrue(panel.waitForExistence(timeout: 15), "The native folder picker should open.")

        // macOS Open panels expose Go to Folder through the standard Command-Shift-G shortcut.
        panel.typeKey("g", modifierFlags: [.command, .shift])
        let goSheet = app.descendants(matching: .sheet)
            .matching(NSPredicate(format: "identifier != %@", "open-panel")).firstMatch
        XCTAssertTrue(goSheet.waitForExistence(timeout: 10), "The native Go to Folder sheet should open.")
        let pathField = goSheet.textFields.firstMatch
        XCTAssertTrue(pathField.waitForExistence(timeout: 5))
        pathField.click()
        pathField.typeKey("a", modifierFlags: [.command])
        pathField.typeText(path)
        // The Go button belongs to a separate accessibility window on macOS.
        // Return submits the focused path field without relying on that window.
        pathField.typeKey(XCUIKeyboardKey.return, modifierFlags: [])

        let openButton = panel.buttons["Open"].firstMatch
        XCTAssertTrue(openButton.waitForExistence(timeout: 10))
        openButton.click()
        XCTAssertTrue(panel.waitForNonExistence(timeout: 10), "The native folder picker should close.")
    }

}
