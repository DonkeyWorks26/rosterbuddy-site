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
    // Reasons raised by the live Sandbox RPCs (20261030* migrations).
    'not_a_member': 'not_authorized',
    'authentication_required': 'sign_in_required',
    'range_invalid': 'invalid_input',
    'group_name_invalid': 'invalid_input',
    'owner_must_transfer_or_remove_members': 'owner_must_transfer',
    'owner_required': 'not_authorized',
    'cannot_revoke_owner': 'cannot_revoke_owner',
    'membership_not_found': 'membership_unavailable',
    'too_many_shifts': 'invalid_input',
  });
  const CATEGORY_MESSAGES = Object.freeze({
    not_authorized: 'You do not have access to that group.',
    invite_unavailable: 'That invite is not available.',
    sharing_unavailable: 'That sharing request is not available.',
    membership_unavailable: 'That person is not available in this group.',
    group_unavailable: 'That group is not available.',
    sign_in_required: 'Sign in to continue.',
    invalid_input: 'That request was not valid.',
    owner_must_transfer: 'Remove the other members or hand over the group before leaving it.',
    cannot_revoke_owner: 'The group owner cannot be removed.',
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

  // get_group_roster refuses ranges over 62 days and, given no range, returns one
  // empty row per member. replace_group_roster refuses more than 366 entries.
  const MAX_READ_DAYS = 62;
  const MAX_UPLOAD_ENTRIES = 366;
  const pad2 = (value) => String(value).padStart(2, '0');
  const localIso = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  function addDays(iso, days) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }
  function validIso(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
  // An explicit {from, to} wins (clamped to the server limit); otherwise the
  // current month onward, which is what the group roster preview shows.
  function readWindow(range, nowMs) {
    if (range && validIso(range.from) && validIso(range.to) && range.to >= range.from) {
      const limit = addDays(range.from, MAX_READ_DAYS - 1);
      return { from: range.from, to: range.to > limit ? limit : range.to };
    }
    const today = new Date(nowMs);
    const from = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`;
    return { from, to: addDays(from, MAX_READ_DAYS - 1) };
  }
  // Uploads start at the first day of the previous month so history never
  // pushes a long-time user over the server entry cap.
  const WITHDRAW_FROM = '2026-01-01'; // before this feature existed; nothing was ever shared earlier
  const UPLOAD_SPAN_DAYS = 366; // upsert_my_shifts refuses a window wider than 366 days
  function uploadWindow(nowMs) {
    const from = uploadWindowStart(nowMs);
    return { from, to: addDays(from, UPLOAD_SPAN_DAYS - 1) };
  }
  function uploadWindowStart(nowMs) {
    const today = new Date(nowMs);
    const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return `${previous.getFullYear()}-${pad2(previous.getMonth() + 1)}-01`;
  }

  const CONSENT_STATES = Object.freeze(['pending', 'accepted', 'paused', 'declined', 'revoked']);

  // The app-wide session (Settings > Account) is the only session. When an
  // accessToken provider is passed the SDK uses it for REST and realtime and
  // keeps no session of its own, so sharing calls are never sent anonymously.
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
    // client.auth is read lazily: with an accessToken provider the SDK throws on
    // any auth access, and sharing never signs in through the SDK.
    const auth = () => client.auth;
    const rpc = requireMethod(client, 'rpc');
    const channel = requireMethod(client, 'channel');
    return {
      getSession: () => requireMethod(auth(), 'getSession')(),
      createAccount: (credentials) => requireMethod(auth(), 'signUp')(credentials),
      signIn: (credentials) => requireMethod(auth(), 'signInWithPassword')(credentials),
      signOut: () => requireMethod(auth(), 'signOut')(),
      // These names and parameter keys are the approved Sandbox contract.
      // Do not add a client-side fallback RPC: an unknown function can expose
      // private data or mutate a different schema.
      bootstrapHousehold: (input = {}) => rpc('bootstrap_household', { p_name: input.name }),
      createGroup: (input = {}) => rpc('create_group', {
        p_name: input.name,
        p_display_name: input.displayName || input.ownerDisplayName || 'RosterBuddy user',
      }),
      getGroupRoster: (input = {}) => rpc('get_group_roster', {
        p_group_id: input.groupId,
        p_from: input.from == null ? null : input.from,
        p_to: input.to == null ? null : input.to,
      }),
      listMyGroups: () => rpc('list_my_groups'),
      listGroupInvitations: (input = {}) => rpc('list_group_invitations', { p_group_id: input.groupId }),
      setGroupSharing: (input = {}) => rpc('set_group_sharing', {
        p_household_id: input.groupId,
        p_share_notes: input.shareNotes === true,
      }),
      setMemberRestriction: (input = {}) => rpc('set_member_restriction', {
        p_household_id: input.groupId,
        p_viewer_id: input.memberId,
        // The Sandbox RPC accepts false to apply the notes restriction and
        // null to remove it; true would incorrectly broaden access.
        p_notes_override: input.restricted === true ? false : null,
      }),
      revokeMembership: (input = {}) => rpc('revoke_membership', {
        p_household_id: input.groupId,
        p_user_id: input.memberId,
      }),
      leaveGroup: (input = {}) => rpc('leave_group', { p_group_id: input.groupId }),
      // These Sandbox checks always evaluate auth.uid(); never send a caller-
      // supplied user id that could create an authorization ambiguity.
      isActiveMember: (input = {}) => rpc('is_active_member', { p_group: input.groupId }),
      isGroupOwner: (input = {}) => rpc('is_group_owner', { p_group: input.groupId }),
      createGroupInvitation: (input = {}) => rpc('create_group_invitation', {
        p_group_id: input.groupId,
        p_email: input.email,
        p_ttl_seconds: input.ttlSeconds == null ? 604800 : input.ttlSeconds,
      }),
      acceptGroupInvitation: (input = {}) => rpc('accept_group_invitation', { p_token: input.token }),
      revokeGroupInvitation: (input = {}) => rpc('revoke_group_invitation', { p_invitation_id: input.invitationId }),
      // Any active member uploads their OWN shifts (date_key/code), replacing what they sent for [from, to].
      // No window (null) only adds or updates. replace_group_roster below is the older owner-only call.
      upsertMyShifts: (input = {}) => rpc('upsert_my_shifts', {
        p_group_id: input.groupId,
        p_shifts: Array.isArray(input.shifts) ? input.shifts : [],
        p_from: input.from == null ? null : input.from,
        p_to: input.to == null ? null : input.to,
      }),
      setMyDisplayName: (input = {}) => rpc('set_my_display_name', {
        p_group_id: input.groupId,
        p_display_name: input.displayName,
      }),
      replaceGroupRoster: (input = {}) => rpc('replace_group_roster', {
        p_group_id: input.groupId,
        p_entries: Array.isArray(input.entries) ? input.entries : [],
      }),
      subscribeGroup: (input = {}, listener) => {
        const realtime = channel(`group-roster:${input.groupId}`);
        const configured = realtime.on('postgres_changes', {
          event: '*', schema: 'public', table: 'group_member_shifts',
          filter: `household_id=eq.${input.groupId}`,
        }, listener);
        const subscription = configured && typeof configured.subscribe === 'function' ? configured.subscribe() : configured;
        return () => {
          if (realtime && typeof realtime.unsubscribe === 'function') realtime.unsubscribe();
          return subscription;
        };
      },
    };
  }

  function createGroupSharingAdapter({ localApi, localStore, config = {}, transport = null, syncConsent = false, now = () => Date.now() } = {}) {
    if (!localApi || !localStore) throw new Error('local group-sharing boundary required');
    const parsed = readSupabaseConfig(config);
    let consent = syncConsent === true;
    const cache = new Map();
    const subscriptions = new Map();
    let lastRosterReport = { sent: 0, skipped: 0 };

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
        // create_group returns table(group_id uuid), so a row object; older shapes returned a bare id.
        const groupId = id && typeof id === 'object' ? (id.group_id || id.id || id.household_id) : id;
        if (!groupId) throw new Error('cloud group creation returned no group id');
        if (/^group_/i.test(String(groupId))) throw new Error('cloud group creation returned a local group id');
        const ownerId = input.ownerId || null;
        return { id: String(groupId), name: String(input.name || 'Household').trim() || 'Household', ownerId,
          roster: {}, templates: {}, members: ownerId ? { [ownerId]: { role: 'owner', revokedAt: null } } : {} };
      }
      if (name === 'getGroupRoster') return (Array.isArray(data) ? data : []).map((row) => ({
        userId: row.user_id || row.userId,
        displayName: String(row.display_name || row.displayName || 'Group member').slice(0, 60),
        date: row.date_key || row.dateKey,
        shiftCode: row.code == null ? '' : String(row.code).slice(0, 16),
      }));
      if (name === 'listMyGroups') return (Array.isArray(data) ? data : []).map((row) => ({
        id: String(row.group_id || row.groupId || ''),
        name: String(row.name || 'Group'),
        role: row.role === 'owner' ? 'owner' : 'member',
        displayName: String(row.display_name || row.displayName || 'Group member').slice(0, 60),
        memberCount: Number(row.member_count != null ? row.member_count : row.memberCount) || 0,
      })).filter((row) => row.id && !/^group_/i.test(row.id));
      if (name === 'listGroupInvitations') return (Array.isArray(data) ? data : []).map((row) => ({
        id: row.invitation_id || row.invitationId || row.id,
        email: row.email,
        role: row.role,
        acceptedAt: row.accepted_at || row.acceptedAt || null,
        revokedAt: row.revoked_at || row.revokedAt || null,
      }));
      if (name === 'createGroupInvitation') {
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return row;
        const token = row.token;
        return {
          invitationId: row.invitation_id || row.invitationId,
          token,
          // The server hands back only the one-time token. Build the same link the local path returns so the
          // owner can copy or share it; without it the UI rejects the invite and the token is lost.
          link: token ? `https://donkeyworks26.github.io/rosterbuddy-site/#invite=${encodeURIComponent(token)}` : undefined,
          expiresAt: row.expires_at || row.expiresAt || null,
        };
      }
      if (name === 'acceptGroupInvitation') {
        // accept_group_invitation returns the bare group uuid; the UI reads result.groupId like the local path.
        const row = Array.isArray(data) ? data[0] : data;
        const groupId = row && typeof row === 'object' ? (row.group_id || row.groupId || row.id) : row;
        if (!groupId) throw new Error('invite acceptance returned no group id');
        return { groupId: String(groupId) };
      }
      return data;
    }
    function unsupported(name) {
      const error = new Error(`cloud operation unsupported: ${name}`);
      error.code = 'cloud-operation-unsupported';
      return error;
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
    function peopleFrom(rows, accountId) {
      const seen = new Map();
      rows.forEach((row) => {
        if (!row.userId || seen.has(row.userId)) return;
        seen.set(row.userId, { userId: row.userId, displayName: row.displayName, role: row.userId === accountId ? 'owner' : 'member', revokedAt: null, joinedAt: null });
      });
      return Array.from(seen.values());
    }
    // One member-labelled read for everything the Sandbox exposes: shifts for the window, and (via the
    // empty rows the server returns for members without shifts) the member list.
    function fetchGroupRows(groupId, range) {
      const win = readWindow(range, now());
      return Promise.resolve(call('getGroupRoster', [{ groupId, from: win.from, to: win.to }], { groupId, from: win.from, to: win.to }));
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
      bootstrapHousehold: (name) => {
        if (!cloudSelected()) throw unsupported('bootstrapHousehold');
        return call('bootstrapHousehold', [{ name }], { name });
      },
      createInvite: (groupId, actorId, options = {}) => {
        if (cloudSelected()) return call('createGroupInvitation', [{ groupId, email: options.email, ttlSeconds: options.ttlMs == null ? undefined : Math.round(options.ttlMs / 1000) }], options);
        return call('createInvite', [{ groupId, actorId, email: options.email, ttlMs: options.ttlMs }], options);
      },
      revokeInvite: (invitationId) => {
        if (cloudSelected()) return call('revokeGroupInvitation', [{ invitationId }], { invitationId });
        return call('revokeInvite', [{ invitationId }], { invitationId });
      },
      acceptInvite: (token, email) => {
        if (cloudSelected()) return call('acceptGroupInvitation', [{ token }], { token, email });
        return call('acceptInvite', [{ token, email }], { token, email });
      },
      revokeMember: (groupId, actorId, memberId) => call('revokeMembership', [{ groupId, actorId, memberId }], { groupId, actorId, memberId }),
      leaveGroup: (groupId, actorId) => {
        if (!cloudSelected()) throw unsupported('leaveGroup');
        return call('leaveGroup', [{ groupId, actorId }], { groupId, actorId });
      },
      setMemberRestriction: (groupId, memberId, restricted) => {
        if (!cloudSelected()) throw unsupported('setMemberRestriction');
        return call('setMemberRestriction', [{ groupId, memberId, restricted }], { groupId, memberId, restricted });
      },
      projectRoster: localApi.projectRoster,
      readSharedRoster: (groupId, accountId, range = {}) => {
        if (!cloudSelected()) return call('readSharedRoster', [{ groupId, accountId }], { groupId, accountId });
        return fetchGroupRows(groupId, range).then((rows) => rows.filter((row) => row.date));
      },
      getGroupRoster: (groupId, from, to) => {
        if (!cloudSelected()) throw unsupported('getGroupRoster');
        return call('getGroupRoster', [{ groupId, from, to }], { groupId, from, to });
      },
      listGroupInvitations: (groupId) => {
        if (!cloudSelected()) throw unsupported('listGroupInvitations');
        return call('listGroupInvitations', [{ groupId }], { groupId });
      },
      listMembers: (groupId, accountId) => {
        if (!cloudSelected()) return call('listMembers', [{ groupId, accountId }], { groupId, accountId });
        // Callers only ask as the group manager, so the caller's own row is the manager.
        const today = localIso(new Date(now()));
        return fetchGroupRows(groupId, { from: today, to: today }).then((rows) => peopleFrom(rows, accountId));
      },
      listPendingReciprocalRequests: (groupId, accountId) => {
        if (cloudSelected()) throw unsupported('listPendingReciprocalRequests');
        return call('listPendingReciprocalRequests', [{ groupId, accountId }], { groupId, accountId });
      },
      listMyGroups: () => {
        if (!cloudSelected()) throw unsupported('listMyGroups');
        return call('listMyGroups', [], {});
      },
      listOwnedHouseholds: () => {
        if (!cloudSelected()) throw unsupported('listOwnedHouseholds');
        const result = call('listMyGroups', [], {});
        return result && typeof result.then === 'function'
          ? result.then((rows) => rows.filter((row) => row.role === 'owner'))
          : result.filter((row) => row.role === 'owner');
      },
      listAccessibleHouseholds: () => {
        if (!cloudSelected()) throw unsupported('listAccessibleHouseholds');
        return call('listMyGroups', [], {});
      },
      subscribeGroup: (groupId, accountId, listener) => {
        if (!cloudSelected()) throw unsupported('subscribeGroup');
        const cleanup = call('subscribeGroup', [{ groupId }, listener], { groupId });
        return trackSubscription(groupId, cleanup);
      },
      // Upload the caller's OWN shifts (any active member, not only the manager). The server replaces whatever this
      // person sent inside the window, so a shift removed locally disappears from the group too.
      updateRoster: (groupId, actorId, roster, templates) => {
        if (!cloudSelected()) return false;
        let entries; let skipped = 0; let win = null;
        if (Array.isArray(roster)) entries = roster;
        else {
          win = uploadWindow(now());
          entries = [];
          localApi.projectRoster(roster || {}, templates || {}).filter((row) => row.date >= win.from && row.date <= win.to).forEach((row) => {
            const code = String(row.shiftCode || '').toUpperCase().slice(0, 4);
            // Same rule as the Sandbox: 1-4 printable ASCII characters, no spaces (letters, digits and symbols such as 9=).
            if (/^[!-~]{1,4}$/.test(code)) entries.push({ date: row.date, code }); else skipped += 1;
          });
          entries = entries.slice(0, MAX_UPLOAD_ENTRIES);
        }
        lastRosterReport = { sent: entries.length, skipped };
        const shifts = entries.map((entry) => ({ date_key: entry.date, code: entry.code }));
        return call('upsertMyShifts', [{ groupId, shifts, from: win && win.from, to: win && win.to }], { groupId, shifts });
      },
      // Withdraw: remove everything this person has shared with the group. Shifts uploaded in earlier months
      // would survive a clear of only the current window, so clear from before sharing existed up to the end of
      // the current window, in consecutive windows the server accepts. Succeeds only if every window did.
      stopSharing: (groupId) => {
        if (!cloudSelected()) throw unsupported('stopSharing');
        lastRosterReport = { sent: 0, skipped: 0 };
        const end = uploadWindow(now()).to;
        return (async () => {
          let from = WITHDRAW_FROM;
          while (from <= end) {
            const to = addDays(from, UPLOAD_SPAN_DAYS - 1);
            await Promise.resolve(call('upsertMyShifts', [{ groupId, shifts: [], from, to }], { groupId, shifts: [] }));
            from = addDays(to, 1);
          }
          return true;
        })();
      },
      // What the last cloud upload sent, and how many shifts were left out because their code is not 1-4 letters/digits.
      rosterUploadReport: () => ({ ...lastRosterReport }),
      // What the live Sandbox can do. The reciprocal/consent RPCs of migration 20261027 are not deployed.
      capabilities: () => ({ reciprocalSharing: false, schedulePreference: false, displayName: true, memberUpload: true }),
      setGroupSharing: (groupId, shareNotes) => {
        if (!cloudSelected()) throw unsupported('setGroupSharing');
        return call('setGroupSharing', [{ groupId, shareNotes: shareNotes === true }], { groupId, shareNotes: shareNotes === true });
      },
      // The legacy UI name represents schedule sharing, while Sandbox exposes
      // only the explicitly named notes preference. Never silently translate it.
      setSharingPreference: () => { throw unsupported('setSharingPreference'); },
      requestReciprocalSharing: () => { throw unsupported('requestReciprocalSharing'); },
      acceptReciprocalSharing: () => { throw unsupported('acceptReciprocalSharing'); },
      declineReciprocalSharing: () => { throw unsupported('declineReciprocalSharing'); },
      stopReciprocalSharing: () => { throw unsupported('stopReciprocalSharing'); },
      updateReciprocalRoster: () => { throw unsupported('updateReciprocalRoster'); },
      pauseReciprocalSharing: () => { throw unsupported('pauseReciprocalSharing'); },
      resumeReciprocalSharing: () => { throw unsupported('resumeReciprocalSharing'); },
      readGroupSchedule: (groupId, range) => {
        if (!cloudSelected()) throw unsupported('readGroupSchedule');
        return fetchGroupRows(groupId, range).then((rows) => rows.filter((row) => row.date).map((row) => ({
          sourceUserId: row.userId, displayName: row.displayName || 'Group member', date: row.date, shiftCode: row.shiftCode,
          label: '', start: '', finish: '', version: 0,
        })));
      },
      getCachedGroupSchedule: () => [],
      listGroupPeople: (groupId) => {
        if (!cloudSelected()) throw unsupported('listGroupPeople');
        const today = localIso(new Date(now()));
        return fetchGroupRows(groupId, { from: today, to: today }).then((rows) => peopleFrom(rows, null));
      },
      listGroupSummaries: () => {
        if (!cloudSelected()) throw unsupported('listGroupSummaries');
        return call('listMyGroups', [], {});
      },
      listMySharing: () => { throw unsupported('listMySharing'); },
      syncOutgoingSchedules: async () => { throw unsupported('syncOutgoingSchedules'); },
      setDisplayName: (groupId, displayName) => {
        if (!cloudSelected()) throw unsupported('setDisplayName');
        return call('setMyDisplayName', [{ groupId, displayName }], { groupId, displayName });
      },
      isActiveMember: (groupId, userId) => {
        if (!cloudSelected()) throw unsupported('isActiveMember');
        return call('isActiveMember', [{ groupId, userId }], { groupId, userId });
      },
      isGroupOwner: (groupId, userId) => {
        if (!cloudSelected()) throw unsupported('isGroupOwner');
        return call('isGroupOwner', [{ groupId, userId }], { groupId, userId });
      },
      readReciprocalRoster: () => { throw unsupported('readReciprocalRoster'); },
      isRevocationError,

    };
  }

  return { readSupabaseConfig, createSupabaseClient, createSupabaseTransport, createGroupSharingAdapter, sanitizeCloudError, isRevocationError, CONSENT_STATES };
});
