// Adapted from ZCode 3c5b227 bash-semantics.ts. See source.json and THIRD_PARTY_NOTICES.md.
import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
import { analysisContainsGitAndDirectoryChange, analysisContainsGitCommand, isGitRuntimeContextUnsafe, type BashReadonlyRuntimeContext } from "./bash-git-runtime-safety.js";
import { evaluateBashReadonlyPolicy, hasKnownBashWriteOption } from "./bash-readonly-policy.js";

export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    return false;
  }

  return hasReadOnlyCommand;
}
