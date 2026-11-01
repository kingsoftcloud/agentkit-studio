// Pure Studio final-output shape helpers.
//
// Ports the pure helpers from ``ksadk/studio/native_final_shape.py`` (lines
// 31-437 of the pinned reference commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3): requested_final_shape,
// declared_value_submission_schema, json_object_submission_schema,
// final_shape_contract_description, the exact-workspace-file parsers,
// exact_byte_difference and _violation. The ``StudioFinalShapeVerifier`` class,
// file I/O (``_read_exact_workspace_file``) and web-entry binding
// (``_written_web_entry``) are intentionally NOT ported; the parent owns them.
//
// All exports use camelCase (intentional TS/Node spelling). The module is pure:
// no file I/O, no network, no eval/Function/subprocess, no shared mutable
// state; every schema is a fresh object per call.
//
// Divergences from the Python source (documented):
//  - Python ``re`` Unicode semantics are ported faithfully via a ``pyRe``
//    helper: ``\s`` -> the Python whitespace class (incl U+001C-1F, U+0085;
//    excl U+FEFF — NOT JS ``\s``), ``\w`` -> ``[\p{L}\p{N}_]`` (letters + all
//    numbers + underscore, not just Nd), ``\d`` -> ``\p{Nd}`` (JS ``\d`` is
//    ASCII even with the ``u`` flag, but Python ``\d`` is Nd, so a fullwidth-
//    digit answer counts as a number/integer). ``digits`` keeps the source's
//    ``[0-9]`` ASCII contract. ``.fullmatch`` parity is via a ``fullMatch``
//    helper (JS ``$`` would otherwise let a trailing ``\n`` through). Flags
//    match the source ``re.IGNORECASE`` where present, plus ``u``.
//  - ``finalShapeViolation`` returns ``null`` (no violation) for a ``null`` /
//    undefined shape; the Python ``_violation`` is only ever called with a
//    truthy shape, so this is a bounded defensive guard, not a semantic change.
//  - ``exactByteDifference`` and the exact-workspace-file encode/decode use
//    camelCase keys (``firstMismatchByte`` etc., ``relativePath``) per the
//    task's camelCase convention; the Python source uses snake_case keys.
//    There is no old-DB compatibility need, so encode/decode are a
//    self-consistent camelCase pair.
//  - The ``python_list`` literal check delegates to
//    ``native-python-list-literal.mjs``; see its header for the literal-parser
//    grammar and the remaining bounded approximation (unhashable set/dict-key
//    elements rejected instead of CPython's uncaught TypeError propagating).

import {
  pythonStrip,
  pythonLstrip,
  pythonSplitLines,
  codePointLength,
  isPythonListLiteral,
  PY_WS,
  fullMatch,
} from "./native-python-list-literal.mjs";
import { declaredObjectFields } from "./native-output-fields.mjs";

// --- directive patterns --------------------------------------------------------
//
// Python-faithful regex ports: ``\s`` is the Python whitespace class (PY_WS,
// including U+001C-001F and U+0085, excluding U+FEFF — NOT JS ``\s``); ``\w`` is
// ``[\p{L}\p{N}_]`` (letters + all numbers + underscore, matching Python ``\w``
// which is NOT just Nd); ``\d`` uses the JS ``u`` flag so it matches Unicode Nd
// (Python ``\d``), so a fullwidth-digit answer like ``４２`` counts as a
// number/integer while ``digits`` keeps the source's ``[0-9]`` ASCII contract.
// Patterns the source applies with ``.fullmatch`` use the ``fullMatch`` helper
// (JS ``$`` would otherwise let a trailing ``\n`` through). Flags match the
// source's ``re.IGNORECASE`` where present, plus ``u`` for Unicode classes.

const WS = "[" + PY_WS + "]";

function pyRe(src, flags) {
  // Port Python ``re`` Unicode semantics: ``\s`` -> Python whitespace class
  // (PY_WS), ``\w`` -> ``[\p{L}\p{N}_]`` (letters + all numbers + underscore),
  // ``\d`` -> ``\p{Nd}`` (Unicode decimal digits — JS ``\d`` stays ASCII even
  // with the ``u`` flag, but Python ``\d`` is Nd, so a fullwidth-digit answer
  // like ``４２`` counts as a number/integer). ``\b``/``\n``/``\r``/escapes
  // pass through. Inside a character class, ``\s``/``\w``/``\d`` merge into the
  // existing class without extra brackets (e.g. ``[\w一-鿿]`` ->
  // ``[\p{L}\p{N}_一-鿿]``).
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "s") {
        out += inClass ? PY_WS : WS;
        i++;
        continue;
      }
      if (next === "w") {
        out += inClass ? "\\p{L}\\p{N}_" : "[\\p{L}\\p{N}_]";
        i++;
        continue;
      }
      if (next === "d") {
        out += "\\p{Nd}";
        i++;
        continue;
      }
      out += "\\" + next;
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, flags);
}

