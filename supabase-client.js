/* Capacitor/browser Supabase client seam.
 * The SDK bundle is loaded immediately before this file in index.html. The
 * local config remains the only source of URL/key values, and this factory is
 * only used after the group-sharing UI records explicit sync consent.
 */
(function attach(root) {
  if (!root || root.RosterBuddySupabaseClientFactory) return;
  const sdk = root.supabase;
  if (!sdk || typeof sdk.createClient !== 'function') return;
  // The app-wide session (legacy-magic-link.js) is the only session. When an
  // accessToken provider is passed, the SDK uses it for REST and realtime and
  // keeps no session of its own; otherwise the SDK manages its own session.
  root.RosterBuddySupabaseClientFactory = function createRosterBuddySupabaseClient(url, key, options) {
    const accessToken = options && typeof options.accessToken === 'function' ? options.accessToken : null;
    if (accessToken) return sdk.createClient(url, key, { accessToken });
    return sdk.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  };
})(typeof window !== 'undefined' ? window : null);
