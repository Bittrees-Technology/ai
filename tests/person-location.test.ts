import { test } from "node:test";
import assert from "node:assert/strict";
import {
  personUSLocation,
  recoverPersonLocation,
} from "../modules/research/person-location.js";
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

test("named individual directory cards qualify without borrowing company addresses", () => {
  const quote =
    "3 Jeb Belford 11 Managing Director Chief Investment Officer New York, NY";
  assert.equal(
    personUSLocation(
      quote,
      "Jeb Belford",
      quote,
      "Managing Director Chief Investment Officer",
    ),
    true,
  );
  for (const q of [
    "Jeb Belford Chief Investment Officer. Our headquarters is in New York, NY",
    "Jeb Belford Chief Investment Officer Mary Jones New York, NY",
    "Mary Jones Chief Investment Officer New York, NY",
  ])
    assert.equal(
      personUSLocation(q, "Jeb Belford", q, "Chief Investment Officer"),
      false,
    );
  assert.equal(
    personUSLocation(
      quote + " Jeb Belford is based in London.",
      "Jeb Belford",
      quote,
      "Managing Director Chief Investment Officer",
    ),
    false,
  );
});

test("recover only a whole literal named card, never an office or another person", () => {
  const card =
    "Jeb Belford 11 Managing Director Chief Investment Officer New York, NY";
  assert.equal(
    recoverPersonLocation(card, "Jeb Belford", "Chief Investment Officer"),
    card,
  );
  assert.equal(
    personUSLocation(card, "Jeb Belford", card, "Chief Investment Officer"),
    true,
  );
  assert.equal(
    recoverPersonLocation(
      "Jane Smith Chief Investment Officer. Boston, MA headquarters",
      "Jane Smith",
      "Chief Investment Officer",
    ),
    undefined,
  );
  assert.equal(
    recoverPersonLocation(
      "Jane Smith Chief Investment Officer Boston, MA headquarters",
      "Jane Smith",
      "Chief Investment Officer",
    ),
    undefined,
  );
  assert.equal(
    recoverPersonLocation(card, "Jane Smith", "Chief Investment Officer"),
    undefined,
  );
  assert.equal(
    recoverPersonLocation(
      card + " Jeb Belford is based in London.",
      "Jeb Belford",
      "Chief Investment Officer",
    ),
    undefined,
  );
});