const NUMBER_REQUEST_RE = pyRe(
  "\\b(?:return|reply|respond|output|give)\\s+only\\s+(?:the|a|one)?\\s*(?<kind>total|sum|count|number|integer|numeric\\s+value)(?:\\s+(?:it|they|the\\s+[a-z-]+)\\s+(?:reported|returned|produced))?\\s*[.!?]?\\s*$",
  "iu"
);
const DIGITS_REQUEST_RE = pyRe(
  "\\b(?:return|reply|respond|output|give)(?:\\s+with)?\\s+only\\s+(?:the|those|these)?\\s*digits?\\s*[.!?]?\\s*$",
  "iu"
);
const SENTENCE_REQUEST_RE = pyRe(
  "\\b(?:return|reply|respond|output|give)\\s+only\\s+(?:the|a|one)\\s+(?:[a-z-]+\\s+){0,4}sentence\\b(?:\\s+from\\s+[a-z0-9_./-]+)?\\s*[.!?]?\\s*$",
  "iu"
);
// Answer patterns: \d uses the u flag (Unicode Nd) so fullwidth digits match
// for number/integer; digits keeps the source's ASCII [0-9] contract.
const NUMBER_ANSWER_RE = pyRe("[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)", "u");
const INTEGER_ANSWER_RE = pyRe("[+-]?\\d+", "u");
const DIGITS_ANSWER_RE = pyRe("[0-9]+", "u");
const CHINESE_NUMBER_REQUEST_RE = pyRe(
  "(?:只|仅)(?:回复|输出)\\s*(?:数字|数值)\\s*[。.!！]?\\s*$",
  "u"
);
const CHINESE_JSON_BOOLEAN_REQUEST_RE = pyRe(
  "(?:只|仅)(?:回复|输出)\\s*JSON\\s*布尔值\\s*[。.!！]?\\s*$",
  "iu"
);
const CHINESE_CHOICE_REQUEST_RE = pyRe(
  "(?:只|仅)(?:回复|输出)\\s*(?<first>[\\w一-鿿]{1,16})\\s*或\\s*(?<second>[\\w一-鿿]{1,16})\\s*[。.!！]?\\s*$",
  "u"
);
const STRUCTURED_JSON_REQUEST_RE = pyRe(
  "\\b(?:return|reply|respond|output|give)(?:\\s+with)?\\s+only\\s+(?:a|one|the)?\\s*JSON\\s+(?<kind>object|array)\\s*[.!?]?\\s*$",
  "iu"
);
// fullmatch patterns have no ^/$ anchors; the fullMatch helper anchors them.
const CHINESE_STRUCTURED_JSON_RE = pyRe(
  "\\s*(?:(?:最后|最终)(?:请)?|请)?(?:只|仅)(?:回复|输出|返回)\\s*(?:一个|上述|该)?\\s*JSON\\s*(?<kind>对象|数组)(?:[,，]\\s*(?:(?:键|字段|每项)[^。\\n]*|格式(?:为|是)\\s*(?<format>\\{[^。\\n]*\\}|\\[[^。\\n]*\\])|(?<header>(?:格式|结构)如下\\s*[:：])|(?:不(?:要|得)?|禁止)(?:附加|添加)(?:其他|额外|任何)?(?:说明|解释)(?:文字|文本)?))?\\s*",
  "iu"
);
const PYTHON_LIST_REQUEST_RE = pyRe(
  "(?:^|[.!?\\n]\\s*)(?:return|reply|respond|output|give)(?:\\s+with)?\\s+only\\s+(?:a|one|the)?\\s*Python\\s+list\\s*literal\\s*[.!?]?\\s*$",
  "iu"
);
const CHINESE_PYTHON_LIST_RE = pyRe(
  "\\s*(?:最后)?(?:只|仅)(?:回复|输出|返回)\\s*Python\\s*列表字面量\\s*",
  "iu"
);

