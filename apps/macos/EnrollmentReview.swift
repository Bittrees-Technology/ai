import Foundation
import CryptoKit

struct EnrollmentReviewDisplay {
    let digest: String
    let wallet: String
    let device: String
    let workspace: String
    let authority: String
    let principal: String
    let publicKey: String
    let expiresAt: Double
    static func parse(_ proposal: [String: Any]) -> EnrollmentReviewDisplay? {
        guard let digest = proposal["digest"] as? String,
                  digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let review = proposal["review"] as? [String: Any], let disclosure = proposal["disclosure"] as? [String: Any],
                  let serialized = try? JSONSerialization.data(withJSONObject: ["review": review, "disclosure": disclosure], options: [.sortedKeys, .withoutEscapingSlashes]),
                  SHA256.hash(data: serialized).map({ String(format: "%02x", $0) }).joined() == digest,
                  Set(review.keys) == Set(["epoch", "expiresAt", "authorityId", "deviceId", "sourceWorkspace", "principal", "publicKey", "ownerWallet"]),
                  let authority = review["authorityId"] as? String, UUID(uuidString: authority) != nil,
                  let epoch = review["epoch"] as? String, UUID(uuidString: epoch) != nil,
                  let principal = review["principal"] as? String, principal.hasPrefix("agent:"), UUID(uuidString: String(principal.dropFirst(6))) != nil,
                  let publicKey = review["publicKey"] as? String, publicKey.count <= 300, publicKey.hasPrefix("-----BEGIN PUBLIC KEY-----"),
                  let wallet = review["ownerWallet"] as? String, wallet.range(of: "^0x[a-f0-9]{40}$", options: .regularExpression) != nil,
                  let device = review["deviceId"] as? String, UUID(uuidString: device) != nil,
                  let workspace = review["sourceWorkspace"] as? String, UUID(uuidString: workspace) != nil,
                  let expiry = review["expiresAt"] as? Double,
                  expiry > Date().timeIntervalSince1970 * 1000, expiry <= Date().timeIntervalSince1970 * 1000 + 300000,
                  disclosure["hosts"] as? [String] == ["ai.bittrees.org", "roles.bittrees.org"],
                  disclosure["operations"] as? [String] == ["heartbeat", "start", "poll", "attest", "complete"],
                  disclosure["maximumDurationSeconds"] as? Int == 300,
                  disclosure["maximumCalls"] as? Int == 108,
                  disclosure["maximumPolls"] as? Int == 100,
                  disclosure["additionalSpendingUSD"] as? Int == 0,
                  disclosure["grantsWorkflowAuthority"] as? Bool == false else { return nil }
        return EnrollmentReviewDisplay(digest: digest, wallet: wallet, device: device, workspace: workspace, authority: authority, principal: principal, publicKey: publicKey, expiresAt: expiry)
    }
}
