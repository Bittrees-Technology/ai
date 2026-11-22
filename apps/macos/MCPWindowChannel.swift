import Foundation

enum MCPWindowChannel {
    static func receiveSelection() throws -> String? {
        let channel = FileHandle(fileDescriptor:3, closeOnDealloc:false)
        func read(_ count: Int) throws -> Data {
            var bytes = Data()
            while bytes.count < count {
                guard let part = try channel.read(upToCount:count - bytes.count), !part.isEmpty else {
                    throw MCPFailure("The connection window closed unexpectedly.")
                }
                bytes.append(part)
            }
            return bytes
        }
        try channel.write(contentsOf:Data([1]))
        let length = try read(4).reduce(0) { ($0 << 8) | Int($1) }
        guard length <= 160_000 else { throw MCPFailure("Could not open the native connection window.") }
        if length == 0 { return nil }
        guard let result = String(data:try read(length), encoding:.utf8) else { throw MCPFailure("Invalid tool result.") }
        return result
    }
}
