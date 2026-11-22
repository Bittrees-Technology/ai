import Foundation

@main struct MCPClientTests {
    @MainActor static func main() async throws {
        let root = CommandLine.arguments[1]
        for invalid in ["http://example.com/mcp", "https://user:pass@example.com", "https://example.com/?token=secret", "file:///tmp/mcp"] {
            precondition((try? MCPClient.endpointURL(invalid)) == nil)
        }
        func connection(_ route: String) throws -> MCPClient {
            try MCPClient(endpoint: MCPClient.endpointURL(root + route), token:"fixture-token")
        }
        let publicClient = try MCPClient(endpoint: MCPClient.endpointURL(root + "/public"), token: "")
        let publicTools = try await publicClient.discover()
        precondition(publicTools.count == 2)
        publicClient.close()
        let anonymous = try MCPClient(endpoint: MCPClient.endpointURL(root + "/private"), token: "")
        do { _ = try await anonymous.discover(); preconditionFailure("Expected a token prompt") }
        catch is MCPAccessDenied { anonymous.close() }
        for mode in ["/json", "/stream", "/private"] {
            let client = try connection(mode)
            let tools = try await client.discover()
            precondition(tools.map(\.name) == ["echo", "fail"])
            let text = try await client.call("echo", arguments:["message":"olá"])
            precondition(text.contains("olá"))
            do { _ = try await client.call("unknown", arguments:[:]); preconditionFailure() } catch {}
            do { _ = try await client.call("fail", arguments:[:]); preconditionFailure() }
            catch { precondition(error.localizedDescription.contains("tool reported an error")) }
            client.close()
        }
        for (route, message) in [("/redirect","redirected"),("/wrong-id","did not match"),("/denied","Access denied")] {
            let client = try connection(route)
            do { _ = try await client.discover(); preconditionFailure() }
            catch { precondition(error.localizedDescription.contains(message)) }
            client.close()
        }
        print("MCP HTTP JSON, streamed results, token and session binding, pagination, calls, error and denial checks passed.")
    }
}
