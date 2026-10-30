/* Settings > Account: the single app-wide owner of optional sign-in UI.
 * It only renders the state reported by window.RosterBuddyCurrentAuth and
 * forwards user actions to it. Signing in never uploads anything (that is the
 * separate cloud-sync consent) and signing out never touches local rosters.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddyAccountView = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  'use strict';

  // Only a closed category, the HTTP status and a fixed sentence are shown.
  // Provider bodies, emails, URLs and tokens never reach the UI.
  function failureText(error) {
    const diagnostic = error && error.diagnostic;
    if (diagnostic && typeof diagnostic.category === 'string' && typeof diagnostic.message === 'string') {
      const status = Number.isInteger(diagnostic.status) ? `HTTP ${diagnostic.status}, ` : '';
      return `Sign-in unavailable (${status}${diagnostic.category}): ${diagnostic.message}`;
    }
    return 'Sign-in unavailable. Your local roster is not affected.';
  }

  function describe(status, identity) {
    const state = status && status.authenticated && identity ? 'signed-in'
      : (!status || status.offline) ? 'not-configured'
        : status.reason === 'session_expired' ? 'session-expired' : 'signed-out';
    if (state === 'session-expired') {
      return {
        state, title: 'Session expired',
        body: 'Sign in again to use Sharing. Your roster is safe on this device and nothing is uploaded until you sign in and cloud sync is on.',
        canRequestLink: true, canSignOut: true,
      };
    }
    if (state === 'signed-in') {
      return {
        state, title: `Signed in as ${identity.email || 'your account'}`,
        body: 'Your roster stays on this device. Signing out does not delete it, and nothing is uploaded unless you turn on cloud sync.',
        canRequestLink: false, canSignOut: true,
      };
    }
    if (state === 'not-configured') {
      return {
        state, title: 'Local device',
        body: 'Sign-in is not set up in this build, so everything stays on this device.',
        canRequestLink: false, canSignOut: false,
      };
    }
    return {
      state, title: 'Local device',
      body: 'Signing in is optional and only needed for Sharing. Your roster stays on this device and nothing is uploaded until you turn on cloud sync.',
      canRequestLink: true, canSignOut: false,
    };
  }

  function bind({ document: doc, auth, addEventListener } = {}) {
    const el = (id) => doc.getElementById(id);
    let transient = '';
    function render() {
      let status = null; let identity = null;
      try { status = auth && auth.status(); identity = auth && auth.identity(); } catch (_) { status = null; identity = null; }
      const model = describe(status, identity);
      const set = (id, fn) => { const node = el(id); if (node) fn(node); };
      set('account-settings-status', (n) => { n.textContent = model.title; });
      set('account-settings-body', (n) => { n.textContent = model.body; });
      set('account-email', (n) => { n.disabled = !model.canRequestLink; n.classList.toggle('hidden-control', model.state === 'signed-in'); });
      set('account-request-link', (n) => { n.disabled = !model.canRequestLink; n.classList.toggle('hidden-control', model.state === 'signed-in'); });
      const googleOffered = model.canRequestLink && Boolean(auth && typeof auth.googleSignInAvailable === 'function' && auth.googleSignInAvailable());
      set('account-google-sign-in', (n) => { n.disabled = !googleOffered; n.classList.toggle('hidden-control', !googleOffered); });
      set('account-sign-out', (n) => { n.disabled = !model.canSignOut; n.classList.toggle('hidden-control', !model.canSignOut); });
      set('account-auth-message', (n) => { n.textContent = model.state === 'signed-in' ? '' : transient; });
      return model;
    }
    const requestButton = el('account-request-link');
    if (requestButton) requestButton.addEventListener('click', async () => {
      const input = el('account-email');
      if (!auth || typeof auth.requestMagicLink !== 'function') { transient = failureText(null); render(); return; }
      try {
        const result = await auth.requestMagicLink(String((input && input.value) || '').trim());
        const opensApp = Boolean(result && typeof result.redirectTo === 'string' && /^rosterbuddy:/i.test(result.redirectTo));
        transient = 'Check your email for the sign-in link' + (opensApp ? ' and open it on this phone to return to RosterBuddy.' : ' (it opens in your browser).') + ' Your local roster remains available.';
      } catch (error) {
        transient = failureText(error);
      }
      render();
    });
    const googleButton = el('account-google-sign-in');
    if (googleButton) googleButton.addEventListener('click', () => {
      try { auth.startGoogleSignIn(); } catch (_) { transient = failureText(null); render(); }
    });
    const signOutButton = el('account-sign-out');
    if (signOutButton) signOutButton.addEventListener('click', async () => {
      try { if (auth) await auth.signOut(); } catch (_) {}
      transient = '';
      render();
    });
    if (typeof addEventListener === 'function') addEventListener('rosterbuddy:auth-changed', () => { transient = ''; render(); });
    return render();
  }

  return { describe, failureText, bind };
});
