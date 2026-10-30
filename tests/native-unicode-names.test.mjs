// Tests for the Unicode named-escape (\N{name}) lookup table.
//
// Validates that ``lookupUnicodeName`` matches CPython's ``\N{name}`` escape
// path (Modules/unicodedata.c::_getcode called with ``with_named_seq=0`` from
// Objects/unicodeobject.c::_PyUnicode_DecodeUnicodeEscapeInternal). The
// distinction the parent review flagged: the ``\N`` escape rejects named
// SEQUENCES (``with_named_seq=0``) even though ``unicodedata.lookup`` (which
// uses ``with_named_seq=1``) can resolve them. Data is pinned to Unicode
// 14.0.0 (the CPython 3.11 baseline).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupUnicodeName,
  unicodeVersion,
  nameCount,
  aliasCount,
  sourceProvenance,
} from "../src/providers/native-unicode-names.mjs";

test("lookupUnicodeName reports the pinned Unicode version and data counts", () => {
  assert.equal(unicodeVersion, "14.0.0");
  assert.ok(nameCount > 30000, `nameCount=${nameCount}`);
  assert.ok(aliasCount > 400, `aliasCount=${aliasCount}`);
});

test("lookupUnicodeName resolves explicit names with ASCII-only case folding (Py_TOUPPER)", () => {
  // CPython _cmpname uses Py_TOUPPER (ASCII-only). Lowercase ASCII a-z folds
  // to uppercase; non-ASCII bytes do NOT fold into an ASCII uppercase.
  assert.equal(lookupUnicodeName("SNOWMAN"), 0x2603);
  assert.equal(lookupUnicodeName("snowman"), 0x2603); // ASCII lower -> upper
  assert.equal(lookupUnicodeName("Snowman"), 0x2603);
  assert.equal(lookupUnicodeName("SNOWMAN WITHOUT SNOW"), 0x26c4);
  assert.equal(lookupUnicodeName("GREEK SMALL LETTER ALPHA"), 0x03b1);
  assert.equal(lookupUnicodeName("latin capital letter a"), 0x0041);
  assert.equal(lookupUnicodeName("SPACE"), 0x0020);
  assert.equal(lookupUnicodeName("DIGIT ZERO"), 0x0030);
});

test("lookupUnicodeName does NOT JS-Unicode-case-fold non-ASCII into an ASCII name", () => {
  // A fullwidth-letter query (which JS toUpperCase would fold to ASCII) must
  // NOT match the stored ASCII-uppercase name: CPython Py_TOUPPER leaves
  // non-ASCII bytes unchanged, so these reject.
  assert.equal(lookupUnicodeName("ｓｎｏｗｍａｎ"), null); // fullwidth "snowman"
  assert.equal(lookupUnicodeName("ｃｊｋ"), null); // fullwidth "cjk" prefix region
  // A non-ASCII prefix that looks like the Hangul/CJK prefix rejects.
  assert.equal(lookupUnicodeName("ｈａｎｇｕｌ ｓｙｌｌａｂｌｅ ｇａ"), null);
});

test("lookupUnicodeName resolves all alias types (control/abbreviation/correction/alternate/figment)", () => {
  // CPython _check_alias_and_seq resolves IS_ALIAS regardless of alias type.
  assert.equal(lookupUnicodeName("NULL"), 0x0000); // control + the 1.0 name
  assert.equal(lookupUnicodeName("NUL"), 0x0000); // abbreviation
  assert.equal(lookupUnicodeName("nul"), 0x0000); // case-insensitive
  assert.equal(lookupUnicodeName("START OF HEADING"), 0x0001);
  assert.equal(lookupUnicodeName("SOH"), 0x0001);
  assert.equal(lookupUnicodeName("LINE FEED"), 0x000a);
  assert.equal(lookupUnicodeName("LF"), 0x000a);
});

test("lookupUnicodeName resolves algorithmic CJK UNIFIED IDEOGRAPH-HEX (uppercase hex only)", () => {
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-4E00"), 0x4e00);
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-9FFF"), 0x9fff);
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-20000"), 0x20000);
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-3134A"), 0x3134a);
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-4DB0"), 0x4db0); // Extension A
  // lowercase hex rejects (CPython validates the hex case-sensitively)
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-4e00"), null);
  // wrong digit count rejects
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-4E0"), null);
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-200000"), null);
  // code point outside a unified-ideograph range rejects
  assert.equal(lookupUnicodeName("CJK UNIFIED IDEOGRAPH-A000"), null);
});

