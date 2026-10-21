// Tests for the pure Studio final-output shape helpers.
//
// Derived from the pinned reference tests
// ``tests/studio/test_native_final_shape.py`` and
// ``tests/studio/test_native_python_literal_shape.py`` at commit
// 355059d78e47ed764bbdb3606304cdf34e9838a3, plus adversarial cases for the
// literal parser, prototype-sensitive keys and byte/Unicode clipping required
// by the task. Deterministic assertions only; no Python execution.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestedFinalShape,
  declaredValueSubmissionSchema,
  jsonObjectSubmissionSchema,
  finalShapeContractDescription,
  requestedExactWorkspaceFile,
  encodeExactWorkspaceFile,
  decodeExactWorkspaceFile,
  exactByteDifference,
  finalShapeViolation,
} from "../src/providers/native-final-shape.mjs";
import {
  isPythonListLiteral,
  parsePythonListLiteral,
  codePointLength,
} from "../src/providers/native-python-list-literal.mjs";

// --- requestedFinalShape: clause precedence, Chinese/English, exclusion ------

test("requestedFinalShape recognizes English numeric directives", () => {
  assert.equal(requestedFinalShape("Read the file. Return only the total."), "number");
  assert.equal(requestedFinalShape("Return only the integer."), "integer");
  assert.equal(requestedFinalShape("Return only the count."), "number");
});

test("requestedFinalShape recognizes sentence directives with imperative prefix", () => {
  assert.equal(
    requestedFinalShape(
      "Read the bound Skill instructions, then return only the instruction sentence from SKILL.md."
    ),
    "sentence"
  );
});

test("requestedFinalShape returns null for non-exclusive or explanatory requests", () => {
  assert.equal(requestedFinalShape("Return the result with a short explanation."), null);
  assert.equal(requestedFinalShape("Return only the total and explain it."), null);
  assert.equal(requestedFinalShape("Return only the sentence and explain it."), null);
});

test("requestedFinalShape recognizes digits and Chinese numeric/boolean directives", () => {
  assert.equal(requestedFinalShape("Read the canvas. Reply with only those digits."), "digits");
  assert.equal(requestedFinalShape("计算 37 × 24，只回复数字。"), "number");
  assert.equal(
    requestedFinalShape('从 JSON {"ok":true} 提取 ok，只回复 JSON 布尔值。'),
    "json_boolean"
  );
  assert.equal(requestedFinalShape("解释 JSON 布尔值的用法。"), null);
});

test("requestedFinalShape recognizes two-choice directives and rejects ambiguity", () => {
  assert.deepEqual(requestedFinalShape("2024 年是闰年吗？只回复 是 或 否。"), ["是", "否"]);
  assert.deepEqual(requestedFinalShape("选择方案，只输出 左 或 右。"), ["左", "右"]);
  // A conflicting clause (extra explanation after the choice) gives no rule.
  assert.equal(requestedFinalShape("只回复 是 或 否，并解释原因。"), null);
  // Equal choices do not produce a rule; later checks also miss.
  assert.equal(requestedFinalShape("只回复 是 或 是。"), null);
});

test("requestedFinalShape recognizes structured JSON directives (English and Chinese)", () => {
  assert.equal(requestedFinalShape("Read the sources. Return only a JSON object."), "json_object");
  assert.equal(requestedFinalShape("Read the sources. Reply with only a JSON array."), "json_array");
  assert.equal(
    requestedFinalShape("最后只返回 JSON 对象，键为 incidents 和 total_cents。不能修改文件。"),
    "json_object"
  );
  assert.equal(requestedFinalShape("仅输出 JSON 数组。"), "json_array");
  assert.equal(
    requestedFinalShape('最后只返回 JSON 对象，格式为 {"records":数组,"count":整数}。'),
    "json_object"
  );
  assert.equal(
    requestedFinalShape('仅输出 JSON 数组，格式是 [{"label":字符串}]。'),
    "json_array"
  );
});

test("requestedFinalShape rejects quoted, negated, fenced or conflicting JSON clauses", () => {
  assert.equal(requestedFinalShape("解释‘只返回 JSON 对象’这句话。"), null);
  assert.equal(requestedFinalShape("不要只返回 JSON 对象。"), null);
  assert.equal(requestedFinalShape("最后只返回 JSON 对象并解释原因。"), null);
  assert.equal(requestedFinalShape('解释“只返回 JSON 对象，格式为 {"x":1}”这句话。'), null);
  assert.equal(requestedFinalShape('不要只返回 JSON 对象，格式为 {"x":1}。'), null);
  assert.equal(requestedFinalShape('只返回 JSON 对象，格式为 {"x":1}，再解释原因。'), null);
  // declared outer shape must match the format example's outer bracket
  assert.equal(requestedFinalShape('只返回 JSON 对象，格式为 [{"x":1}]。'), null);
  assert.equal(requestedFinalShape('只返回 JSON 数组，格式为 {"x":1}。'), null);
});

test("requestedFinalShape excludes fenced blocks and blockquotes from authority", () => {
  assert.equal(
    requestedFinalShape("```text\n最后只返回 JSON 对象，键为 alpha。\n```\n解释引用。"),
    null
  );
  assert.equal(requestedFinalShape("> 最后只返回 JSON 对象，键为 alpha。"), null);
  assert.equal(requestedFinalShape("> 5. 最后只返回 JSON 对象，键为 alpha。"), null);
});