const DIRECT_PREFIX_SET = new Set([
  "",
  "then",
  "finally",
  "and then",
  "请",
  "最后",
  "最终",
  "最后请",
  "最终请",
  "然后",
]);
const CLAUSE_DELIMITER_RE = /[.!?。？！\n,，]/;
const COMPOUND_PREFIX_RE = pyRe(
  "(?:read|inspect|check|calculate|compute|use|ask|analy[sz]e)\\b[^\"'`:“”‘’]*\\s+(?:and(?:\\s+then)?|then)",
  "u"
);
const SENTENCE_SPLIT_RE = /[。\n]/;
const LIST_MARKER_RE = pyRe("^\\s*(?:-\\s+|[1-9][0-9]{0,2}[.)]\\s+)", "u");
const FENCE_RE = pyRe("^\\s*(`{3,}|~{3,})(.*)$", "u");

const EXACT_WORKSPACE_FILE_RE = pyRe(
  "\\s*(?:请)?在工作区(?:创建|写入)\\s*(?<path>(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+)\\s*[,，]\\s*内容(?:必须)?(?:恰好是|完全是|只写|仅写)\\s*(?<content>[^。\\r\\n]{1,4096})。(?:完成后(?:再)?回复(?:文件)?路径。?)?\\s*",
  "u"
);
const EXACT_PATH_RE = pyRe("(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+", "u");

function codePointSlice(s, start, end) {
  // Slice by code point, matching Python's ``str[-1024:]`` / ``[:1024]`` which
  // count code points (JS ``String.prototype.slice`` counts UTF-16 units).
  return Array.from(s).slice(start, end).join("");
}

function visibleGoalText(goal) {
  // Quoted/fenced blocks and blockquote lines cannot supply output authority.
  const visible = [];
  let fence = null; // [kindChar, runLength]
  for (const line of pythonSplitLines(goal)) {
    const marker = FENCE_RE.exec(line);
    if (marker) {
      const run = marker[1];
      const kind = run[0];
      const length = run.length;
      if (fence === null) {
        fence = [kind, length];
      } else if (fence[0] === kind && length >= fence[1] && !marker[2].trim()) {
        fence = null;
      }
      continue;
    }
    if (fence === null && !pythonLstrip(line).startsWith(">")) visible.push(line);
  }
  return visible.join("\n");
}

function directiveMatch(pattern, text) {
  // A matching phrase needs an imperative clause, not just matching words.
  const match = pattern.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index);
  const segments = before.split(CLAUSE_DELIMITER_RE);
  const prefix = pythonStrip(segments[segments.length - 1]).toLowerCase();
  const direct = DIRECT_PREFIX_SET.has(prefix);
  const compound = fullMatch(COMPOUND_PREFIX_RE, prefix);
  return direct || compound ? match : null;
}

function pythonListRequested(goal) {
  if (PYTHON_LIST_REQUEST_RE.test(goal)) return true;
  // Only a complete directive counts; a quote, negation or conflicting request
  // must not silently become a host constraint.
  for (const sentence of goal.split(/[。！？\n]/)) {
    if (fullMatch(CHINESE_PYTHON_LIST_RE, sentence)) return true;
  }
  return false;
}

function structuredJsonClauses(goal) {
  // Parse explicit directives only, never contradictory outer shapes.
  const text = visibleGoalText(goal);
  const candidates = [];
  const english = directiveMatch(STRUCTURED_JSON_REQUEST_RE, text);
  if (english) {
    candidates.push([
      english.groups.kind === "object" ? "json_object" : "json_array",
      english[0],
    ]);
  }
  const sentences = text.split(SENTENCE_SPLIT_RE);
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index].replace(LIST_MARKER_RE, "");
    const match = CHINESE_STRUCTURED_JSON_RE.exec(sentence);
    // Source applies ``.fullmatch``: the whole sentence must match.
    if (!match || match.index !== 0 || match[0].length !== sentence.length) continue;
    const expected = match.groups.kind === "对象" ? "{" : "[";
    let example = match.groups.format || "";
    if (match.groups.header) {
      example = "";
      for (let j = index + 1; j < sentences.length; j++) {
        if (sentences[j].trim() !== "") {
          example = pythonLstrip(sentences[j]);
          break;
        }
      }
      if (!example.startsWith("{") && !example.startsWith("[")) continue;
    }
    // Only validate the explicitly declared outer shape. Example fields,
    // values and task semantics are never inferred here.
    if (example && example[0] !== expected) return [];
    candidates.push([expected === "{" ? "json_object" : "json_array", match[0]]);
  }
  return candidates;
}

