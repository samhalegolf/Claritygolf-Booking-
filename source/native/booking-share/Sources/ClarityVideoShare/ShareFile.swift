import Foundation

/// A bounded, ordered temporary file. Never accepts a caller-provided filesystem path.
public final class ShareFile: @unchecked Sendable {
    public let url: URL
    private let condition = NSCondition()
    private var writer: FileHandle?
    private var count = 0
    private var ready = false
    private var failure: Error?
    public static let maxBytes = 2 * 1024 * 1024 * 1024
    public static let maxChunk = 512 * 1024

    public init(name: String, root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("ClarityVideoShares")) throws {
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let clean = name.components(separatedBy: CharacterSet(charactersIn: "/\\:\0")).joined(separator: "-")
        url = directory.appendingPathComponent(String(clean.prefix(180)).isEmpty ? "Clarity-video.mp4" : String(clean.prefix(180)))
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw Self.error("Could not create temporary video.") }
        writer = try FileHandle(forWritingTo: url)
    }

    public func append(_ data: Data, offset: Int) throws {
        condition.lock(); defer { condition.unlock() }
        if let failure { throw failure }
        guard !ready, let writer, offset == count, !data.isEmpty,
              data.count <= Self.maxChunk, count <= Self.maxBytes - data.count else {
            throw Self.error("Video transfer is out of order or exceeds the size limit.")
        }
        try writer.write(contentsOf: data)
        count += data.count
    }

    public func finish(size: Int) throws {
        condition.lock(); defer { condition.unlock() }
        if let failure { throw failure }
        guard !ready, size > 0, count == size else { throw Self.error("Video transfer is incomplete.") }
        try writer?.close()
        writer = nil
        ready = true
        condition.broadcast()
    }

    /// Only called from the system provider's background worker.
    public func wait(timeout: TimeInterval = 900) throws -> URL {
        condition.lock(); defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while !ready && failure == nil {
            if !condition.wait(until: deadline) { throw Self.error("Video preparation timed out.") }
        }
        if let failure { throw failure }
        return url
    }

    public func abort(_ error: Error = NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) {
        condition.lock()
        failure = error
        try? writer?.close()
        writer = nil
        condition.broadcast()
        condition.unlock()
    }

    public func remove() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    static func error(_ text: String) -> NSError {
        NSError(domain: "ClarityVideoShare", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