test("requestedFinalShape recognizes Python list directives and rejects mentions", () => {
  assert.equal(
    requestedFinalShape("Python 中 [2,4]*2 的值是什么？只回复 Python 列表字面量。"),
    "python_list"
  );
  assert.equal(
    requestedFinalShape("Evaluate the expression. Return only a Python list literal."),
    "python_list"
  );
  assert.equal(requestedFinalShape("Give the result. Reply only the Python list literal."), "python_list");
  assert.equal(requestedFinalShape("解释 Python 列表字面量。"), null);
  assert.equal(requestedFinalShape('解释“只回复 Python 列表字面量”这句话。'), null);
  assert.equal(requestedFinalShape("不要只回复 Python 列表字面量。"), null);
  assert.equal(requestedFinalShape("只回复 Python 列表字面量，并解释原因。"), null);
  assert.equal(requestedFinalShape("Do not return only a Python list literal."), null);
});

test("requestedFinalShape precedence: number beats later checks", () => {
  // "Return only the total." is a number, not a sentence, even though both
  // patterns could partly match; number is checked first.
  assert.equal(requestedFinalShape("Return only the total."), "number");
});

// --- finalShapeViolation: per-shape acceptance and rejection ------------------

test("finalShapeViolation number: accepts one numeric value, rejects preambles", () => {
  assert.equal(finalShapeViolation("number", "42"), null);
  assert.equal(finalShapeViolation("number", "3.14"), null);
  assert.equal(finalShapeViolation("number", "-0.5"), null);
  assert.equal(finalShapeViolation("number", ".5"), null);
  assert.equal(
    finalShapeViolation("number", "19 + 23 = 42"),
    "Return only one numeric value, without a preamble or Markdown."
  );
});

test("finalShapeViolation integer: rejects decimals and preambles", () => {
  assert.equal(finalShapeViolation("integer", "42"), null);
  assert.equal(finalShapeViolation("integer", "-7"), null);
  assert.equal(
    finalShapeViolation("integer", "42.0"),
    "Return only one integer, without a preamble, Markdown or a decimal fraction."
  );
  assert.equal(
    finalShapeViolation("integer", "The answer is 42"),
    "Return only one integer, without a preamble, Markdown or a decimal fraction."
  );
});

test("finalShapeViolation digits: accepts only digit runs", () => {
  assert.equal(finalShapeViolation("digits", "6428"), null);
  assert.equal(
    finalShapeViolation("digits", "The four digits are: 6428"),
    "Return only the requested digits, without a preamble or Markdown."
  );
});

test("finalShapeViolation number/integer use Unicode Nd (Python \\d); digits stays ASCII [0-9]", () => {
  // Python ``_NUMBER_ANSWER``/``_INTEGER_ANSWER`` use ``\d`` = Unicode Nd, so a
  // fullwidth-digit answer is a valid number/integer. ``digits`` keeps the
  // source's ``[0-9]`` ASCII contract, so fullwidth rejects there.
  const fullwidth = "４２"; // ４２
  assert.equal(finalShapeViolation("number", fullwidth), null);
  assert.equal(finalShapeViolation("integer", fullwidth), null);
  assert.equal(
    finalShapeViolation("digits", fullwidth),
    "Return only the requested digits, without a preamble or Markdown."
  );
  assert.equal(finalShapeViolation("digits", "42"), null);
  // The answer check is a fullmatch, not a search: trailing non-whitespace junk
  // rejects. (The candidate is pythonStripped first, so a bare trailing
  // newline is removed before the regex, matching Python ``text.strip()``.)
  assert.equal(
    finalShapeViolation("number", "42 extra"),
    "Return only one numeric value, without a preamble or Markdown."
  );
  assert.equal(finalShapeViolation("number", "42\n"), null);
  assert.equal(
    finalShapeViolation("integer", "42 x"),
    "Return only one integer, without a preamble, Markdown or a decimal fraction."
  );
});

test("requestedFinalShape uses Python Unicode whitespace (\\s) in directives", () => {
  // U+0085 (NEL) is Python ``\\s`` whitespace (not JS ``\\s``); a directive that
  // separates words with NEL is still recognized.
  assert.equal(requestedFinalShape("Return\u0085only\u0085the\u0085total."), "number");
  assert.equal(requestedFinalShape("return\u0085only\u0085a\u0085JSON\u0085object."), "json_object");
});

test("requestedFinalShape two-choice allows Unicode numbers in the choice word", () => {
  // Python ``\\w`` is letters + all numbers (Nl/No/Nd) + underscore; the choice
  // pattern ``[\\w\\u4e00-\\u9fff]`` accepts digits and letter-numbers.
  assert.deepEqual(requestedFinalShape("只回复 1 或 2。"), ["1", "2"]);
  assert.deepEqual(requestedFinalShape("只回复 Ⅷ 或 Ⅸ。"), ["Ⅷ", "Ⅸ"]);
});

test("finalShapeViolation json_boolean: accepts true/false only, rejects markdown", () => {
  assert.equal(finalShapeViolation("json_boolean", "true"), null);
  assert.equal(finalShapeViolation("json_boolean", "false"), null);
  assert.equal(
    finalShapeViolation("json_boolean", "`true`"),
    "Return only a JSON boolean literal: true or false, without Markdown."
  );
  assert.equal(
    finalShapeViolation("json_boolean", "The answer is true"),
    "Return only a JSON boolean literal: true or false, without Markdown."
  );
});

test("finalShapeViolation two-choice: accepts exact match only", () => {
  assert.equal(finalShapeViolation(["是", "否"], "是"), null);
  assert.equal(finalShapeViolation(["是", "否"], "否"), null);
  assert.equal(
    finalShapeViolation(["是", "否"], "是。"),
    "Return exactly one of the two requested values, without punctuation or explanation."
  );
  assert.equal(
    finalShapeViolation(["是", "否"], "maybe"),
    "Return exactly one of the two requested values, without punctuation or explanation."
  );
});

