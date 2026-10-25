// Pure projection of authorized directory receipts; no filesystem I/O or execution authority.
// Behavior reference: KsADK 355059d native_directory_observation.py.
import { createHash } from "node:crypto";
import { canonical } from "../../packages/agentkit-harness-core/dist/index.mjs";

export const DIRECTORY_OBSERVATION_POLICY = "studio-directory-observation/v1";

export const DIRECTORY_MODEL_DESCRIPTION =
  " Use glob to find filenames directly (for example '**/*.py'); narrow path " +
  "before recursive listing. Native returns a bounded path view with explicit " +
  "omissions; the saved complete result retains entry metadata. Sorting by " +
  "size or mtime also exposes that sort value.";

export const DIRECTORY_SCOPE_MODEL_DESCRIPTION =
  DIRECTORY_MODEL_DESCRIPTION +
  " glob filters the selected entries; it does not enable recursion. " +
  "Set recursive=true to search nested directories, including with '**/*.py'. " +
  "An empty nonrecursive listing describes only immediate children.";

const KNOWN_POLICIES = new Set([
  DIRECTORY_OBSERVATION_POLICY,
  "studio-directory-observation/v2",
  "studio-directory-observation/v3",
]);

const METADATA_NOTE =
  "Metadata omitted from this view; use available artifact_uri or narrow path/glob.";

const SCOPE_NOTE =
  "Only immediate children were searched; glob does not enable recursion. " +
  "For nested paths, set recursive=true.";

const POLICY_INVALID = "native_directory_observation_policy_invalid";

function validatePolicy(policy) {
  if (typeof policy !== "string" || !KNOWN_POLICIES.has(policy)) {
    throw new Error(POLICY_INVALID);
  }
}

function utf8Bytes(s) {
  return Buffer.from(s, "utf8").length;
}

// Python ``type(x) is int`` excludes bool; accept JS integer ``number`` or
// ``bigint`` (Python ``int`` is arbitrary precision), reject everything else.
function isIntLike(v) {
  if (typeof v === "bigint") return true;
  if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0)) return true;
  return false;
}

// Minimal PurePosixPath-equivalent helpers. PurePosixPath collapses ``//`` and
// single ``.`` segments but keeps ``..`` (no symlink-erasing normalization) and
// remembers the leading-slash absolute marker. Only the operations the
// reference uses are implemented (is_absolute, ``..`` in parts, parent ==).
function posixSegments(path) {
  const absolute = path.startsWith("/");
  const segs = path.split("/").filter((s) => s !== "" && s !== ".");
  return { absolute, segs };
}

function posixNormalForm(path) {
  const { absolute, segs } = posixSegments(path);
  if (absolute) return segs.length === 0 ? "/" : "/" + segs.join("/");
  return segs.length === 0 ? "." : segs.join("/");
}

function posixParent(path) {
  const { absolute, segs } = posixSegments(path);
  if (absolute) {
    if (segs.length <= 1) return "/";
    return "/" + segs.slice(0, -1).join("/");
  }
  if (segs.length <= 1) return ".";
  return segs.slice(0, -1).join("/");
}

// Quote only actual immediate directory entries; never infer unseen paths.
function childDirectories(value) {
  const base = value.path;
  if (typeof base !== "string" || base === "" || base.includes("\\")) return [];
  const root = posixSegments(base);
  if (root.absolute || root.segs.includes("..")) return [];
  const rootNorm = posixNormalForm(base);
  const result = [];
  for (const entry of value.entries) {
    if (entry.type !== "directory") continue;
    const p = entry.path;
    if (typeof p !== "string" || p.includes("\\")) continue;
    const { segs } = posixSegments(p);
    if (segs.includes("..")) continue;
    if (posixParent(p) === rootNorm) result.push(p + "/");
  }
  return result;
}

export function directoryFeedbackDigest(
  resultBytes,
  { policy = DIRECTORY_OBSERVATION_POLICY } = {},
) {
  validatePolicy(policy);
  if (!Number.isSafeInteger(resultBytes)) throw new Error("native_directory_result_bytes_invalid");
  const payload = canonical({
    policy,
    max_entries: 100,
    max_model_bytes: 4096,
    archive_framing_reserve_bytes: 640,
    result_bytes: resultBytes,
    history: "observed-archive/v4",
  });
  return "sha256:" + createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
}

