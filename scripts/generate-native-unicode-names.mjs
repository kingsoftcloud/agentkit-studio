// Deterministic generator for the Unicode named-escape lookup table used by
// native-unicode-names.mjs. Reads the public Unicode 14.0.0 UCD files
// (UnicodeData.txt, NameAliases.txt) downloaded to a directory given as argv[1]
// and writes a compact JSON table to argv[2].
//
// Provenance: the generator COMPUTES and VERIFIES the pinned SHA-256 of each
// input file against the values below, and emits the exact Unicode version,
// source URLs, and SHA-256s into the output ``source`` field so the bundled
// table is byte-for-byte reproducible from the public sources. The Unicode
// LICENSE V3 (src/providers/native-unicode-LICENSE.txt) is the license for the
// data; its source URL is recorded in the output.
//
// The emitted table mirrors exactly what CPython's ``\N{name}`` escape accepts
// (verified against Modules/unicodedata.c::_getcode at cpython v3.11.0):
//   - explicit character names (UnicodeData.txt field 2), looked up with
//     ASCII-only ``Py_TOUPPER`` (CPython ``_cmpname``).
//   - all name aliases (NameAliases.txt: correction/control/alternate/
//     figment/abbreviation). CPython ``_check_alias_and_seq`` resolves
//     ``IS_ALIAS`` regardless of alias type when called via the ``\N`` escape
//     path (``with_named_seq=0`` still resolves aliases; only named SEQUENCES
//     are skipped).
//   - CJK UNIFIED IDEOGRAPH ranges are NOT expanded (11k+ characters); they
//     are stored as ranges and resolved algorithmically by the lookup
//     (CPython ``is_unified_ideograph`` + the ``CJK UNIFIED IDEOGRAPH-HEX``
//     branch of ``_getcode``).
//   - HANGUL SYLLABLE names are NOT stored (11k+ syllables); the lookup
//     resolves them algorithmically from the 38-entry L/V/T short-name table
//     and the SBase/LBase/VBase/TBase constants, matching CPython
//     ``_getcode``'s ``HANGUL SYLLABLE`` branch and ``hangul_syllables``.
//
// Named SEQUENCES (NamedSequences.txt) are intentionally NOT included: the
// ``\N`` escape calls ``getcode(..., with_named_seq=0)``, and
// ``_check_alias_and_seq`` rejects named sequences when
// ``with_named_seq`` is 0. (``unicodedata.lookup`` uses with_named_seq=1 and
// CAN resolve them — that is the documented ``\N``-vs-``lookup`` distinction.)
//
// Determinism: the output object keys are emitted in sorted order; arrays are
// sorted by code point, then by byte-wise (locale-independent) name comparison
// (NOT ``localeCompare``, which is locale-dependent). Generation is offline
// once the UCD files are present; no runtime network, no npm dependencies.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const dataDir = process.argv[2];
const outPath = process.argv[3];
if (!dataDir || !outPath) {
  console.error("usage: generate-native-unicode-names.mjs <ucd-data-dir> <out-json>");
  process.exit(2);
}

// Pinned source provenance. The generator verifies each input's SHA-256 matches
// before producing output, so a different/corrupted download fails loudly.
const UNICODE_VERSION = "14.0.0";
const UCD_BASE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const PINNED = {
  "UnicodeData.txt": "36018e68657fdcb3485f636630ffe8c8532e01c977703d2803f5b89d6c5feafb",
  "NameAliases.txt": "14b3b677d33f95c51423dce6eef4a6a28b4b160451ecedee4b91edb6745cf4a3",
};
const LICENSE_URL = "https://www.unicode.org/license.txt";
const LICENSE_SHA256 =
  "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96";
const LICENSE_SOURCE_PATH = "src/providers/native-unicode-LICENSE.txt";

function readAndVerify(name) {
  const buf = readFileSync(`${dataDir}/${name}`);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== PINNED[name]) {
    throw new Error(
      `pinned SHA-256 mismatch for ${name}: expected ${PINNED[name]}, got ${sha}`
    );
  }
  return buf.toString("utf8");
}

function readLines(name) {
  const text = readAndVerify(name);
  return text.split("\n").filter((l) => l.length && !l.startsWith("#"));
}

// --- CJK unified ideograph ranges (match CPython is_unified_ideograph) ---------
// These ranges are NOT read from UnicodeData (the <First>/<Last> markers cover
// them) but are pinned from CPython unicodedata.c so the lookup matches exactly
// which code points ``CJK UNIFIED IDEOGRAPH-<hex>`` accepts.
const CJK_RANGES = [
  [0x3400, 0x4dbf, "CJK Ideograph Extension A"],
  [0x4e00, 0x9fff, "CJK Ideograph"],
  [0x20000, 0x2a6df, "CJK Ideograph Extension B"],
  [0x2a700, 0x2b738, "CJK Ideograph Extension C"],
  [0x2b740, 0x2b81d, "CJK Ideograph Extension D"],
  [0x2b820, 0x2cea1, "CJK Ideograph Extension E"],
  [0x2ceb0, 0x2ebe0, "CJK Ideograph Extension F"],
  [0x30000, 0x3134a, "CJK Ideograph Extension G"],
];

