import { stripVTControlCharacters } from 'node:util';

/** Keep candidate identity parsing independent of the installed gh CLI version. */
export async function readGitHubJobLogs(execute, path) {
  const options = { maxBuffer: 32 * 1024 * 1024 };
  let result;
  try {
    result = await execute('gh', ['api', '--allow-escape-sequences', path], options);
  } catch (error) {
    // Retry only a CLI capability error, never an authentication/API failure.
    if (!String(error.stderr || '').includes('unknown flag: --allow-escape-sequences')) throw error;
    result = await execute('gh', ['api', path], options);
  }
  return stripVTControlCharacters(result.stdout);
}
