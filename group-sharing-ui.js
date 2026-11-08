/* Group UI adapter. Cloud sync is opt-in and only becomes active when a
 * reviewed transport is injected; otherwise this remains an explicit local
 * fallback and never claims multi-device sync. */
(function () {
  const api = window.RosterBuddyGroupSharing;
  const backend = window.RosterBuddyGroupSharingBackend;
  const handoffApi = window.RosterBuddyInviteHandoff;
  if (!api) return;
  function moveRosterExportControls() {
    const exportHost = document.getElementById('share-export-content');
    if (!exportHost) return;
    ['share-picker', 'share-options', 'share-preview', 'share-actions', 'calendar-export-note']
      .map((id) => document.getElementById(id) || document.querySelector(`#screen-share > .${id}`))
      .filter((node) => node && node.parentElement !== exportHost)
      .forEach((node) => exportHost.appendChild(node));
  }
  document.querySelectorAll('[data-open="share-export"]').forEach((button) => button.addEventListener('click', moveRosterExportControls));
  const STORAGE = 'rosterbuddy.local.groupSharing.v1';
  const syncPreference = window.RosterBuddyCloudSyncConsent && window.RosterBuddyCloudSyncConsent.createSyncPreference(localStorage);
  const uiGeneration = (Number(window.RosterBuddyGroupSharingUiGeneration) || 0) + 1;
  window.RosterBuddyGroupSharingUiGeneration = uiGeneration;
  let store = load();
  let syncConsent = syncPreference ? syncPreference.canUpload() : false;
  let adapter = makeAdapter();
  const SELECTED_GROUP_STORAGE = 'rosterbuddy.selectedGroupId';
  let selectedGroupId = (() => {
    try { return sessionStorage.getItem(SELECTED_GROUP_STORAGE) || localStorage.getItem(SELECTED_GROUP_STORAGE) || null; } catch (_) { return null; }
  })();
  // A received invite is kept for 15 minutes. localStorage (not sessionStorage) because the emailed sign-in link opens in a new tab.
  function inviteStore() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (_) {}
    return sessionStorage;
  }
  let pendingInviteToken = (() => {
    const handoff = handoffApi && handoffApi.read(inviteStore());
    if (!handoff) { if (handoffApi) handoffApi.clear(inviteStore()); return ''; }
    return handoff.token;
  })();
  let lastAuthIdentity = null;
  let reciprocalTargetUserId = null;
  let activeGroupSubscription = null;
  // Hub, consent and shared-calendar state. All of it is memory-only and is
  // dropped on sign-out, consent withdrawal, group switch and access loss.
  const CONSENT_LABELS = { pending: 'Waiting', accepted: 'Sharing', paused: 'Paused', revoked: 'Stopped', declined: 'Declined' };
  let hubState = { status: 'loading', groups: [], error: '' };
  let hubRequestId = 0;
  let showCreateForm = false;
  let mySharing = [];
  let calendarGroupId = null;
  let lastUploadKey = '';
  let refreshInFlight = false;
  // Owner roster upload bookkeeping: upload only when the roster actually changed, one at a time, and back off after a failure.
  let rosterUploadKey = '';
  let rosterUploadInFlight = false;
  let rosterUploadRetryAt = 0;
  let uploadNotice = '';
  let realtimeTimer = null;

  function appAuth() { return window.RosterBuddyCurrentAuth || null; }
  function offlineNow() { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  function isTransientError(error) {
    return offlineNow() || Boolean(error && (error.code === 'server_error' || error.code === 'rate_limited'));
  }
  function localSessionProjection(identity) {
    if (!identity) return null;
    store.accounts[identity.id] = {
      id: identity.id,
      email: String(identity.email || '').trim().toLowerCase(),
      displayName: identity.displayName || identity.email || 'App account',
      createdAt: store.accounts[identity.id] ? store.accounts[identity.id].createdAt : Date.now(),
    };
    store.session = { accountId: identity.id, signedInAt: Date.now() };
    return store.accounts[identity.id];
  }

  function makeAdapter() {
    if (!backend) return api;
    const config = window.RosterBuddySupabaseConfig || {};
    let transport = null;
    if (syncConsent) {
      try {
        const parsed = backend.readSupabaseConfig(config);
        const factory = config.clientFactory || window.RosterBuddySupabaseClientFactory;
        const auth = appAuth();
        const accessToken = auth && typeof auth.accessToken === 'function' ? () => auth.accessToken() : undefined;
        const client = backend.createSupabaseClient(parsed, factory, accessToken ? { accessToken } : undefined);
        transport = backend.createSupabaseTransport(client);
      } catch (_) { transport = null; }
    }
    try {
      return backend.createGroupSharingAdapter({ localApi: api, localStore: store, config, transport, syncConsent });
    } catch (_) { return api; }
  }

  function load() {
    try { return api.hydrateStore(JSON.parse(localStorage.getItem(STORAGE) || '{}')); }
    catch (error) { return api.createStore(); }
  }
  function save() {
    const serializable = { accounts: store.accounts, groups: store.groups, invites: store.invites, session: store.session };
    try { localStorage.setItem(STORAGE, JSON.stringify(serializable)); } catch (error) { setStatus('Local storage unavailable; sharing stayed disabled.', true); }
  }
  function el(id) { return document.getElementById(id); }
  function setStatus(message, error = false) {
    const target = el('group-session-status');
    if (target) { target.textContent = message; target.classList.toggle('warning', error); }
  }
  function account() {
    const identity = appAuth() && appAuth().identity();
    return localSessionProjection(identity);
  }
  function selectedGroup() { return selectedGroupId && store.groups[selectedGroupId]; }
  function setShareView(detail) {
    const hub = el('sharing-group-hub');
    const groupDetail = el('sharing-group-detail');
    if (hub) hub.classList.toggle('hidden-control', Boolean(detail));
    if (groupDetail) groupDetail.classList.toggle('hidden-control', !detail);
  }
  function selectGroup(groupId) {
    const nextGroupId = groupId ? String(groupId) : null;
    if (selectedGroupId && selectedGroupId !== nextGroupId && adapter) {
      if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
      if (typeof adapter.handleRevocation === 'function') adapter.handleRevocation(selectedGroupId);
    }
    selectedGroupId = nextGroupId;
    try {
      if (selectedGroupId) sessionStorage.setItem(SELECTED_GROUP_STORAGE, selectedGroupId);
      else sessionStorage.removeItem(SELECTED_GROUP_STORAGE);
    } catch (_) {}
    try {
      localStorage.removeItem(SELECTED_GROUP_STORAGE);
    } catch (_) {}
    return selectedGroupId;
  }
  function isCurrentUi() { return window.RosterBuddyGroupSharingUiGeneration === uiGeneration; }
  function clearLocalGroupsBeforeCloudSelection() {
    Object.keys(store.groups).filter((id) => /^group_/i.test(id)).forEach((id) => { delete store.groups[id]; });
    selectGroup(null);
  }
  function clearCloudDerivedState() {
    uploadNotice = '';
    if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
    if (adapter && typeof adapter.clearCloudState === 'function') adapter.clearCloudState();
    Object.keys(store.groups).filter((id) => !/^group_/i.test(id)).forEach((id) => { delete store.groups[id]; });
    clearSharedCalendar();
    mySharing = [];
    lastUploadKey = '';
    rosterUploadKey = '';
    rosterUploadRetryAt = 0;
    hubRequestId += 1;
    hubState = { status: 'loading', groups: [], error: '' };
    selectGroup(null);
    save();
  }
  function clearSharedCalendar() {
    calendarGroupId = null;
    if (typeof window.RosterBuddyClearCalendarView === 'function') window.RosterBuddyClearCalendarView();
  }
  // Access to a group ended (removed, consent withdrawn, group gone). Drop every
  // cached projection, subscription and calendar view for it, immediately.
  function handleAccessLost(groupId) {
    if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
    if (adapter && typeof adapter.handleRevocation === 'function') adapter.handleRevocation(groupId);
    if (calendarGroupId === groupId) clearSharedCalendar();
    delete store.groups[groupId];
    hubState.groups = hubState.groups.filter((candidate) => String(candidate.id) !== String(groupId));
    mySharing = [];
    lastUploadKey = '';
    rosterUploadKey = '';
    if (selectedGroupId === groupId) selectGroup(null);
    // The detail pane must not keep showing the people or schedule of a group
    // this device can no longer read.
    const members = el('group-members');
    if (members) members.innerHTML = '';
    const preview = el('group-roster-preview');
    if (preview) preview.textContent = 'No shared group selected.';
    const selectedCard = el('sharing-selected-group');
    if (selectedCard) selectedCard.classList.add('hidden-control');
    setShareView(false);
    renderHub();
    save();
    setStatus('Access to that group has changed. Its shared schedule was removed from this device.', true);
  }
  function isAccessError(error) { return Boolean(backend && backend.isRevocationError && backend.isRevocationError(error)); }
  function syncIdentityPreference(identity) {
    if (syncPreference && typeof syncPreference.setIdentity === 'function') syncPreference.setIdentity(identity);
    const previous = syncConsent;
    syncConsent = Boolean(identity && syncPreference && syncPreference.canUpload());
    // The adapter is first built at load, before the account id is known, from the account-less preference.
    // Once the per-account consent is read it must be rebuilt, or a saved consent never reaches the server.
    if (syncConsent !== previous) {
      if (adapter && typeof adapter.clearCloudState === 'function') adapter.clearCloudState();
      if (!syncConsent) clearCloudDerivedState();
      adapter = makeAdapter();
    }
  }
  function clearInviteUiState() {
    const input = el('group-invite-token');
    const output = el('group-invite-output');
    if (input) input.value = '';
    if (output) output.textContent = '';
  }
  // Metadata-only shell for a cloud group; roster/templates stay empty and are
  // never trusted. Role is whatever the server said, not the cached value.
  function ensureGroupShell(info, current) {
    const manages = info.owner === true || info.role === 'owner';
    const group = store.groups[info.id] || { id: info.id, name: info.name, ownerId: null, roster: {}, templates: {}, members: {} };
    group.name = info.name;
    group.ownerId = manages ? current.id : null;
    group.members = group.members || {};
    group.members[current.id] = { role: manages ? 'owner' : 'member', revokedAt: null };
    store.groups[info.id] = group;
    return group;
  }
  let householdRestorePromise = null;
  async function restoreCloudSelection() {
    const current = account();
    const cloudStatus = adapter.status ? adapter.status() : { mode: 'local' };
    if (cloudStatus.mode !== 'cloud' || !current) return selectedGroupId;
    if (householdRestorePromise) return householdRestorePromise;
    householdRestorePromise = (async () => {
      // Cached/local ids are never trusted. Rebuild selection from a server
      // metadata projection so roster/private fields remain separate.
      const cachedSelection = selectedGroupId;
      clearLocalGroupsBeforeCloudSelection();
      // Owned and joined groups are both listed, so a person who manages one
      // group and belongs to another can still reach the second.
      const owned = await Promise.resolve(adapter.listOwnedHouseholds());
      const accessible = await Promise.resolve(adapter.listAccessibleHouseholds());
      const households = owned.concat(accessible.filter((candidate) => !owned.some((entry) => String(entry.id) === String(candidate.id))));
      const byId = new Map(households.map((household) => [String(household.id), household]));
      const verified = cachedSelection && byId.get(String(cachedSelection));
      const chosen = verified || households[0] || null;
      if (!chosen) { selectGroup(null); return null; }
      ensureGroupShell(chosen, current);
      selectGroup(chosen.id);
      return chosen.id;
    })().finally(() => { householdRestorePromise = null; });
    return householdRestorePromise;
  }
  function currentHandoff() { return handoffApi ? handoffApi.read(inviteStore()) : null; }
  function tokenFromInput(value) {
    return handoffApi ? handoffApi.tokenFromLink(value) : String(value || '').trim();
  }
  function renderRosterSwitcher(groups, current, activeGroupId) {
    const select = el('calendar-roster-select');
    const readonly = el('calendar-shared-readonly');
    if (!select) return;
    const options = ['<option value="personal">My calendar</option>'].concat((groups || []).map((group) => `<option value="shared:${escapeHtml(group.id)}">${escapeHtml(group.name || 'Shared roster')}</option>`));
    select.innerHTML = options.join('');
    const chosen = activeGroupId ? `shared:${activeGroupId}` : 'personal';
    select.value = chosen;
    const shared = chosen !== 'personal';
    if (readonly) { readonly.classList.toggle('hidden-control', !shared); }
    if (!shared && typeof window.RosterBuddyClearCalendarView === 'function') window.RosterBuddyClearCalendarView();
  }
  function switcherGroups() {
    return adapter.status && adapter.status().mode === 'cloud' ? hubState.groups : Object.values(store.groups);
  }
  // Sharing is per group and explicit: nothing about a person's roster is uploaded to a group until they have
  // chosen to share with it on this device (the group creator's choice is made by creating the group).
  const GROUP_SHARE_STORAGE = 'rosterbuddy.groupShare.v1';
  const DISPLAY_NAME_STORAGE = 'rosterbuddy.groupDisplayName.v1';
  function readJsonMap(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; }
  }
  function groupShareOn(userId, groupId) { return Boolean(userId && groupId) && readJsonMap(GROUP_SHARE_STORAGE)[`${userId}:${groupId}`] === true; }
  function setGroupShare(userId, groupId, on) {
    if (!userId || !groupId) return;
    const map = readJsonMap(GROUP_SHARE_STORAGE);
    if (on) map[`${userId}:${groupId}`] = true; else delete map[`${userId}:${groupId}`];
    try { localStorage.setItem(GROUP_SHARE_STORAGE, JSON.stringify(map)); } catch (_) {}
  }
  function savedDisplayName(userId) { const value = readJsonMap(DISPLAY_NAME_STORAGE)[userId]; return typeof value === 'string' ? value : ''; }
  function saveDisplayName(userId, name) {
    const map = readJsonMap(DISPLAY_NAME_STORAGE); map[userId] = name;
    try { localStorage.setItem(DISPLAY_NAME_STORAGE, JSON.stringify(map)); } catch (_) {}
  }
  // Best effort: a person who has chosen a name gets it in every group they join or create.
  async function applySavedDisplayName(groupId, current) {
    const name = savedDisplayName(current.id);
    if (!name || !adapter.setDisplayName || !adapter.status || adapter.status().mode !== 'cloud') return;
    try { await Promise.resolve(adapter.setDisplayName(groupId, name)); } catch (_) { /* the name can be set again from the group screen */ }
  }
  // Stop sharing with a group. The server flag is the truth: it is switched off (which also removes my shifts) first, and
  // only once that is confirmed does this device stop uploading. If it fails, the person is told they are STILL sharing.
  async function withdrawSharing(group, current) {
    try {
      await Promise.resolve(adapter.stopSharing(group.id));
      setGroupShare(current.id, group.id, false);
      rosterUploadKey = '';
      return { ok: true, message: `Stopped sharing with ${group.name || 'this group'}. Your shifts were removed from it.` };
    } catch (error) {
      return { ok: false, message: `Could not turn sharing off right now, so you are still sharing with ${group.name || 'this group'}. Check your connection and try again. ${error.message || ''}`.trim() };
    }
  }
  // What the live Sandbox supports; the reciprocal/consent RPCs are not deployed there, so their controls stay hidden.
  function reciprocalSupported() {
    return Boolean(adapter.capabilities && adapter.capabilities().reciprocalSharing === true);
  }
  function applyCapabilityVisibility(cloud) {
    const show = !cloud || reciprocalSupported();
    const button = el('sharing-reciprocal-enable');
    if (button) button.classList.toggle('hidden-control', !show);
    const consent = el('sharing-reciprocal-consent');
    const row = consent && typeof consent.closest === 'function' ? consent.closest('label') : null;
    const target = row || consent;
    if (target) target.classList.toggle('hidden-control', !show);
  }
  // The shared calendar is read one month at a time (the server limits a read to 62 days).
  function viewedMonthRange() {
    const key = typeof window.RosterBuddyViewedMonthKey === 'function' ? window.RosterBuddyViewedMonthKey() : '';
    const match = /^(\d{4})-(\d{2})$/.exec(String(key));
    if (!match) return undefined;
    const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
  }
  // Cloud: the combined, member-labelled projection (fails closed). Local: the
  // single local roster, labelled with the group name.
  async function loadGroupRows(group, current) {
    const cloud = adapter.status && adapter.status().mode === 'cloud';
    if (cloud) return Promise.resolve(adapter.readGroupSchedule(group.id, viewedMonthRange()));
    const rows = await Promise.resolve(adapter.readSharedRoster(group.id, current.id));
    return rows.map((row) => Object.assign({}, row, { sourceUserId: group.ownerId || 'local', displayName: group.name || 'Shared roster' }));
  }
  // Mutual sharing: say plainly why shifts are hidden, instead of showing a blank roster.
  function updateSharedNotice(group, current, rows) {
    const node = el('calendar-shared-notice');
    if (!node) return;
    const cloud = adapter && adapter.status && adapter.status().mode === 'cloud';
    let text = '';
    if (cloud && group && current) {
      const people = (rows && rows.people) || [];
      const meSharing = groupShareOn(current.id, group.id);
      const waiting = people.filter((person) => String(person.id) !== String(current.id) && person.sharing === false).map((person) => person.name);
      if (!meSharing) text = 'You are not sharing your roster, so you cannot see anyone else\u2019s shifts. Turn on \u201CShare my roster\u201D in this group (Share tab). People only see each other while both are sharing.';
      else if (waiting.length) text = `Not sharing yet: ${waiting.join(', ')}. You will see their shifts once they turn sharing on.`;
    }
    node.textContent = text;
    node.classList.toggle('hidden-control', !text);
  }
  async function showGroupCalendar(group, current, onlyUserId) {
    const rows = await loadGroupRows(group, current);
    if (adapter.cacheSharedProjection && adapter.status().mode !== 'cloud') adapter.cacheSharedProjection(group.id, rows);
    if (typeof window.RosterBuddySetCalendarView === 'function') window.RosterBuddySetCalendarView(rows, group.name || 'Shared roster', rows && rows.people);
    updateSharedNotice(group, current, rows);
    calendarGroupId = group.id;
    if (onlyUserId && typeof window.RosterBuddySetCalendarMemberFilter === 'function') window.RosterBuddySetCalendarMemberFilter([onlyUserId]);
    const title = document.querySelector('#screen-calendar .app-topbar .eyebrow:not(.brand-lockup)');
    if (title) title.textContent = group.name || 'Shared roster';
    const readonly = el('calendar-shared-readonly');
    if (readonly) readonly.classList.remove('hidden-control');
    const select = el('calendar-roster-select');
    if (select) select.value = `shared:${group.id}`;
  }
  async function switchGroup(groupId) {
    const current = account();
    const info = hubState.groups.find((candidate) => String(candidate.id) === String(groupId));
    if (!current || !info) throw new Error('That group is not available.');
    if (String(selectedGroupId) !== String(info.id)) { clearSharedCalendar(); mySharing = []; lastUploadKey = ''; }
    ensureGroupShell(info, current);
    selectGroup(info.id);
    return info;
  }
  async function selectRosterView(value) {
    if (!value || value === 'personal') {
      clearSharedCalendar();
      const title = document.querySelector('#screen-calendar .app-topbar .eyebrow:not(.brand-lockup)');
      if (title) title.textContent = 'My calendar';
      return;
    }
    const groupId = value.replace(/^shared:/, '');
    const current = account();
    if (!current) return;
    if (!store.groups[groupId] && adapter.status && adapter.status().mode === 'cloud') await switchGroup(groupId);
    const group = store.groups[groupId];
    if (!group) return;
    try { await showGroupCalendar(group, current); }
    catch (error) {
      // Only a server answer that says access ended removes the group; a wiring or input error must not.
      if (isAccessError(error)) handleAccessLost(groupId);
      throw error;
    }
  }
  async function openGroupCalendar(onlyUserId) {
    const current = account();
    const group = selectedGroup();
    if (!current || !group) throw new Error('Open a group first.');
    try { await showGroupCalendar(group, current, onlyUserId); }
    catch (error) {
      if (isAccessError(error)) handleAccessLost(group.id);
      throw error;
    }
    if (typeof showScreen === 'function') showScreen('calendar');
  }
  // Re-read the open shared view. Access errors clear it at once; only clearly
  // transient failures (offline, 5xx, rate limit) keep the last loaded data.
  async function refreshOpenCalendar() {
    const group = calendarGroupId && store.groups[calendarGroupId];
    const current = account();
    if (!group || !current) return;
    try {
      const rows = await loadGroupRows(group, current);
      if (calendarGroupId !== group.id) return;
      const state = window.RosterBuddyCalendarViewState ? window.RosterBuddyCalendarViewState() : { filter: null };
      window.RosterBuddySetCalendarView(rows, group.name || 'Shared roster', rows && rows.people);
      updateSharedNotice(group, current, rows);
      if (state.filter && window.RosterBuddySetCalendarMemberFilter) window.RosterBuddySetCalendarMemberFilter(state.filter);
    } catch (error) {
      if (isAccessError(error)) { handleAccessLost(group.id); return; }
      setStatus(isTransientError(error) ? 'Could not refresh the group calendar. Showing the last loaded schedule.' : (error.message || 'Could not refresh the group calendar.'), true);
    }
  }
  async function ensureGroupSubscription(group, current, cloudStatus) {
    if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
    if (!group || !current || cloudStatus.mode !== 'cloud' || !adapter.subscribeGroup) return;
    // replace_group_roster deletes and re-inserts every row, so one upload is a burst of change events.
    // They collapse into a single refresh.
    activeGroupSubscription = adapter.subscribeGroup(group.id, current.id, () => {
      if (realtimeTimer) return;
      realtimeTimer = setTimeout(async () => {
        realtimeTimer = null;
        if (String(selectedGroupId) !== String(group.id)) return;
        try {
          if (calendarGroupId === group.id) await refreshOpenCalendar();
          await render();
        } catch (error) {
          if (isAccessError(error)) handleAccessLost(group.id);
        }
      }, 750);
    });
  }
  function localSummaries(current) {
    return Object.values(store.groups)
      .filter((group) => /^group_/i.test(String(group.id)) && group.members && group.members[current.id] && !group.members[current.id].revokedAt)
      .map((group) => ({
        id: group.id, name: group.name || 'Group',
        role: group.ownerId === current.id ? 'owner' : 'member',
        memberCount: Object.values(group.members).filter((member) => !member.revokedAt).length,
        sharedWithMeCount: 0, pendingRequestCount: 0,
      }));
  }
  async function loadHub() {
    const requestId = ++hubRequestId;
    const current = account();
    const cloudStatus = adapter.status ? adapter.status() : { mode: 'local' };
    if (!current) { hubState = { status: 'signed-out', groups: [], error: '' }; renderHub(); return; }
    if (cloudStatus.mode !== 'cloud') { hubState = { status: 'local', groups: localSummaries(current), error: '' }; renderHub(); return; }
    if (offlineNow()) { hubState = { status: 'offline', groups: hubState.groups, error: '' }; renderHub(); return; }
    // A background refresh keeps showing the groups already loaded; the loading notice is for the first load only.
    if (hubState.status !== 'ready' && hubState.status !== 'empty') {
      hubState = { status: 'loading', groups: hubState.groups, error: '' };
      renderHub();
    }
    try {
      const groups = await Promise.resolve(adapter.listGroupSummaries());
      if (requestId !== hubRequestId || !isCurrentUi()) return;
      // The server flag is the truth for "am I sharing in this group": keep this device's upload switch in step with it.
      groups.forEach((g) => { if (g && g.id && typeof g.sharing === 'boolean') setGroupShare(current.id, g.id, g.sharing); });
      hubState = { status: groups.length ? 'ready' : 'empty', groups, error: '' };
    } catch (error) {
      if (requestId !== hubRequestId || !isCurrentUi()) return;
      // Fail closed: an unreadable list is never shown from stale memory.
      hubState = { status: 'error', groups: [], error: error.message || 'Please try again.' };
    }
    renderHub();
  }
  function renderHub() {
    const state = el('sharing-hub-state');
    const list = el('sharing-group-list');
    const retry = el('sharing-hub-retry');
    const newButton = el('sharing-new-group');
    const groups = hubState.groups;
    const messages = {
      loading: 'Loading your groups…',
      'signed-out': 'Sign in from Settings > Account to see your groups. Your local roster is not affected.',
      local: syncPreference && syncPreference.get() === 'unset'
        ? (groups.length ? 'These groups are saved on this phone only until you share one.' : 'You are not in a group yet. Join with an invite, or create a group.')
        : (groups.length ? 'Sharing is off on this device. These groups are saved on this phone only.' : 'Sharing is off on this device. A group you create stays on this phone only.'),
      offline: 'You are offline. The groups shown may be out of date, and changes need a connection.',
      empty: 'You are not in a group yet. Create one, or open an invite you were sent.',
      error: `Could not load your groups. ${hubState.error}`,
      ready: '',
    };
    const text = messages[hubState.status] || '';
    if (state) { state.textContent = text; state.classList.toggle('hidden-control', !text); state.classList.toggle('warning', hubState.status === 'error' || hubState.status === 'offline'); }
    if (retry) retry.classList.toggle('hidden-control', hubState.status !== 'error');
    if (newButton) newButton.classList.toggle('hidden-control', !groups.length || showCreateForm);
    if (!list) return;
    list.innerHTML = groups.map((group) => {
      const selected = String(group.id) === String(selectedGroupId);
      const people = `${group.memberCount} ${group.memberCount === 1 ? 'person' : 'people'}`;
      const role = group.role === 'owner' ? 'You manage this group' : 'Member';
      const requests = group.pendingRequestCount ? ` · ${group.pendingRequestCount} sharing request${group.pendingRequestCount === 1 ? '' : 's'}` : '';
      return `<article class="sharing-group-row${selected ? ' selected' : ''}"><div><strong>${escapeHtml(group.name)}</strong><span class="muted">${escapeHtml(people)} · ${escapeHtml(role)}${escapeHtml(requests)}</span></div><button class="secondary-button compact" type="button" data-select-group="${escapeHtml(group.id)}" aria-pressed="${selected}">${selected ? 'Selected' : 'Open'}</button></article>`;
    }).join('');
  }
  function stateLabel(direction, record) {
    if (!record) return direction === 'outgoing' ? 'Not sharing with them' : '';
    const status = record.status;
    if (direction === 'outgoing') {
      if (status === 'pending') return 'Waiting for them to accept';
      if (status === 'accepted') return 'Sharing your schedule with them';
      if (status === 'paused') return 'Paused — nothing is shared';
      return status === 'declined' ? 'They declined' : 'Stopped';
    }
    if (status === 'accepted') return 'Shared with you';
    if (status === 'paused') return 'Paused by them';
    if (status === 'pending') return 'Waiting for you';
    return 'Stopped';
  }
  function consentMarkup(member, cloud) {
    if (!cloud || member.userId === (account() || {}).id || member.revokedAt) return '';
    const outgoing = mySharing.find((record) => record.direction === 'outgoing' && record.counterpartUserId === member.userId);
    const incoming = mySharing.find((record) => record.direction === 'incoming' && record.counterpartUserId === member.userId);
    const lines = [stateLabel('outgoing', outgoing), stateLabel('incoming', incoming)].filter(Boolean).map((line) => `<span>${escapeHtml(line)}</span>`).join('');
    const buttons = [];
    const out = outgoing && outgoing.status;
    if (!out || out === 'revoked' || out === 'declined') buttons.push(`<button class="secondary-button compact" type="button" data-request-reciprocal="${escapeHtml(member.userId)}">Share my schedule</button>`);
    if (out === 'pending') buttons.push(`<button class="secondary-button compact" type="button" data-stop-reciprocal="${escapeHtml(outgoing.grantId)}">Cancel request</button>`);
    if (out === 'accepted') buttons.push(`<button class="secondary-button compact" type="button" data-pause-reciprocal="${escapeHtml(outgoing.grantId)}">Pause</button><button class="secondary-button compact" type="button" data-stop-reciprocal="${escapeHtml(outgoing.grantId)}">Stop sharing</button>`);
    if (out === 'paused') buttons.push(`<button class="secondary-button compact" type="button" data-resume-reciprocal="${escapeHtml(outgoing.grantId)}">Resume</button><button class="secondary-button compact" type="button" data-stop-reciprocal="${escapeHtml(outgoing.grantId)}">Stop sharing</button>`);
    if (incoming && incoming.status === 'accepted') buttons.push(`<button class="secondary-button compact" type="button" data-view-member="${escapeHtml(member.userId)}">View schedule</button><button class="secondary-button compact" type="button" data-stop-reciprocal="${escapeHtml(incoming.grantId)}">Stop receiving</button>`);
    return lines + buttons.join('');
  }
  function renderDetailHeader(group, current, cloud) {
    const meta = el('sharing-detail-meta');
    const permissions = el('sharing-permissions');
    const manages = group.ownerId === current.id;
    const deleteZone = el('sharing-delete-zone');
    if (deleteZone) deleteZone.classList.toggle('hidden-control', !(manages && cloud));
    const info = hubState.groups.find((candidate) => String(candidate.id) === String(group.id));
    if (meta) {
      const count = info ? `${info.memberCount} ${info.memberCount === 1 ? 'person' : 'people'} · ` : '';
      meta.textContent = `${count}${manages ? 'You manage this group' : 'You are a member'}`;
    }
    if (permissions) {
      const perPerson = !cloud || reciprocalSupported();
      const lines = cloud && !perPerson
        ? (manages
          ? ['You can invite people and remove access.', 'Everyone in this group sees the shift dates and codes of each person who chooses to share.', 'Shift times, pay, notes and recovery are never shared.']
          : ['You can see the shift dates and codes people share with this group.', 'You decide whether to share yours: use the "Share my roster" switch.', 'Shift times, pay, notes and recovery are never shared.'])
        : (manages
          ? ['You can invite people and remove access.', 'You choose who sees your own schedule, person by person.', 'People only see shift dates, codes and times. Pay, notes and recovery are never shared.']
          : ['You can see schedules people have chosen to share with you.', 'You choose who sees your own schedule, person by person.', 'People only see shift dates, codes and times. Pay, notes and recovery are never shared.']);
      if (!cloud) lines.unshift('Sharing is off on this device, so nothing leaves this phone.');
      permissions.innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    }
  }
  const PREVIEW_LIMIT = 40;
  function previewLine(row, cloud) {
    const who = cloud && row.displayName ? `${escapeHtml(row.displayName)} · ` : '';
    const label = row.label ? ` ${escapeHtml(row.label)}` : '';
    const times = row.start ? ` · ${escapeHtml(row.start)}–${escapeHtml(row.finish)}` : '';
    return `${who}${escapeHtml(row.date)} · ${escapeHtml(row.shiftCode)}${label}${times}`;
  }
  let renderSeq = 0;
  async function render() {
    const renderId = ++renderSeq;
    const stale = () => renderId !== renderSeq || !isCurrentUi();
    const current = account();
    // Signed out: only the sign-in prompt is useful; name, groups, create and join need an account.
    // Set before any await or early return below, so a failed group load can never leave a signed-in user without the hub.
    const shareScreen = el('screen-share');
    if (shareScreen && shareScreen.dataset) shareScreen.dataset.signedOut = current ? 'false' : 'true';
    syncIdentityPreference(current);
    const cloudStatus = adapter.status ? adapter.status() : { mode: 'local', reason: 'backend-not-configured' };
    const syncStatus = el('group-sync-status');
    if (syncStatus) syncStatus.textContent = cloudStatus.mode === 'cloud' ? 'Everyone in this group sees your shift days and codes. Never times, pay or notes.' : 'Sharing is off on this device. Turn the switch on to share with a group.';
    const consent = el('group-sync-consent');
    if (consent) consent.checked = syncConsent;
    try { await restoreCloudSelection(); }
    catch (error) { if (stale()) return; hubState = { status: 'error', groups: [], error: error.message || 'Please try again.' }; renderHub(); setStatus(error.message || 'Unable to load your groups.', true); return; }
    if (stale()) return;
    await loadHub();
    if (stale()) return;
    if (calendarGroupId && calendarGroupId !== selectedGroupId) clearSharedCalendar();
    renderRosterSwitcher(switcherGroups(), current, calendarGroupId);
    // A skipped-shift warning stays on screen (it used to be overwritten by the next refresh within a second).
    const baseStatus = current ? (cloudStatus.mode === 'cloud' ? `Signed in as ${current.displayName || current.email}.` : (syncPreference && syncPreference.get() === 'unset' ? `Signed in as ${current.displayName || current.email}.` : `Signed in as ${current.displayName || current.email}. Sharing is off on this device.`)) : 'Sign in to share with a group. Your own roster stays on this phone.';
    const standingNotice = current && cloudStatus.mode === 'cloud' ? uploadNotice : '';
    setStatus(standingNotice ? `${baseStatus} ${standingNotice}` : baseStatus, Boolean(standingNotice));
    // The sign-in prompt only belongs to someone who is signed out.
    const openAccount = el('sharing-open-account');
    const accountRow = openAccount && typeof openAccount.closest === 'function' ? openAccount.closest('.sharing-account-note') : null;
    if (accountRow) accountRow.classList.toggle('hidden-control', Boolean(current));
    const group = selectedGroup();
    const noGroup = el('sharing-no-group');
    const selectedCard = el('sharing-selected-group');
    const groupStatus = el('sharing-group-status');
    const selectedName = el('sharing-selected-group-name');
    const selectedMeta = el('sharing-selected-group-meta');
    if (noGroup) noGroup.classList.toggle('hidden-control', Boolean(group) && !showCreateForm);
    if (selectedCard) selectedCard.classList.toggle('hidden-control', !group);
    const newButton = el('sharing-new-group');
    if (newButton) newButton.classList.toggle('hidden-control', !group || showCreateForm);
    if (groupStatus) groupStatus.textContent = group ? `${hubState.groups.length || 1} ${(hubState.groups.length || 1) === 1 ? 'group' : 'groups'}` : 'No group yet';
    if (selectedName && group) selectedName.textContent = group.name || 'Shared roster';
    if (selectedMeta && group) selectedMeta.textContent = 'Shared roster · read-only';
    if (!group) setShareView(false);
    const preview = el('group-roster-preview');
    const members = el('group-members');
    if (!group || !current) {
      if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
      mySharing = [];
      if (preview) preview.textContent = 'No shared group selected.';
      if (members) members.innerHTML = '';
      return;
    }
    renderDetailHeader(group, current, cloudStatus.mode === 'cloud');
    if (consent && cloudStatus.mode === 'cloud') consent.checked = groupShareOn(current.id, group.id);
    const nameInput = el('sharing-display-name');
    if (nameInput && !nameInput.value) nameInput.value = savedDisplayName(current.id);
    applyCapabilityVisibility(cloudStatus.mode === 'cloud');
    if (preview && !preview.innerHTML) preview.textContent = 'Loading the shared schedule…';
    try {
      const rows = await Promise.resolve(adapter.readSharedRoster(group.id, current.id));
      if (stale()) return;
      await ensureGroupSubscription(group, current, cloudStatus);
      if (preview) {
        const shown = rows.slice(0, PREVIEW_LIMIT).map((row) => previewLine(row, cloudStatus.mode === 'cloud')).join('<br>');
        const more = rows.length > PREVIEW_LIMIT ? `<br>… and ${rows.length - PREVIEW_LIMIT} more` : '';
        preview.innerHTML = `<strong>${escapeHtml(group.name)}</strong><br>${rows.length ? shown + more : 'No shared shifts yet.'}`;
      }
      let memberRows = Object.entries(group.members || {}).map(([id, member]) => ({ userId: id, displayName: (store.accounts[id] || {}).displayName || (id === current.id ? current.displayName : 'Cloud member'), role: member.role, revokedAt: member.revokedAt || null }));
      if (cloudStatus.mode === 'cloud' && group.ownerId === current.id) {
        try {
          memberRows = await Promise.resolve(adapter.listMembers(group.id, current.id));
          group.members = Object.fromEntries(memberRows.filter((member) => member.userId).map((member) => [member.userId, { role: member.role, revokedAt: member.revokedAt, joinedAt: member.joinedAt }]));
        } catch (_) {
          // Owner metadata is optional; never replace a successful roster preview.
        }
      } else if (cloudStatus.mode === 'cloud') {
        // Members cannot call the manager-only list; this one returns names and roles only.
        try { memberRows = await Promise.resolve(adapter.listGroupPeople(group.id)); } catch (_) { /* keep self-only rows */ }
      }
      let pendingRequests = [];
      if (cloudStatus.mode === 'cloud' && typeof adapter.listPendingReciprocalRequests === 'function') {
        try { pendingRequests = await Promise.resolve(adapter.listPendingReciprocalRequests(group.id, current.id)); } catch (_) { pendingRequests = []; }
      }
      if (cloudStatus.mode === 'cloud' && typeof adapter.listMySharing === 'function') {
        try { mySharing = await Promise.resolve(adapter.listMySharing(group.id)); } catch (_) { mySharing = []; }
      }
      if (stale()) return;
      const pendingMarkup = pendingRequests.map((request) => `<article><strong>Schedule request from ${escapeHtml(request.sourceDisplayName)}</strong><span>Pending — nothing is shared until you accept.</span><button class="secondary-button compact" type="button" data-accept-reciprocal="${escapeHtml(request.grantId)}">Accept</button><button class="secondary-button compact" type="button" data-decline-reciprocal="${escapeHtml(request.grantId)}">Decline</button></article>`).join('');
      const cloud = cloudStatus.mode === 'cloud';
      if (members) members.innerHTML = `<p class="eyebrow settings-section-label">People</p>${pendingMarkup}${memberRows.length ? '' : '<p class="muted">No one else is in this group yet. Invite someone to get started.</p>'}${memberRows.map((member) => `<article><strong>${escapeHtml(member.displayName || 'Connected person')}</strong><span>${member.revokedAt ? 'Access removed' : (member.sharing === false ? 'Connected \u00B7 not sharing yet' : 'Connected')}</span>${current.id === group.ownerId && member.userId !== current.id && !member.revokedAt ? `<button class="secondary-button compact" type="button" data-revoke-member="${escapeHtml(member.userId)}">Remove access</button>` : ''}${consentMarkup(member, cloud && reciprocalSupported())}</article>`).join('')}`;
      if (cloud) maybeUploadOutgoing(group).catch(() => {});
    } catch (error) {
      if (stale()) return;
      if (isAccessError(error)) { handleAccessLost(group.id); return; }
      setStatus(error.message || 'Unable to read the shared roster.', true);
      if (preview) preview.textContent = 'Unable to load the shared roster.';
    }
  }
  // Upload the allowlisted projection only to outgoing grants that are accepted
  // right now. Paused/pending/stopped grants are never written to.
  async function maybeUploadOutgoing(group) {
    if (!adapter.syncOutgoingSchedules || !adapter.status || adapter.status().mode !== 'cloud' || !window.RosterBuddyGetLocalRoster) return;
    const accepted = mySharing.filter((record) => record.direction === 'outgoing' && record.status === 'accepted').map((record) => record.grantId).sort().join(',');
    if (!accepted) { lastUploadKey = ''; return; }
    const latest = window.RosterBuddyGetLocalRoster();
    const key = `${group.id}|${accepted}|${JSON.stringify(latest.roster)}|${JSON.stringify(latest.templates)}`;
    if (key === lastUploadKey) return;
    lastUploadKey = key;
    try { await adapter.syncOutgoingSchedules(group.id, latest.roster, latest.templates); }
    catch (error) { lastUploadKey = ''; setStatus(error.message || 'Your schedule could not be shared right now.', true); }
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function holdInviteForGlobalAuth(token) {
    pendingInviteToken = token;
    if (handoffApi) handoffApi.write(inviteStore(), handoffApi.make({ link: token, source: 'received' }));
    setStatus('Invite saved. Sign in (Settings > Account) and it will be accepted for you.');
    return;
  }
  function clearPendingInvite() {
    pendingInviteToken = '';
    if (handoffApi) handoffApi.clear(inviteStore());
  }
  // Joining a group needs the cloud account. This turns cloud viewing on; nothing of the person's own roster is
  // uploaded until they switch "Share my roster" on for that group (a separate, per-group choice).
  function ensureCloudForInvite() {
    if (syncConsent && adapter.status && adapter.status().mode === 'cloud') return true;
    if (syncPreference) syncPreference.set('cloud-enabled');
    syncConsent = syncPreference ? syncPreference.canUpload() : true;
    adapter = makeAdapter();
    return Boolean(adapter.status && adapter.status().mode === 'cloud');
  }
  let inviteResumeInFlight = false;
  const INVITE_OUTCOME_KEY = 'rosterbuddy.inviteOutcome.v1';
  function recordInviteOutcome(outcome) { try { localStorage.setItem(INVITE_OUTCOME_KEY, JSON.stringify({ outcome, at: Date.now(), tab: tabId })); } catch (_) {} }
  function recentInviteOutcome() {
    try { const saved = JSON.parse(localStorage.getItem(INVITE_OUTCOME_KEY) || 'null'); return saved && Date.now() - saved.at < 30000 ? saved.outcome : ''; } catch (_) { return ''; }
  }
  // Two open tabs can both see the same waiting invite (one landed on it, the other finished the emailed sign-in).
  // Only one may accept it; an invite works once, so the second would only show a false error.
  const INVITE_CLAIM_KEY = 'rosterbuddy.inviteClaim.v1';
  const tabId = Math.random().toString(36).slice(2);
  // Write the claim, wait a moment, and confirm it is still ours: two tabs checking at the same instant both see it
  // empty, but whichever wrote last is the only one that still finds its own id afterwards.
  async function claimInvite(token) {
    try {
      const now = Date.now();
      const existing = JSON.parse(localStorage.getItem(INVITE_CLAIM_KEY) || 'null');
      if (existing && existing.token === token && existing.tab !== tabId && now - existing.at < 60000) return false;
      localStorage.setItem(INVITE_CLAIM_KEY, JSON.stringify({ token, tab: tabId, at: now }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      const check = JSON.parse(localStorage.getItem(INVITE_CLAIM_KEY) || 'null');
      return Boolean(check && check.tab === tabId);
    } catch (_) { return true; }
  }
  async function resumePendingInvite() {
    const current = account();
    if (!pendingInviteToken || !current || inviteResumeInFlight) return;
    // The stored invite is gone: another tab already used it (or its 15 minutes ran out). Nothing to accept here.
    if (handoffApi && !currentHandoff()) { pendingInviteToken = ''; return; }
    // An invite this person just CREATED for someone else is never accepted by their own app (it would only ever error).
    const waiting = currentHandoff();
    if (waiting && waiting.source === 'owner-created') return;
    inviteResumeInFlight = true;
    try {
      if (!(await claimInvite(pendingInviteToken))) return;
      if (handoffApi && !currentHandoff()) { pendingInviteToken = ''; return; }
      await resumePendingInviteNow(current);
    } finally { inviteResumeInFlight = false; }
  }
  async function resumePendingInviteNow(current) {
    const handoff = currentHandoff();
    if (handoffApi && !handoffApi.belongsTo(handoff, current)) {
      clearPendingInvite();
      setStatus('This invite was issued for a different account. Create or open a fresh invite.', true);
      return;
    }
    const token = handoff ? handoff.token : pendingInviteToken;
    try {
      if (!ensureCloudForInvite()) throw new Error('Sharing is not available on this device right now.');
      const result = await Promise.resolve(adapter.acceptInvite(token, current.email));
      recordInviteOutcome('accepted');
      clearPendingInvite();
      await applySavedDisplayName(result.groupId, current);
      selectGroup(result.groupId);
      save();
      await render();
      const output = el('group-invite-output');
      if (output) output.textContent = 'Invite accepted. Only the shared roster projection is visible.';
      setStatus('Invite accepted. You can see this group\u2019s calendar. Your own shifts stay private until you switch on Share my roster.');
    } catch (error) {
      // A failed invite is not retried on every page load: the person is told, and can ask for a fresh one.
      recordInviteOutcome('failed');
      clearPendingInvite();
      setStatus(`${error.message || 'Invite acceptance failed.'} Ask for a fresh invite for the email you are signed in with.`, true);
    }
  }
  function run(action) {
    Promise.resolve().then(action).then(async (successMessage) => { save(); await render(); if (successMessage) setStatus(successMessage); })
      .catch((error) => { setStatus(error.message || 'Group sharing action failed.', true); });
  }

  function cloudUser(result) {
    const data = result && result.data ? result.data : {};
    const user = data.user || (data.session && data.session.user) || null;
    return user ? { id: user.id, email: user.email || '', displayName: (user.user_metadata && (user.user_metadata.display_name || user.user_metadata.name)) || user.email || 'Cloud account' } : null;
  }
  el('sharing-open-group').addEventListener('click', () => {
    if (!selectedGroup()) return;
    setShareView(true);
    const heading = el('sharing-detail-title');
    if (heading) heading.textContent = selectedGroup().name || 'Shared roster';
  });
  el('sharing-invite-people').addEventListener('click', () => {
    if (!selectedGroup()) return;
    setShareView(true);
    const panel = el('sharing-invite-panel');
    if (panel) panel.classList.remove('hidden-control');
    const toggle = el('sharing-invite-panel-toggle');
    if (toggle) toggle.textContent = 'Close invite';
  });
  el('sharing-back-to-groups').addEventListener('click', () => { resetDeleteGroupUi(); setShareView(false); });
  // Delete group (owner only; the server enforces it too). Two steps: open the warning, then type the group name.
  function resetDeleteGroupUi() {
    const box = el('sharing-delete-confirm'); const name = el('sharing-delete-name'); const go = el('sharing-delete-confirm-button');
    if (box) box.classList.add('hidden-control');
    if (name) name.value = '';
    if (go) go.disabled = true;
  }
  const deleteNameMatches = () => { const g = selectedGroup(); return Boolean(g && String(g.name || '').trim() && String((el('sharing-delete-name') || {}).value || '').trim().toLowerCase() === String(g.name).trim().toLowerCase()); };
  on('sharing-delete-group', 'click', () => { const box = el('sharing-delete-confirm'); if (box) box.classList.remove('hidden-control'); });
  on('sharing-delete-cancel', 'click', resetDeleteGroupUi);
  on('sharing-delete-name', 'input', () => { const go = el('sharing-delete-confirm-button'); if (go) go.disabled = !deleteNameMatches(); });
  on('sharing-delete-confirm-button', 'click', () => {
    const group = selectedGroup(); const current = account();
    if (!group || !current || !deleteNameMatches()) return;
    const groupId = group.id; const groupName = group.name;
    run(async () => {
      // Nothing is removed locally until the server has confirmed; a failure leaves the group exactly as it was.
      await Promise.resolve(adapter.deleteGroup(groupId));
      handleAccessLost(groupId);
      resetDeleteGroupUi();
      setShareView(false);
      try { await loadHub(); } catch (_) { /* the hub shows its own error */ }
      return `Deleted ${groupName}.`;
    });
  });
  el('sharing-invite-panel-toggle').addEventListener('click', () => {
    const panel = el('sharing-invite-panel');
    if (!panel) return;
    const open = panel.classList.toggle('hidden-control');
    el('sharing-invite-panel-toggle').textContent = open ? 'Invite someone' : 'Close invite';
  });
  // The switch applies at once; the hidden save button remains the single code path.
  el('group-sync-consent').addEventListener('change', () => { el('group-enable-sync').click(); });
  el('group-enable-sync').addEventListener('click', async () => {
    syncConsent = Boolean(el('group-sync-consent').checked);
    const current = account();
    if (syncConsent && current && adapter.status && adapter.status().mode === 'cloud') {
      const typed = String((el('sharing-display-name') || {}).value || '').trim();
      if (typed && typed.length <= 40 && !typed.includes('@')) saveDisplayName(current.id, typed);
      if (!savedDisplayName(current.id)) {
        el('group-sync-consent').checked = false;
        syncConsent = false;
        setStatus('Add your name first, so your group knows whose shifts these are.', true);
        const nameBox = el('sharing-display-name'); if (nameBox && typeof nameBox.focus === 'function') nameBox.focus();
        return;
      }
    }
    if (!syncConsent) {
      // Unticking while a cloud group is open withdraws sharing with that group but keeps cloud viewing on.
      const open = selectedGroup();
      if (current && open && adapter.status && adapter.status().mode === 'cloud' && !/^group_/i.test(String(open.id))) {
        syncConsent = syncPreference ? syncPreference.canUpload() : false;
        const outcome = await withdrawSharing(open, current);
        await render();
        setStatus(outcome.message, !outcome.ok);
        return;
      }
      if (syncPreference) syncPreference.set('local-only');
      clearCloudDerivedState();
      setStatus('Turn on the switch to share.', true);
      return;
    }
    if (syncPreference) syncPreference.set('cloud-enabled');
    adapter = makeAdapter();
    const status = adapter.status ? adapter.status() : { mode: 'local', reason: 'backend-not-configured' };
    if (status.mode !== 'cloud') {
      await render();
      setStatus(status.reason === 'backend-transport-unavailable' ? 'Cloud sync consent recorded, but no configured client factory is available. Staying local/offline.' : 'Cloud sync is not configured. Staying local/offline.', true);
      return;
    }
    await restoreCloudSelection();
    const group = selectedGroup();
    if (!current || !group || /^group_/i.test(String(group.id))) {
      await render();
      setStatus('Cloud sync is on. Create a group or accept an invite, then switch sharing on.', true);
      return;
    }
    try {
      await applySavedDisplayName(group.id, current);
      await Promise.resolve(adapter.setMySharing(group.id, true));
      setGroupShare(current.id, group.id, true);
      rosterUploadKey = '';
      await render();
      setStatus(`Sharing your shift dates and codes with ${group.name || 'this group'}. Everyone in the group can see them.`);
    } catch (error) {
      setGroupShare(current.id, group.id, false);
      syncConsent = false;
      adapter = makeAdapter();
      await render();
      setStatus(error.message || 'Cloud sharing consent could not be saved.', true);
    }
  });

  el('group-create').addEventListener('click', () => {
    if (!isCurrentUi()) return;
    return run(async () => {
      const currentRoster = window.RosterBuddyGetLocalRoster ? window.RosterBuddyGetLocalRoster() : { roster: {}, templates: {} };
      const current = account();
      if (!current) throw new Error('sign in before creating a group');
      // Creating a group is a sharing action. If cloud sync is still undecided, turn it on so the group is real and
      // the people invited can see it; someone who chose "this device only" keeps that choice (and is told below).
      if (syncPreference && syncPreference.get() === 'unset') ensureCloudForInvite();
      const currentStatus = adapter.status ? adapter.status() : { mode: 'local' };
      const group = await Promise.resolve(adapter.createGroup({ name: el('group-name').value, ownerId: current.id, displayName: savedDisplayName(current.id) || undefined, roster: currentRoster.roster, templates: currentRoster.templates }));
      if (!group || !group.id) throw new Error('group creation returned no group id');
      if (currentStatus.mode === 'cloud' && /^group_/i.test(String(group.id))) throw new Error('cloud group creation returned a local group id');
      if (currentStatus.mode === 'cloud') clearLocalGroupsBeforeCloudSelection();
      store.groups[group.id] = group;
      selectGroup(group.id);
      // Creating a group is the manager's choice to share with the people they invite.
      if (currentStatus.mode === 'cloud') {
        // Creating a group opts the creator in. The server flag is set first; if that fails the person is simply not sharing yet.
        try { await Promise.resolve(adapter.setMySharing(group.id, true)); setGroupShare(current.id, group.id, true); } catch (_) { setGroupShare(current.id, group.id, false); }
        rosterUploadKey = '';
      }
      showCreateForm = false;
      const phoneOnly = currentStatus.mode !== 'cloud';
      const created = phoneOnly
        ? `Created ${group.name} on this phone only. Turn on Sync across devices in Settings so other people can join it.`
        : `Created ${group.name}. Sharing is ready.`;
      setStatus(created, phoneOnly);
      return created;
    });
  });
  let lastInvitedEmail = '';
  let lastInvite = null;
  async function createInviteNow() {
    const group = selectedGroup() || Object.values(store.groups).find((candidate) => candidate.ownerId === account()?.id);
    if (!group) throw new Error('create a group first');
    selectGroup(group.id);
    const current = account();
    if (!current) throw new Error('sign in before creating an invite');
    const invitedEmail = String(el('group-invite-email').value || '').trim().toLowerCase();
    if (!invitedEmail) throw new Error('enter the connected person’s confirmed email first');
    clearPendingInvite();
    clearInviteUiState();
    const invite = await Promise.resolve(adapter.createInvite(group.id, current.id, { email: invitedEmail }));
    if (!invite || !invite.link) throw new Error('invite creation returned no link');
    el('group-invite-token').value = invite.link;
    if (handoffApi) handoffApi.write(inviteStore(), handoffApi.make({ link: invite.link, ownerId: current.id, ownerEmail: current.email, invitedEmail, source: 'owner-created' }));
    pendingInviteToken = invite.token || handoffApi.tokenFromLink(invite.link);
    el('group-invite-output').textContent = `Fresh invite created for the intended account (expires ${new Date(invite.expiresAt).toLocaleString()}). Copy or share this link now; it is single-use.`;
    lastInvitedEmail = invitedEmail;
    lastInvite = { groupId: group.id, invitationId: invite.invitationId || '', token: invite.token || '' };
    return invite;
  }
  el('group-invite').addEventListener('click', () => run(async () => { await createInviteNow(); }));
  // The message the Owner sends. It names the email the invite is for, because only that account can accept it.
  function inviteMessage(link) {
    const invited = String((el('group-invite-email') || {}).value || '').trim();
    return {
      subject: 'Join my RosterBuddy shared roster',
      text: `I\u2019ve invited you to share rosters on RosterBuddy. Open this link and sign in${invited ? ` with ${invited}` : ''} to accept. It works once and expires in 7 days.\n${link}`,
    };
  }
  async function copyToClipboard(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (_) {}
    try {
      const area = document.createElement('textarea');
      area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(area);
      return Boolean(ok);
    } catch (_) { return false; }
  }
  // One tap: make sure there is a fresh invite for the typed email, then hand the message to the owner's email app
  // already addressed to that person. RosterBuddy itself cannot send email; the owner presses Send in their mail app.
  async function ensureInviteForTypedEmail() {
    const invited = String((el('group-invite-email') || {}).value || '').trim().toLowerCase();
    if (!invited) throw new Error('Type the email address of the person you are inviting first.');
    let link = el('group-invite-token').value.trim();
    if (!link || lastInvitedEmail !== invited) {
      await createInviteNow();
      save(); await render();
      link = el('group-invite-token').value.trim();
    }
    if (!link) throw new Error('Could not create the invite. Please try again.');
    return { link, invited };
  }
  const EMAIL_REASONS = {
    rate_limited: 'You have sent several invites recently. Please wait a while, or use Share another way.',
    invitation_too_old: 'That invite is too old to email, and a fresh one could not be sent either. Please try again in a moment.',
    not_owner: 'Only the group owner can send invites.',
  };
  // The server refused this particular invitation: make a fresh one and try once more (never loop on a stale link).
  const STALE_INVITE_REASONS = new Set(['already_sent', 'invitation_too_old', 'invitation_not_found']);
  el('group-share-invite').addEventListener('click', async () => {
    let prepared; let emailUnavailableReason = '';
    try { prepared = await ensureInviteForTypedEmail(); } catch (error) { setStatus(error.message || 'Could not prepare the invite.', true); return; }
    // 1. Preferred: RosterBuddy emails the invitation itself (server side). Nothing for the owner to do.
    const canEmail = adapter && typeof adapter.sendInviteEmail === 'function' && lastInvite && lastInvite.invitationId && lastInvite.token;
    if (canEmail) {
      setStatus(`Sending the invite to ${prepared.invited}\u2026`);
      let outcome = await adapter.sendInviteEmail({ groupId: lastInvite.groupId, invitationId: lastInvite.invitationId, token: lastInvite.token });
      if (!outcome.sent && STALE_INVITE_REASONS.has(outcome.reason)) {
        // Tapped again, or the invite went stale: make a fresh invite (this cancels the earlier one) and email that.
        try { lastInvitedEmail = ''; prepared = await ensureInviteForTypedEmail(); } catch (error) { setStatus(error.message || 'Could not prepare the invite.', true); return; }
        outcome = await adapter.sendInviteEmail({ groupId: lastInvite.groupId, invitationId: lastInvite.invitationId, token: lastInvite.token });
      }
      if (outcome.sent) { setStatus(`Invite emailed to ${prepared.invited}. They open the link, sign in with that email, and they are in.`); return; }
      if (EMAIL_REASONS[outcome.reason]) { setStatus(EMAIL_REASONS[outcome.reason], true); return; }
      // Any other reason (not set up yet, offline, server problem): fall through to the owner's own mail app,
      // and say why, so a broken server path is never mistaken for the normal flow.
      emailUnavailableReason = String(outcome.reason || 'unknown');
    }
    // 2. Fallback: the owner's mail app, already addressed to the invited person.
    const message = inviteMessage(prepared.link);
    const copied = await copyToClipboard(message.text);
    try {
      const anchor = document.createElement('a');
      anchor.href = `mailto:${encodeURIComponent(prepared.invited).replace(/%40/g, '@')}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.text)}`;
      anchor.rel = 'noopener'; document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
    } catch (_) {}
    const why = emailUnavailableReason ? `Automatic email is unavailable (${emailUnavailableReason}). ` : '';
    setStatus(`${why}Your email app should open with the invite to ${prepared.invited}. Press Send there.${copied ? ' The message is also copied in case it does not open.' : ''}`, Boolean(emailUnavailableReason));
  });
  // Any other way (Messages, WhatsApp, ...): the system share sheet.
  el('group-share-invite-other').addEventListener('click', async () => {
    let prepared;
    try { prepared = await ensureInviteForTypedEmail(); } catch (error) { setStatus(error.message || 'Could not prepare the invite.', true); return; }
    const message = inviteMessage(prepared.link);
    const native = window.RosterBuddyAndroid;
    if (native && typeof native.shareText === 'function') {
      let opened = false;
      try { opened = native.shareText(message.subject, message.text) !== false; } catch (_) { opened = false; }
      if (opened) { setStatus('Choose how to send the invite. It only works for the email you invited.'); return; }
    }
    if (navigator.share) {
      try { await navigator.share({ title: message.subject, text: message.text }); setStatus('Invite handed to the share sheet.'); return; }
      catch (error) { if (error && error.name === 'AbortError') return; }
    }
    const copied = await copyToClipboard(message.text);
    setStatus(copied ? 'Invite message copied. Paste it into any message.' : 'Copy the invite link above and send it yourself.', !copied);
  });

  function acceptPastedInvite(text) {
    const typed = tokenFromInput(text);
    const handoff = currentHandoff();
    const token = typed || (handoff ? handoff.token : '');
    const current = account();
    if (!token) { setStatus('Paste the invite link first.', true); return; }
    if (!current) {
      holdInviteForGlobalAuth(token);
      return;
    }
    run(async () => {
      if (!ensureCloudForInvite()) throw new Error('Sharing is not available on this device right now.');
      const result = await Promise.resolve(adapter.acceptInvite(token, current.email));
      await applySavedDisplayName(result.groupId, current);
      selectGroup(result.groupId);
      clearPendingInvite();
      el('group-invite-output').textContent = 'Invite accepted. Only the shared roster projection is visible.';
      return 'Invite accepted. You can see this group\u2019s calendar. Your own shifts stay private until you switch on Share my roster.';
    });
  }
  el('group-accept').addEventListener('click', () => acceptPastedInvite(el('group-invite-token').value));
  // Same action from the empty Groups page, so a person with no group can join without creating one first.
  const joinButton = el('sharing-join-button');
  if (joinButton) joinButton.addEventListener('click', () => acceptPastedInvite((el('sharing-join-token') || {}).value));
  el('calendar-roster-select').addEventListener('change', (event) => {
    selectRosterView(event.target.value).catch((error) => setStatus(error.message || 'Unable to open that roster.', true));
  });
  el('sharing-reciprocal-enable').addEventListener('click', () => run(async () => {
    const current = account();
    const group = selectedGroup();
    if (!current || !group) throw new Error('connect to a shared roster first');
    if (!reciprocalTargetUserId) throw new Error('Choose a connected person before requesting reciprocal sharing.');
    if (!el('sharing-reciprocal-consent').checked) throw new Error('Check consent before requesting schedule sharing.');
    const result = await Promise.resolve(adapter.requestReciprocalSharing(group.id, current.id, reciprocalTargetUserId));
    return result && result.status === 'accepted'
      ? 'Reciprocal sharing is already active.'
      : 'Request sent. No schedule is shared until the connected person accepts.';
  }));
  el('group-members').addEventListener('click', (event) => {
    const accept = event.target.closest('[data-accept-reciprocal]');
    if (accept) { run(async () => { await Promise.resolve(adapter.acceptReciprocalSharing(accept.dataset.acceptReciprocal)); return 'Reciprocal sharing accepted.'; }); return; }
    const decline = event.target.closest('[data-decline-reciprocal]');
    if (decline) { run(async () => { await Promise.resolve(adapter.declineReciprocalSharing(decline.dataset.declineReciprocal)); return 'Reciprocal sharing request declined.'; }); return; }
    const pause = event.target.closest('[data-pause-reciprocal]');
    if (pause) { run(async () => { await Promise.resolve(adapter.pauseReciprocalSharing(pause.dataset.pauseReciprocal)); lastUploadKey = ''; return 'Sharing paused. Nothing is shared with them until you resume.'; }); return; }
    const resume = event.target.closest('[data-resume-reciprocal]');
    if (resume) { run(async () => { await Promise.resolve(adapter.resumeReciprocalSharing(resume.dataset.resumeReciprocal)); lastUploadKey = ''; return 'Sharing resumed.'; }); return; }
    const stop = event.target.closest('[data-stop-reciprocal]');
    if (stop) { run(async () => { await Promise.resolve(adapter.stopReciprocalSharing(stop.dataset.stopReciprocal)); lastUploadKey = ''; return 'Sharing stopped.'; }); return; }
    const viewMember = event.target.closest('[data-view-member]');
    if (viewMember) { run(async () => { await openGroupCalendar(viewMember.dataset.viewMember); }); return; }
    const reciprocal = event.target.closest('[data-request-reciprocal]');
    if (reciprocal) {
      reciprocalTargetUserId = reciprocal.dataset.requestReciprocal;
      setStatus('Connected person selected. Review your consent, then request sharing.', false);
      return;
    }
    const button = event.target.closest('[data-revoke-member]');
    if (!button) return;
    run(async () => { await Promise.resolve(adapter.revokeMember(selectedGroupId, account().id, button.dataset.revokeMember)); });
  });

  // Defensive binding for the hub controls so a stripped-down page still loads.
  function on(id, type, handler) { const node = el(id); if (node) node.addEventListener(type, handler); }
  on('sharing-group-list', 'click', (event) => {
    const button = event.target.closest('[data-select-group]');
    if (!button) return;
    run(async () => { await switchGroup(button.dataset.selectGroup); });
  });
  on('sharing-hub-retry', 'click', () => run(async () => { await restoreCloudSelection(); }));
  on('sharing-new-group', 'click', () => { showCreateForm = true; render(); });
  on('sharing-view-group-calendar', 'click', () => run(async () => { await openGroupCalendar(null); }));
  on('sharing-refresh-group', 'click', () => run(async () => { lastUploadKey = ''; await refreshOpenCalendar(); return 'Refreshed.'; }));
  on('sharing-display-name', 'change', () => { const box = el('sharing-save-display-name'); if (box && String((el('sharing-display-name') || {}).value || '').trim()) box.click(); });
  on('sharing-save-display-name', 'click', () => run(async () => {
    const name = String((el('sharing-display-name') || {}).value || '').trim();
    if (!name || name.length > 40 || name.includes('@')) throw new Error('Enter a name of up to 40 characters, without an email address.');
    const current = account();
    if (!current) throw new Error('Sign in first to set your name.');
    const group = selectedGroup();
    if (!group || !adapter.status || adapter.status().mode !== 'cloud' || /^group_/i.test(String(group.id))) { saveDisplayName(current.id, name); return 'Name saved. It is used when you join or create a group.'; }
    if (adapter.capabilities && adapter.capabilities().displayName !== true) throw new Error('Changing the name your group sees is not available yet.');
    await Promise.resolve(adapter.setDisplayName(group.id, name));
    saveDisplayName(current.id, name);
    return 'Name saved. Your group sees this name next to your shifts.';
  }));
  // Reciprocal rosters have no realtime delivery (no SELECT grant), so cloud
  // state is refetched on a timer and when the app becomes visible again.
  async function refreshCloudState() {
    if (refreshInFlight || !isCurrentUi() || !adapter.status || adapter.status().mode !== 'cloud' || !account()) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    refreshInFlight = true;
    try { await render(); await refreshOpenCalendar(); } finally { refreshInFlight = false; }
  }
  setInterval(refreshCloudState, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloudState(); });
  window.addEventListener('online', () => refreshCloudState());
  window.addEventListener('offline', () => { loadHub(); });
  window.addEventListener('storage', (event) => { if (event.key === STORAGE) { store = load(); adapter = makeAdapter(); render(); } });
  window.addEventListener('rosterbuddy:sync-preference-changed', () => {
    const wasCloud = Boolean(adapter && adapter.status && adapter.status().mode === 'cloud');
    const open = selectedGroup();
    const me = account();
    if (adapter && typeof adapter.clearCloudState === 'function') adapter.clearCloudState();
    syncConsent = syncPreference ? syncPreference.canUpload() : false;
    // Going local-only must not leave this person's shifts readable in the group: remove them while the cloud
    // adapter still exists (best effort; the choice itself is recorded either way).
    if (!syncConsent && wasCloud && open && me && !/^group_/i.test(String(open.id)) && groupShareOn(me.id, open.id)) {
      withdrawSharing(open, me).then((outcome) => setStatus(outcome.message, !outcome.ok), () => {});
    }
    if (!syncConsent) clearCloudDerivedState();
    adapter = makeAdapter();
    render();
  });
  window.addEventListener('rosterbuddy:auth-changed', () => {
    const identity = appAuth() && appAuth().identity();
    const identityKey = identity ? `${identity.id}:${String(identity.email || '').trim().toLowerCase()}` : null;
    if (identityKey !== lastAuthIdentity) {
      clearCloudDerivedState();
      syncIdentityPreference(identity);
      adapter = makeAdapter();
      const handoff = currentHandoff();
      const hasAuthGateHandoff = Boolean(pendingInviteToken && handoff && handoffApi && (!identity || handoffApi.belongsTo(handoff, identity)));
      lastAuthIdentity = identityKey;
      if (!hasAuthGateHandoff) clearPendingInvite();
      clearInviteUiState();
      selectGroup(null);
      if (hasAuthGateHandoff) {
        const input = el('group-invite-token');
        if (input) input.value = handoff.link;
      }
    }
    restoreCloudSelection().then(() => render()).then(() => resumePendingInvite());
  });
  // Cloud only: send the caller's own roster, if they chose to share with this group, when it has changed. Local groups hold a snapshot taken when the group
  // was created (the local adapter never refreshes it), so there is nothing to upload or re-render for them.
  async function uploadMyRoster(group, current) {
    if (!adapter.status || adapter.status().mode !== 'cloud') return;
    if (rosterUploadInFlight || Date.now() < rosterUploadRetryAt) return;
    const latest = window.RosterBuddyGetLocalRoster();
    const today = new Date();
    const key = [group.id, current.id, `${today.getFullYear()}-${today.getMonth()}`, JSON.stringify(latest.roster), JSON.stringify(latest.templates)].join('|');
    if (key === rosterUploadKey) return;
    rosterUploadInFlight = true;
    try {
      await Promise.resolve(adapter.updateRoster(group.id, current.id, latest.roster, latest.templates));
      rosterUploadKey = key;
      rosterUploadRetryAt = 0;
      const report = adapter.rosterUploadReport ? adapter.rosterUploadReport() : null;
      uploadNotice = report && report.skipped > 0 ? `${report.skipped} shift${report.skipped === 1 ? ' was' : 's were'} not shared because the code has a space, an unsupported character or is not 1-4 characters.` : '';
      if (uploadNotice) setStatus(uploadNotice, true);
    } catch (error) {
      rosterUploadRetryAt = Date.now() + 60000;
      setStatus(error.message || 'Roster update failed.', true);
    } finally { rosterUploadInFlight = false; }
  }
  setInterval(() => {
    const group = selectedGroup();
    const current = account();
    if (group && current) maybeUploadOutgoing(group).catch(() => {});
    if (!group || !current || !window.RosterBuddyGetLocalRoster || !groupShareOn(current.id, group.id)) return;
    uploadMyRoster(group, current);
  }, 1000);
  window.RosterBuddyCalendarMonthChanged = () => { if (calendarGroupId) refreshOpenCalendar(); };
  // An https invite link (.../#invite=TOKEN): keep the token, take it out of the address bar, open Share, and accept it
  // as soon as the person is signed in. The emailed sign-in may open in another tab, hence the stored handoff.
  function captureLandedInvite() {
    if (!handoffApi || typeof location === 'undefined') return false;
    const token = handoffApi.inviteFromHash(location.hash);
    if (!token) return false;
    handoffApi.write(inviteStore(), handoffApi.make({ link: token, source: 'received' }));
    pendingInviteToken = token;
    // window.history on purpose: app.js has its own global named `history` (the screen list) that hides the browser's.
    try { window.history.replaceState(null, document.title, location.pathname + location.search + handoffApi.hashWithoutInvite(location.hash)); } catch (_) {}
    return true;
  }
  async function handleLandedInvite() {
    const landed = captureLandedInvite();
    if (landed) {
      if (typeof showScreen === 'function') { try { showScreen('share'); } catch (_) {} }
      await render();
    }
    if (!pendingInviteToken) return;
    if (account()) await resumePendingInvite();
    else if (landed) setStatus('You have been invited to a shared roster. Sign in with the email it was sent to and it will be accepted for you.');
  }
  window.addEventListener('hashchange', () => { handleLandedInvite(); });
  // Another window of the app used the waiting invite: drop our copy and refresh, so this window shows the new group too.
  window.addEventListener('storage', (event) => {
    if (!handoffApi || event.key !== handoffApi.STORAGE_KEY || event.newValue) return;
    if (!pendingInviteToken) return;
    pendingInviteToken = '';
    // Only a real acceptance is announced. A refusal, an expired invite or a newly created one just drops our copy.
    if (recentInviteOutcome() !== 'accepted') return;
    Promise.resolve(restoreCloudSelection()).then(() => render()).then(() => setStatus('Invite accepted. You can see this group\u2019s calendar. Your own shifts stay private until you switch on Share my roster.')).catch(() => {});
  });
  // The first-sign-in cloud popup is skipped while an invite is waiting: accepting the invite is the choice.
  window.RosterBuddyHasPendingInvite = () => { const waiting = currentHandoff(); return Boolean(pendingInviteToken && !(waiting && waiting.source === 'owner-created')); };
  const startupRender = render();
  Promise.resolve(startupRender).then(() => handleLandedInvite());
  window.RosterBuddyReceiveInviteLink = (link) => {
    const token = tokenFromInput(link);
    if (!token) { setStatus('Invite link is invalid or empty.', true); return false; }
    holdInviteForGlobalAuth(token);
    const input = el('group-invite-token');
    if (input) input.value = String(link).trim();
    return true;
  };
})();
