import Darwin
import Foundation
import XCTest

final class DueGoodDesktopUITests: XCTestCase {
    private let productionBundleIdentifier = "com.zerodelta.duegood"

    private struct ExpectedPage: Decodable {
        let id: String
        let heading: String
        let requiredText: [String]
        let forbiddenText: [String]
        let emptyStateText: String?
    }

    private struct ExpectedDocument: Decodable {
        let schemaVersion: Int
        let performFullRefresh: Bool
        let pages: [ExpectedPage]
    }

    private struct PageRoute {
        let id: String
        let navLabel: String
        let heading: String
    }

    private let liveRoutes = [
        PageRoute(id: "timeline", navLabel: "Timeline", heading: "Timeline"),
        PageRoute(id: "grades", navLabel: "Grades", heading: "Grades"),
        PageRoute(id: "inbox", navLabel: "Inbox", heading: "Inbox"),
        PageRoute(id: "completed", navLabel: "Done", heading: "Completed"),
        PageRoute(id: "courses", navLabel: "Courses", heading: "Courses"),
        PageRoute(id: "library", navLabel: "Library", heading: "Library"),
        PageRoute(id: "activity", navLabel: "Activity", heading: "Activity"),
        PageRoute(id: "more", navLabel: "More", heading: "More"),
    ]

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

    func testLiveRefreshAllPagesInPopulatedStore() throws {
        let expected = try readPrivateLiveExpectedDocument()
        let app = XCUIApplication(bundleIdentifier: productionBundleIdentifier)
        guard app.state != .notRunning else {
            XCTFail("The installed Due Good app must already be running.")
            return
        }
        app.activate()
        XCTAssertNotEqual(app.state, .notRunning, "The live verifier only attaches to the running app.")

        let refreshWasEnabled = app.buttons.allElementsBoundByIndex.contains { $0.label == "Refresh" && $0.isEnabled }
        XCTAssertTrue(refreshWasEnabled, "The full-refresh button must be enabled before this new refresh starts.")
        let refreshOutcome = performFullRefresh(app)
        XCTAssertNotEqual(refreshOutcome, "failed", "The full refresh reported failure.")
        guard refreshOutcome == "complete" || refreshOutcome == "partial" else { return }
        for page in expected.pages {
            verify(page, route: liveRoutes.first(where: { $0.id == page.id })!, app: app)
        }
    }

