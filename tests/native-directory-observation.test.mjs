// Tests for the pure Native directory model observation helper.
//
// Derived from the pinned reference tests
// ``tests/studio/test_native_directory_observation.py``,
// ``tests/studio/test_native_directory_scope.py`` and
// ``tests/studio/test_native_directory_policy_build.py`` at commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3. The ExecutionSpec/AgentSpec contract
// assertions and the real-filesystem/archive integration tests are not
// portable to this pure module (the parent owns host wiring, archive I/O and
// source capacity) and are intentionally omitted. Deterministic assertions
// only; no Python execution.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTORY_OBSERVATION_POLICY,
  DIRECTORY_MODEL_DESCRIPTION,
  DIRECTORY_SCOPE_MODEL_DESCRIPTION,
  directoryFeedbackDigest,
  directoryModelReply,
} from "../src/providers/native-directory-observation.mjs";

const V1 = "studio-directory-observation/v1";
const V2 = "studio-directory-observation/v2";
const V3 = "studio-directory-observation/v3";
const POLICY_INVALID = "native_directory_observation_policy_invalid";

function assertPolicyInvalid(fn) {
  assert.throws(
    () => fn(),
    (err) => err instanceof Error && err.message === POLICY_INVALID,
    `expected ${POLICY_INVALID}`,
  );
}

// Reference ``listing(count)``. size is a JS number; mtime_ns stays within
// Number.MAX_SAFE_INTEGER so the sort-value assertions survive JSON round-trip
// (large bigint precision is covered separately below).
function listing(count = 500) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const name = `part-${String(i).padStart(4, "0")}.py`;
    entries.push({
      path: `evidence/目录/${name}`,
      name,
      type: "file",
      size: i + 123,
      mtime_ns: 1792000000 + i,
    });
  }
  return {
    ok: true,
    path: "evidence",
    recursive: true,
    truncated: true,
    entries,
  };
}

// --- exported description constants ------------------------------------------

test("description constants match the reference strings exactly", () => {
  assert.equal(DIRECTORY_OBSERVATION_POLICY, "studio-directory-observation/v1");
  assert.equal(
    DIRECTORY_MODEL_DESCRIPTION,
    " Use glob to find filenames directly (for example '**/*.py'); narrow path " +
      "before recursive listing. Native returns a bounded path view with explicit " +
      "omissions; the saved complete result retains entry metadata. Sorting by " +
      "size or mtime also exposes that sort value.",
  );
  assert.equal(
    DIRECTORY_SCOPE_MODEL_DESCRIPTION,
    DIRECTORY_MODEL_DESCRIPTION +
      " glob filters the selected entries; it does not enable recursion. " +
      "Set recursive=true to search nested directories, including with '**/*.py'. " +
      "An empty nonrecursive listing describes only immediate children.",
  );
  // v3 descriptions are tagged with the "does not enable recursion" note.
  assert.ok(DIRECTORY_SCOPE_MODEL_DESCRIPTION.includes("does not enable recursion"));
  assert.ok(!DIRECTORY_MODEL_DESCRIPTION.includes("does not enable recursion"));
});

// --- directoryFeedbackDigest -------------------------------------------------

test("directoryFeedbackDigest produces sha256: + 64 lowercase hex", () => {
  assert.match(directoryFeedbackDigest(32768), /^sha256:[0-9a-f]{64}$/);
});

test("directoryFeedbackDigest defaults to v1 and is deterministic", () => {
  assert.equal(directoryFeedbackDigest(32768), directoryFeedbackDigest(32768));
  assert.equal(
    directoryFeedbackDigest(32768),
    directoryFeedbackDigest(32768, { policy: V1 }),
  );
});

test("directoryFeedbackDigest differs across policies and result bytes", () => {
  assert.notEqual(directoryFeedbackDigest(32768), directoryFeedbackDigest(32768, { policy: V2 }));
  assert.notEqual(directoryFeedbackDigest(32768), directoryFeedbackDigest(32768, { policy: V3 }));
  assert.notEqual(directoryFeedbackDigest(1024), directoryFeedbackDigest(32768));
  assert.notEqual(directoryFeedbackDigest(1024, { policy: V2 }), directoryFeedbackDigest(1024, { policy: V3 }));
});

test("directoryFeedbackDigest rejects unknown policy", () => {
  assertPolicyInvalid(() => directoryFeedbackDigest(32768, { policy: "bad" }));
  assertPolicyInvalid(() =>
    directoryFeedbackDigest(32768, { policy: "studio-directory-observation/v4" }),
  );
});

