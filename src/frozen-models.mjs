/** Public model keys for one immutable bundle, without credentials. */
export function frozenModels(profiles = []) {
  return profiles.filter(profile => profile.enabled !== false && profile.modelName).map(profile => ({
    id: profiles.filter(item => item.enabled !== false && item.modelName === profile.modelName).length > 1 ? profile.id : profile.modelName,
    profileId: profile.id, name: profile.modelName, default: profile.default === true,
  }));
}
