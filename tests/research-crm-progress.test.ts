import { test } from "node:test";
import assert from "node:assert/strict";
import { crmProgress } from "../modules/research/crm-progress.js";
test("research saves do not imply CRM additions; only source mappings count", () => {
  const entries = [
    { id: "p", kind: "people" },
    { id: "o", kind: "organizations" },
    { id: "held", kind: "people" },
  ];
  assert.equal(crmProgress({ entries }).crmPeople, 0);
  const progress = crmProgress({
    entries,
    links: [
      { entryId: "o", status: "available" },
      { entryId: "held", status: "unavailable" },
    ],
    submissions: [
      {
        status: "awaiting_review",
        mappings: [{ entryId: "held", recordId: "x" }],
      },
      {
        status: "reviewed",
        mappings: [
          { entryId: "p", recordId: "r" },
          { entryId: "p", recordId: "r" },
        ],
      },
    ],
  });
  assert.equal(progress.researchPeople, 2);
  assert.equal(progress.crmPeople, 1);
  assert.equal(progress.crmOrganizations, 1);
  assert.deepEqual(progress.entryIds, ["o", "p"]);
});
