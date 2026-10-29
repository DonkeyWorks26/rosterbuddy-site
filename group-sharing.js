/* Local/offline group-sharing core.
 * This is deliberately not production authentication or cloud sync. It is the
 * safe fallback used by group-sharing-backend.js when no reviewed Supabase
 * transport and explicit sync consent are available.
 */
(function attachGroupSharing(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyGroupSharing = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createApi() {
  const ALLOWED_SHIFT_FIELDS = ['date', 'shiftCode', 'label', 'start', 'finish'];
  const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const normaliseEmail = (value) => String(value || '').trim().toLowerCase();
  const nowOf = (store) => Number(store.now()) || 0;
  const currentAccount = (store) => store.session ? store.accounts[store.session.accountId] : null;
  const requireSignedIn = (store) => {
    const account = currentAccount(store);
    if (!account) throw new Error('signed-in account required');
    return account;
  };
  const requireGroup = (store, groupId) => {
    const group = store.groups[groupId];
    if (!group) throw new Error('group not found');
    return group;
  };
  const isActiveMember = (group, accountId) => Boolean(group.members[accountId] && !group.members[accountId].revokedAt);
  const requireMember = (group, accountId) => {
    if (!isActiveMember(group, accountId)) throw new Error('not a member');
  };

  function createStore(options = {}) {
    return { accounts: {}, groups: {}, invites: {}, session: null, now: options.now || (() => Date.now()), listeners: {} };
  }

  function hydrateStore(raw, options = {}) {
    const store = createStore(options);
    if (!raw || typeof raw !== 'object') return store;
    ['accounts', 'groups', 'invites'].forEach((key) => {
      if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) store[key] = JSON.parse(JSON.stringify(raw[key]));
    });
    if (raw.session && typeof raw.session.accountId === 'string') store.session = { accountId: raw.session.accountId, signedInAt: Number(raw.session.signedInAt) || 0 };
    return store;
  }

  function createAccount(store, { email, displayName }) {
    const normalised = normaliseEmail(email);
    if (!normalised || !String(displayName || '').trim()) throw new Error('email and display name required');
    const existing = Object.values(store.accounts).find((account) => account.email === normalised);
    if (existing) return { ...existing };
    const account = { id: makeId('acct'), email: normalised, displayName: String(displayName).trim(), createdAt: nowOf(store) };
    store.accounts[account.id] = account;
    return { ...account };
  }

  function signIn(store, email) {
    const account = Object.values(store.accounts).find((candidate) => candidate.email === normaliseEmail(email));
    if (!account) throw new Error('account not found');
    store.session = { accountId: account.id, signedInAt: nowOf(store) };
    return { ...account, accountId: account.id };
  }

  function signOut(store) { store.session = null; }

  function createGroup(store, { name, roster = {}, templates = {} }) {
    const owner = requireSignedIn(store);
    const group = {
      id: makeId('group'), name: String(name || '').trim() || 'Household', ownerId: owner.id,
      roster: JSON.parse(JSON.stringify(roster)), templates: JSON.parse(JSON.stringify(templates)),
      members: { [owner.id]: { role: 'owner', joinedAt: nowOf(store), revokedAt: null } },
      createdAt: nowOf(store), updatedAt: nowOf(store),
    };
    store.groups[group.id] = group;
    return { ...group, members: { ...group.members } };
  }

  function createInvite(store, groupId, actorId, { ttlMs = 7 * 24 * 60 * 60 * 1000, email = '' } = {}) {
    const actor = requireSignedIn(store);
    const group = requireGroup(store, groupId);
    if (actor.id !== actorId || group.ownerId !== actor.id) throw new Error('owner authorization required');
    const invitedEmail = normaliseEmail(email);
    if (!invitedEmail) throw new Error('invited email required');
    const token = makeId('invite');
    const invite = { token, groupId, createdBy: actor.id, invitedEmail, createdAt: nowOf(store), expiresAt: nowOf(store) + Math.max(1, Number(ttlMs) || 1), usedAt: null, revokedAt: null };
    store.invites[token] = invite;
    return { ...invite, link: `rosterbuddy://invite/${encodeURIComponent(token)}` };
  }

  function acceptInvite(store, token, email) {
    const account = requireSignedIn(store);
    if (account.email !== normaliseEmail(email)) throw new Error('invite must be accepted by the signed-in account');
    const invite = store.invites[String(token || '')];
    if (!invite || invite.revokedAt) throw new Error('invite not found or revoked');
    if (invite.usedAt) throw new Error('invite already used');
    if (invite.invitedEmail && invite.invitedEmail !== account.email) throw new Error('invite must be accepted by the intended invited account');
    if (nowOf(store) >= invite.expiresAt) throw new Error('invite expired');
    const group = requireGroup(store, invite.groupId);
    group.members[account.id] = { role: 'member', joinedAt: nowOf(store), revokedAt: null };
    invite.usedAt = nowOf(store);
    group.updatedAt = nowOf(store);
    return { groupId: group.id, accountId: account.id };
  }

  function revokeMember(store, groupId, actorId, memberId) {
    const actor = requireSignedIn(store);
    const group = requireGroup(store, groupId);
    if (actor.id !== actorId || actor.id !== group.ownerId) throw new Error('owner authorization required');
    if (!isActiveMember(group, memberId)) throw new Error('not a member');
    if (memberId === group.ownerId) throw new Error('owner cannot be revoked');
    group.members[memberId].revokedAt = nowOf(store);
    group.updatedAt = nowOf(store);
    return true;
  }

  function projectRoster(roster = {}, templates = {}) {
    const result = [];
    Object.keys(roster).sort().forEach((month) => {
      const monthRoster = roster[month] && typeof roster[month] === 'object' ? roster[month] : {};
      Object.keys(monthRoster).sort((a, b) => Number(a) - Number(b)).forEach((day) => {
        const template = templates[monthRoster[day]];
        if (!template) return;
        const row = { date: `${month}-${String(day).padStart(2, '0')}`, shiftCode: String(template.icon || '').slice(0, 8), label: String(template.label || '').slice(0, 80), start: String(template.start || '').slice(0, 5), finish: String(template.finish || '').slice(0, 5) };
        result.push(Object.fromEntries(ALLOWED_SHIFT_FIELDS.map((key) => [key, row[key]])));
      });
    });
    return result;
  }

  function readSharedRoster(store, groupId, accountId) {
    const group = requireGroup(store, groupId);
    requireMember(group, accountId);
    return projectRoster(group.roster, group.templates);
  }

  function requestReciprocalSharing(store, groupId, accountId, consent) {
    const account = requireSignedIn(store);
    const group = requireGroup(store, groupId);
    if (account.id !== accountId) throw new Error('signed-in account required');
    requireMember(group, accountId);
    if (consent !== true) throw new Error('explicit reciprocal sharing consent required');
    group.members[accountId].shareScheduleConsentAt = nowOf(store);
    group.updatedAt = nowOf(store);
    // Local mode records intent only. It never makes a member roster visible;
    // cloud authorization must create the allowlisted projection server-side.
    return { requested: true, authorized: false };
  }

  function notify(store, groupId) { (store.listeners[groupId] || []).forEach((listener) => listener(readSharedRoster(store, groupId, currentAccount(store)?.id))); }
  function subscribeGroup(store, groupId, accountId, listener) {
    const group = requireGroup(store, groupId); requireMember(group, accountId);
    if (typeof listener !== 'function') throw new Error('listener required');
    (store.listeners[groupId] ||= []).push(listener);
    return () => { store.listeners[groupId] = (store.listeners[groupId] || []).filter((candidate) => candidate !== listener); };
  }

  function updateRoster(store, groupId, actorId, roster, templates) {
    const actor = requireSignedIn(store);
    const group = requireGroup(store, groupId);
    if (actor.id !== actorId || group.ownerId !== actor.id) throw new Error('owner authorization required');
    group.roster = JSON.parse(JSON.stringify(roster || {}));
    group.templates = JSON.parse(JSON.stringify(templates || {}));
    group.updatedAt = nowOf(store);
    notify(store, groupId);
    return true;
  }

  return { createStore, hydrateStore, createAccount, signIn, signOut, createGroup, createInvite, acceptInvite, revokeMember, projectRoster, readSharedRoster, requestReciprocalSharing, subscribeGroup, updateRoster };
});
