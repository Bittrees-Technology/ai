import Foundation
import CryptoKit

@main struct CheckCentralReview {
    static func main() throws {
        let proposals = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
        func resign(_ proposal: [String: Any], mutate: (inout [String: Any]) -> Void) throws -> [String: Any] {
            var result = proposal
            var review = result["review"] as! [String: Any]
            mutate(&review)
            result["review"] = review
            let bytes = try JSONSerialization.data(withJSONObject: review, options: [.sortedKeys, .withoutEscapingSlashes])
            result["digest"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            return result
        }
        for proposal in proposals {
            precondition(CentralReviewDisplay.parse(proposal) != nil, "Native display must accept exact Node proposal, including Unicode/slashes and costs")
            var changed = proposal
            changed["digest"] = String(repeating: "0", count: 64)
            precondition(CentralReviewDisplay.parse(changed) == nil)
            changed = proposal; changed["version"] = true
            precondition(CentralReviewDisplay.parse(changed) == nil, "Boolean version is not integer version")
            let oversized = try resign(proposal) { review in
                var budget = review["budget"] as! [String: Any]; budget["maximumMicroUSD"] = 1000001; review["budget"] = budget
            }
            precondition(CentralReviewDisplay.parse(oversized) == nil, "A correct hash cannot authorize excess spending")
            let mismatch = try resign(proposal) { review in
                var budget = review["budget"] as! [String: Any]; budget["epoch"] = UUID().uuidString.lowercased(); review["budget"] = budget
            }
            precondition(CentralReviewDisplay.parse(mismatch) == nil)
            let misleading = try resign(proposal) { review in
                var scope = review["scope"] as! [String: Any]; scope["workflowId"] = "workflow\nHidden scope"; review["scope"] = scope
            }
            precondition(CentralReviewDisplay.parse(misleading) == nil)
            precondition(CentralReviewDisplay.parse(proposal, now: Date().timeIntervalSince1970 * 1000 + 3600000) == nil)
        }
        print("Native central review matches Node scopes/budgets and rejects tampering, excess costs, mismatches and expiry")
    }
}
