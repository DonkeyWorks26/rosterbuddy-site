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
  let pendingInviteToken = (() => {
    const handoff = handoffApi && handoffApi.read(sessionStorage);
    if (!handoff) { if (handoffApi) handoffApi.clear(sessionStorage); return ''; }
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
  // Owner schedule sharing is explicit per person and per group, recorded on
  // this device only when the owner ticks the consent box. Nothing is uploaded
  // for a group without that record, and the record is removed on withdrawal.
  const OWNER_SHARE_KEY = 'rosterbuddy.ownerShareConsent.v1';
  let lastOwnerUploadKey = '';
  let ownerUploadRetryAt = 0;
  function ownerShareStorageKey() { const who = account(); return who ? `${OWNER_SHARE_KEY}.${who.id}` : null; }
  function ownerShareGroups() {
    const key = ownerShareStorageKey();
    try { const list = JSON.parse((key && localStorage.getItem(key)) || '[]'); return Array.isArray(list) ? list.map(String) : []; } catch (_) { return []; }
  }
  function ownerShareOn(groupId) { return ownerShareGroups().includes(String(groupId)); }
  function setOwnerShare(groupId, on) {
    const key = ownerShareStorageKey();
    if (!key) return;
    const rest = ownerShareGroups().filter((id) => id !== String(groupId));
    try { localStorage.setItem(key, JSON.stringify(on ? rest.concat(String(groupId)) : rest)); } catch (_) {}
    lastOwnerUploadKey = ''; ownerUploadRetryAt = 0;
  }
  // Best effort: switch the owner's schedule sharing off on the server so people
  // already in the group stop seeing it. Local state is cleared by the caller.
  async function withdrawServerSharing() {
    const group = selectedGroup();
    const current = account();
    if (!group || !current || group.ownerId !== current.id || /^group_/i.test(String(group.id))) return;
    if (!adapter || !adapter.status || adapter.status().mode !== 'cloud') { setOwnerShare(group.id, false); return; }
    setOwnerShare(group.id, false);
    try { await Promise.resolve(adapter.setSharingPreference(group.id, current.id, false)); }
    catch (_) { setStatus('Sharing is off on this phone, but the group may still see your schedule until you reconnect and turn it off again.', true); }
  }

  function appAuth() { return window.RosterBuddyCurrentAuth || null; }
  // Only a closed category, the HTTP status and a fixed sentence are shown.
  // Provider bodies, emails, URLs and tokens never reach the UI.
  function authFailureText(error) {
    const diagnostic = error && error.diagnostic;
    if (diagnostic && typeof diagnostic.category === 'string' && typeof diagnostic.message === 'string') {
      const status = Number.isInteger(diagnostic.status) ? `HTTP ${diagnostic.status}, ` : '';
      return `Sign-in unavailable (${status}${diagnostic.category}): ${diagnostic.message}`;
    }
    return 'Sign-in unavailable. Your local roster is not affected.';
  }
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
        // One session only: the app-wide sign-in supplies the bearer token.
        const auth = appAuth();
        const client = backend.createSupabaseClient(parsed, factory, auth && typeof auth.accessToken === 'function' ? { accessToken: () => auth.accessToken() } : undefined);
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
    if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
    if (adapter && typeof adapter.clearCloudState === 'function') adapter.clearCloudState();
    Object.keys(store.groups).filter((id) => !/^group_/i.test(id)).forEach((id) => { delete store.groups[id]; });
    clearSharedCalendar();
    mySharing = [];
    lastUploadKey = '';
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
    syncConsent = Boolean(identity && syncPreference && syncPreference.canUpload());
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
  function currentHandoff() { return handoffApi ? handoffApi.read(sessionStorage) : null; }
  function tokenFromInput(value) {
    const raw = String(value || '').trim();
    const marker = '/invite/';
    if (raw.includes(marker)) {
      try { return decodeURIComponent(raw.slice(raw.lastIndexOf(marker) + marker.length)); }
      catch (_) { return ''; }
    }
    return raw;
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
  // Cloud: the combined, member-labelled projection (fails closed). Local: the
  // single local roster, labelled with the group name.
  async function loadGroupRows(group, current) {
    const cloud = adapter.status && adapter.status().mode === 'cloud';
    if (cloud) return Promise.resolve(adapter.readGroupSchedule(group.id));
    const rows = await Promise.resolve(adapter.readSharedRoster(group.id, current.id));
    return rows.map((row) => Object.assign({}, row, { sourceUserId: group.ownerId || 'local', displayName: group.name || 'Shared roster' }));
  }
  async function showGroupCalendar(group, current, onlyUserId) {
    const rows = await loadGroupRows(group, current);
    if (adapter.cacheSharedProjection && adapter.status().mode !== 'cloud') adapter.cacheSharedProjection(group.id, rows);
    if (typeof window.RosterBuddySetCalendarView === 'function') window.RosterBuddySetCalendarView(rows, group.name || 'Shared roster');
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
      if (isAccessError(error) || !isTransientError(error)) { handleAccessLost(groupId); }
      throw error;
    }
  }
  async function openGroupCalendar(onlyUserId) {
    const current = account();
    const group = selectedGroup();
    if (!current || !group) throw new Error('Open a group first.');
    try { await showGroupCalendar(group, current, onlyUserId); }
    catch (error) {
      if (isAccessError(error) || !isTransientError(error)) handleAccessLost(group.id);
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
      window.RosterBuddySetCalendarView(rows, group.name || 'Shared roster');
      if (state.filter && window.RosterBuddySetCalendarMemberFilter) window.RosterBuddySetCalendarMemberFilter(state.filter);
    } catch (error) {
      if (isTransientError(error)) { setStatus('Could not refresh the group calendar. Showing the last loaded schedule.', true); return; }
      handleAccessLost(group.id);
    }
  }
  async function ensureGroupSubscription(group, current, cloudStatus) {
    if (activeGroupSubscription) { activeGroupSubscription(); activeGroupSubscription = null; }
    if (!group || !current || cloudStatus.mode !== 'cloud' || !adapter.subscribeGroup) return;
    activeGroupSubscription = adapter.subscribeGroup(group.id, current.id, async () => {
      try {
        const rows = await Promise.resolve(adapter.readSharedRoster(group.id, current.id));
        adapter.cacheSharedProjection(group.id, rows);
        if (calendarGroupId === group.id) await refreshOpenCalendar();
        await render();
      } catch (error) {
        // Revoked or unknown failures fail closed; transient ones keep the last data.
        if (!isTransientError(error)) handleAccessLost(group.id);
      }
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
    hubState = { status: 'loading', groups: hubState.groups, error: '' };
    renderHub();
    try {
      const groups = await Promise.resolve(adapter.listGroupSummaries());
      if (requestId !== hubRequestId || !isCurrentUi()) return;
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
      'signed-out': 'Sign in with the optional sharing email to see your groups.',
      local: groups.length ? 'Sharing is off on this device. These groups are saved on this phone only.' : 'Sharing is off on this device. A group you create stays on this phone only.',
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
    const info = hubState.groups.find((candidate) => String(candidate.id) === String(group.id));
    if (meta) {
      const count = info ? `${info.memberCount} ${info.memberCount === 1 ? 'person' : 'people'} · ` : '';
      meta.textContent = `${count}${manages ? 'You manage this group' : 'You are a member'}`;
    }
    if (permissions) {
      const lines = manages
        ? ['You can invite people and remove access.', 'You choose who sees your own schedule, person by person.', 'People only see shift dates, codes and times. Pay, notes and recovery are never shared.']
        : ['You can see schedules people have chosen to share with you.', 'You choose who sees your own schedule, person by person.', 'People only see shift dates, codes and times. Pay, notes and recovery are never shared.'];
      if (!cloud) lines.unshift('Sharing is off on this device, so nothing leaves this phone.');
      permissions.innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    }
  }
  let renderSeq = 0;
  async function render() {
    const renderId = ++renderSeq;
    const stale = () => renderId !== renderSeq || !isCurrentUi();
    const current = account();
    syncIdentityPreference(current);
    const cloudStatus = adapter.status ? adapter.status() : { mode: 'local', reason: 'backend-not-configured' };
    const syncStatus = el('group-sync-status');
    if (syncStatus) syncStatus.textContent = cloudStatus.mode === 'cloud' ? 'Sharing is on for this device.' : `Sharing is off. ${cloudStatus.reason === 'sync-consent-required' ? 'Tick the consent box to turn it on.' : 'Your rosters stay on this phone.'}`;
    const consent = el('group-sync-consent');
    if (consent) consent.checked = syncConsent;
    try { await restoreCloudSelection(); }
    catch (error) { if (stale()) return; hubState = { status: 'error', groups: [], error: error.message || 'Please try again.' }; renderHub(); setStatus(error.message || 'Unable to load your groups.', true); return; }
    if (stale()) return;
    await loadHub();
    if (stale()) return;
    if (calendarGroupId && calendarGroupId !== selectedGroupId) clearSharedCalendar();
    renderRosterSwitcher(switcherGroups(), current, calendarGroupId);
    setStatus(current ? `Signed in as ${current.displayName || current.email}. ${cloudStatus.mode === 'cloud' ? 'Sharing is on.' : 'Sharing is off, so nothing leaves this phone.'}` : 'Sign in by email to share rosters. Until then everything stays on this phone.');
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
    if (preview && !preview.innerHTML) preview.textContent = 'Loading the shared schedule…';
    try {
      const rows = await Promise.resolve(adapter.readSharedRoster(group.id, current.id));
      if (stale()) return;
      await ensureGroupSubscription(group, current, cloudStatus);
      if (preview) preview.innerHTML = `<strong>${escapeHtml(group.name)}</strong><br>${rows.length ? rows.map((row) => `${escapeHtml(row.date)} · ${escapeHtml(row.shiftCode)} ${escapeHtml(row.label)}${row.start ? ` · ${escapeHtml(row.start)}–${escapeHtml(row.finish)}` : ''}`).join('<br>') : 'No allowlisted shifts yet.'}`;
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
      if (members) members.innerHTML = `<p class="eyebrow settings-section-label">People</p>${pendingMarkup}${memberRows.length ? '' : '<p class="muted">No one else is in this group yet. Invite someone to get started.</p>'}${memberRows.map((member) => `<article><strong>${escapeHtml(member.displayName || 'Connected person')}</strong><span>${member.revokedAt ? 'Access removed' : 'Connected'}</span>${current.id === group.ownerId && member.userId !== current.id && !member.revokedAt ? `<button class="secondary-button compact" type="button" data-revoke-member="${escapeHtml(member.userId)}">Remove access</button>` : ''}${consentMarkup(member, cloud)}</article>`).join('')}`;
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
    if (handoffApi) handoffApi.write(sessionStorage, handoffApi.make({ link: token, source: 'received' }));
    setStatus('This connection uses the optional sharing flow. Local roster access does not require an account.');
    return;
  }
  function clearPendingInvite() {
    pendingInviteToken = '';
    if (handoffApi) handoffApi.clear(sessionStorage);
  }
  async function resumePendingInvite() {
    const current = account();
    if (!pendingInviteToken || !current) return;
    const handoff = currentHandoff();
    if (handoffApi && !handoffApi.belongsTo(handoff, current)) {
      clearPendingInvite();
      setStatus('This invite was issued for a different account. Create or open a fresh invite.', true);
      return;
    }
    const token = handoff ? handoff.token : pendingInviteToken;
    try {
      const result = await Promise.resolve(adapter.acceptInvite(token, current.email));
      clearPendingInvite();
      selectGroup(result.groupId);
      save();
      await render();
      const output = el('group-invite-output');
      if (output) output.textContent = 'Invite accepted. Only the shared roster projection is visible.';
    } catch (error) { setStatus(error.message || 'Invite acceptance failed.', true); }
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
  el('sharing-request-magic-link').addEventListener('click', () => run(async () => {
    const email = String(el('sharing-magic-link-email').value || '').trim();
    const auth = appAuth();
    if (!auth || typeof auth.requestMagicLink !== 'function') throw new Error('optional sharing auth is unavailable');
    const status = el('sharing-magic-link-status');
    try { await auth.requestMagicLink(email); }
    catch (error) {
      const text = authFailureText(error);
      if (status) status.textContent = text;
      throw new Error(text);
    }
    if (status) status.textContent = 'Check your email for the optional sharing link. Your local roster remains available.';
    return 'Sharing link requested. Your local roster remains available.';
  }));
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
    if (toggle) toggle.textContent = 'Hide invite options';
  });
  el('sharing-back-to-groups').addEventListener('click', () => setShareView(false));
  el('sharing-invite-panel-toggle').addEventListener('click', () => {
    const panel = el('sharing-invite-panel');
    if (!panel) return;
    const open = panel.classList.toggle('hidden-control');
    el('sharing-invite-panel-toggle').textContent = open ? 'Show invite options' : 'Hide invite options';
  });
  el('group-enable-sync').addEventListener('click', async () => {
    syncConsent = Boolean(el('group-sync-consent').checked);
    if (!syncConsent) {
      await withdrawServerSharing();
      if (syncPreference) syncPreference.set('local-only');
      clearCloudDerivedState();
      setStatus('Sharing is turned off. Your schedule is no longer shared with this group.');
      return;
    }
    if (syncPreference) syncPreference.set('cloud-enabled');
    adapter = makeAdapter();
    const status = adapter.status ? adapter.status() : { mode: 'local', reason: 'backend-not-configured' };
    if (status.mode !== 'cloud') {
      await render();
      setStatus(status.reason === 'backend-transport-unavailable' ? 'Sharing could not start on this device. Your rosters stay on this phone.' : 'Sharing is not available in this version. Your rosters stay on this phone.', true);
      return;
    }
    const current = account();
    await restoreCloudSelection();
    const group = selectedGroup();
    if (!current || !group || group.ownerId !== current.id || /^group_/i.test(String(group.id))) {
      await render();
      setStatus('Choose a group before turning on sharing.', true);
      return;
    }
    try {
      await Promise.resolve(adapter.setSharingPreference(group.id, current.id, true));
      setOwnerShare(group.id, true);
      await render();
      setStatus('Sharing is on. People in this group can see your shift dates, codes and times.');
    } catch (error) {
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
      const currentStatus = adapter.status ? adapter.status() : { mode: 'local' };
      const group = await Promise.resolve(adapter.createGroup({ name: el('group-name').value, ownerId: current.id, roster: currentRoster.roster, templates: currentRoster.templates }));
      if (!group || !group.id) throw new Error('group creation returned no group id');
      if (currentStatus.mode === 'cloud' && /^group_/i.test(String(group.id))) throw new Error('cloud group creation returned a local group id');
      if (currentStatus.mode === 'cloud') clearLocalGroupsBeforeCloudSelection();
      store.groups[group.id] = group;
      selectGroup(group.id);
      showCreateForm = false;
      const created = currentStatus.mode === 'cloud'
        ? `Created ${group.name}. Your schedule is not shared until you turn sharing on.`
        : `Created ${group.name}. It is saved on this phone only.`;
      setStatus(created);
      return created;
    });
  });
  el('group-invite').addEventListener('click', () => run(async () => {
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
    if (handoffApi) handoffApi.write(sessionStorage, handoffApi.make({ link: invite.link, ownerId: current.id, ownerEmail: current.email, invitedEmail, source: 'owner-created' }));
    pendingInviteToken = invite.token || handoffApi.tokenFromLink(invite.link);
    el('group-invite-output').textContent = `Fresh invite created for the intended account (expires ${new Date(invite.expiresAt).toLocaleString()}). Copy or share this link now; it is single-use.`;
  }));
  el('group-share-invite').addEventListener('click', async () => {
    const link = el('group-invite-token').value.trim();
    if (!link) { setStatus('Create an invite first.', true); return; }
    if (!navigator.share) { setStatus('Platform sharing is unavailable here. Copy the invite link and share it yourself.', true); return; }
    try {
      await navigator.share({ title: 'RosterBuddy group invite', text: 'Join my RosterBuddy shared roster:', url: link });
      setStatus('Invite link handed to the platform share sheet.');
    } catch (error) {
      if (error && error.name !== 'AbortError') setStatus('Invite share was not completed; the link remains available to copy.', true);
    }
  });

  el('group-accept').addEventListener('click', () => {
    const handoff = currentHandoff();
    const token = handoff ? handoff.token : tokenFromInput(el('group-invite-token').value);
    const current = account();
    if (!current) {
      if (!token) { setStatus('Paste an invite link first.', true); return; }
      holdInviteForGlobalAuth(token);
      return;
    }
    run(async () => {
      const result = await Promise.resolve(adapter.acceptInvite(token, current.email));
      selectGroup(result.groupId);
      clearPendingInvite();
      el('group-invite-output').textContent = 'Invite accepted. Only the shared roster projection is visible.';
    });
  });
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
  on('sharing-save-display-name', 'click', () => run(async () => {
    const name = String((el('sharing-display-name') || {}).value || '').trim();
    if (!name || name.length > 60 || name.includes('@')) throw new Error('Enter a short name without an email address.');
    if (!adapter.status || adapter.status().mode !== 'cloud') throw new Error('Turn on sharing to change the name your group sees.');
    await Promise.resolve(adapter.setDisplayName(name));
    return 'Name saved. Your group sees this name next to your schedule.';
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
    syncConsent = syncPreference ? syncPreference.canUpload() : false;
    const withdrawn = !syncConsent ? withdrawServerSharing() : Promise.resolve();
    withdrawn.then(() => {
      if (adapter && typeof adapter.clearCloudState === 'function') adapter.clearCloudState();
      if (!syncConsent) clearCloudDerivedState();
      adapter = makeAdapter();
      render();
    });
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
  setInterval(async () => {
    const group = selectedGroup();
    const current = account();
    if (group && current) maybeUploadOutgoing(group).catch(() => {});
    if (!group || !current || group.ownerId !== current.id || !window.RosterBuddyGetLocalRoster) return;
    const cloud = Boolean(adapter.status && adapter.status().mode === 'cloud');
    // Cloud: only with the owner's recorded consent, and only when the
    // allowlisted projection changed (pay/notes edits never trigger an upload).
    if (cloud && !ownerShareOn(group.id)) return;
    const latest = window.RosterBuddyGetLocalRoster();
    const projectionKey = cloud ? `${group.id}|${JSON.stringify(adapter.projectRoster(latest.roster, latest.templates))}` : null;
    const changed = cloud
      ? projectionKey !== lastOwnerUploadKey
      : (JSON.stringify(group.roster) !== JSON.stringify(latest.roster) || JSON.stringify(group.templates) !== JSON.stringify(latest.templates));
    if (!changed || (cloud && Date.now() < ownerUploadRetryAt)) return;
    if (cloud) lastOwnerUploadKey = projectionKey;
    try { await Promise.resolve(adapter.updateRoster(group.id, current.id, latest.roster, latest.templates)); save(); await render(); }
    catch (error) {
      if (cloud) { lastOwnerUploadKey = ''; ownerUploadRetryAt = Date.now() + 30000; }
      setStatus(error.message || 'Roster update failed.', true);
    }
  }, 1000);
  render();
  window.RosterBuddyReceiveInviteLink = (link) => {
    const token = tokenFromInput(link);
    if (!token) { setStatus('Invite link is invalid or empty.', true); return false; }
    holdInviteForGlobalAuth(token);
    const input = el('group-invite-token');
    if (input) input.value = String(link).trim();
    return true;
  };
})();