test("finalShapeViolation sentence: rejects preamble, markdown and multi-line", () => {
  assert.equal(finalShapeViolation("sentence", "Be concise."), null);
  assert.equal(
    finalShapeViolation("sentence", "The sentence is:\n\n> Be concise."),
    "Return only the requested sentence on one plain-text line."
  );
  assert.equal(
    finalShapeViolation("sentence", "**bold**"),
    "Return only the requested sentence on one plain-text line."
  );
  assert.equal(
    finalShapeViolation("sentence", "`code`"),
    "Return only the requested sentence on one plain-text line."
  );
  assert.equal(
    finalShapeViolation("sentence", "- bullet"),
    "Return only the requested sentence on one plain-text line."
  );
  assert.equal(
    finalShapeViolation("sentence", "# heading"),
    "Return only the requested sentence on one plain-text line."
  );
});

test("finalShapeViolation json_object/array: rejects prose, fences, NaN, wrong shape", () => {
  assert.equal(finalShapeViolation("json_object", '{"total_cents":999}'), null);
  assert.equal(finalShapeViolation("json_array", "[1,2,3]"), null);
  for (const bad of [
    'Here is the result: {"total_cents": 73}',
    '```json\n{"total_cents":73}\n```',
    '[{"total_cents":73}]',
    '{"total_cents":NaN}',
  ]) {
    assert.equal(
      finalShapeViolation("json_object", bad),
      "Return only one valid JSON object, without a preamble, Markdown fence or trailing explanation.",
      JSON.stringify(bad)
    );
  }
  assert.equal(
    finalShapeViolation("json_array", '{"not":"array"}'),
    "Return only one valid JSON array, without a preamble, Markdown fence or trailing explanation."
  );
  assert.equal(
    finalShapeViolation("json_object", "[1,2,3]"),
    "Return only one valid JSON object, without a preamble, Markdown fence or trailing explanation."
  );
});

test("finalShapeViolation returns null for null shape (bounded guard)", () => {
  assert.equal(finalShapeViolation(null, "anything"), null);
  assert.equal(finalShapeViolation(undefined, "anything"), null);
});

// --- python_list literal parser (the hard requirement) -----------------------

test("python_list violation accepts valid literals and rejects invalid ones", () => {
  const shape = "python_list";
  for (const good of ["[2, 4, 2, 4]", "['value', True, None, {'nested': (1, 2)}]", "[2, 4, 2, 6]"]) {
    assert.equal(finalShapeViolation(shape, good), null, JSON.stringify(good));
  }
  for (const bad of [
    "`[2, 4, 2, 4]`",
    "```python\n[2, 4, 2, 4]\n```",
    "结果是 [2, 4, 2, 4]",
    "[2, 4] * 2",
    "[value for value in range(4)]",
    "(2, 4, 2, 4)",
    "[2, 4, 2, 4] # result",
  ]) {
    assert.equal(
      finalShapeViolation(shape, bad),
      "Return only one Python list literal, without Markdown, an assignment, a computed expression or trailing explanation.",
      JSON.stringify(bad)
    );
  }
});

test("python_list literal parser: never executes computed/malicious expressions", () => {
  // These must all reject without evaluating anything.
  const reject = [
    "[__import__('os').system('rm -rf /')]",
    "[exec('print(1)')]",
    "[eval('1+1')]",
    "[open('/etc/passwd').read()]",
    "[x for x in range(4)]",
    "[1 if True else 2]",
    "[lambda: 0]",
    "[1 < 2]",
    "[a.b]",
    "[f(x)]",
    "[*a]",
    "[**{1:2}]",
    "x = [1, 2]",
    "[1+2]",
    "[2*3]",
    "[1, 2,, 3]",
    "[1 2]",
  ];
  for (const s of reject) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
});

test("python_list literal parser: accepts nested literal forms", () => {
  const accept = [
    "[]",
    "[1, 2,]",
    "[1, # comment\n2]",
    "[...]",
    "[True, False, None]",
    "[-1, +2j, 3.0, .5, 5., 1.5e-3]",
    "[0x1F, 0o17, 0b101, 0, 1_000, 1_0.5_0e1_0]",
    "[b'bytes', r'raw', u'unicode', '''triple''']",
    '["""multi\nline"""]',
    "[[1, 2], (3, 4), {5, 6}, {'k': [7, 8]}]",
    "[-1, +2, -3]", // single unary signs only
    "[{}, [], ()]",
    "[{1:2}, {1,2}, (1,)]",
    "[{(1,2): 3}]",
    "[[[[[[[[[[1]]]]]]]]]]",
  ];
  for (const s of accept) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: accepts literal_eval special forms", () => {
  // Forms ast.literal_eval accepts (verified against CPython 3.9 ast.py):
  // empty set(), adjacent string/bytes concatenation, and real+/-imaginary
  // complex literals.
  const accept = [
    "[set()]",
    "['a' 'b']",
    "[b'a' b'b']",
    "['a' 'b' 'c']",
    "[1+2j]",
    "[1-2j]",
    "[-1+2j]",
    "[-1-2j]",
    "[+1+2j]",
    "[-1.5+2j]",
    "[(1+2j)]", // parenthesized subexpression keeps the BinOp span
    "[2j]", // bare imaginary Constant
    "[-2j]",
    "[+2j]",
    "[set(), 1]",
    "[{1: set()}]", // set() as a dict value (values need not be hashable)
  ];
  for (const s of accept) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: accepts CPython numeric grammar edge cases", () => {
  // Finding 1: base-specific digits, underscore after base prefix, and the
  // decimal leading-zero rule (pure integer only).
  const accept = [
    "[0x_FF]", "[0b_10]", "[0o_77]", // one underscore after base prefix
    "[00]", "[0_0]", "[000]", // decimal zero runs (all zeros)
    "[01.0]", "[01e2]", "[01j]", // leading zeros allowed for float/imaginary
    "[0]", "[0.5]", "[.5]", "[5.]", "[1e10]",
    "[0xff, 0xFF, 0o77, 0b11]",
  ];
  for (const s of accept) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: rejects malformed numbers and unhashable elements", () => {
  const reject = [
    "[1_]",
    "[1__0]",
    "[0b2]", // binary digit out of range
    "[0o9]", // octal digit out of range
    "[0bdead]", // hex-looking digits in a binary literal
    "[01]", // leading zero then nonzero in a pure integer
    "[0_1]", // underscore then nonzero after leading zero
    "[0x]", // incomplete hex
    "[{[1]:2}]",
    "[{[1,2]}]",
    "[{{1:2}}]",
    "[{1:2} extra]",
  ];
  for (const s of reject) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
});