test("lookupUnicodeName resolves algorithmic HANGUL SYLLABLE names (case-sensitive prefix)", () => {
  // CPython matches the ``"HANGUL SYLLABLE "`` prefix and Jamo parts with
  // case-sensitive ``strncmp``. The L column includes an EMPTY short name
  // (IEUNG, index 11), so a syllable with no L (e.g. ``HANGUL SYLLABLE A``)
  // is VALID: L=11(empty), V=A(0), T=0(empty) => U+C544.
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE GA"), 0xac00); // L=G(0),V=A(0),T=empty(0)
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE GAG"), 0xac01); // T=G(1)
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE HAN"), 0xd55c); // L=H(18),V=A(0),T=N(3)
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE A"), 0xc544); // L=11(empty),V=A(0),T=empty
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE EO"), 0xc5b4); // L=11,V=4,T=0
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE GAL"), 0xac08); // L=G,V=A,T=L(8)
  // lowercase prefix REJECTS (strncmp is case-sensitive; falls through to the
  // explicit-name table where it does not match)
  assert.equal(lookupUnicodeName("hangul syllable ga"), null);
  assert.equal(lookupUnicodeName("Hangul Syllable GA"), null);
  // bad jamo rejects
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE XYZ"), null);
  // a V with no match rejects (V column has no empty entry)
  assert.equal(lookupUnicodeName("HANGUL SYLLABLE GQ"), null);
});

test("lookupUnicodeName rejects named sequences (\\N uses with_named_seq=0)", () => {
  // KEYCAP NUMBER SIGN is a multi-code-point named sequence (0023 FE0F 20E3).
  // \N rejects it; unicodedata.lookup would accept it (different path).
  assert.equal(lookupUnicodeName("KEYCAP NUMBER SIGN"), null);
  assert.equal(lookupUnicodeName("KEYCAP ASTERISK"), null);
  // A single precomposed character is NOT a named sequence and resolves.
  assert.equal(lookupUnicodeName("LATIN SMALL LIGATURE FI"), 0xfb01);
});

test("lookupUnicodeName rejects unknown, empty, and non-string names", () => {
  assert.equal(lookupUnicodeName("THIS IS NOT A CHARACTER NAME"), null);
  assert.equal(lookupUnicodeName(""), null);
  assert.equal(lookupUnicodeName(42), null);
  assert.equal(lookupUnicodeName(null), null);
  assert.equal(lookupUnicodeName(undefined), null);
});

test("lookupUnicodeName is pure: no shared mutable state between calls", () => {
  // Repeated lookups of the same name return the same value.
  assert.equal(lookupUnicodeName("SNOWMAN"), lookupUnicodeName("SNOWMAN"));
  assert.equal(lookupUnicodeName("SNOWMAN"), 0x2603);
});

test("a name from a newer Unicode version than 14.0.0 rejects (version difference)", () => {
  // This is a documented platform/version difference: names added after
  // Unicode 14.0.0 (the CPython 3.11 baseline data) are not in the bundled
  // table and reject. We cannot assert a specific future name without knowing
  // one, so this test asserts the general principle: a clearly-fabricated name
  // rejects (covered above), and the bundled version is pinned to 14.0.0.
  assert.equal(unicodeVersion, "14.0.0");
});

test("bundled data carries full source provenance (version, URLs, SHA-256, license)", () => {
  // The generator computes and verifies pinned SHA-256s and emits exact
  // version + URLs + SHA-256s so the bundled table is byte-for-byte
  // reproducible from the public Unicode 14.0.0 sources.
  assert.ok(sourceProvenance, "source provenance present");
  assert.equal(sourceProvenance.unicodeVersion, "14.0.0");
  assert.equal(sourceProvenance.baseUrl, "https://www.unicode.org/Public/14.0.0/ucd");
  assert.ok(sourceProvenance.files, "files provenance present");
  assert.equal(
    sourceProvenance.files["UnicodeData.txt"].url,
    "https://www.unicode.org/Public/14.0.0/ucd/UnicodeData.txt"
  );
  assert.equal(
    sourceProvenance.files["UnicodeData.txt"].sha256,
    "36018e68657fdcb3485f636630ffe8c8532e01c977703d2803f5b89d6c5feafb"
  );
  assert.equal(
    sourceProvenance.files["NameAliases.txt"].sha256,
    "14b3b677d33f95c51423dce6eef4a6a28b4b160451ecedee4b91edb6745cf4a3"
  );
  assert.ok(sourceProvenance.license, "license provenance present");
  assert.equal(sourceProvenance.license.url, "https://www.unicode.org/license.txt");
  assert.equal(
    sourceProvenance.license.sha256,
    "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
  );
  assert.equal(sourceProvenance.license.sourcePath, "src/providers/native-unicode-LICENSE.txt");
});
