/* Persisted, fail-closed cloud sync consent.
 * The preference is independent from sharing permissions: it only controls
 * whether the app may upload the owner's private local state or keep a live
 * cloud subscription. No cloud data is deleted when local-only is selected.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyCloudSyncConsent = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  const STORAGE_KEY = 'rosterbuddy.cloudSyncPreference.v1';
  const STATES = Object.freeze({ UNSET: 'unset', ENABLED: 'cloud-enabled', LOCAL_ONLY: 'local-only' });
  const VALID = new Set(Object.values(STATES));

  function createSyncPreference(storage) {
    const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    let identityKey = null;
    function key() { return identityKey ? `${STORAGE_KEY}.${identityKey}` : STORAGE_KEY; }
    function setIdentity(identity) {
      const id = typeof identity === 'string' ? identity : identity && (identity.id || identity.userId);
      identityKey = id ? String(id).trim() : null;
      return identityKey;
    }
    function get() {
      try {
        const value = target && target.getItem(key());
        return VALID.has(value) ? value : STATES.UNSET;
      } catch (_) { return STATES.UNSET; }
    }
    function set(value) {
      if (!VALID.has(value) || value === STATES.UNSET) throw new Error('invalid cloud sync preference');
      try { if (target) target.setItem(key(), value); } catch (_) {}
      return value;
    }
    return {
      get,
      set,
      setIdentity,
      identity: () => identityKey,
      canUpload: () => get() === STATES.ENABLED,
      needsFirstUseChoice: (authenticated) => Boolean(authenticated) && get() === STATES.UNSET,
      states: STATES,
    };
  }

  function createSyncLifecycle({ preference, uploadLocalData, unsubscribeRealtime } = {}) {
    if (!preference) throw new Error('sync preference required');
    let realtimeCleanup = null;
    function start() {
      if (!preference.canUpload()) return status();
      if (typeof uploadLocalData === 'function') uploadLocalData();
      return status();
    }
    function chooseCloud() {
      preference.set(STATES.ENABLED);
      return start();
    }
    function stopRealtime() {
      if (realtimeCleanup) { realtimeCleanup(); realtimeCleanup = null; }
      if (typeof unsubscribeRealtime === 'function') unsubscribeRealtime();
    }
    function chooseLocalOnly() {
      preference.set(STATES.LOCAL_ONLY);
      stopRealtime();
      return status();
    }
    function trackRealtime(cleanup) {
      if (typeof cleanup === 'function') realtimeCleanup = cleanup;
      return realtimeCleanup;
    }
    function status() { return { preference: preference.get(), canUpload: preference.canUpload() }; }
    return { start, chooseCloud, chooseLocalOnly, trackRealtime, stopRealtime, status };
  }
  return { STATES, STORAGE_KEY, createSyncPreference, createSyncLifecycle };
});
