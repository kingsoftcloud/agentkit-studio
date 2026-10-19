/** Exact lifecycle evidence required by the patched Host verification gate. */
export const HOST_DEPENDENCY_LIFECYCLE_CHECKS = Object.freeze([
  'late-permission-preset-service-enables-runtime-inspection',
  'late-compatible-service-starts-without-reloading-studio-owner',
  'service-removal-closes-listener-and-replacement-restarts-it',
  'permission-preset-removal-closes-listener-and-replacement-restarts-it',
  'studio-owner-disposal-closes-current-runtime',
  'startup-completing-after-disposal-closes-its-listener',
]);

export function assertHostDependencyLifecycleReport(report) {
  const checks = report?.checks;
  if (report?.evidence !== 'real-cordis-dependency-scopes-controlled-http-runtime'
    || report.passed !== true || report.failure || !Array.isArray(checks)
    || checks.length !== HOST_DEPENDENCY_LIFECYCLE_CHECKS.length
    || checks.some(check => check?.passed !== true)
    || !HOST_DEPENDENCY_LIFECYCLE_CHECKS.every(name => checks.filter(check => check.name === name).length === 1)) {
    throw Object.assign(new Error('Host dependency lifecycle verification did not complete'), { code: 'PATCHED_HOST_LIFECYCLE_INCOMPLETE' });
  }
  return report;
}