// --- directoryModelReply: projection preserves order, omissions, sort values

for (const sort of ["name", "size", "mtime"]) {
  test(`projection preserves order/omissions/sort for sort_by=${sort}`, () => {
    const raw = listing(500);
    const original = structuredClone(raw);
    const reply = directoryModelReply(raw, { sort_by: sort }, { resultBytes: 32768 });
    const view = JSON.parse(reply);
    const content = view.content;
    const paths = content.paths;

    assert.ok(paths.length > 0 && paths.length <= 100);
    const expectedPaths = raw.entries.slice(0, paths.length).map((e) => e.path);
    if (sort === "name") {
      assert.deepEqual(paths, expectedPaths);
    } else {
      assert.deepEqual(
        paths.map((p) => p.path),
        expectedPaths,
      );
      const field = sort === "size" ? "size" : "mtime_ns";
      assert.deepEqual(
        paths.map((p) => p[field]),
        raw.entries.slice(0, paths.length).map((e) => e[field]),
      );
      // name sort never exposes size/mtime_ns; size/mtime never expose the other.
      const other = sort === "size" ? "mtime_ns" : "size";
      assert.ok(!reply.includes(`"${other}"`));
    }
    if (sort === "name") {
      assert.ok(!reply.includes("mtime_ns") && !reply.includes('"size"'));
    }
    assert.equal(content.returned_entries, 500);
    assert.equal(content.shown_entries + content.omitted_entries, 500);
    assert.equal(content.result_truncated, true);
    assert.deepEqual(raw, original);
  });
}

test("directory names unicode and empty results are not fabricated", () => {
  const raw = listing(1);
  raw.entries[0].path = 'evidence/引号"\n目录';
  raw.entries[0].type = "directory";
  const original = structuredClone(raw);
  const reply = directoryModelReply(raw, {}, { resultBytes: 1024 });
  const view = JSON.parse(reply);
  assert.deepEqual(view.content.paths, ['evidence/引号"\n目录/']);
  assert.deepEqual(raw, original);

  const empty = JSON.parse(directoryModelReply(listing(0), {}, { resultBytes: 1024 }));
  assert.equal(empty.content.returned_entries, 0);
  assert.equal(empty.content.omitted_entries, 0);
  assert.equal(empty.content.shown_entries, 0);
});

// --- v2 recursive overview ---------------------------------------------------

test("recursive overview keeps observed sibling directories outside path prefix", () => {
  for (const byteCap of [2048, 32768]) {
    const raw = listing(180);
    raw.path = "evidence";
    raw.entries = [
      { path: "evidence/aaa", type: "directory" },
      ...Array.from({ length: 175 }, (_, i) => ({
        path: `evidence/aaa/deep/file-${String(i).padStart(4, "0")}.py`,
        type: "file",
      })),
      { path: "evidence/late", type: "directory" },
      { path: "evidence/late/sub", type: "directory" },
      { path: "evidence/last.py", type: "file" },
    ];
    const before = structuredClone(raw);
    const reply = directoryModelReply(
      raw,
      { path: "evidence", recursive: true },
      { resultBytes: byteCap, policy: V2 },
    );
    const content = JSON.parse(reply).content;

    assert.deepEqual(content.observed_child_directories, ["evidence/aaa/", "evidence/late/"]);
    assert.ok(!content.paths.includes("evidence/late/"));
    assert.equal(content.child_directories_omitted, 0);
    assert.equal(content.child_directory_scope, "returned entries only; listing truncated");
    assert.equal(content.shown_entries + content.omitted_entries, raw.entries.length);
    assert.ok(Buffer.from(reply, "utf8").length <= Math.min(4096, byteCap - 640));
    assert.deepEqual(raw, before);
  }
});

test("small directory budget keeps legacy fallback (v1 == v2)", () => {
  const raw = listing(5);
  assert.equal(
    directoryModelReply(raw, {}, { resultBytes: 1024 }),
    directoryModelReply(raw, {}, { resultBytes: 1024, policy: V2 }),
  );
});

