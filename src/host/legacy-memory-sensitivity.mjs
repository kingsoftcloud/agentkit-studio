// Screen explicit writes to the legacy Studio memory store before storing or transferring them.
const secretPatterns = [[/api[_-]?key\s*[:=]\s*\S+/iu, 'api_key'], [/secret[_-]?key\s*[:=]\s*\S+/iu, 'secret_key'],
  [/access[_-]?key\s*[:=]\s*\S+|AKIA[0-9A-Z]{16}/iu, 'access_key'], [/cookie\s*[:=]\s*\S+/iu, 'cookie'],
  [/authorization\s*[:=]\s*bearer\s+\S+/iu, 'auth_header'], [/https?:\/\/\S+?(?:X-Amz-Signature|X-Amz-Security-Token|signed)=/iu, 'signed_url'],
  [/(postgres|mysql|mongodb|redis):\/\/\S+:\S+@\S+/iu, 'dsn'], [/sk-[A-Za-z0-9]{20,}/iu, 'token']];
export function nativeMemorySensitiveLabels(content, supplied = []) {
  return [...new Set([...supplied.filter(label => label && label !== 'none'),
    ...secretPatterns.filter(([pattern]) => pattern.test(content)).map(([, label]) => label)])].sort();
}