export function directoryModelReply(
  value,
  arguments_,
  { resultBytes, policy = DIRECTORY_OBSERVATION_POLICY } = {},
) {
  validatePolicy(policy);
  if (!Number.isSafeInteger(resultBytes)) throw new Error("native_directory_result_bytes_invalid");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.ok !== true ||
    !Array.isArray(value.entries) ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }
  const entries = value.entries;
  const args =
    arguments_ && typeof arguments_ === "object" && !Array.isArray(arguments_)
      ? arguments_
      : {};
  // Python ``str(arguments.get("sort_by") or "name").strip().lower()``: a
  // non-string sort_by coerces to a name sort in the reference (the str() of
  // any non-string never matches "size"/"mtime"), so non-string -> name.
  const sortByRaw = args.sort_by;
  const sort =
    (typeof sortByRaw === "string" ? sortByRaw.trim().toLowerCase() : "name") ||
    "name";
  const sortField =
    sort === "size" ? "size" : sort === "mtime" ? "mtime_ns" : undefined;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      (entry.type !== "file" && entry.type !== "directory")
    ) {
      return null;
    }
    if (sortField !== undefined && !isIntLike(entry[sortField])) return null;
  }
  const budget = Math.min(4096, resultBytes - 640);
  const overview = {};
  if (policy === "studio-directory-observation/v3") {
    if (typeof value.path !== "string" || typeof value.recursive !== "boolean") {
      return null;
    }
    const pattern = args.glob;
    if (pattern != null && typeof pattern !== "string") return null;
    overview.listing_scope = {
      path: value.path,
      recursive: value.recursive,
      glob: pattern === undefined ? null : pattern,
    };
    if (entries.length === 0 && value.recursive === false) {
      overview.scope_note = SCOPE_NOTE;
    }
  }
  const paths = [];
  function render() {
    return canonical({
      status: "ok",
      content: {
        paths,
        returned_entries: entries.length,
        shown_entries: paths.length,
        omitted_entries: entries.length - paths.length,
        result_truncated: value.truncated,
        metadata: METADATA_NOTE,
        ...overview,
      },
    });
  }
  if (utf8Bytes(render()) > budget) return null;
  // A recursive alphabetical prefix can be entirely occupied by one large
  // subtree. Preserve the requested path order and separately expose only
  // sibling directories already returned by that same authorized execution.
  // This is not another filesystem read or a claim of complete tree coverage.
  if (
    (policy === "studio-directory-observation/v2" ||
      policy === "studio-directory-observation/v3") &&
    value.recursive === true
  ) {
    const directories = childDirectories(value);
    const shown = [];
    overview.observed_child_directories = shown;
    overview.child_directories_omitted = directories.length;
    overview.child_directory_scope = value.truncated
      ? "returned entries only; listing truncated"
      : "returned entries only";
    if (utf8Bytes(render()) > budget - 128) {
      delete overview.observed_child_directories;
      delete overview.child_directories_omitted;
      delete overview.child_directory_scope;
    } else {
      const overviewBudget = Math.min(1024, Math.floor(budget / 2));
      for (const directory of directories) {
        shown.push(directory);
        overview.child_directories_omitted = directories.length - shown.length;
        if (
          utf8Bytes(canonical(overview)) > overviewBudget ||
          utf8Bytes(render()) > budget - 128
        ) {
          shown.pop();
          overview.child_directories_omitted = directories.length - shown.length;
          break;
        }
      }
    }
  }
  const limit = Math.min(100, entries.length);
  for (let i = 0; i < limit; i++) {
    const entry = entries[i];
    const path = entry.path + (entry.type === "directory" ? "/" : "");
    if (sortField !== undefined) {
      paths.push({ path, [sortField]: entry[sortField] });
    } else {
      paths.push(path);
    }
    if (utf8Bytes(render()) > budget) {
      paths.pop();
      break;
    }
  }
  return render();
}
