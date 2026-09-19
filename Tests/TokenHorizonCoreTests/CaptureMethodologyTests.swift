import XCTest
@testable import TokenHorizonCore

/// The capture methodology is one knob with three sources: point meters,
/// MITM interception, or provider session files. point/mitm always annotate
/// from files; files mode makes the scanners the counting source.
final class CaptureMethodologyTests: XCTestCase {

    func testAllCasesIncludeFiles() {
        XCTAssertEqual(Set(MeterCaptureMode.allCases), [.point, .mitm, .files])
    }

    func testRawValuesMatchGoDaemonContract() {
        // The Go daemon (daemon/) and the settings.json captureMethodology
        // key share these exact spellings.
        XCTAssertEqual(MeterCaptureMode.point.rawValue, "point")
        XCTAssertEqual(MeterCaptureMode.mitm.rawValue, "mitm")
        XCTAssertEqual(MeterCaptureMode.files.rawValue, "files")
        XCTAssertEqual(MeterCaptureMode(rawValue: "files"), .files)
    }

    func testFilesModeForcesFilePolling() {
        // In the files methodology the scanners ARE the counting source —
        // polling cannot be off. The getter forces it on.
        let store = SettingsStore.shared
        let previous = store.meterCaptureMode
        defer { store.meterCaptureMode = previous }
        store.meterCaptureMode = .files
        XCTAssertTrue(store.filePolling)
        store.meterCaptureMode = .point
    }

    func testMethodologyPersistsUnderCaptureMethodologyKey() {
        let store = SettingsStore.shared
        let previous = store.meterCaptureMode
        defer { store.meterCaptureMode = previous }
        store.meterCaptureMode = .files
        let path = Platform.paths.configDirectory.appendingPathComponent("settings.json").path
        let obj = (try? JSONSerialization.jsonObject(
            with: Data(contentsOf: URL(fileURLWithPath: path)))) as? [String: Any]
        XCTAssertEqual(obj?["captureMethodology"] as? String, "files")
        store.meterCaptureMode = previous
    }
}
