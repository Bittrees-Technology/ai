import Foundation
import CryptoKit

@main struct CheckEnrollmentReview {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let proposal = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(EnrollmentReviewDisplay.parse(proposal) != nil, "Node proposal digest must match native Swift")
        var changed = proposal
        var review = proposal["review"] as! [String: Any]
        review["deviceId"] = UUID().uuidString.lowercased()
        changed["review"] = review
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Changed device must invalidate displayed approval")
        changed = proposal
        var disclosure = proposal["disclosure"] as! [String: Any]
        disclosure["hosts"] = ["other.example"]
        changed["disclosure"] = disclosure
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Changed destination must invalidate approval")
        changed = proposal
        changed["digest"] = String(repeating: "0", count: 64)
        precondition(EnrollmentReviewDisplay.parse(changed) == nil, "Wrong digest must fail")
        func repin(_ disclosure: [String: Any]) throws -> [String: Any] {
            var value = proposal
            value["disclosure"] = disclosure
            let bytes = try JSONSerialization.data(withJSONObject: ["review": proposal["review"]!, "disclosure": disclosure], options: [.sortedKeys, .withoutEscapingSlashes])
            value["digest"] = SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined()
            return value
        }
        let original = proposal["disclosure"] as! [String: Any]
        if original["costBasis"] != nil {
            precondition(EnrollmentReviewDisplay.parse(proposal)!.spendingSummary.contains("US$1"))
            for change: [String: Any] in [
                ["maximumAdditionalMicroUSD": 1000001], ["maximumAdditionalMicroUSD": true],
                ["costBasis": "verified-included-usage"], ["limitScope": "per-helper"],
                ["maximumAggregateAttempts": 241], ["approvalReference": ""],
                ["approvalExpiresAt": 1], ["additionalSpendingUSD": 0],
            ] {
                let altered = try repin(original.merging(change) { _, new in new })
                precondition(EnrollmentReviewDisplay.parse(altered) == nil,
                             "Rehashed malformed or misleading paid disclosure must fail")
            }
        } else {
            for value: Any in [1, false] {
                var disclosure = original; disclosure["additionalSpendingUSD"] = value
                let altered = try repin(disclosure)
                precondition(EnrollmentReviewDisplay.parse(altered) == nil, "Included usage must remain exactly zero")
            }
        }
        print("Native review accepts Node digest and rejects changed identity, host and digest")
    }
}