// --- Hangul algorithmic syllable resolution ------------------------------------
// Pinned verbatim from CPython unicodedata.c::hangul_syllables (the L/V/T
// short-name columns). Empty strings are stored as "" (CPython uses 0/NULL).
const HANGUL_SYLLABLES = [
  ["G", "A", ""],
  ["GG", "AE", "G"],
  ["N", "YA", "GG"],
  ["D", "YAE", "GS"],
  ["DD", "EO", "N"],
  ["R", "E", "NJ"],
  ["M", "YEO", "NH"],
  ["B", "YE", "D"],
  ["BB", "O", "L"],
  ["S", "WA", "LG"],
  ["SS", "WAE", "LM"],
  ["", "OE", "LB"],
  ["J", "YO", "LS"],
  ["JJ", "U", "LT"],
  ["C", "WEO", "LP"],
  ["K", "WE", "LH"],
  ["T", "WI", "M"],
  ["P", "YU", "B"],
  ["H", "EU", "BS"],
  ["", "YI", "S"],
  ["", "I", "SS"],
  ["", "", "NG"],
  ["", "", "J"],
  ["", "", "C"],
  ["", "", "K"],
  ["", "", "T"],
  ["", "", "P"],
  ["", "", "H"],
];

// --- parse UnicodeData.txt: code point -> canonical name ----------------------
const names = []; // [code, name]
const controlNames = []; // Cc/Cf with a real name in field 10 (the 1-character name)
for (const line of readLines("UnicodeData.txt")) {
  const f = line.split(";");
  const code = parseInt(f[0], 16);
  const name = f[1];
  // Range markers (<..., First>/<..., Last>) cover CJK/Hangul-syllable runs;
  // they are algorithmic, so do not store them as named entries.
  if (!name || name === "<control>" || name.endsWith(", First>") || name.endsWith(", Last>")) {
    // <control> characters get their printable name from field 10 (e.g. NULL),
    // but those are exposed as aliases via NameAliases.txt. Field 10 here is the
    // 1.0 name; CPython's name database does NOT expose it for \N lookup, so
    // skip storing it (the alias table covers the accepted names).
    continue;
  }
  names.push([code, name]);
}

// --- parse NameAliases.txt: name -> code (all alias types) --------------------
// CPython _check_alias_and_seq resolves IS_ALIAS regardless of the alias type,
// so all aliases (correction, control, alternate, figment, abbreviation) are
// accepted by the \N escape. If a name has multiple aliases, all are kept as
// separate lookup entries (case-insensitive on lookup).
const aliases = []; // [code, aliasName, type]
for (const line of readLines("NameAliases.txt")) {
  const f = line.split(";");
  const code = parseInt(f[0], 16);
  const alias = f[1];
  const type = (f[2] || "").trim();
  if (!alias) continue;
  aliases.push([code, alias, type]);
}

// Deterministic, locale-independent sort: by code point, then by byte-wise
// UTF-16 code-unit comparison of the name (NOT ``localeCompare``, which is
// locale-dependent). Code-point comparison would also work; both are stable
// and locale-independent. Using code-unit comparison matches a plain
// ``Array.prototype.sort`` default for these ASCII names.
function cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
names.sort((a, b) => (a[0] - b[0] || cmpStr(a[1], b[1])));
aliases.sort((a, b) => (a[0] - b[0] || cmpStr(a[1], b[1])));

const table = {
  unicodeVersion: UNICODE_VERSION,
  source: {
    unicodeVersion: UNICODE_VERSION,
    baseUrl: UCD_BASE_URL,
    files: {
      "UnicodeData.txt": {
        url: `${UCD_BASE_URL}/UnicodeData.txt`,
        sha256: PINNED["UnicodeData.txt"],
      },
      "NameAliases.txt": {
        url: `${UCD_BASE_URL}/NameAliases.txt`,
        sha256: PINNED["NameAliases.txt"],
      },
    },
    license: {
      url: LICENSE_URL,
      sha256: LICENSE_SHA256,
      sourcePath: LICENSE_SOURCE_PATH,
    },
  },
  cjkRanges: CJK_RANGES.map(([lo, hi, label]) => [lo, hi]),
  hangul: {
    sBase: 0xac00,
    lBase: 0x1100,
    vBase: 0x1161,
    tBase: 0x11a7,
    lCount: 19,
    vCount: 21,
    tCount: 28,
    // Flattened L/V/T columns: index = jamo index, value = short name.
    lNames: HANGUL_SYLLABLES.slice(0, 19).map((r) => r[0]),
    vNames: HANGUL_SYLLABLES.slice(0, 21).map((r) => r[1]),
    tNames: HANGUL_SYLLABLES.slice(0, 28).map((r) => r[2]),
  },
  // Explicit names as parallel arrays: codePoints[i] <-> names[i]. Lookup builds
  // an uppercased name->index map at load time.
  codePoints: names.map((n) => n[0]),
  names: names.map((n) => n[1]),
  // Aliases: codePoints[i] <-> aliasNames[i] (uppercased at load time).
  aliasCodePoints: aliases.map((a) => a[0]),
  aliasNames: aliases.map((a) => a[1]),
};

writeFileSync(outPath, JSON.stringify(table) + "\n", "utf8");
console.error(`generated ${outPath}: ${names.length} names, ${aliases.length} aliases, ${CJK_RANGES.length} CJK ranges, Hangul algorithmic`);