test("python_list literal parser: rejects non-literal ast.literal_eval forms", () => {
  // real+/-real rejects; imaginary left rejects; nested binop rejects; calls
  // other than empty set() reject; repeated/nested unary signs reject; mixed
  // str/bytes adjacency rejects; f-strings reject.
  const reject = [
    "[1+2]", // real + real
    "[1-2]",
    "[3.5+1.5]",
    "[2j+1]", // imaginary left
    "[2j-1]",
    "[-2j+1]",
    "[1+-2j]", // signed imaginary on the right (right must be a Constant)
    "[1+2j+3j]", // nested binop
    "[set([1])]", // non-empty set call
    "[set(1)]",
    "[len(1)]", // any other call
    "[foo()]",
    "[set() extra]", // trailing junk after the call
    "[--1]", // repeated unary signs
    "[+-1]",
    "[---3]",
    "[b'a' 'b']", // mixed bytes and str
    "['a' b'b']",
    "[f'x']", // f-string
    "[1+True]", // bool is not a numeric operand
    "[-True]",
    "[True+2j]",
    "[{set()}]", // set() is unhashable as a set element
  ];
  for (const s of reject) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
});

test("python_list literal parser: rejects malformed string escapes and raw odd backslash", () => {
  // Truncated hex/unicode escapes reject; raw strings cannot end with an odd
  // number of backslashes. Octal escapes above 0o377 are ACCEPTED by CPython
  // (DeprecationWarning only, not an error) and are tested in the accept test.
  // bytes \u/\U/\N are preserved literally (unrecognized escapes) and are
  // tested in the accept test.
  const reject = [
    "['\\x']", // truncated \xXX
    "['\\x1']",
    "['\\u']", // truncated \uXXXX
    "['\\u004']",
    "['\\U']", // truncated \UXXXXXXXX
    "['\\U0000004']",
    "['\\N{']", // unterminated \N
    "['\\N{}']", // empty name
    "[r'\\']", // raw string ending with odd backslash
  ];
  for (const s of reject) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
});

