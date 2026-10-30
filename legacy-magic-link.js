/* Legacy password-free Supabase auth adapter for optional sharing only. */
(function attach(root) {
  'use strict';
  if (!root || root.RosterBuddyLegacyMagicLink) return;

  const SESSION_KEY = 'rosterbuddy.legacy-magic-link-session';
  const config = root.RosterBuddySupabaseConfig || {};
  const baseUrl = String(config.url || config.supabaseUrl || '').trim().replace(/\/$/, '');
  const anonKey = String(config.anonKey || config.publishableKey || config.supabaseAnonKey || '').trim();
  const errors = [];
  if (!baseUrl) errors.push('missing_url');
  else if (!/^https:\/\/[^\s/]+(?:\/.*)?$/i.test(baseUrl)) errors.push('malformed_url');
  if (!anonKey) errors.push('missing_anon_key');
  else if (/^(service_role|sb_secret)_/i.test(anonKey)) errors.push('service_role_key_rejected');
  let session = readSession();

  // The session persists across app restarts in localStorage. A session left in
  // sessionStorage by an earlier build is migrated once. If localStorage is not
  // available (or full) the tab-only store is used instead, as before. Every
  // sign-out path calls writeSession(null), which clears both stores.
  function storageFor(kind) {
    try { return root[kind] || null; } catch (_) { return null; }
  }
  function parseStored(store) {
    try { return store ? JSON.parse(store.getItem(SESSION_KEY) || 'null') : null; } catch (_) { return null; }
  }
  function readSession() {
    const persistent = storageFor('localStorage');
    const tab = storageFor('sessionStorage');
    const saved = parseStored(persistent);
    if (saved) return saved;
    const legacy = parseStored(tab);
    if (legacy && persistent) {
      try { persistent.setItem(SESSION_KEY, JSON.stringify(legacy)); tab.removeItem(SESSION_KEY); } catch (_) {}
    }
    return legacy;
  }
  function writeSession(value) {
    session = value || null;
    const persistent = storageFor('localStorage');
    const tab = storageFor('sessionStorage');
    try { if (persistent) persistent.removeItem(SESSION_KEY); } catch (_) {}
    try { if (tab) tab.removeItem(SESSION_KEY); } catch (_) {}
    if (!session) return;
    const serialized = JSON.stringify(session);
    try {
      if (!persistent) throw new Error('no persistent storage');
      persistent.setItem(SESSION_KEY, serialized);
    } catch (_) {
      try { if (tab) tab.setItem(SESSION_KEY, serialized); } catch (__) {}
    }
  }
  function configured() { return errors.length === 0; }
  function nativeAndroid() {
    const capacitor = root.Capacitor;
    return Boolean(capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform() && typeof capacitor.getPlatform === 'function' && capacitor.getPlatform() === 'android');
  }
  function redirectUrl() {
    return nativeAndroid() ? 'rosterbuddy://auth/callback' : 'https://donkeyworks26.github.io/rosterbuddy-site/auth-callback.html';
  }
  // Client-side only. An expired access token with no refresh token cannot be
  // renewed, so the session is treated as signed out. With a refresh token the
  // identity stays and accessToken() renews the token on next use. Tokens with
  // no readable exp (or no atob) are never guessed to be expired.
  function sessionExpired() {
    try {
      if (!session || session.refresh_token) return false;
      const part = String(session.access_token || '').split('.')[1];
      if (!part || typeof root.atob !== 'function') return false;
      const claims = JSON.parse(root.atob(part.replace(/-/g, '+').replace(/_/g, '/')));
      return Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now();
    } catch (_) { return false; }
  }
  function identity() {
    const user = session && session.user;
    if (!user || !user.id || sessionExpired()) return null;
    return { id: user.id, email: user.email || '', displayName: (user.user_metadata && (user.user_metadata.display_name || user.user_metadata.name)) || user.email || 'Cloud account' };
  }
  function status() {
    return { authenticated: Boolean(identity()), offline: !configured(), gate: false, mode: identity() ? 'optional-sharing' : 'offline', reason: !configured() ? (errors[0] || 'not_configured') : (identity() ? 'authenticated' : (session && sessionExpired() ? 'session_expired' : 'signed_out')) };
  }
  function notify() {
    if (typeof root.dispatchEvent !== 'function') return;
    const EventCtor = root.CustomEvent;
    if (typeof EventCtor === 'function') root.dispatchEvent(new EventCtor('rosterbuddy:auth-changed', { detail: status() }));
  }
  // Closed allowlist. Provider bodies, messages, emails, URLs and headers are
  // never copied into an Error; only a known category and the HTTP status are.
  const AUTH_DIAGNOSTICS = Object.freeze({
    redirect_not_allowed: { category: 'redirect_not_allowed', message: 'Redirect URL is not allowed.' },
    over_email_send_rate_limit: { category: 'over_email_send_rate_limit', message: 'Email sending is temporarily rate-limited.' },
    provider_disabled: { category: 'provider_disabled', message: 'The email sign-in provider is disabled.' },
    validation_failed: { category: 'validation_failed', message: 'The sign-in request was rejected as invalid.' },
    network_unavailable: { category: 'network_unavailable', message: 'The sign-in service could not be reached.' },
    over_request_rate_limit: { category: 'over_request_rate_limit', message: 'Too many sign-in requests; try again later.' },
    email_provider_disabled: { category: 'email_provider_disabled', message: 'The email sign-in provider is disabled.' },
    otp_disabled: { category: 'otp_disabled', message: 'Email sign-in links are disabled.' },
    signup_disabled: { category: 'signup_disabled', message: 'New sign-ups are disabled.' },
    email_address_invalid: { category: 'email_address_invalid', message: 'The email address was rejected as invalid.' },
    email_address_not_authorized: { category: 'email_address_not_authorized', message: 'This email address is not authorised to receive sign-in emails.' },
    unexpected_failure: { category: 'unexpected_failure', message: 'The sign-in service reported an unexpected failure.' },
    request_timeout: { category: 'request_timeout', message: 'The sign-in service timed out.' },
    captcha_failed: { category: 'captcha_failed', message: 'The sign-in service requires a captcha check.' },
  });
  const STATUS_CLASS_DIAGNOSTICS = Object.freeze({
    rate_limited: { category: 'rate_limited', message: 'The sign-in service is rate-limiting requests.' },
    request_unauthorized: { category: 'request_unauthorized', message: "The sign-in service refused the app's credentials." },
    request_rejected: { category: 'request_rejected', message: 'The sign-in service rejected the request.' },
    server_error: { category: 'server_error', message: 'The sign-in service had a server error.' },
  });
  const GENERIC_AUTH_DIAGNOSTIC = Object.freeze({ category: 'auth_error', message: 'The sign-in service returned an unrecognised error.' });
  function statusClassDiagnostic(status) {
    if (status === 429) return STATUS_CLASS_DIAGNOSTICS.rate_limited;
    if (status === 401 || status === 403) return STATUS_CLASS_DIAGNOSTICS.request_unauthorized;
    if (status >= 400 && status <= 499) return STATUS_CLASS_DIAGNOSTICS.request_rejected;
    if (status >= 500 && status <= 599) return STATUS_CLASS_DIAGNOSTICS.server_error;
    return null;
  }
  function authDiagnostic(error) {
    const status = Number.isInteger(error && error.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
    const code = typeof (error && error.code) === 'string' ? error.code : '';
    const known = (Object.prototype.hasOwnProperty.call(AUTH_DIAGNOSTICS, code) && AUTH_DIAGNOSTICS[code]) || (error && error.network ? AUTH_DIAGNOSTICS.network_unavailable : null);
    const selected = known || (status && statusClassDiagnostic(status)) || GENERIC_AUTH_DIAGNOSTIC;
    return { status, category: selected.category, message: selected.message };
  }
  function requestFailure(code, status, network) {
    const error = new Error('supabase_request_failed');
    error.code = code;
    if (status != null) error.status = status;
    if (network) error.network = true;
    error.diagnostic = authDiagnostic(error);
    return error;
  }
  async function request(path, options) {
    if (!configured()) throw new Error('supabase_not_configured');
    const headers = Object.assign({ apikey: anonKey, 'Content-Type': 'application/json' }, options && options.headers);
    if (session && session.access_token && !(options && options.headers && options.headers.Authorization)) headers.Authorization = 'Bearer ' + session.access_token;
    const fetchFn = root.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) throw new Error('fetch_unavailable');
    let response;
    try { response = await fetchFn(baseUrl + path, Object.assign({}, options, { headers })); }
    catch (_) { throw requestFailure('network_unavailable', null, true); }
    let body = null; try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      // GoTrue sends the string in `error_code` (legacy; `code` is the HTTP status) or in `code` (versioned).
      const candidates = body && typeof body === 'object' ? [body.error_code, body.code] : [];
      const code = candidates.find((value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUTH_DIAGNOSTICS, value)) || '';
      throw requestFailure(code, response.status, false);
    }
    return body;
  }
  function tokenPair() {
    const hash = new URLSearchParams((root.location.hash || '').replace(/^#/, ''));
    return { accessToken: hash.get('access_token'), refreshToken: hash.get('refresh_token') };
  }
  async function requestMagicLink(email, allowCreate) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('email_invalid');
    await request('/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: normalized, options: { shouldCreateUser: allowCreate === true, emailRedirectTo: redirectUrl() } }) });
    return { ok: true, email: normalized, redirectTo: redirectUrl() };
  }
  async function resumeMagicLink() {
    const tokens = tokenPair();
    if (!tokens.accessToken || !tokens.refreshToken) return status();
    const user = await request('/auth/v1/user', { method: 'GET', headers: { Authorization: 'Bearer ' + tokens.accessToken } });
    writeSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, user });
    try { root.history.replaceState({}, root.document && root.document.title || '', root.location.pathname + root.location.search); } catch (_) {}
    notify();
    return status();
  }
  async function signOut() { writeSession(null); notify(); return { ok: true }; }

  // The single source of the bearer token used by sharing RPCs and realtime.
  // Refreshes shortly before expiry. A terminal refresh failure (the provider
  // rejected the refresh token) signs the app out; a transient failure (offline,
  // 5xx, rate limit) keeps the session and rejects this one call.
  const REFRESH_SKEW_MS = 60 * 1000;
  let refreshInFlight = null;
  function tokenExpiryMs(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
      const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4);
      const payload = JSON.parse(root.atob ? root.atob(padded) : Buffer.from(padded, 'base64').toString('utf8'));
      return payload && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
    } catch (_) { return null; }
  }
  function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    const refreshToken = session && session.refresh_token;
    refreshInFlight = (async () => {
      try {
        const body = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }), headers: { Authorization: 'Bearer ' + anonKey } });
        if (!body || !body.access_token || !body.refresh_token) throw requestFailure('', 400, false);
        writeSession({ access_token: body.access_token, refresh_token: body.refresh_token, user: body.user || (session && session.user) });
        return session.access_token;
      } catch (error) {
        const terminal = error && !error.network && Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 429;
        if (terminal) { writeSession(null); notify(); return null; }
        throw error;
      } finally { refreshInFlight = null; }
    })();
    return refreshInFlight;
  }
  async function accessToken() {
    if (!session || !session.access_token) return null;
    const expiresAt = tokenExpiryMs(session.access_token);
    if (expiresAt == null || expiresAt - Date.now() > REFRESH_SKEW_MS) return session.access_token;
    if (!session.refresh_token) { writeSession(null); notify(); return null; }
    return refreshSession();
  }
  // The native shell delivers a late callback as a same-document hash change
  // (`#rb_cb=auth&...`), so the one-time load-time resume is not enough. A
  // failed late callback must never sign out an already-valid session.
  function consumeLateCallback() {
    if (!configured() || !tokenPair().accessToken) return;
    resumeMagicLink().catch(function () { try { root.history.replaceState({}, '', root.location.pathname + root.location.search); } catch (_) {} });
  }

  root.RosterBuddyLegacyMagicLink = { configured: configured(), errors: errors.slice(), status, identity, accessToken, requestMagicLink, resumeMagicLink, signOut, redirectUrl, authDiagnostic };
  if (typeof root.addEventListener === 'function') root.addEventListener('hashchange', consumeLateCallback);
  if (configured()) resumeMagicLink().catch(function () { writeSession(null); });
})(typeof window !== 'undefined' ? window : null);
