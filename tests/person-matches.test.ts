import { test } from "node:test";
import assert from "node:assert/strict";
import {
  possibleSamePerson,
  personMatches,
} from "../modules/research/person-matches.js";
test("holds middle initials, credentials, accents and typographical variants", () => {
  for (const [a, b] of [
    ["Christopher S. Calicott", "Christopher Calicott"],
    ["Paul Chew, CFA", "Paul Chew"],
    ["Dr. José O’Neill, MBA", "Jose O'Neill"],
    ["Jane Anne Smith", "Jane A. Smith"],
    ["J. Smith", "Jane Smith"],
    ["  PAUL  CHEW ", "Paul Chew"],
  ]) {
    assert.equal(possibleSamePerson(a!, b!), true, `${a} vs ${b}`);
    assert.equal(possibleSamePerson(b!, a!), true);
  }
});
test("does not collapse different given names, full middle names, generations or single names", () => {
  for (const [a, b] of [
    ["John Smith", "James Smith"],
    ["Jane Anne Smith", "Jane Beth Smith"],
    ["John Smith Jr.", "John Smith Sr."],
    ["John Smith Jr.", "John Smith"],
    ["Ann Marie Jones", "Anne Jones"],
    ["Smith", "Jane Smith"],
    ["", ""],
  ])
    assert.equal(possibleSamePerson(a!, b!), false, `${a} vs ${b}`);
});
test("same ID is an idempotent retry, organizations are not person matches", () => {
  const candidate = { id: "one", name: "Paul Chew" };
  assert.deepEqual(
    personMatches(candidate, [
      { ...candidate, kind: "people" },
      { id: "two", name: "Paul Chew CFA", kind: "organizations" },
    ]),
    [],
  );
  assert.equal(
    personMatches(candidate, [
      { id: "three", kind: "people", name: "Paul Chew, CFA" },
    ]).length,
    1,
  );
});