test("overview does not infer missing directories or apply to nonrecursive listing", () => {
  const raw = listing(5);
  const view = JSON.parse(
    directoryModelReply(raw, {}, { resultBytes: 32768, policy: V2 }),
  );
  assert.deepEqual(view.content.observed_child_directories, []);
  assert.ok(!view.content.observed_child_directories.includes("evidence/目录/"));

  raw.recursive = false;
  const view2 = JSON.parse(
    directoryModelReply(raw, {}, { resultBytes: 32768, policy: V2 }),
  );
  assert.ok(!("observed_child_directories" in view2.content));
});

test("overview is bounded and counts omitted unicode directory entries", () => {
  const raw = listing(0);
  raw.entries = [];
  for (let i = 0; i < 200; i++) {
    raw.entries.push({
      path: `evidence/${String(i).padStart(4, "0")}-` + "目录".repeat(12),
      type: "directory",
    });
  }
  const reply = directoryModelReply(raw, {}, { resultBytes: 2048, policy: V2 });
  const content = JSON.parse(reply).content;
  const shown = content.observed_child_directories;

  assert.ok(shown.length > 0 && shown.length < 200);
  assert.deepEqual(
    shown,
    raw.entries.slice(0, shown.length).map((e) => e.path + "/"),
  );
  assert.equal(shown.length + content.child_directories_omitted, 200);
  assert.ok(Buffer.from(reply, "utf8").length <= 1408);
});

test("directory overview does not quote unscoped root", () => {
  for (const base of ["/external", "../external", "a\\b"]) {
    const raw = listing(0);
    raw.path = base;
    raw.entries = [{ path: base + "/child", type: "directory" }];
    const view = JSON.parse(
      directoryModelReply(raw, {}, { resultBytes: 32768, policy: V2 }),
    );
    assert.deepEqual(view.content.observed_child_directories, []);
  }
});

test("recursive overview counts truncated scope correctly when not truncated", () => {
  const raw = {
    ok: true,
    path: "evidence",
    recursive: true,
    truncated: false,
    entries: [
      { path: "evidence/aaa", type: "directory" },
      { path: "evidence/last.py", type: "file" },
    ],
  };
  const content = JSON.parse(
    directoryModelReply(raw, {}, { resultBytes: 32768, policy: V2 }),
  ).content;
  assert.deepEqual(content.observed_child_directories, ["evidence/aaa/"]);
  assert.equal(content.child_directory_scope, "returned entries only");
  assert.equal(content.child_directories_omitted, 0);
});

// --- v1 default / v3 scope ---------------------------------------------------

test("unconfigured policy retains exact v1 view", () => {
  const raw = listing(2);
  assert.equal(
    directoryModelReply(raw, {}, { resultBytes: 32768 }),
    directoryModelReply(raw, {}, { resultBytes: 32768, policy: V1 }),
  );
  assert.equal(
    directoryFeedbackDigest(32768),
    directoryFeedbackDigest(32768, { policy: V1 }),
  );
  assert.notEqual(
    directoryFeedbackDigest(32768),
    directoryFeedbackDigest(32768, { policy: V2 }),
  );
});

test("old empty listing projection remains exact for v1 and v2", () => {
  const raw = {
    ok: true,
    path: "evidence/repo",
    recursive: false,
    truncated: false,
    entries: [],
  };
  const expected = {
    status: "ok",
    content: {
      paths: [],
      returned_entries: 0,
      shown_entries: 0,
      omitted_entries: 0,
      result_truncated: false,
      metadata:
        "Metadata omitted from this view; use available artifact_uri or narrow path/glob.",
    },
  };
  for (const policy of [V1, V2]) {
    const view = JSON.parse(
      directoryModelReply(raw, { glob: "**/source.py" }, { resultBytes: 32768, policy }),
    );
    assert.deepEqual(view, expected);
  }
});