function structuredJsonClause(goal) {
  const candidates = structuredJsonClauses(goal);
  if (candidates.length === 0) return null;
  const shapes = new Set(candidates.map((c) => c[0]));
  if (shapes.size !== 1) return null;
  return candidates[candidates.length - 1];
}

// --- required exports ----------------------------------------------------------

export function requestedFinalShape(goal) {
  // Recognize only an unambiguous final clause; unknown requests get no rule.
  const visible = visibleGoalText(goal);
  const number = directiveMatch(NUMBER_REQUEST_RE, visible);
  if (number) {
    return number.groups.kind.toLowerCase() === "integer" ? "integer" : "number";
  }
  if (directiveMatch(CHINESE_NUMBER_REQUEST_RE, visible)) return "number";
  if (directiveMatch(CHINESE_JSON_BOOLEAN_REQUEST_RE, visible)) return "json_boolean";
  const choices = directiveMatch(CHINESE_CHOICE_REQUEST_RE, visible);
  if (choices) {
    const first = choices.groups.first;
    const second = choices.groups.second;
    if (first !== second) return [first, second];
  }
  if (directiveMatch(DIGITS_REQUEST_RE, visible)) return "digits";
  if (directiveMatch(SENTENCE_REQUEST_RE, visible)) return "sentence";
  const structured = structuredJsonClause(goal);
  if (structured) return structured[0];
  if (pythonListRequested(visible)) return "python_list";
  return null;
}

export function jsonObjectSubmissionSchema(goal) {
  // One host submission protocol for explicit parent and child object goals.
  // Freeze the outer shape and an unambiguous explicit key list, never an
  // inferred answer, field value/type or semantic verifier. Every caller
  // receives a fresh schema. Unsupported field declarations stay unconstrained.
  const output = {
    type: "object",
    description: "The complete JSON object requested by the current user.",
  };
  const fields = goal ? declaredObjectFields(structuredJsonClauses(goal)) : null;
  if (fields) {
    // Null-prototype object so a declared field literally named ``__proto__``
    // (which the key grammar permits) becomes an own property instead of
    // mutating the prototype, matching Python dict semantics.
    const properties = Object.create(null);
    for (const key of fields) properties[key] = {};
    output.properties = properties;
    output.required = fields.slice();
    output.additionalProperties = false;
  }
  return {
    type: "object",
    properties: { output },
    required: ["output"],
    additionalProperties: false,
  };
}

export function declaredValueSubmissionSchema(goal) {
  // Compile an explicit delivery form, never its answer or source semantics.
  const shape = requestedFinalShape(goal);
  if (shape === "json_object") return jsonObjectSubmissionSchema(goal);
  const types = {
    number: "number",
    integer: "integer",
    json_boolean: "boolean",
    json_array: "array",
    sentence: "string",
    digits: "string",
  };
  if (typeof shape !== "string" || !(shape in types)) return null;
  const value = { type: types[shape] };
  if (shape === "sentence") {
    value.minLength = 1;
    value.pattern = "^[^\\r\\n]+$";
    value.description =
      "Only the complete requested sentence, without an introduction or commentary.";
  } else if (shape === "digits") {
    value.minLength = 1;
    value.pattern = "^[0-9]+$";
  }
  return {
    type: "object",
    properties: { output: value },
    required: ["output"],
    additionalProperties: false,
  };
}

export function finalShapeContractDescription(goal) {
  // Keep an explicit output clause when bounding the acceptance description.
  // The full goal remains in the Run's authoritative continuity state; this
  // description is only a rejection rule, not proof of semantic completion.
  const suffix = codePointSlice(goal, -1024);
  if (requestedFinalShape(suffix) === requestedFinalShape(goal)) return suffix;
  const structured = structuredJsonClause(goal);
  if (structured) return codePointSlice(structured[1], 0, 1024);
  return suffix;
}

export function requestedExactWorkspaceFile(goal) {
  // Only freeze an explicit path and byte-for-byte content, never infer them.
  const match = EXACT_WORKSPACE_FILE_RE.exec(goal);
  // Source applies ``.fullmatch``: the whole goal must be this one directive.
  if (!match || match.index !== 0 || match[0].length !== goal.length) return null;
  const relative = match.groups.path;
  const parts = relative.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return { relativePath: parts.join("/"), content: match.groups.content };
}

