/* Short-lived, identity-scoped invite handoff for same-device acceptance. */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyInviteHandoff = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createApi() {
  const STORAGE_KEY = 'rosterbuddy.pendingGroupInvite.v2';
  const MAX_AGE_MS = 15 * 60 * 1000;

  function normaliseEmail(value) { return String(value || '').trim().toLowerCase(); }
  // The one place an invite token is read out of whatever the person pasted or tapped:
  // https://.../#invite=TOKEN (current), rosterbuddy://invite/TOKEN (older), ...?invite=TOKEN, or the bare token.
  // A web address that carries no invite is not a token.
  function tokenFromLink(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const hashOrQuery = raw.match(/[#?&]invite=([^&#\s]+)/);
    const path = raw.match(/\/invite\/([^?#\s]+)/);
    const found = hashOrQuery || path;
    if (found) { try { return decodeURIComponent(found[1]); } catch (_) { return ''; } }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /\s/.test(raw)) return '';
    return raw;
  }
  const WEB_INVITE_BASE = 'https://donkeyworks26.github.io/rosterbuddy-site/';
  // The token sits after the # so it is never sent to the web server.
  function webLink(token) { return token ? `${WEB_INVITE_BASE}#invite=${encodeURIComponent(token)}` : ''; }
  // Hand-written on purpose: no URLSearchParams, so a raw "+" in a token stays a "+".
  function hashParts(hash) {
    return String(hash || '').replace(/^#/, '').split('&').filter(Boolean).map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
    });
  }
  function inviteFromHash(hash) {
    const found = hashParts(hash).find((part) => part[0] === 'invite');
    if (!found || !found[1]) return '';
    try { return decodeURIComponent(found[1]).trim(); } catch (_) { return ''; }
  }
  function hashWithoutInvite(hash) {
    const rest = hashParts(hash).filter((part) => part[0] !== 'invite').map((part) => (part[1] === '' && !String(hash).includes(`${part[0]}=`) ? part[0] : `${part[0]}=${part[1]}`)).join('&');
    return rest ? `#${rest}` : '';
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
  return { STORAGE_KEY, MAX_AGE_MS, WEB_INVITE_BASE, normaliseEmail, tokenFromLink, webLink, inviteFromHash, hashWithoutInvite, make, read, write, clear, belongsTo };
});