    private func performFullRefresh(_ app: XCUIApplication) -> String {
        let refresh = app.buttons.allElementsBoundByIndex.first(where: { $0.label == "Refresh" })
        guard let refresh, refresh.exists, refresh.isEnabled else {
            print("DUEGOOD_LIVE_REFRESH outcome=failed")
            XCTFail("The full-refresh button is unavailable.")
            return "failed"
        }
        let priorRunningStatuses = Set(visibleStaticText(app).filter(isRunningRefreshStatus))
        refresh.click()

        let deadline = Date().addingTimeInterval(30 * 60)
        let transitionDeadline = Date().addingTimeInterval(10)
        var sawRunningTransition = false
        while Date() < deadline {
            let labels = visibleStaticText(app)
            let runningStatus = labels.first(where: isRunningRefreshStatus)
            let refreshDisabled = app.buttons.allElementsBoundByIndex.contains {
                !$0.isEnabled && ($0.label == "Refreshing…" || $0.label == "Refreshing calendar…")
            }
            sawRunningTransition = sawRunningTransition || (runningStatus.map {
                !priorRunningStatuses.contains($0) && refreshDisabled
            } ?? false)
            let refreshReenabled = app.buttons.allElementsBoundByIndex.contains(where: { $0.label == "Refresh" && $0.isEnabled })
            if sawRunningTransition && refreshReenabled && labels.contains(where: { $0.contains("Updated data could not be reloaded; the prior view is still shown.") }) {
                print("DUEGOOD_LIVE_REFRESH outcome=reload-failed")
                XCTFail("The refreshed dashboard could not be reloaded.")
                return "reload-failed"
            }
            if sawRunningTransition && refreshReenabled && labels.contains(where: { $0.hasPrefix("Full refresh complete.") }) {
                print("DUEGOOD_LIVE_REFRESH outcome=complete")
                return "complete"
            }
            if sawRunningTransition && refreshReenabled && labels.contains(where: { $0.hasPrefix("Full refresh partial.") }) {
                print("DUEGOOD_LIVE_REFRESH outcome=partial")
                return "partial"
            }
            if sawRunningTransition && refreshReenabled && labels.contains(where: { $0.hasPrefix("Full refresh failed.") }) {
                print("DUEGOOD_LIVE_REFRESH outcome=failed")
                return "failed"
            }
            if Date() >= transitionDeadline && !sawRunningTransition {
                print("DUEGOOD_LIVE_REFRESH outcome=unconfirmed")
                XCTFail("The new refresh did not show a running state before its final status.")
                return "unconfirmed"
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        print("DUEGOOD_LIVE_REFRESH outcome=timeout")
        XCTFail("The full refresh did not reach a final status before its deadline.")
        return "timeout"
    }

    private func isRunningRefreshStatus(_ label: String) -> Bool {
        label == "Canvas refresh is in progress"
            || label == "Canvas and calendar refresh is in progress"
            || label.hasPrefix("Canvas and calendar refresh ·")
    }

    private func verify(_ page: ExpectedPage, route: PageRoute, app: XCUIApplication) {
        guard page.id == route.id, page.heading == route.heading else {
            print("DUEGOOD_LIVE_PAGE id=\(route.id) ok=false matched=0")
            XCTFail("A page did not match its registered public route.")
            return
        }
        let navigationItem = app.descendants(matching: .any).allElementsBoundByIndex.first {
            $0.label == route.navLabel && ($0.elementType == .link || $0.elementType == .button)
        }
        guard let navigationItem else {
            print("DUEGOOD_LIVE_PAGE id=\(route.id) ok=false matched=0")
            XCTFail("A registered page could not be opened.")
            return
        }
        navigationItem.click()

        let regionLabel = "Due Good \(route.id) page"
        let pageRegion = app.descendants(matching: .any).allElementsBoundByIndex.first {
            $0.label == regionLabel && ($0.elementType == .other || $0.elementType == .group)
        }
        let regionVisible = pageRegion?.waitForExistence(timeout: 15) ?? false
        let labels = pageRegion.map { visibleStaticText($0) } ?? []
        let headingVisible = regionVisible && labels.contains(route.heading)
        let matched = page.requiredText.filter { token in
            labels.contains(where: { $0 == token || $0.contains(token) })
        }.count
        let forbidden = page.forbiddenText.contains { token in
            labels.contains(where: { $0 == token || $0.contains(token) })
        }
        let emptyStateVisible = page.emptyStateText.map { expected in labels.contains(where: { $0 == expected }) } ?? true
        let ok = regionVisible && headingVisible && matched == page.requiredText.count && !forbidden && emptyStateVisible
        print("DUEGOOD_LIVE_PAGE id=\(route.id) ok=\(ok ? "true" : "false") matched=\(matched)")
        XCTAssertTrue(headingVisible, "A page heading was not visible.")
        XCTAssertTrue(regionVisible, "The registered page content region was not accessible.")
        XCTAssertEqual(matched, page.requiredText.count, "Expected source text was not visible on a page.")
        XCTAssertFalse(forbidden, "A forbidden source text token was visible.")
        XCTAssertTrue(emptyStateVisible, "The expected public empty state was not visible.")
    }

    private func visibleStaticText(_ parent: XCUIElement) -> [String] {
        parent.staticTexts.allElementsBoundByIndex.flatMap { element in
            let label = element.label
            let value = element.value as? String ?? ""
            return [label, value].filter { !$0.isEmpty }
        }
    }

    private func readPrivateLiveExpectedDocument() throws -> ExpectedDocument {
        guard let filePath = ProcessInfo.processInfo.environment["DUEGOOD_LIVE_EXPECTED_FILE"],
              filePath.hasPrefix("/") else {
            XCTFail("The live verifier did not supply its private expected-file path.")
            throw NSError(domain: "DueGoodLiveVerifier", code: 1)
        }
        let fd = open(filePath, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else {
            XCTFail("The private expected file could not be opened safely.")
            throw NSError(domain: "DueGoodLiveVerifier", code: 2)
        }
        defer { close(fd) }
        var opened = stat()
        var named = stat()
        guard fstat(fd, &opened) == 0, lstat(filePath, &named) == 0,
              (opened.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              opened.st_uid == getuid(), (opened.st_mode & 0o777) == 0o600,
              opened.st_size > 0, opened.st_size <= 256 * 1024,
              opened.st_dev == named.st_dev, opened.st_ino == named.st_ino else {
            XCTFail("The private expected file failed ownership or identity checks.")
            throw NSError(domain: "DueGoodLiveVerifier", code: 3)
        }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                read(fd, bytes.baseAddress, bytes.count)
            }
            guard count >= 0 else {
                XCTFail("The private expected file could not be read safely.")
                throw NSError(domain: "DueGoodLiveVerifier", code: 4)
            }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= 256 * 1024 else {
                XCTFail("The private expected file exceeded its size limit.")
                throw NSError(domain: "DueGoodLiveVerifier", code: 5)
            }
        }
        var after = stat()
        var afterNamed = stat()
        guard fstat(fd, &after) == 0, lstat(filePath, &afterNamed) == 0,
              (after.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              after.st_uid == getuid(), (after.st_mode & 0o777) == 0o600,
              after.st_dev == opened.st_dev, after.st_ino == opened.st_ino,
              after.st_size == opened.st_size,
              after.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec,
              after.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec,
              afterNamed.st_dev == opened.st_dev, afterNamed.st_ino == opened.st_ino,
              Int64(data.count) == opened.st_size,
              let expected = try? JSONDecoder().decode(ExpectedDocument.self, from: data),
              expected.schemaVersion == 1, expected.performFullRefresh,
              expected.pages.map(\.id) == liveRoutes.map(\.id),
              expected.pages.count == liveRoutes.count,
              zip(expected.pages, liveRoutes).allSatisfy({ pair in
                  let (page, route) = pair
                  return page.heading == route.heading
                      && (!page.requiredText.isEmpty || page.emptyStateText != nil)
                      && page.requiredText.count <= 100 && page.forbiddenText.count <= 100
              }) else {
            XCTFail("The private expected file schema or identity was invalid.")
            throw NSError(domain: "DueGoodLiveVerifier", code: 6)
        }
        return expected
    }

}
