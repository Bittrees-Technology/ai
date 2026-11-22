import Foundation

@main struct MCPChannelFixture {
    static func main() throws {
        // The parent runs this in the loopback-only app sandbox with the real
        // window channel and substitutes an operator-selected result for the UI.
        let first = try MCPWindowChannel.receiveSelection()
        precondition(first == "local fixture result")
        let closed = try MCPWindowChannel.receiveSelection()
        precondition(closed == nil)
        print("Guarded Mac received the selected result and handled a closed window.")
    }
}
