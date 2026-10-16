import { test } from "node:test";
import assert from "node:assert/strict";
import { personUSLocation } from "../modules/research/person-location.js";
test("personal current US evidence, not firm or career evidence", () => {
  const check = (q: string, n = "Paddy Dear", source = q) =>
    personUSLocation(source, n, q);
  assert.equal(
    check("Paddy Dear is based in London. Tetragon has a Boston office."),
    false,
  );
  assert.equal(
    check("Paddy Dear worked in New York before moving to London."),
    false,
  );
  assert.equal(
    check("Stephen Prince is based in New York.", "Paddy Dear"),
    false,
  );
  assert.equal(
    check("Stephen Prince is based in New York.", "Stephen Prince"),
    true,
  );
  assert.equal(
    check(
      "Stephen Prince is based in New York.",
      "Stephen Prince",
      "Stephen Prince is based in London.",
    ),
    false,
  );
  assert.equal(
    check(
      "Stephen Prince is based in New York.",
      "Stephen Prince",
      "Stephen Prince is based in New York. Stephen Prince is based in London.",
    ),
    false,
  );
  assert.equal(check("Paddy Dear is not based in New York."), false);
  assert.equal(check("Paddy Dear was based in New York."), false);
  assert.equal(
    check(
      "Paddy Dear is based in New York.",
      "Paddy Dear",
      "Company is based in New York.",
    ),
    false,
  );
});
