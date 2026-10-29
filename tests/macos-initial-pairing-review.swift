import Foundation

@main struct CheckInitialPairingReview {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let proposal = fixture["proposal"] as! [String: Any], expected = fixture["expected"] as! [String: String]
        let now = fixture["now"] as! Double
        func parse(_ p: [String: Any], principal: String? = nil, local: String? = nil, source: String? = nil, at: Double? = nil) -> InitialPairingReviewDisplay? {
            InitialPairingReviewDisplay.parse(p, expectedPrincipal: principal ?? expected["principal"]!, expectedKeyFingerprint: local ?? expected["keyFingerprint"]!, expectedRolesKeyFingerprint: source ?? expected["rolesKeyFingerprint"]!, now: at ?? now)
        }
        let good = parse(proposal)
        precondition(good != nil, "Actual Node review digest must match Swift")
        precondition(Set(good!.confirmation(now: now)!.keys) == Set(["reviewId", "digest"]), "Native confirmation never supplies editable scope")
        precondition(good!.summary.contains("$0") && good!.summary.contains("62 requests"), "Display includes the exact enforced limits")
        for item in fixture["invalid"] as! [[String: Any]] {
            precondition(parse(item["proposal"] as! [String: Any]) == nil, "Reject negative fixture \(item["name"]!)")
        }
        precondition(parse(proposal, source: String(repeating: "f", count: 64)) == nil, "Expected source binding is independent")
        precondition(parse(proposal, local: String(repeating: "e", count: 64)) == nil, "Expected local binding is independent")
        precondition(parse(proposal, principal: "agent:" + UUID().uuidString.lowercased()) == nil, "Expected principal is independent")
        precondition(parse(proposal, at: now - 1) == nil, "Clock rollback cannot extend the original five minutes")
        precondition(parse(proposal, at: good!.expiresAt) == nil, "Expired review cannot be confirmed")
        precondition(good!.confirmation(now: good!.expiresAt) == nil, "Confirmation itself rechecks expiry")
        precondition(good!.confirmation(now: now - 1) == nil, "Confirmation itself rejects clock rollback")
        print("Native initial pairing review: Node/Swift digest, 17 invalid proposals including re-digested scope changes, independent bindings, expiry and narrow confirmation passed")
    }
}
