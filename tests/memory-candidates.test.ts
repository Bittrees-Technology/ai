import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareMemoryCandidates,
  parseMemoryCandidates,
} from "../modules/memory/candidates.js";
const source = {
  requestText: "I prefer short summaries with source links.",
  resultText: "The team may release on Friday; no date is confirmed.",
};
const candidate = {
  type: "preference",
  text: "Prefer short summaries with source links.",
  evidence: [{ source: "request", quote: source.requestText }],
};
const output = (candidates: unknown[]) =>
  JSON.stringify({ version: 1, candidates });
test("memory candidates bind the exact source and remain unapproved model suggestions", () => {
  const prepared = prepareMemoryCandidates(source);
  const result = parseMemoryCandidates(
    output([candidate]),
    source,
    prepared.sourceHash,
  );
  assert.equal(result.candidates[0]!.origin, "model");
  assert.equal(result.candidates[0]!.state, "candidate");
  assert.equal(result.candidates[0]!.verified, false);
  assert.deepEqual(result.candidates[0]!.evidence[0], {
    ...candidate.evidence[0],
    start: 0,
    end: source.requestText.length,
  });
  assert.throws(
    () =>
      parseMemoryCandidates(
        output([candidate]),
        { ...source, resultText: "Changed result" },
        prepared.sourceHash,
      ),
    /SOURCE_CHANGED/,
  );
  assert.deepEqual(
    parseMemoryCandidates(output([]), source, prepared.sourceHash).candidates,
    [],
  );
});
test("candidate validation rejects forged support, authority fields, extra output and oversized batches", () => {
  const hash = prepareMemoryCandidates(source).sourceHash;
  for (const text of [
    output([{ ...candidate, verified: true }]),
    output([
      {
        ...candidate,
        evidence: [{ source: "result", quote: source.requestText }],
      },
    ]),
    output([
      {
        ...candidate,
        evidence: [{ source: "request", quote: "Invented source statement" }],
      },
    ]),
    output([{ ...candidate, type: "permission" }]),
    output([candidate, candidate]),
    output(Array(9).fill(candidate)),
    "```json\n" + output([candidate]) + "\n```",
    output([candidate]) + "extra",
  ])
    assert.throws(
      () => parseMemoryCandidates(text, source, hash),
      /INVALID_OUTPUT/,
    );
  assert.throws(
    () => parseMemoryCandidates("x".repeat(32769), source, hash),
    /CAPACITY/,
  );
  assert.throws(
    () =>
      prepareMemoryCandidates({
        requestText: "é".repeat(8000),
        resultText: "x",
      }),
    /CAPACITY/,
  );
});
test("valid evidence does not prove a paraphrase and cannot grant source authority", () => {
  const hash = prepareMemoryCandidates(source).sourceHash;
  const result = parseMemoryCandidates(
    output([
      {
        type: "fact",
        text: "Incorrect certainty: release is Friday.",
        evidence: [{ source: "result", quote: source.resultText }],
      },
    ]),
    source,
    hash,
  );
  assert.equal(result.candidates[0]!.verified, false);
  assert.equal(result.candidates[0]!.state, "candidate");
  assert.equal("sources" in result.candidates[0]!, false);
  assert.throws(
    () =>
      parseMemoryCandidates(
        output([{ ...candidate, sources: [{ app: "crm" }] }]),
        source,
        hash,
      ),
    /INVALID_OUTPUT/,
  );
});
