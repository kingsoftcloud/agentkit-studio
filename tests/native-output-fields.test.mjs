// Tests for the explicit JSON object field compiler.
//
// Derived from the pinned reference test
// ``tests/studio/test_native_explicit_output_fields.py`` at commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3. The parent-owned subagent runtime
// cases (child rejecting extra fields, sealed child adoption) are not ported;
// only the pure field-declaration compiler and its schema integration are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredObjectFields } from "../src/providers/native-output-fields.mjs";
import {
  jsonObjectSubmissionSchema,
  finalShapeContractDescription,
  requestedFinalShape,
} from "../src/providers/native-final-shape.mjs";

// ``structuredJsonClauses`` strips list markers and trailing sentence
// terminators before the clause reaches declaredObjectFields; these inputs
// mirror that already-extracted clause text.
function clause(goal) {
  // Reuse the real pipeline to obtain the clauses declaredObjectFields sees.
  return jsonObjectSubmissionSchema(goal).properties.output;
}

test("declaredObjectFields compiles explicit key sets (direct)", () => {
  assert.deepEqual(
    declaredObjectFields([
      ["json_object", "最后只返回 JSON 对象，键为 readings 和 aggregate；readings 的每项键为 code、offset、ref"],
    ]),
    ["aggregate", "readings"]
  );
  assert.deepEqual(
    declaredObjectFields([["json_object", '请仅输出一个 JSON 对象，字段为 "状态"、`count`']]),
    ["count", "状态"]
  );
  assert.deepEqual(
    declaredObjectFields([["json_object", "只返回 JSON 对象，键为 alpha, beta"]]),
    ["alpha", "beta"]
  );
  assert.deepEqual(
    declaredObjectFields([["json_object", "只返回 JSON 对象，键为 singular"]]),
    ["singular"]
  );
  assert.deepEqual(
    declaredObjectFields([["json_object", "最后只返回 JSON 对象，键为 alpha 和 beta"]]),
    ["alpha", "beta"]
  );
  assert.deepEqual(
    declaredObjectFields([["json_object", "请仅输出 JSON 对象，字段为 alpha、beta"]]),
    ["alpha", "beta"]
  );
});

test("declaredObjectFields returns null on no clauses or non-object shape", () => {
  assert.equal(declaredObjectFields([]), null);
  assert.equal(declaredObjectFields([["json_array", "仅输出 JSON 数组"]]), null);
});

test("parent contract freezes explicit fields, not values (integration)", () => {
  const cases = [
    [
      "最后只返回 JSON 对象，键为 readings 和 aggregate；readings 的每项键为 code、offset、ref。",
      new Set(["readings", "aggregate"]),
    ],
    ['请仅输出一个 JSON 对象，字段为 "状态"、`count`。', new Set(["状态", "count"])],
    ["只返回 JSON 对象，键为 alpha, beta。", new Set(["alpha", "beta"])],
    ["只返回 JSON 对象，键为 singular。", new Set(["singular"])],
    ["5. 最后只返回 JSON 对象，键为 alpha 和 beta。", new Set(["alpha", "beta"])],
    ["2) 请仅输出 JSON 对象，字段为 alpha、beta。", new Set(["alpha", "beta"])],
  ];
  for (const [goal, keys] of cases) {
    const inner = clause(goal);
    assert.deepEqual(new Set(Object.keys(inner.properties)), keys, JSON.stringify(goal));
    assert.deepEqual(new Set(inner.required), keys, JSON.stringify(goal));
    assert.equal(inner.additionalProperties, false, JSON.stringify(goal));
    for (const v of Object.values(inner.properties)) assert.deepEqual(v, {}, JSON.stringify(goal));
  }
});

test("ambiguous or example fields do not become authority", () => {
  const goals = [
    "最后只返回 JSON 对象，键为 alpha 和 alpha。",
    "最后只返回 JSON 对象，键为 alpha 和可能有 beta。",
    "最后只返回 JSON 对象，键为 alpha 或 beta。",
    "最后只返回 JSON 对象，键为 alpha，允许其他字段。",
    "最后只返回 JSON 对象，键为 alpha；允许其他字段。",
    "最后只返回 JSON 对象，键为 alpha；不要限制任何字段。",
    "最后只返回 JSON 对象，键为 alpha；beta 的每项键为 code。",
    "只返回 JSON 对象，键为 alpha。只返回 JSON 对象，键为 beta。",
    '最后只返回 JSON 对象，格式为 {"alpha":42}。',
  ];
  for (const goal of goals) {
    const inner = clause(goal);
    assert.equal(inner.required, undefined, JSON.stringify(goal));
    assert.equal(inner.additionalProperties, undefined, JSON.stringify(goal));
  }
});

test("quoted or negated directives are not compiled into a shape rule", () => {
  const goals = [
    "不要最后只返回 JSON 对象，键为 alpha。",
    "解释“最后只返回 JSON 对象，键为 alpha”这句话。",
    "```text\n最后只返回 JSON 对象，键为 alpha。\n```\n解释引用。",
    "> 最后只返回 JSON 对象，键为 alpha。",
    "5. 不要最后只返回 JSON 对象，键为 alpha。",
    "5. 解释“最后只返回 JSON 对象，键为 alpha”这句话。",
    "> 5. 最后只返回 JSON 对象，键为 alpha。",
  ];
  for (const goal of goals) {
    // The parent sets final_submission_schema to None when no shape is
    // recognized; that corresponds to requestedFinalShape being null here.
    assert.equal(requestedFinalShape(goal), null, JSON.stringify(goal));
  }
});

test("full goal is compiled for fields before its description is bounded", () => {
  const goal = "只返回 JSON 对象，键为 alpha 和 beta。" + "保持来源准确。".repeat(300);
  const inner = clause(goal);
  assert.deepEqual(new Set(inner.required), new Set(["alpha", "beta"]));
  assert.ok(finalShapeContractDescription(goal).length <= 1024);
});

test("declaredObjectFields is pure: repeated calls return independent arrays", () => {
  const a = declaredObjectFields([["json_object", "只返回 JSON 对象，键为 alpha, beta"]]);
  const b = declaredObjectFields([["json_object", "只返回 JSON 对象，键为 alpha, beta"]]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  a.push("mutated");
  assert.equal(b.includes("mutated"), false);
});
