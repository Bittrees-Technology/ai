import Foundation

// Main-thread state shared by menu actions and owned-process callbacks.
// No process may overlap the live engine and an offline recovery operation.
struct RecoveryLifecycle {
    enum Phase { case idle, stoppingEngine, recovering }
    enum AfterStop: Equatable { case recover, quit, ignore }
    private(set) var phase: Phase = .idle
    private(set) var arguments: [String] = []
    private(set) var quitRequested = false
    var busy: Bool { phase != .idle }

    mutating func begin(backup: URL?) -> Bool {
        guard !busy, !quitRequested, backup == nil || backup!.isFileURL else { return false }
        arguments = backup.map { ["--backup", $0.path, "--confirm"] } ?? ["--previous", "--confirm"]
        phase = .stoppingEngine
        return true
    }
    mutating func engineStopped() -> AfterStop {
        guard phase == .stoppingEngine else { return .ignore }
        if quitRequested { phase = .idle; arguments = []; return .quit }
        phase = .recovering
        return .recover
    }
    // A false result means a pending Quit should complete, without restarting.
    mutating func finished() -> Bool {
        guard phase == .recovering else { return false }
        phase = .idle
        arguments = []
        return !quitRequested
    }
    mutating func requestQuit() -> Bool {
        guard busy else { return false }
        quitRequested = true
        return true
    }
}