test("python_list literal parser: accepts raw strings and valid escapes", () => {
  const accept = [
    "[r'\\n']", // raw keeps backslash literally
    "[r'\\\\']", // even trailing backslashes
    "[r'a\\'b']", // escaped quote inside raw
    "[R\"x\"]",
    "['\\n']", // recognized single-char escape
    "['\\x41']", // valid hex escape
    "['\\u0041']", // valid unicode escape
    "['\\U00000041']",
    "[b'\\x41']", // bytes hex escape
    "[b'\\101']", // bytes octal escape
    "['\\d']", // unknown single-char escape allowed
    "['''triple''']", // triple-quoted
    '["""multi\nline"""]',
  ];
  for (const s of accept) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: accepts CPython escape-grammar edge cases", () => {
  // Verified against CPython 3.11 Objects/unicodeobject.c
  // _PyUnicode_DecodeUnicodeEscapeInternal.
  const accept = [
    "['\\400']", // octal >0o377 accepted (DeprecationWarning, not error)
    "['\\477']",
    "[b'\\400']", // octal >0o377 in bytes
    "[b'\\477']",
    "[b'\\u1234']", // bytes \u preserved literally (unrecognized escape)
    "[b'\\U00110000']", // bytes \U preserved literally (not a Unicode escape)
    "[b'\\N{ANY NAME}']", // bytes \N preserved literally
    "[b'\\N{LATIN SMALL LETTER A}']",
    "[rb'\\u0041']", // raw bytes \u as ASCII backslashes
    "['\\x00']", // escaped NUL inside a literal is valid
    "[b'\\x00']",
    "['\\uD800']", // \u surrogate permitted by CPython's str decoder
    "['\\uDFFF']",
    "['\\U0000D800']", // \U surrogate permitted
    "['a\\\rb']", // CR line continuation
    "['a\\\r\nb']", // CRLF line continuation
    "[\"\"\"a\\\r\nb\"\"\"]", // CRLF continuation in triple string
    "['\\N{SNOWMAN}']", // \N named escape resolves a real name
    "['\\N{snowman}']", // case-insensitive
    "['\\N{CJK UNIFIED IDEOGRAPH-4E00}']", // algorithmic CJK
    "['\\N{HANGUL SYLLABLE GA}']", // algorithmic Hangul
    "['\\N{NULL}']", // control alias
    "['\\N{NUL}']", // abbreviation alias
    "[r'\\N{NOT A REAL NAME}']", // raw does not resolve \N (preserved)
    // Triple strings: embedded single/double quotes are content; close only on
    // three consecutive matching quotes.
    "['''a'b''']", // triple single with embedded single quote
    "['''a''b''']", // triple with a run of two quotes (content)
    '["""a"b"""]', // triple double with embedded double quote
    "[r'''a'b''']", // raw triple with embedded quote
    "[b'''a'b''']", // bytes triple with embedded quote
    "[\"\"\"a\\\r\nb\"\"\"]", // triple CRLF continuation
    "[\"\"\"line1\r\nline2\"\"\"]", // triple bare CRLF
    "['\\N{HANGUL SYLLABLE A}']", // \N Hangul with empty L (U+C544)
    // str forms with non-ASCII stay accepted (only bytes must be ASCII).
    "['à']", // str non-ASCII content
    "[r'à']", // raw str non-ASCII
    "['\\à']", // str non-ASCII after backslash (unknown escape, allowed in str)
  ];
  for (const s of accept) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: rejects NUL in source, out-of-range \\U, unknown \\N", () => {
  const reject = [
    "[\u0000]", // a real NUL byte anywhere in source rejects
    "['\u0000']", // NUL inside a string literal source rejects
    "['\\U00110000']", // \U out of range (> 0x10FFFF) rejects
    "['\\UFFFFFFFF']",
    "['\\N{NOT A REAL NAME}']", // unknown \N name rejects
    "['\\N{KEYCAP NUMBER SIGN}']", // named sequence rejects (\N uses with_named_seq=0)
    "[b'à']", // bytes body must be ASCII; real non-ASCII byte rejects
    "[br'à']", // raw bytes non-ASCII rejects
    "[b\"\"\"à\"\"\"]", // triple bytes non-ASCII rejects
    // bytes ASCII must hold AFTER a backslash (raw and ordinary): the consumed
    // escape char is still a source byte and must be ASCII.
    "[b'\\à']", // non-ASCII after backslash (unknown escape) rejects
    "[br'\\à']", // non-ASCII after backslash in raw bytes rejects
    // str forms with the same non-ASCII stay accepted (tested in accept test).
    // Unterminated triple strings reject (no three-quote close).
    "['''x']", // unterminated triple single
    "['''abc]", // unterminated triple, no close
    '["""abc]', // unterminated triple double
    "[r'''x']", // unterminated raw triple
    "[b'''x']", // unterminated bytes triple
    // lowercase algorithmic \N prefixes reject (case-sensitive strncmp)
    "['\\N{hangul syllable ga}']",
    "['\\N{cjk unified ideograph-4e00}']",
  ];
  for (const s of reject) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
});

test("python_list literal parser: enforces CPython 200-bracket nesting limit", () => {
  // CPython's tokenizer limits bracket/paren/brace nesting to 200 (MAXNesting).
  // 200 nested brackets accept; 201 reject (bounded before JS stack overflow).
  const buildNested = (n) => {
    let s = "1";
    for (let i = 0; i < n; i++) s = "[" + s + "]";
    return s;
  };
  assert.equal(isPythonListLiteral(buildNested(200)), true);
  assert.equal(isPythonListLiteral(buildNested(201)), false);
  // Redundant parentheses inside the top list still parse (span check rejects
  // parenthesized single expressions that don't span, but a list inside parens
  // at the top is itself not a top-level list — tested via node count).
  assert.equal(parsePythonListLiteral("[1, 2, 3]").nodeCount, 1 + 1 + 3);
  assert.equal(parsePythonListLiteral("[set()]").nodeCount, 4);
  assert.equal(parsePythonListLiteral("[1+2j]").nodeCount, 6);
  assert.equal(parsePythonListLiteral("[-1-2j]").nodeCount, 8);
});

test("python_list literal parser: source lexical whitespace is ASCII-only (space/tab/formfeed/CR/LF)", () => {
  // CPython's tokenizer accepts only ASCII space/tab/formfeed as inter-token
  // trivia (CR/LF are line terminators, also trivia inside brackets). Non-ASCII
  // "whitespace" (NBSP, NEL, line separator, vertical tab, ideographic space)
  // is NOT source trivia and rejects between tokens. The same characters are
  // valid as str CONTENTS (inside a string literal).
  const rejectBetween = [
    "[1 ,2]", // NBSP
    "[1 ,2]", // line separator
    "[1\u000b,2]", // vertical tab
    "[1\u0085,2]", // NEL
    "[1　,2]", // ideographic space
  ];
  for (const s of rejectBetween) {
    assert.equal(isPythonListLiteral(s), false, JSON.stringify(s));
  }
  // Valid source trivia: space, tab, formfeed, CR, LF.
  for (const s of ["[1, 2]", "[1,\t2]", "[1,\u000c2]", "[1,\r\n2]", "[1,\n2]"]) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
  // The non-ASCII whitespace chars are valid as str contents.
  for (const s of ["[' ']", "[' ']", "['\u000b']", "['\u0085']"]) {
    assert.equal(isPythonListLiteral(s), true, JSON.stringify(s));
  }
});

