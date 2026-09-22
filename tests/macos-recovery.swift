import Foundation

@main
struct RecoveryLifecycleTests {
    static func main() {
        var flow = RecoveryLifecycle()
        precondition(!flow.busy)
        precondition(flow.engineStopped() == .ignore)
        precondition(!flow.finished())
        precondition(!flow.begin(backup: URL(string: "https://example.com/backup.aib")))
        precondition(!flow.busy)
        let file = URL(fileURLWithPath: "/tmp/backup with spaces;$(literal).aib")
        precondition(flow.begin(backup: file))
        precondition(flow.arguments == ["--backup", file.path, "--confirm"])
        precondition(flow.phase == .stoppingEngine)
        precondition(!flow.begin(backup: nil))
        precondition(!flow.finished()) // Must not restart before the owned engine exits.
        precondition(flow.engineStopped() == .recover)
        precondition(flow.phase == .recovering)
        precondition(flow.engineStopped() == .ignore) // Duplicate/stale exit cannot launch twice.
        precondition(!flow.begin(backup: nil))
        precondition(flow.finished()) // Both CLI success and failure return through this gate.
        precondition(flow.arguments.isEmpty && !flow.busy)
        precondition(flow.begin(backup: nil))
        precondition(flow.arguments == ["--previous", "--confirm"])
        precondition(flow.requestQuit())
        precondition(flow.engineStopped() == .quit) // Quit before recovery skips the command.
        precondition(flow.arguments.isEmpty && !flow.busy)
        precondition(!flow.begin(backup: nil))

        var running = RecoveryLifecycle()
        precondition(!running.requestQuit()) // Ordinary Quit belongs to engine shutdown.
        precondition(running.begin(backup: nil))
        precondition(running.engineStopped() == .recover)
        precondition(running.requestQuit())
        precondition(running.phase == .recovering) // Do not terminate an in-progress restore.
        precondition(!running.finished()) // Finish Quit instead of restarting the engine.
        precondition(!running.busy && running.arguments.isEmpty)
        var kit = RecoveryLifecycle()
        precondition(kit.beginKit(engineRunning: false))
        precondition(kit.phase == .recovering && kit.arguments.isEmpty)
        precondition(!kit.beginKit(engineRunning: true))
        precondition(kit.engineStopped() == .ignore)
        precondition(kit.finished())
        precondition(kit.beginKit(engineRunning: true))
        precondition(kit.phase == .stoppingEngine)
        precondition(kit.requestQuit())
        precondition(kit.engineStopped() == .quit)
        var kitRunning = RecoveryLifecycle()
        precondition(kitRunning.beginKit(engineRunning: false))
        precondition(kitRunning.requestQuit())
        precondition(!kitRunning.finished())
        print("Mac recovery lifecycle: sequencing, duplicate denial, literal arguments, and Quit checks passed")
    }
}
