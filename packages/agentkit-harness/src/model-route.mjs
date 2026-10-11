export function dshModelRoute(profile = {}, index = 0) {
  const provider = String(profile?.provider || 'ksyun').trim() || 'ksyun';
  const model = String(profile?.modelName || '').trim() || `model-${index + 1}`;
  const id = String(profile?.id || `${provider}:${model}`).trim();
  return `agentkit-studio-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
}