test("python_list literal parser: identifier NFKC normalization, no $, astral advance", () => {
  // CPython NFKC-normalizes identifier names in the AST: a fullwidth ``ｓｅｔ``
  // normalizes to ``set`` and the empty-set call is accepted. ``$`` is NOT a
  // valid identifier start (JS-only extension). Non-ASCII spellings of
  // True/False/None are NAME tokens (not keyword constants) and reject.
  assert.equal(isPythonListLiteral("[ｓｅｔ()]"), true); // ｓｅｔ() -> set()
  assert.equal(isPythonListLiteral("[set()]"), true);
  assert.equal(isPythonListLiteral("[$set()]"), false); // $ not a valid start
  assert.equal(isPythonListLiteral("[$x]"), false);
  // fullwidth True/False/None are NAMEs, not keyword constants -> reject
  assert.equal(isPythonListLiteral("[Ｔｒｕｅ]"), false); // Ｔｒｕｅ
  assert.equal(isPythonListLiteral("[ｆａｌｓｅ]"), false); // Ｆａｌｓｅ
  assert.equal(isPythonListLiteral("[Ｎｏｎｅ]"), false); // Ｎｏｎｅ
  // ASCII keywords still work
  assert.equal(isPythonListLiteral("[True]"), true);
  assert.equal(isPythonListLiteral("[False]"), true);
  assert.equal(isPythonListLiteral("[None]"), true);
  // A non-set call rejects
  assert.equal(isPythonListLiteral("[len()]"), false);
  // A bare name rejects
  assert.equal(isPythonListLiteral("[set]"), false);
  // Astral identifier advance does not skip following tokens: an astral NAME
  // followed by () is a Call with a non-``set`` name -> rejects.
  assert.equal(isPythonListLiteral("[𐀀()]"), false); // U+10000 call
  assert.equal(isPythonListLiteral("[𐀀]"), false); // bare astral name
});

test("python_list literal parser: enforces CPython 3.11 default 4300-digit decimal-int limit", () => {
  // CPython 3.11's default int-max-str-digits is 4300 (pycore_long.h
  // _PY_LONG_DEFAULT_MAX_STR_DIGITS): a decimal INTEGER with more than 4300
  // digits (underscores excluded) raises ValueError, which literal_eval
  // catches and rejects. Hex/oct/bin ints, floats and imaginaries are separate
  // conversion paths and not subject to this specific limit. The 65536
  // code-point and 4096 AST-node limits still bound everything.
  const D = (n) => "1".repeat(n);
  assert.equal(isPythonListLiteral("[" + D(4300) + "]"), true);
  assert.equal(isPythonListLiteral("[" + D(4301) + "]"), false);
  // Underscores excluded from the count.
  let withUnders = "";
  for (let i = 0; i < 4300; i++) {
    withUnders += "1";
    if (i < 4299) withUnders += "_";
  }
  assert.equal(isPythonListLiteral("[" + withUnders + "]"), true);
  let overUnders = "";
  for (let i = 0; i < 4301; i++) {
    overUnders += "1";
    if (i < 4300) overUnders += "_";
  }
  assert.equal(isPythonListLiteral("[" + overUnders + "]"), false);
  // Floats/imaginaries are not subject to the int digit limit.
  assert.equal(isPythonListLiteral("[" + D(5000) + ".0]"), true);
  assert.equal(isPythonListLiteral("[" + D(5000) + "j]"), true);
  // Hex/oct/bin ints are not subject to the decimal limit.
  assert.equal(isPythonListLiteral("[0x" + "F".repeat(5000) + "]"), true);
  assert.equal(isPythonListLiteral("[0o" + "7".repeat(5000) + "]"), true);
  assert.equal(isPythonListLiteral("[0b" + "1".repeat(5000) + "]"), true);
});

test("python_list literal parser: respects <=65536 Unicode code points", () => {
  // A candidate of exactly 65536 code points that is a valid list accepts.
  // Build a valid list whose code-point length is exactly 65536.
  // "[" + N commas structure: we want total code points == 65536.
  // Use a single huge string literal element of the right length.
  // "[" + "\"" + (65536 - 4) chars + "\"" + "]" => 65536 cp.
  const innerLen = 65536 - 4;
  const atBoundary = "[" + '"' + "a".repeat(innerLen) + '"' + "]";
  assert.equal(codePointLength(atBoundary), 65536);
  assert.equal(isPythonListLiteral(atBoundary), true);
  // One code point over the limit rejects without parsing.
  const over = "[" + '"' + "a".repeat(innerLen + 1) + '"' + "]";
  assert.equal(codePointLength(over), 65537);
  assert.equal(isPythonListLiteral(over), false);
  // Astral characters count as one code point each.
  const astral = "[" + '"' + "😀".repeat(10) + '"' + "]";
  assert.equal(codePointLength(astral), 1 + 1 + 10 + 1 + 1); // [ " 10cp " ]
  assert.equal(isPythonListLiteral(astral), true);
});

test("python_list literal parser: respects <=4096 AST-equivalent nodes", () => {
  // A flat list of N integer elements has 1 (Expression) + 1 (List) + N (ints).
  // N = 4094 => 4096 nodes (accept). N = 4095 => 4097 nodes (reject).
  const build = (n) => "[" + Array.from({ length: n }, (_, i) => i).join(", ") + "]";
  assert.equal(isPythonListLiteral(build(4094)), true);
  assert.equal(isPythonListLiteral(build(4095)), false);
  // Nested lists each add nodes; a deeply nested valid literal still parses.
  assert.equal(isPythonListLiteral("[[[[[1]]]]]"), true);
});

test("parsePythonListLiteral exposes node count for the accepted literal", () => {
  assert.deepEqual(parsePythonListLiteral("[1, 2, 3]"), {
    nodeCount: 1 + 1 + 3,
    start: 0,
    end: 9,
  });
  assert.equal(parsePythonListLiteral("[2, 4] * 2"), null);
});

// --- declaredValueSubmissionSchema --------------------------------------------

