/* Short-lived, identity-scoped invite handoff for same-device acceptance. */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyInviteHandoff = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createApi() {
  const STORAGE_KEY = 'rosterbuddy.pendingGroupInvite.v2';
  const MAX_AGE_MS = 15 * 60 * 1000;

  function normaliseEmail(value) { return String(value || '').trim().toLowerCase(); }
  function tokenFromLink(value) {
    const raw = String(value || '').trim();
    const marker = '/invite/';
    if (raw.includes(marker)) {
      try { return decodeURIComponent(raw.slice(raw.lastIndexOf(marker) + marker.length)); } catch (_) { return ''; }
    }
    return raw;
  }
  function make({ link, ownerId = '', ownerEmail = '', invitedEmail = '', source = 'received', createdAt = Date.now() } = {}) {
    const token = tokenFromLink(link);
    if (!token) return null;
    return {
      link: String(link || '').trim(), token,
      ownerId: String(ownerId || ''), ownerEmail: normaliseEmail(ownerEmail),
      invitedEmail: normaliseEmail(invitedEmail), source,
      createdAt: Number(createdAt) || Date.now(),
    };
  }
  function read(storage, now = Date.now()) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const handoff = JSON.parse(raw);
      const createdAt = Number(handoff && handoff.createdAt);
      if (!handoff || !handoff.token || !Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now || now - createdAt > MAX_AGE_MS) return null;
      return { ...handoff, createdAt };
    } catch (_) { return null; }
  }
  function write(storage, handoff) {
    if (!storage || !handoff || !handoff.token) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(handoff));
  }
  function clear(storage) { try { if (storage) storage.removeItem(STORAGE_KEY); } catch (_) {} }
  function belongsTo(handoff, identity) {
    if (!handoff || !identity) return false;
    const email = normaliseEmail(identity.email);
    if (handoff.source === 'owner-created') return Boolean(handoff.invitedEmail && email === handoff.invitedEmail);
    return true;
  }
  return { STORAGE_KEY, MAX_AGE_MS, normaliseEmail, tokenFromLink, make, read, write, clear, belongsTo };
});
