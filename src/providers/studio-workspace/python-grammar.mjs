/** Ruff's public parse() recovers from invalid syntax and check() also applies
 * compilation checks (e.g. duplicate parameters), so neither is an ast.parse
 * grammar boundary. format() first uses ParsedModule::from_source, the strict
 * grammar parser. Discard its output: validation must never rewrite the file.
 *
 * Do not use comments() for this boundary. Its debug renderer in pinned Ruff
 * 0.16.8 truncates node source by byte offsets and panics on Unicode boundaries.
 * Both workspace syntax validation and command-risk inspection use this same
 * boundary, before their own version/token/AST checks.
 * See astral-sh/ruff 0.16.8 crates/ruff_wasm/src/lib.rs.
 */
export function assertPythonGrammar(workspace, source) {
  workspace.format(source);
}
