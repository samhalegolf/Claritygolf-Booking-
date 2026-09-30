import CoreMotion
import Foundation
import PuttingLabCore

/// Core Motion, reduced to the one reading the lab uses. Setup help and a
/// movement tripwire only: the measurement frame comes from the template.
/// Device motion needs no permission prompt.
final class PuttingMotionMonitor {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var latestAttitude: DeviceAttitude?

    init() {
        queue.name = "app.claritygolf.putting.motion"
        queue.maxConcurrentOperationCount = 1
    }

    var isAvailable: Bool { manager.isDeviceMotionAvailable }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 60
        manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] motion, _ in
            guard let self, let motion else { return }
            let q = motion.attitude.quaternion
            let g = motion.gravity
            let attitude = DeviceAttitude(w: q.w, x: q.x, y: q.y, z: q.z, gravity: Vec3(g.x, g.y, g.z))
            self.lock.lock()
            self.latestAttitude = attitude
            self.lock.unlock()
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }

    /// The most recent attitude, or nil before the first update.
    var attitude: DeviceAttitude? {
        lock.lock()
        defer { lock.unlock() }
        return latestAttitude
    }
}