test("declaredValueSubmissionSchema compiles value shapes and nulls others", () => {
  assert.deepEqual(declaredValueSubmissionSchema("Return only the total."), {
    type: "object",
    properties: { output: { type: "number" } },
    required: ["output"],
    additionalProperties: false,
  });
  assert.deepEqual(declaredValueSubmissionSchema("Return only the integer."), {
    type: "object",
    properties: { output: { type: "integer" } },
    required: ["output"],
    additionalProperties: false,
  });
  assert.deepEqual(declaredValueSubmissionSchema("Reply with only those digits."), {
    type: "object",
    properties: { output: { type: "string", minLength: 1, pattern: "^[0-9]+$" } },
    required: ["output"],
    additionalProperties: false,
  });
  assert.deepEqual(declaredValueSubmissionSchema("Return only the sentence from SKILL.md."), {
    type: "object",
    properties: {
      output: {
        type: "string",
        minLength: 1,
        pattern: "^[^\\r\\n]+$",
        description: "Only the complete requested sentence, without an introduction or commentary.",
      },
    },
    required: ["output"],
    additionalProperties: false,
  });
  assert.deepEqual(declaredValueSubmissionSchema("只回复 JSON 布尔值。"), {
    type: "object",
    properties: { output: { type: "boolean" } },
    required: ["output"],
    additionalProperties: false,
  });
  assert.deepEqual(declaredValueSubmissionSchema("Return only a JSON array."), {
    type: "object",
    properties: { output: { type: "array" } },
    required: ["output"],
    additionalProperties: false,
  });
  // Choice tuple, python_list and unknown goals have no value submission schema.
  assert.equal(declaredValueSubmissionSchema("只回复 是 或 否。"), null);
  assert.equal(declaredValueSubmissionSchema("只回复 Python 列表字面量。"), null);
  assert.equal(declaredValueSubmissionSchema("Explain the result."), null);
});

// --- jsonObjectSubmissionSchema: explicit key extraction, no inference -------

test("jsonObjectSubmissionSchema returns a fresh object per call (no shared refs)", () => {
  const a = jsonObjectSubmissionSchema("只返回 JSON 对象，键为 alpha 和 beta。");
  const b = jsonObjectSubmissionSchema("只返回 JSON 对象，键为 alpha 和 beta。");
  assert.notEqual(a, b);
  assert.notEqual(a.properties, b.properties);
  assert.notEqual(a.properties.output, b.properties.output);
  assert.notEqual(a.properties.output.properties.alpha, b.properties.output.properties.alpha);
  a.properties.output.properties.alpha.tainted = true;
  assert.equal(b.properties.output.properties.alpha.tainted, undefined);
});

test("jsonObjectSubmissionSchema freezes explicit keys without inferring values", () => {
  const goal = "最后只返回 JSON 对象，键为 readings 和 aggregate；readings 的每项键为 code、offset、ref。";
  const inner = jsonObjectSubmissionSchema(goal).properties.output;
  assert.deepEqual(new Set(Object.keys(inner.properties)), new Set(["readings", "aggregate"]));
  assert.deepEqual(inner.required, ["aggregate", "readings"]);
  assert.equal(inner.additionalProperties, false);
  for (const v of Object.values(inner.properties)) assert.deepEqual(v, {});
  // Outer shape always present.
  const outer = jsonObjectSubmissionSchema(goal);
  assert.deepEqual(outer.required, ["output"]);
  assert.equal(outer.additionalProperties, false);
});

test("jsonObjectSubmissionSchema leaves unconstrained when fields are ambiguous", () => {
  for (const goal of [
    "最后只返回 JSON 对象，键为 alpha 和 alpha。",
    "最后只返回 JSON 对象，键为 alpha 或 beta。",
    "最后只返回 JSON 对象，键为 alpha，允许其他字段。",
    "最后只返回 JSON 对象，键为 alpha；允许其他字段。",
    "最后只返回 JSON 对象，键为 alpha；beta 的每项键为 code。",
    "只返回 JSON 对象，键为 alpha。只返回 JSON 对象，键为 beta。",
    '最后只返回 JSON 对象，格式为 {"alpha":42}。',
  ]) {
    const inner = jsonObjectSubmissionSchema(goal).properties.output;
    assert.equal(inner.required, undefined, JSON.stringify(goal));
    assert.equal(inner.additionalProperties, undefined, JSON.stringify(goal));
    assert.equal(inner.properties, undefined, JSON.stringify(goal));
  }
});

test("jsonObjectSubmissionSchema with no goal has an unconstrained output object", () => {
  const s = jsonObjectSubmissionSchema();
  assert.deepEqual(s.required, ["output"]);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.output, {
    type: "object",
    description: "The complete JSON object requested by the current user.",
  });
});

test("jsonObjectSubmissionSchema handles prototype-sensitive field names as own keys", () => {
  const goal = "只返回 JSON 对象，键为 __proto__ 和 value。";
  const inner = jsonObjectSubmissionSchema(goal).properties.output;
  assert.deepEqual(new Set(Object.keys(inner.properties)), new Set(["__proto__", "value"]));
  assert.equal(Object.prototype.hasOwnProperty.call(inner.properties, "__proto__"), true);
  // Serializes with __proto__ as a normal JSON key.
  const json = JSON.parse(JSON.stringify(jsonObjectSubmissionSchema(goal)));
  assert.deepEqual(Object.keys(json.properties.output.properties), ["__proto__", "value"]);
});

// --- finalShapeContractDescription: bounded preservation ----------------------

