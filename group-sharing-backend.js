/* Production-shaped backend boundary for group sharing.
 *
 * This module intentionally does not import an SDK or create a network client.
 * A reviewed Supabase client/transport may be injected after project setup and
 * explicit sync consent. Until then the adapter remains local and says so.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyGroupSharingBackend = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createApi() {
  function invalidKey() {
    const error = new Error('invalid Supabase client key');
    error.code = 'invalid-client-key';
    return error;
  }

  function decodedJwtRole(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 3) return null;
    try {
      const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4);
      const json = typeof Buffer !== 'undefined'
        ? Buffer.from(padded, 'base64').toString('utf8')
        : decodeURIComponent(Array.from(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
      const payload = JSON.parse(json);
      return payload && typeof payload.role === 'string' ? payload.role : null;
    } catch (_) { return null; }
  }

  function validateClientKey(value) {
    const key = String(value || '').trim();
    if (!key || key.length > 4096) throw invalidKey();
    if (/^(service_role|sb_secret)_/i.test(key)) throw invalidKey();
    if (key.startsWith('sb_publishable_')) return key;
    if (decodedJwtRole(key) === 'anon') return key;
    throw invalidKey();
  }

  function readSupabaseConfig(source = {}) {
    const url = String(source.url || source.supabaseUrl || '').trim();
    const rawKey = source.anonKey || source.publishableKey || source.supabaseAnonKey || '';
    if (!url && !rawKey) return { configured: false, reason: 'backend-not-configured' };
    if (!/^https:\/\/[^\s/]+(?:\/.*)?$/i.test(url)) {
      const error = new Error('invalid Supabase URL'); error.code = 'invalid-client-config'; throw error;
    }
    validateClientKey(rawKey);
    return { configured: true, url, anonKey: String(rawKey).trim() };
  }

  // Provider error text can echo emails, tokens, URLs or SQL. Only our own
  // reviewed `raise exception` strings and a closed set of status/SQLSTATE
  // categories may cross this boundary; everything else becomes a category.
  const SAFE_REASONS = Object.freeze({
    'not authorized': 'not_authorized',
    'invite unavailable': 'invite_unavailable',
    'invitation unavailable': 'invite_unavailable',
    'sharing grant unavailable': 'sharing_unavailable',
    'sharing request unavailable': 'sharing_unavailable',
    'membership unavailable': 'membership_unavailable',
    'household unavailable': 'group_unavailable',
    'active member authorization required': 'not_authorized',
    'signed-in account required': 'sign_in_required',
    'invalid household': 'invalid_input',
    'invalid invitation': 'invalid_input',
    'invalid display name': 'invalid_input',
    'invalid roster': 'invalid_input',
  });
  const CATEGORY_MESSAGES = Object.freeze({
    not_authorized: 'You do not have access to that group.',
    invite_unavailable: 'That invite is not available.',
    sharing_unavailable: 'That sharing request is not available.',
    membership_unavailable: 'That person is not available in this group.',
    group_unavailable: 'That group is not available.',
    sign_in_required: 'Sign in to continue.',
    invalid_input: 'That request was not valid.',
    permission_denied: 'The sharing service refused that request.',
    session_expired: 'Your sharing session has expired. Sign in again.',
    conflict: 'That change conflicts with an existing record.',
    rate_limited: 'The sharing service is rate-limiting requests. Try again later.',
    request_rejected: 'The sharing service rejected the request.',
    server_error: 'The sharing service had a server error.',
    cloud_rpc_error: 'The sharing service returned an unrecognised error.',
  });
  function categoryFor(raw) {
    const reason = typeof (raw && raw.message) === 'string' ? raw.message.trim().toLowerCase() : '';
    if (Object.prototype.hasOwnProperty.call(SAFE_REASONS, reason)) return SAFE_REASONS[reason];
    const code = typeof (raw && raw.code) === 'string' ? raw.code : '';
    if (code === '42501') return 'permission_denied';
    if (code === 'PGRST301' || code === 'PGRST303') return 'session_expired';
    if (code === '23505') return 'conflict';
    if (/^22[0-9A-Z]{3}$/.test(code) || code === 'PGRST102') return 'invalid_input';
    const status = Number(raw && (raw.status || raw.statusCode));
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'permission_denied';
    if (status >= 400 && status <= 499) return 'request_rejected';
    if (status >= 500 && status <= 599) return 'server_error';
    return 'cloud_rpc_error';
  }
  function sanitizeCloudError(raw) {
    const category = categoryFor(raw);
    const error = new Error(CATEGORY_MESSAGES[category]);
    error.code = category;
    const status = Number(raw && (raw.status || raw.statusCode));
    if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
    error.sanitized = true;
    return error;
  }
  function sanitizeTransportError(error) {
    return error && error.sanitized ? error : sanitizeCloudError(error);
  }
  function isRevocationError(error) {
    return Boolean(error && (error.code === 'not_authorized' || error.code === 'sharing_unavailable' || error.code === 'permission_denied'));
  }

  const CONSENT_STATES = Object.freeze(['pending', 'accepted', 'paused', 'declined', 'revoked']);

  function createSupabaseClient(config, factory, options) {
    if (!config || config.configured !== true) throw new Error('backend-not-configured');
    if (typeof factory !== 'function') throw new Error('Supabase client factory required');
    return factory(config.url, config.anonKey, options);
  }

  function createSupabaseTransport(client) {
    if (!client || typeof client !== 'object') throw new Error('Supabase transport client required');
    const requireMethod = (object, name) => {
      if (!object || typeof object[name] !== 'function') throw new Error(`Supabase transport missing ${name}`);
      return object[name].bind(object);
    };
    const auth = client.auth;
    const rpc = requireMethod(client, 'rpc');
    const channel = requireMethod(client, 'channel');
    return {
      getSession: () => requireMethod(auth, 'getSession')(),
      createAccount: (credentials) => requireMethod(auth, 'signUp')(credentials),
      signIn: (credentials) => requireMethod(auth, 'signInWithPassword')(credentials),
      signOut: () => requireMethod(auth, 'signOut')(),
      // Keep RPC argument names aligned with the reviewed SQL signatures. The
      // UI/adapter uses a stable app-facing shape; only this boundary knows
      // Supabase's function parameter names.
      createGroup: (input = {}) => rpc('create_household', { household_name: input.name }),
      createInvite: (input = {}) => rpc('create_invitation', {
        target_household: input.groupId,
        target_email: input.email,
        ttl_seconds: input.ttlMs == null ? undefined : Math.floor(Number(input.ttlMs) / 1000),
      }),
      revokeInvite: (input = {}) => rpc('revoke_invitation', { target_invitation: input.invitationId }),
      acceptInvite: (input = {}) => rpc('accept_invitation', { raw_token: input.token }),
      revokeMember: (input = {}) => rpc('revoke_membership', {
        target_household: input.groupId,
        target_user: input.memberId,
      }),
      updateRoster: (input = {}) => rpc('replace_shared_roster', {
        target_household: input.groupId,
        entries: input.entries || [],
      }),
      setSharingPreference: (input = {}) => rpc('set_sharing_preferences', {
        target_household: input.groupId,
        share_schedule: input.shareSchedule === true,
      }),
      requestReciprocalSharing: (input = {}) => rpc('request_member_sharing', {
        target_household: input.groupId,
        target_user: input.targetUserId,
        source_consent: input.shareSchedule === true,
      }),
      acceptReciprocalSharing: (input = {}) => rpc('accept_member_sharing', { target_grant: input.grantId }),
      declineReciprocalSharing: (input = {}) => rpc('decline_member_sharing', { target_grant: input.grantId }),
      stopReciprocalSharing: (input = {}) => rpc('stop_member_sharing', { target_grant: input.grantId }),
      updateReciprocalRoster: (input = {}) => rpc('replace_reciprocal_roster', {
        target_grant: input.grantId,
        entries: input.entries || [],
      }),
      readReciprocalRoster: (input = {}) => rpc('read_reciprocal_roster', {
        target_household: input.groupId,
        source_user: input.sourceUserId || null,
      }),
      pauseReciprocalSharing: (input = {}) => rpc('pause_member_sharing', { target_grant: input.grantId }),
      resumeReciprocalSharing: (input = {}) => rpc('resume_member_sharing', { target_grant: input.grantId }),
      readGroupSchedule: (input = {}) => rpc('read_group_schedule', { target_household: input.groupId }),
      listGroupPeople: (input = {}) => rpc('list_group_people', { target_household: input.groupId }),
      listGroupSummaries: () => rpc('list_group_summaries'),
      listMySharing: (input = {}) => rpc('list_my_member_sharing', { target_household: input.groupId }),
      setDisplayName: (input = {}) => rpc('set_my_display_name', { new_name: input.displayName }),
      readSharedRoster: (input = {}) => rpc('read_shared_roster', { target_household: input.groupId }),
      listMembers: (input = {}) => rpc('list_household_members', { target_household: input.groupId }),
      listPendingReciprocalRequests: (input = {}) => rpc('list_pending_member_sharing', { target_household: input.groupId }),
      listOwnedHouseholds: () => rpc('list_owned_households'),
      listAccessibleHouseholds: () => rpc('list_accessible_households'),
      subscribeGroup: (groupId, accountId, onChange) => {
        if (typeof onChange !== 'function') throw new Error('realtime listener required');
        const realtime = channel(`shared-roster:${groupId}`);
        const filter = { event: '*', schema: 'public', table: 'shared_roster_entries', filter: `household_id=eq.${groupId}` };
        const subscribed = realtime.on('postgres_changes', filter, onChange);
        if (!subscribed || typeof subscribed.subscribe !== 'function') throw new Error('Supabase realtime channel cannot subscribe');
        subscribed.subscribe();
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          if (typeof subscribed.unsubscribe === 'function') subscribed.unsubscribe();
        };
      },
    };
  }

  function createGroupSharingAdapter({ localApi, localStore, config = {}, transport = null, syncConsent = false } = {}) {
    if (!localApi || !localStore) throw new Error('local group-sharing boundary required');
    const parsed = readSupabaseConfig(config);
    let consent = syncConsent === true;
    const cache = new Map();
    const subscriptions = new Map();

    function cloudSelected() { return parsed.configured && consent; }
    function cloudReady() { return cloudSelected() && transport; }
    function requireCloudTransport() {
      if (!transport) { const error = new Error('backend transport unavailable'); error.code = 'backend-transport-unavailable'; throw error; }
      return transport;
    }
    function status() {
      if (!parsed.configured) return { mode: 'local', configured: false, syncEnabled: false, reason: parsed.reason };
      if (!consent) return { mode: 'local', configured: true, syncEnabled: false, reason: 'sync-consent-required' };
      if (!transport) return { mode: 'local', configured: true, syncEnabled: false, reason: 'backend-transport-unavailable' };
      return { mode: 'cloud', configured: true, syncEnabled: true, reason: 'backend-ready' };
    }
    function unwrapRpc(name, result) {
      if (!result || typeof result !== 'object' || !Object.prototype.hasOwnProperty.call(result, 'data')) return result;
      if (result.error) throw sanitizeCloudError(result.error);
      return result.data;
    }
    function cloudResult(name, result, input) {
      const data = unwrapRpc(name, result);
      if (name === 'createGroup') {
        const id = Array.isArray(data) ? data[0] : data;
        const groupId = id && typeof id === 'object' ? (id.id || id.household_id) : id;
        if (!groupId) throw new Error('cloud group creation returned no group id');
        if (/^group_/i.test(String(groupId))) throw new Error('cloud group creation returned a local group id');
        const ownerId = input.ownerId || null;
        return { id: String(groupId), name: String(input.name || 'Household').trim() || 'Household', ownerId,
          roster: {}, templates: {}, members: ownerId ? { [ownerId]: { role: 'owner', revokedAt: null } } : {} };
      }
      if (name === 'createInvite') {
        // Supabase RPCs can return a row, one-row array, or wrapped object.
        const row = Array.isArray(data) ? data[0] : data && (data.create_invitation || data.invitation || data.row || data);
        const rawToken = row && (row.raw_token || row.rawToken || row.token);
        if (!row || !rawToken) throw new Error('cloud invitation returned no token');
        return { token: rawToken, invitationId: row.invitation_id || row.invitationId || row.id,
          expiresAt: row.expires_at || row.expiresAt, link: `rosterbuddy://invite/${encodeURIComponent(rawToken)}` };
      }
      if (name === 'acceptInvite') {
        const groupId = Array.isArray(data) ? data[0] : data;
        return { groupId: String(groupId && typeof groupId === 'object' ? (groupId.id || groupId.household_id) : groupId) };
      }
      if (name === 'requestReciprocalSharing') {
        const row = Array.isArray(data) ? data[0] : data;
        return { grantId: row && (row.grant_id || row.grantId), status: row && row.status };
      }
      if (name === 'readReciprocalRoster') return (Array.isArray(data) ? data : []).map((row) => ({
        grantId: row.grant_id || row.grantId, sourceUserId: row.source_user_id || row.sourceUserId,
        date: row.date || row.roster_date, shiftCode: row.shiftCode || row.shift_code, label: row.label,
        start: row.start || row.start_time || '', finish: row.finish || row.finish_time || '',
      }));
      if (name === 'readGroupSchedule') return (Array.isArray(data) ? data : []).map((row) => ({
        // Allowlist: nothing beyond schedule fields and a safe label crosses this line.
        sourceUserId: row.source_user_id || row.sourceUserId,
        displayName: String(row.display_name || row.displayName || 'Connected person').slice(0, 60),
        date: row.date || row.roster_date, shiftCode: row.shiftCode || row.shift_code, label: row.label,
        start: row.start || row.start_time || '', finish: row.finish || row.finish_time || '',
        version: Number(row.version) || 0,
      }));
      if (name === 'listGroupPeople') return (Array.isArray(data) ? data : []).map((row) => ({
        userId: row.user_id || row.userId,
        displayName: String(row.display_name || row.displayName || 'Connected person').slice(0, 60),
        role: row.role, isYou: row.is_you === true || row.isYou === true,
      }));
      if (name === 'listGroupSummaries') return (Array.isArray(data) ? data : []).map((row) => ({
        id: String(row.household_id || row.householdId || row.id || ''),
        name: String(row.household_name || row.householdName || row.name || 'Group'),
        role: row.role === 'owner' ? 'owner' : 'member',
        memberCount: Number(row.member_count != null ? row.member_count : row.memberCount) || 0,
        sharedWithMeCount: Number(row.shared_with_me_count != null ? row.shared_with_me_count : row.sharedWithMeCount) || 0,
        pendingRequestCount: Number(row.pending_request_count != null ? row.pending_request_count : row.pendingRequestCount) || 0,
        createdAt: row.created_at || row.createdAt || null,
      })).filter((row) => row.id && !/^group_/i.test(row.id));
      if (name === 'listMySharing') return (Array.isArray(data) ? data : []).map((row) => ({
        grantId: row.grant_id || row.grantId,
        direction: row.direction === 'outgoing' ? 'outgoing' : 'incoming',
        counterpartUserId: row.counterpart_user_id || row.counterpartUserId,
        counterpartDisplayName: String(row.counterpart_display_name || row.counterpartDisplayName || 'Connected person').slice(0, 60),
        status: CONSENT_STATES.includes(row.status) ? row.status : 'revoked',
        updatedAt: row.updated_at || row.updatedAt || null,
      }));
      if (name === 'readSharedRoster') return (Array.isArray(data) ? data : []).map((row) => ({
        date: row.date || row.roster_date, shiftCode: row.shiftCode || row.shift_code, label: row.label,
        start: row.start || row.start_time || '', finish: row.finish || row.finish_time || '',
      }));
      if (name === 'listMembers') return (Array.isArray(data) ? data : []).map((row) => ({
        userId: row.user_id || row.userId,
        displayName: row.display_name || row.displayName || 'Cloud member',
        role: row.role,
        revokedAt: row.revoked_at || row.revokedAt || null,
        joinedAt: row.joined_at || row.joinedAt || null,
      }));
      if (name === 'listPendingReciprocalRequests') return (Array.isArray(data) ? data : []).map((row) => ({
        grantId: row.grant_id || row.grantId,
        groupId: row.household_id || row.householdId,
        sourceUserId: row.source_user_id || row.sourceUserId,
        sourceDisplayName: row.source_display_name || row.sourceDisplayName || 'Connected person',
        requestedAt: row.requested_at || row.requestedAt,
      }));
      if (name === 'listOwnedHouseholds' || name === 'listAccessibleHouseholds') return (Array.isArray(data) ? data : []).map((row) => ({
        id: String(row.household_id || row.householdId || row.id || ''),
        name: String(row.household_name || row.householdName || row.name || 'Household'),
        owner: row.is_owner === true || row.isOwner === true || row.role === 'owner',
      })).filter((row) => row.id && !/^group_/i.test(row.id));
      return data;
    }
    function call(name, args, input) {
      if (cloudSelected()) {
        const cloud = requireCloudTransport();
        if (typeof cloud[name] !== 'function') { const error = new Error(`cloud operation unsupported: ${name}`); error.code = 'cloud-operation-unsupported'; throw error; }
        let result;
        try { result = cloud[name](...args); } catch (error) { throw sanitizeTransportError(error); }
        // The rejection handler is the second argument on purpose: it covers
        // transport failures only, so cloudResult's own errors are not rewrapped.
        return result && typeof result.then === 'function'
          ? result.then((value) => cloudResult(name, value, input), (error) => { throw sanitizeTransportError(error); })
          : cloudResult(name, result, input);
      }
      return localApi[name](localStore, ...args);
    }
    function setSyncConsent(value) {
      consent = value === true;
      if (!consent) disposeRealtime();
      return status();
    }
    function disposeRealtime() {
      subscriptions.forEach((set) => Array.from(set).forEach((cleanup) => cleanup()));
      subscriptions.clear();
    }
    function clearCloudState() {
      disposeRealtime();
      cache.clear();
    }
    function trackSubscription(groupId, cleanup) {
      if (typeof cleanup !== 'function') throw new Error('subscription cleanup required');
      let active = true;
      const wrapped = () => { if (!active) return; active = false; cleanup(); };
      (subscriptions.get(groupId) || new Set()).add(wrapped);
      if (!subscriptions.has(groupId)) subscriptions.set(groupId, new Set([wrapped]));
      return () => { if (!active) return; active = false; cleanup(); const set = subscriptions.get(groupId); if (set) set.delete(wrapped); };
    }
    function handleRevocation(groupId) {
      cache.delete(groupId);
      cache.delete(`schedule:${groupId}`);
      const set = subscriptions.get(groupId);
      if (set) Array.from(set).forEach((cleanup) => cleanup());
      subscriptions.delete(groupId);
    }
    return {
      status,
      setSyncConsent,
      disposeRealtime,
      clearCloudState,
      cacheSharedProjection: (groupId, projection) => cache.set(groupId, Array.isArray(projection) ? projection.slice() : []),
      getCachedProjection: (groupId) => (cache.get(groupId) || []).slice(),
      trackSubscription,
      handleRevocation,
      getSession: () => call('getSession', []),
      createAccount: (input) => cloudSelected()
        ? call('createAccount', [{ email: input.email, password: input.password, options: { data: { display_name: input.displayName } } }])
        : localApi.createAccount(localStore, input),
      signIn: (email, password) => cloudSelected()
        ? call('signIn', [{ email, password }])
        : localApi.signIn(localStore, email),
      signOut: () => cloudSelected() ? call('signOut', []) : localApi.signOut(localStore),
      createGroup: (input) => call('createGroup', [input], input),
      createInvite: (groupId, actorId, options = {}) => call('createInvite', [{ groupId, actorId, email: options.email, ttlMs: options.ttlMs }], options),
      revokeInvite: (invitationId) => call('revokeInvite', [{ invitationId }], { invitationId }),
      acceptInvite: (token, email) => call('acceptInvite', [{ token, email }], { token, email }),
      revokeMember: (groupId, actorId, memberId) => call('revokeMember', [{ groupId, actorId, memberId }], { groupId, actorId, memberId }),
      projectRoster: localApi.projectRoster,
      readSharedRoster: (groupId, accountId) => call('readSharedRoster', [{ groupId, accountId }], { groupId, accountId }),
      listMembers: (groupId, accountId) => call('listMembers', [{ groupId, accountId }], { groupId, accountId }),
      listPendingReciprocalRequests: (groupId, accountId) => call('listPendingReciprocalRequests', [{ groupId, accountId }], { groupId, accountId }),
      listOwnedHouseholds: () => call('listOwnedHouseholds', [], {}),
      listAccessibleHouseholds: () => call('listAccessibleHouseholds', [], {}),
      subscribeGroup: (groupId, accountId, listener) => {
        const cleanup = call('subscribeGroup', [groupId, accountId, listener]);
        return trackSubscription(groupId, cleanup);
      },
      updateRoster: (groupId, actorId, roster, templates) => call('updateRoster', [{ groupId, actorId, entries: localApi.projectRoster(roster, templates) }], { groupId, actorId }),
      setSharingPreference: (groupId, actorId, shareSchedule) => call('setSharingPreference', [{ groupId, actorId, shareSchedule: shareSchedule === true }], { groupId, actorId, shareSchedule: shareSchedule === true }),
      requestReciprocalSharing: (groupId, actorId, targetUserId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('requestReciprocalSharing', [{ groupId, actorId, targetUserId, shareSchedule: true }], { groupId, actorId, targetUserId });
      },
      acceptReciprocalSharing: (grantId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('acceptReciprocalSharing', [{ grantId }], { grantId });
      },
      declineReciprocalSharing: (grantId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('declineReciprocalSharing', [{ grantId }], { grantId });
      },
      stopReciprocalSharing: (grantId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('stopReciprocalSharing', [{ grantId }], { grantId });
      },
      updateReciprocalRoster: (grantId, entries) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('updateReciprocalRoster', [{ grantId, entries }], { grantId });
      },
      pauseReciprocalSharing: (grantId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('pauseReciprocalSharing', [{ grantId }], { grantId });
      },
      resumeReciprocalSharing: (grantId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('resumeReciprocalSharing', [{ grantId }], { grantId });
      },
      // Fail closed: any read error clears this group's cache first, so a revoked
      // reader never keeps a stale combined projection.
      readGroupSchedule: (groupId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        const clear = (error) => { cache.delete(`schedule:${groupId}`); throw error; };
        try {
          const result = call('readGroupSchedule', [{ groupId }], { groupId });
          if (result && typeof result.then === 'function') {
            return result.then((rows) => { cache.set(`schedule:${groupId}`, rows.slice()); return rows; }, clear);
          }
          cache.set(`schedule:${groupId}`, result.slice());
          return result;
        } catch (error) { return clear(error); }
      },
      getCachedGroupSchedule: (groupId) => (cache.get(`schedule:${groupId}`) || []).slice(),
      listGroupPeople: (groupId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('listGroupPeople', [{ groupId }], { groupId });
      },
      listGroupSummaries: () => call('listGroupSummaries', [], {}),
      listMySharing: (groupId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('listMySharing', [{ groupId }], { groupId });
      },
      // Uploads the allowlisted projection (date/code/label/start/finish) to every
      // outgoing grant that is currently 'accepted'. Paused, pending, declined and
      // revoked grants are skipped, so nothing is sent unless consent is active.
      syncOutgoingSchedules: async (groupId, roster, templates) => {
        if (!cloudSelected()) return { uploaded: 0, skipped: 0 };
        const rows = await Promise.resolve(call('listMySharing', [{ groupId }], { groupId }));
        const outgoing = rows.filter((row) => row.direction === 'outgoing');
        const active = outgoing.filter((row) => row.status === 'accepted');
        const entries = localApi.projectRoster(roster, templates);
        for (const row of active) await Promise.resolve(call('updateReciprocalRoster', [{ grantId: row.grantId, entries }], { grantId: row.grantId }));
        return { uploaded: active.length, skipped: outgoing.length - active.length };
      },
      setDisplayName: (displayName) => call('setDisplayName', [{ displayName }], { displayName }),
      isRevocationError,
      readReciprocalRoster: (groupId, sourceUserId) => {
        if (!cloudSelected()) throw new Error('reciprocal cloud sharing is not enabled');
        return call('readReciprocalRoster', [{ groupId, sourceUserId }], { groupId, sourceUserId });
      },
    };
  }

  return { readSupabaseConfig, createSupabaseClient, createSupabaseTransport, createGroupSharingAdapter, sanitizeCloudError, isRevocationError, CONSENT_STATES };
});