test("v3 keeps glob search scope in model view (shallow vs recursive)", () => {
  const shallow = {
    ok: true,
    path: "evidence/repo",
    recursive: false,
    truncated: false,
    entries: [],
  };
  const vShallow = JSON.parse(
    directoryModelReply(
      shallow,
      { path: "evidence/repo", glob: "**/context_runtime.py" },
      { resultBytes: 32768, policy: V3 },
    ),
  );
  assert.deepEqual(vShallow.content.listing_scope, {
    path: "evidence/repo",
    recursive: false,
    glob: "**/context_runtime.py",
  });
  assert.deepEqual(vShallow.content.paths, []);
  assert.ok(vShallow.content.scope_note);
  assert.ok(vShallow.content.scope_note.includes("immediate children"));
  assert.ok(vShallow.content.scope_note.includes("recursive=true"));
  assert.ok(!vShallow.content.scope_note.includes("absent"));

  const deep = {
    ok: true,
    path: "evidence/repo",
    recursive: true,
    truncated: false,
    entries: [
      { path: "evidence/repo/package/context_runtime.py", type: "file" },
    ],
  };
  const vDeep = JSON.parse(
    directoryModelReply(
      deep,
      { path: "evidence/repo", glob: "**/context_runtime.py", recursive: true },
      { resultBytes: 32768, policy: V3 },
    ),
  );
  assert.deepEqual(vDeep.content.listing_scope, {
    path: "evidence/repo",
    recursive: true,
    glob: "**/context_runtime.py",
  });
  assert.deepEqual(vDeep.content.paths, ["evidence/repo/package/context_runtime.py"]);
  assert.ok(!("scope_note" in vDeep.content));
});

test("v3 empty shallow includes scope_note; empty recursive does not", () => {
  const shallow = { ok: true, path: "evidence/repo", recursive: false, truncated: false, entries: [] };
  const vShallow = JSON.parse(
    directoryModelReply(shallow, { glob: "**/*.py" }, { resultBytes: 32768, policy: V3 }),
  );
  assert.equal(vShallow.content.listing_scope.recursive, false);
  assert.ok(vShallow.content.scope_note);

  const deep = { ok: true, path: "evidence/repo", recursive: true, truncated: false, entries: [] };
  const vDeep = JSON.parse(
    directoryModelReply(deep, { glob: "**/*.py" }, { resultBytes: 32768, policy: V3 }),
  );
  assert.equal(vDeep.content.listing_scope.recursive, true);
  assert.ok(!vDeep.content.scope_note);
});

test("v3 large scope falls back without dropping search boundary", () => {
  const raw = { ok: true, path: "目录".repeat(3000), recursive: false, truncated: false, entries: [] };
  assert.equal(
    directoryModelReply(raw, {}, { resultBytes: 1024, policy: V3 }),
    null,
  );
});

test("v3 rejects non-boolean recursive, non-string path and non-string glob", () => {
  assert.equal(
    directoryModelReply(
      { ok: true, path: "evidence", recursive: "true", truncated: false, entries: [] },
      {},
      { resultBytes: 32768, policy: V3 },
    ),
    null,
  );
  assert.equal(
    directoryModelReply(
      { ok: true, path: 123, recursive: true, truncated: false, entries: [] },
      {},
      { resultBytes: 32768, policy: V3 },
    ),
    null,
  );
  const raw = { ok: true, path: "evidence", recursive: true, truncated: false, entries: [] };
  assert.equal(
    directoryModelReply(raw, { glob: 123 }, { resultBytes: 32768, policy: V3 }),
    null,
  );
  // null glob is allowed (treated as missing in the reference).
  const view = JSON.parse(
    directoryModelReply(raw, { glob: null }, { resultBytes: 32768, policy: V3 }),
  );
  assert.equal(view.content.listing_scope.glob, null);
});

// --- failures / unfamiliar shapes / invalid observations ---------------------

test("failures or unfamiliar shapes keep normal governance (null)", () => {
  const cases = [
    { ok: false, error_message: "not found" },
    { ok: true, entries: [{ path: "x", type: "alien" }], truncated: false },
    { ok: true, entries: [{ path: "x", type: {} }], truncated: false },
    { ok: true, entries: "bad", truncated: false },
    { ok: true, entries: [{ path: "", type: "file" }], truncated: false },
    { ok: true, entries: [{ path: "x", type: "file" }], truncated: "yes" },
    { ok: 1, entries: [], truncated: false },
  ];
  for (const value of cases) {
    assert.equal(
      directoryModelReply(value, {}, { resultBytes: 32768 }),
      null,
      `expected null for ${JSON.stringify(value)}`,
    );
  }
});

test("directoryModelReply rejects unknown policy", () => {
  assertPolicyInvalid(() =>
    directoryModelReply(listing(1), {}, { resultBytes: 32768, policy: "bad" }),
  );
  assertPolicyInvalid(() =>
    directoryModelReply(listing(1), {}, { resultBytes: 32768, policy: "studio-directory-observation/v4" }),
  );
});

// --- sort value type validation ---------------------------------------------