test("finalShapeContractDescription bounds to 1024 code points and keeps the final shape", () => {
  const longGoal = "Inspect the files. " + "Context details. ".repeat(100) + "Return only the total.";
  const desc = finalShapeContractDescription(longGoal);
  assert.ok(desc.length <= 1024, "desc length " + desc.length);
  assert.ok(desc.endsWith("Return only the total."));
  assert.equal(requestedFinalShape(desc), "number");
});

test("finalShapeContractDescription preserves an explicit JSON clause in a long goal", () => {
  const longJsonGoal =
    "最后只返回 JSON 对象，键为 incidents 和 total_cents。" + "必须保留准确的来源引用。".repeat(150);
  const desc = finalShapeContractDescription(longJsonGoal);
  assert.ok(desc.length <= 1024, "desc length " + desc.length);
  assert.equal(requestedFinalShape(desc), "json_object");
});

test("finalShapeContractDescription returns the full goal when short", () => {
  const goal = "Return only the total.";
  assert.equal(finalShapeContractDescription(goal), goal);
});

// --- exact workspace file: pure parsing/encoding ------------------------------

test("requestedExactWorkspaceFile freezes path and content", () => {
  const goal = '在工作区创建 baseline/config.json，内容恰好是 {"enabled":true}。完成后回复路径。';
  const req = requestedExactWorkspaceFile(goal);
  assert.deepEqual(req, { relativePath: "baseline/config.json", content: '{"enabled":true}' });
});

test("requestedExactWorkspaceFile rejects traversal, prose and negation", () => {
  assert.equal(requestedExactWorkspaceFile("在工作区创建 ../outside.json，内容恰好是 secret。"), null);
  assert.equal(requestedExactWorkspaceFile("请写一个 JSON 文件。"), null);
  assert.equal(
    requestedExactWorkspaceFile('不要在工作区创建 baseline/config.json，内容恰好是 {"enabled":true}。'),
    null
  );
});

test("encode/decodeExactWorkspaceFile round-trip with pinned camelCase syntax", () => {
  const req = requestedExactWorkspaceFile(
    '在工作区创建 a/b.txt，内容恰好是 hello。'
  );
  const enc = encodeExactWorkspaceFile(req);
  assert.equal(enc, '{"content":"hello","relativePath":"a/b.txt"}');
  assert.deepEqual(decodeExactWorkspaceFile(enc), req);
});

test("decodeExactWorkspaceFile rejects malformed, traversal and out-of-range content", () => {
  assert.equal(decodeExactWorkspaceFile("not json"), null);
  // A well-formed camelCase payload decodes (valid case among the rejections).
  assert.deepEqual(
    decodeExactWorkspaceFile(JSON.stringify({ relativePath: "a", content: "x" })),
    { relativePath: "a", content: "x" }
  );
  assert.equal(decodeExactWorkspaceFile(JSON.stringify({ relativePath: "../a", content: "x" })), null);
  assert.equal(decodeExactWorkspaceFile(JSON.stringify({ relativePath: "a", content: "" })), null);
  assert.equal(decodeExactWorkspaceFile(JSON.stringify({ relativePath: "a", content: 5 })), null);
  assert.equal(decodeExactWorkspaceFile("[]"), null);
});

test("exact workspace content respects <=4096 code points (Unicode clipping)", () => {
  // 4096 code points of content accepted.
  const long = "a".repeat(4096);
  const req = requestedExactWorkspaceFile(`在工作区创建 a.txt，内容恰好是 ${long}。`);
  assert.equal(req.content.length, 4096);
  // 4097 code points rejected by the parser (the {1,4096} bound).
  const tooLong = "a".repeat(4097);
  assert.equal(
    requestedExactWorkspaceFile(`在工作区创建 a.txt，内容恰好是 ${tooLong}。`),
    null
  );
  // Astral characters count as one code point each toward the bound.
  const emoji = "😀".repeat(4096);
  const emojiReq = requestedExactWorkspaceFile(`在工作区创建 a.txt，内容恰好是 ${emoji}。`);
  assert.equal(emojiReq !== null && codePointLength(emojiReq.content), 4096);
});

// --- exactByteDifference: camelCase diagnostics --------------------------------

test("exactByteDifference reports the first mismatch in camelCase", () => {
  const enc = new TextEncoder();
  // expected: {"enabled":true} (16 bytes); actual inserts a space after ':' so
  // the first mismatch is at byte 11 (expected 't'=0x74, actual ' '=0x20).
  const expected = enc.encode('{"enabled":true}');
  const actual = enc.encode('{"enabled": true}');
  const d = exactByteDifference(expected, actual);
  assert.deepEqual(d, {
    firstMismatchByte: 11,
    expectedByteHex: "74",
    actualByteHex: "20",
    expectedByteLength: 16,
    actualByteLength: 17,
  });
});

test("exactByteDifference reports equality at the shorter length", () => {
  const enc = new TextEncoder();
  const a = enc.encode("abc");
  const b = enc.encode("abcdef");
  assert.deepEqual(exactByteDifference(a, b), {
    firstMismatchByte: 3,
    expectedByteHex: null,
    actualByteHex: "64",
    expectedByteLength: 3,
    actualByteLength: 6,
  });
  assert.deepEqual(exactByteDifference(a, a), {
    firstMismatchByte: 3,
    expectedByteHex: null,
    actualByteHex: null,
    expectedByteLength: 3,
    actualByteLength: 3,
  });
});

test("exactByteDifference hex is lowercase two digits", () => {
  const d = exactByteDifference(new Uint8Array([0x0a, 0xff]), new Uint8Array([0x0b, 0xff]));
  assert.equal(d.firstMismatchByte, 0);
  assert.equal(d.expectedByteHex, "0a");
  assert.equal(d.actualByteHex, "0b");
});
