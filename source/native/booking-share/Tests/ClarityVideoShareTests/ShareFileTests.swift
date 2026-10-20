import XCTest
@testable import ClarityVideoShare

final class ShareFileTests: XCTestCase {
    func testOrderedVideoBecomesAvailableOnlyWhenComplete() throws {
        let file = try ShareFile(name: "../swing.mp4")
        defer { file.remove() }
        XCTAssertEqual(file.url.lastPathComponent, "..-swing.mp4")
        try file.append(Data("video".utf8), offset: 0)
        XCTAssertThrowsError(try file.finish(size: 9))
        try file.finish(size: 5)
        XCTAssertEqual(try Data(contentsOf: file.wait(timeout: 1)), Data("video".utf8))
        XCTAssertThrowsError(try file.append(Data([1]), offset: 5))
    }
    func testRejectsUnorderedAndOversizedChunks() throws {
        let file = try ShareFile(name: "swing.mp4")
        defer { file.abort(); file.remove() }
        XCTAssertThrowsError(try file.append(Data([1]), offset: 1))
        XCTAssertThrowsError(try file.append(Data(repeating: 0, count: ShareFile.maxChunk + 1), offset: 0))
        XCTAssertThrowsError(try file.finish(size: 0))
    }
    func testCancellationWakesWaitingProvider() throws {
        let file = try ShareFile(name: "swing.mp4")
        defer { file.remove() }
        let done = expectation(description: "provider cancelled")
        DispatchQueue.global().async {
            XCTAssertThrowsError(try file.wait(timeout: 2))
            done.fulfill()
        }
        file.abort()
        wait(for: [done], timeout: 3)
        XCTAssertThrowsError(try file.append(Data([1]), offset: 0))
    }
}