test("directoryModelReply accepts bigint sort values and preserves exact magnitude", () => {
  // MAX_SAFE_INTEGER + 1 is not exactly representable as a JS number; bigint
  // must be accepted and serialized exactly (Python int is arbitrary precision).
  const raw = {
    ok: true,
    path: "evidence",
    recursive: false,
    truncated: false,
    entries: [
      { path: "evidence/big.py", type: "file", size: 9007199254740993n, mtime_ns: 1792000000000000001n },
    ],
  };
  const byMtime = directoryModelReply(raw, { sort_by: "mtime" }, { resultBytes: 32768 });
  assert.ok(byMtime.includes('"mtime_ns":1792000000000000001'));
  assert.ok(byMtime.includes('"path":"evidence/big.py"'));
  const bySize = directoryModelReply(raw, { sort_by: "size" }, { resultBytes: 32768 });
  assert.ok(bySize.includes('"size":9007199254740993'));
});

test("directoryModelReply rejects non-integer sort values", () => {
  for (const bad of [1.5, NaN, true, false, "123", null, {}, [], Infinity, -Infinity]) {
    const raw = {
      ok: true,
      path: "evidence",
      recursive: false,
      truncated: false,
      entries: [{ path: "evidence/a.py", type: "file", size: bad }],
    };
    assert.equal(
      directoryModelReply(raw, { sort_by: "size" }, { resultBytes: 32768 }),
      null,
      `expected null for size=${String(bad)}`,
    );
  }
  // missing sort field also yields null when sort_by selects it.
  const missing = {
    ok: true,
    path: "evidence",
    recursive: false,
    truncated: false,
    entries: [{ path: "evidence/a.py", type: "file" }],
  };
  assert.equal(
    directoryModelReply(missing, { sort_by: "mtime" }, { resultBytes: 32768 }),
    null,
  );
});

// --- sort_by normalization ---------------------------------------------------

test("sort_by is normalized and defaults to name for non-string", () => {
  const raw = listing(3);
  assert.equal(
    directoryModelReply(raw, { sort_by: "  Size  " }, { resultBytes: 32768 }),
    directoryModelReply(raw, { sort_by: "size" }, { resultBytes: 32768 }),
  );
  // non-string sort_by coerces to a name sort in the reference.
  assert.equal(
    directoryModelReply(raw, { sort_by: 123 }, { resultBytes: 32768 }),
    directoryModelReply(raw, { sort_by: "name" }, { resultBytes: 32768 }),
  );
  assert.equal(
    directoryModelReply(raw, {}, { resultBytes: 32768 }),
    directoryModelReply(raw, { sort_by: "name" }, { resultBytes: 32768 }),
  );
});

// --- immutability and deterministic digest ----------------------------------

test("directoryModelReply never mutates input value or arguments", () => {
  const raw = listing(8);
  raw.entries.push({ path: "evidence/sub", type: "directory" });
  const before = structuredClone(raw);
  const argsBefore = structuredClone({ sort_by: "mtime", path: "evidence" });
  directoryModelReply(raw, argsBefore, { resultBytes: 4096, policy: V2 });
  assert.deepEqual(raw, before);
  assert.deepEqual(argsBefore, structuredClone({ sort_by: "mtime", path: "evidence" }));
});

test("reply fits the UTF-8 byte budget for unicode-heavy listings", () => {
  const raw = listing(120); // 120 unicode paths
  const reply = directoryModelReply(raw, {}, { resultBytes: 2048 });
  assert.ok(reply !== null);
  assert.ok(Buffer.from(reply, "utf8").length <= Math.min(4096, 2048 - 640));
  // Tight budget with no room for the reserve falls back to null.
  assert.equal(directoryModelReply(raw, {}, { resultBytes: 600 }), null);
});

test('invalid byte ceilings cannot disable the model result bound', () => {
  for (const resultBytes of [undefined, NaN, Infinity, '32768', 32768.5]) {
    assert.throws(() => directoryModelReply(listing(1), {}, { resultBytes }), /native_directory_result_bytes_invalid/);
    assert.throws(() => directoryFeedbackDigest(resultBytes), /native_directory_result_bytes_invalid/);
  }
});

test('unsafe Number sort values and negative zero are refused; exact bigint remains supported', () => {
  for (const value of [9007199254740992, 1e21, -0]) {
    const raw = listing(1); raw.entries[0].size = value;
    assert.equal(directoryModelReply(raw, { sort_by: 'size' }, { resultBytes: 32768 }), null);
  }
});