export function encodeExactWorkspaceFile(requirement) {
  // Pinned camelCase wire form (no old-DB compatibility need). Keys are emitted
  // in sorted order so the encoding is stable, matching the Python source's
  // ``sort_keys=True``; ``ensure_ascii=False`` corresponds to JS emitting
  // non-ASCII characters raw.
  return JSON.stringify({
    content: requirement.content,
    relativePath: requirement.relativePath,
  });
}

export function decodeExactWorkspaceFile(description) {
  // Pure parsing/encoding only; accepts the camelCase form produced by
  // encodeExactWorkspaceFile. Returns null on any malformed input.
  let parsed;
  try {
    parsed = JSON.parse(description);
  } catch (e) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const relative = parsed.relativePath;
  const content = parsed.content;
  if (typeof relative !== "string" || typeof content !== "string") return null;
  if (!fullMatch(EXACT_PATH_RE, relative)) return null;
  const parts = relative.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const cpLen = codePointLength(content);
  if (cpLen < 1 || cpLen > 4096) return null;
  return { relativePath: parts.join("/"), content };
}

export function exactByteDifference(expected, actual) {
  // Bounded byte-level repair evidence without echoing file contents.
  const minLen = Math.min(expected.length, actual.length);
  let offset = minLen;
  for (let i = 0; i < minLen; i++) {
    if (expected[i] !== actual[i]) {
      offset = i;
      break;
    }
  }
  return {
    firstMismatchByte: offset,
    expectedByteHex:
      offset < expected.length
        ? expected[offset].toString(16).padStart(2, "0")
        : null,
    actualByteHex:
      offset < actual.length
        ? actual[offset].toString(16).padStart(2, "0")
        : null,
    expectedByteLength: expected.length,
    actualByteLength: actual.length,
  };
}

export function finalShapeViolation(shape, text) {
  if (shape == null) return null;
  const candidate = pythonStrip(text);
  if (Array.isArray(shape)) {
    return shape[0] === candidate || shape[1] === candidate
      ? null
      : "Return exactly one of the two requested values, without punctuation or explanation.";
  }
  if (shape === "number") {
    return fullMatch(NUMBER_ANSWER_RE, candidate)
      ? null
      : "Return only one numeric value, without a preamble or Markdown.";
  }
  if (shape === "integer") {
    return fullMatch(INTEGER_ANSWER_RE, candidate)
      ? null
      : "Return only one integer, without a preamble, Markdown or a decimal fraction.";
  }
  if (shape === "digits") {
    return fullMatch(DIGITS_ANSWER_RE, candidate)
      ? null
      : "Return only the requested digits, without a preamble or Markdown.";
  }
  if (shape === "json_boolean") {
    return candidate === "true" || candidate === "false"
      ? null
      : "Return only a JSON boolean literal: true or false, without Markdown.";
  }
  if (shape === "json_object" || shape === "json_array") {
    try {
      // JS JSON.parse rejects NaN/Infinity natively, matching the Python
      // source's ``parse_constant=reject_constant`` rejection.
      const parsed = JSON.parse(candidate);
      const ok =
        shape === "json_object"
          ? parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          : Array.isArray(parsed);
      if (ok) return null;
    } catch (e) {
      // reject below
    }
    return (
      "Return only one valid JSON " +
      (shape === "json_object" ? "object" : "array") +
      ", without a preamble, Markdown fence or trailing explanation."
    );
  }
  if (shape === "python_list") {
    // Parse a literal, never execute generated Python. The length and node
    // bounds are enforced inside isPythonListLiteral.
    return isPythonListLiteral(candidate)
      ? null
      : "Return only one Python list literal, without Markdown, an assignment, a computed expression or trailing explanation.";
  }
  // sentence (and only sentence remains among the FinalShape strings).
  if (
    !candidate ||
    pythonSplitLines(candidate).length !== 1 ||
    candidate.startsWith(">") ||
    candidate.startsWith("#") ||
    candidate.startsWith("-") ||
    candidate.startsWith("*") ||
    candidate.startsWith("`") ||
    candidate.includes("**") ||
    candidate.includes("`")
  ) {
    return "Return only the requested sentence on one plain-text line.";
  }
  return null;
}

// Exported for testability and parent reuse; pure and deterministic.
export { structuredJsonClauses };
