const templates = {
  early: { label: "Early", icon: "9T", start: "07:30", finish: "17:30", breakMinutes: 0, colour: "aqua", hours: 10, type: "work" },
  mid: { label: "Mid", icon: "9=", start: "09:00", finish: "19:00", breakMinutes: 0, colour: "amber", hours: 10, type: "work" },
  afternoon: { label: "Afternoon", icon: "9S", start: "11:00", finish: "21:00", breakMinutes: 0, colour: "coral", hours: 10, type: "work" },
  late: { label: "Late", icon: "9V", start: "12:30", finish: "22:30", breakMinutes: 0, colour: "violet", hours: 10, type: "work" },
  overnight: { label: "Overnight", icon: "NB", start: "22:00", finish: "08:00", breakMinutes: 0, colour: "plum", hours: 10, type: "work" },
  night: { label: "Night", icon: "N", start: "21:30", finish: "07:30", breakMinutes: 30, colour: "indigo", hours: 9.5, type: "work" },
  sick: { label: "Sick leave", icon: "SL", start: "", finish: "", breakMinutes: 0, colour: "red", hours: 0, type: "leave" },
  annual: { label: "Annual leave", icon: "AL", start: "", finish: "", breakMinutes: 0, colour: "blue", hours: 0, type: "leave" },
  off: { label: "Off", icon: "OFF", start: "", finish: "", breakMinutes: 0, colour: "green", hours: 0, type: "recovery" },
};

const demoRoster = {
  1: "early",
  2: "early",
  3: "late",
  4: "night",
  5: "night",
  6: "night",
  8: "off",
  9: "early",
  10: "early",
  11: "late",
  13: "night",
  14: "night",
  15: "off",
  17: "late",
  18: "early",
  20: "night",
  21: "night",
  22: "off",
  25: "early",
  26: "late",
  27: "night",
  29: "off",
};

const rosters = {};
let calendarViewReadOnly = false;
let calendarViewProjection = null;
let calendarViewFilter = null;
let calendarViewSelectedDay = null;
const casualRosters = {};
const higherDutiesRosters = {};
const onCallRosters = {};
const additionalHoursRosters = {};
const reminders = {};
const dayNotes = {};
const STORAGE_KEY = "shiftWorkerRosterPrototypeV10";
const BACKUP_SCHEMA_VERSION = 1;
// Schema marker for the persisted state's template block. It travels inside
// currentStatePayload(), so the saved state and the backup file (which embeds
// that same payload) share one source of truth. Bump it only when a new
// one-time template migration is added; it is deliberately independent of
// BACKUP_SCHEMA_VERSION, which versions the backup envelope.
const TEMPLATE_STATE_SCHEMA_VERSION = 3;
// Each one-time template migration keeps its own gate rather than sharing
// "anything older than current". The Off type repair must still only touch
// state written before any marker existed (version 0), otherwise bumping the
// marker for an unrelated migration would rewrite a deliberate post-marker
// Off choice all over again.
const TEMPLATE_OFF_TYPE_REPAIR_SCHEMA_VERSION = 2;
// Version 3 merges back the built-in templates the old drifted key allowlist
// had already deleted from installed state.
const TEMPLATE_BUILT_IN_RESTORE_SCHEMA_VERSION = 3;
const APP_VERSION = "0.2.1";
const FIXED_CASUAL_LOADING = 0.25;
const TEMPLATE_COLOURS = new Set(["aqua", "coral", "amber", "violet", "green", "blue", "pink", "slate", "red", "lime", "indigo", "mint", "gold", "plum", "orange"]);

function safeTemplateColour(value) {
  const colour = String(value || "").trim();
  return TEMPLATE_COLOURS.has(colour) ? colour : "aqua";
}

const TEMPLATE_TYPES = new Set(["work", "leave", "recovery"]);

// Only the three types the template editor can actually produce are allowed
// through; anything else falls back to the key's own known-good default type
// (never to the arbitrary stored value), and to "work" when there is no
// default for that key to trust.
function safeTemplateType(value, fallbackType) {
  const type = String(value || "").trim();
  if (TEMPLATE_TYPES.has(type)) return type;
  const fallback = String(fallbackType || "").trim();
  return TEMPLATE_TYPES.has(fallback) ? fallback : "work";
}

// True only when every user-editable field still matches the shipped default
// for this key, so the record carries no sign of deliberate customisation.
// Compared against the already-normalised `safe`, because a legacy payload
// that stored only `{ type: "work" }` merges up to the default shape and is
// exactly the case the legacy repair exists for.
function matchesShippedDefaultShape(safe, fallback) {
  if (!fallback || typeof fallback !== "object") return false;
  return safe.label === fallback.label
    && safe.icon === fallback.icon
    && safe.start === String(fallback.start || "").trim()
    && safe.finish === String(fallback.finish || "").trim()
    && safe.breakMinutes === Math.max(0, Number(fallback.breakMinutes) || 0)
    && safe.hours === Math.max(0, Number(fallback.hours) || 0)
    && safe.colour === safeTemplateColour(fallback.colour);
}

function sanitizedTemplate(template, fallback = {}, key = "", legacyPayload = false) {
  const base = template && typeof template === "object" ? template : {};
  const safe = { ...fallback, ...base };
  safe.label = String(safe.label || fallback.label || "Custom").trim() || "Custom";
  safe.icon = String(safe.icon || fallback.icon || safe.label.slice(0, 2).toUpperCase()).trim().slice(0, 8) || "C";
  safe.start = String(safe.start || "").trim();
  safe.finish = String(safe.finish || "").trim();
  safe.breakMinutes = Math.max(0, Number(safe.breakMinutes) || 0);
  safe.hours = Math.max(0, Number(safe.hours) || 0);
  // This used to be `safe.type === "leave" ? "leave" : "work"`, which
  // silently rewrote the built-in Off template (type "recovery") to "work"
  // on every load/restore -- so Recovery counted visible Off days as
  // rostered work days and reported no recovery blocks at all.
  safe.type = safeTemplateType(safe.type, fallback.type);
  safe.colour = safeTemplateColour(safe.colour);
  // One-time repair of state corrupted by that old rule, gated three ways so
  // it cannot overwrite intent. It runs only for a payload written before
  // TEMPLATE_STATE_SCHEMA_VERSION existed; only for the built-in Off key,
  // whose default type is "recovery"; and only when the stored record is
  // otherwise identical to the shipped Off default. The template editor
  // legitimately offers "Use normal pay rules" for Off, so anything the user
  // has touched -- or anything saved since the marker -- keeps its stored
  // type. A persisted off+"leave" is never touched either: the old rule could
  // emit "leave", so that value provably survived it as the user set it.
  if (legacyPayload && key === "off" && safe.type === "work" && fallback.type === "recovery" && matchesShippedDefaultShape(safe, fallback)) {
    safe.type = "recovery";
  }
  return safe;
}

// Derived from DEFAULT_TEMPLATES rather than a hand-maintained list: the
// previous regex had drifted and silently deleted the real "afternoon",
// "sick" and "annual" keys on every round trip. DEFAULT_TEMPLATES is used
// directly (not the fallbackTemplates argument) so a partial fallback can
// never narrow what counts as a real key. hasOwnProperty keeps inherited
// names such as "constructor" and "__proto__" out.
function isKnownTemplateKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, key) || /^custom\d+$/.test(key);
}

function sanitizedTemplatesPayload(payload, fallbackTemplates = DEFAULT_TEMPLATES, { payloadVersion = TEMPLATE_STATE_SCHEMA_VERSION } = {}) {
  const result = {};
  const source = payload && typeof payload === "object" ? payload : fallbackTemplates;
  const legacyPayload = payloadVersion < TEMPLATE_OFF_TYPE_REPAIR_SCHEMA_VERSION;
  Object.entries(source).forEach(([key, template]) => {
    const templateKey = String(key);
    if (!isKnownTemplateKey(templateKey)) return;
    result[templateKey] = sanitizedTemplate(template, fallbackTemplates[templateKey] || {}, templateKey, legacyPayload);
  });
  // One-time repair of state the old allowlist had already damaged: it
  // deleted the real "afternoon", "sick" and "annual" records, and nothing
  // in the UI can recreate a built-in (only custom keys have a delete
  // control), so those shifts were gone for good. Every missing built-in is
  // merged back from the trusted shipped defaults -- never DEFAULT_TEMPLATES
  // by reference, never an existing record, and never an unknown key, since
  // only keys DEFAULT_TEMPLATES itself owns are considered. Restored records
  // are appended in shipped order; the templates the user already has keep
  // their existing order.
  if (payloadVersion < TEMPLATE_BUILT_IN_RESTORE_SCHEMA_VERSION && Object.keys(result).length) {
    Object.keys(DEFAULT_TEMPLATES).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(result, key)) return;
      result[key] = sanitizedTemplate(JSON.parse(JSON.stringify(DEFAULT_TEMPLATES[key])), DEFAULT_TEMPLATES[key], key, false);
    });
  }
  return Object.keys(result).length ? result : JSON.parse(JSON.stringify(fallbackTemplates));
}

// 0 for anything written before the marker existed, which is the only state
// the legacy Off repair may act on.
function templateStateVersionOf(saved) {
  const version = saved && typeof saved === "object" ? saved.templateStateVersion : 0;
  return Number.isInteger(version) && version > 0 ? version : 0;
}

// State written by a newer RosterBuddy than this build. Its template block
// may use rules this build has never seen, so it is refused outright rather
// than sanitised under the old rules and stamped back down to the current
// marker -- either of which would silently destroy the newer data.
function isUnsupportedTemplateStateVersion(saved) {
  return templateStateVersionOf(saved) > TEMPLATE_STATE_SCHEMA_VERSION;
}

let payProfiles = {
  main: { label: "Main role", rate: 48.81 },
  higher: { label: "Higher duties", rate: 51.64 },
};

let payRules = {
  baseRate: 48.81,
  nightLoading: 0,
  afterHoursStart: "19:00",
  saturdayExtra: 0.5,
  sundayExtra: 0.75,
  overtimeAfterHours: 76,
  overtimeMultiplier: 1.5,
  taxRate: 0.22,
  taxMethod: "payg",
  taxFreeThreshold: true,
  paygTaxOverride: 0,
  salarySacrifice: 0,
  mealsEntertainmentSacrifice: 0,
  additionalTax: 0,
  publicHolidayMultiplier: 2.5,
  onCallAllowance: 0,
};

const manualPublicHolidays = {};
const DEFAULT_TEMPLATES = JSON.parse(JSON.stringify(templates));
const DEFAULT_PAY_PROFILES = JSON.parse(JSON.stringify(payProfiles));
const DEFAULT_PAY_RULES = { ...payRules };

// Keep the persisted theme value deliberately small and fail closed. Older
// builds offered Sunrise/Gum (and earlier builds used other experimental
// names); none of those values should survive a load or restore.
function normalizeTheme(value) {
  return String(value || "").toLowerCase() === "midnight" ? "midnight" : "default";
}

// Applied only on a genuinely fresh install (see applyFreshInstallDefaults),
// never used as a legacy merge/repair fallback -- those keep using
// DEFAULT_TEMPLATES/DEFAULT_PAY_PROFILES/DEFAULT_PAY_RULES/
// DEFAULT_SCAN_ROSTER_IDENTITY unchanged so existing and partial legacy
// state still completes against the old shipped shape it was actually
// saved against. The six work slots keep their structural keys (code
// elsewhere references templates.early/.late by key) but carry no
// employer-specific code, time, or hours; Sick/Annual/Off are already
// generic and are left as-is.
const FRESH_TEMPLATES = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
[
  ["early", "Shift 1", "S1"],
  ["mid", "Shift 2", "S2"],
  ["afternoon", "Shift 3", "S3"],
  ["late", "Shift 4", "S4"],
  ["overnight", "Shift 5", "S5"],
  ["night", "Shift 6", "S6"],
].forEach(([key, label, icon]) => {
  if (!FRESH_TEMPLATES[key]) return;
  FRESH_TEMPLATES[key] = { ...FRESH_TEMPLATES[key], label, icon, start: "", finish: "", breakMinutes: 0, hours: 0 };
});
const FRESH_PAY_PROFILES = { main: { label: "Main role", rate: 0 }, higher: { label: "Higher duties", rate: 0 } };
const FRESH_PAY_RULES = {
  baseRate: 0,
  nightLoading: 0,
  afterHoursStart: "",
  saturdayExtra: 0,
  sundayExtra: 0,
  overtimeAfterHours: 0,
  overtimeMultiplier: 0,
  taxRate: 0,
  taxMethod: "payg",
  taxFreeThreshold: true,
  paygTaxOverride: 0,
  salarySacrifice: 0,
  mealsEntertainmentSacrifice: 0,
  additionalTax: 0,
  publicHolidayMultiplier: 0,
  onCallAllowance: 0,
};
const FRESH_PUBLIC_HOLIDAY_JURISDICTION = "manual";
const FRESH_SCAN_ROSTER_IDENTITY = { name: "", aliases: "" };

const payPeriods = {
  weekly: { label: "Weekly", days: 7 },
  fortnightly: { label: "Fortnightly", days: 14 },
  monthly: { label: "Monthly", days: null },
};

let selectedShift = "early";
let editingTemplateKey = "late";
let selectedEntryDay = 1;
let selectedPayPeriod = "fortnightly";
let selectedTheme = "default";
let calendarDetailsCollapsed = false;
let nextCustomTemplate = 1;
const installDate = new Date();
let currentYear = installDate.getFullYear();
let currentMonth = installDate.getMonth();
let payCycleStartDate = dateKeyForDate(installDate);
let templateHoursManuallyEdited = false;
let weekStartDay = 0;
let recoveryAlertsEnabled = true;
let onboardingCompleted = false;
let publicHolidayJurisdiction = "tasmania";
let backupCreatedAt = "";
let backupSchemaVersion = null;
let templateStateVersion = TEMPLATE_STATE_SCHEMA_VERSION;
// Set only when this device's saved state was written by a newer RosterBuddy
// than this build understands. While set, saving is blocked so that state is
// preserved rather than overwritten.
let unsupportedSavedTemplateState = false;
let unsupportedSavedTemplateStateReported = false;
const DEFAULT_SCAN_ROSTER_IDENTITY = { name: "Alex Ford", aliases: "Ford Alex" };
let scanRosterIdentity = { ...DEFAULT_SCAN_ROSTER_IDENTITY };
// Roster format: "personal" (my own electronic grid, no staff/name matching)
// or "team" (find my name in a staff roster). Any value other than the
// exact string "personal" -- missing, unknown, legacy, wrong case -- resolves
// to "team" so existing users and absent settings keep today's behaviour.
const DEFAULT_SCAN_ROSTER_FORMAT = "team";
function sanitizedScanRosterFormat(value) {
  return value === "personal" ? "personal" : DEFAULT_SCAN_ROSTER_FORMAT;
}
let scanRosterFormat = DEFAULT_SCAN_ROSTER_FORMAT;
let scanRosterCodeMappings = {};
let scanRosterDrafts = [];
let guidedScanSession = { rawText: "", lines: [], mode: "header-row", resolvedLines: [], rowCandidates: [], dateCandidates: [], geometryBlocks: [], automaticDrafts: [], trustedRowStripDrafts: [], trustedRowStripCapability: null, trustedRowStripRequestId: null, trustedRowStripGeneration: null, rowStripProvenance: null, requiresConfirmation: false, dateRowConfirmed: false, staffRowConfirmed: false, personalContextConfirmed: false, personalDateContext: null, selectedRowIndex: -1, selectedDateIndex: -1, warning: "" };
// Gate 2 cloud checks remain entirely in memory. Native owns future transport;
// this web gate stores only one masked artifact for the current scan session.
let guidedScanCloudArtifact = null;
let guidedScanCloudGenerationSeq = 0;
const guidedScanPreviewBootstraps = new Map();
const GUIDED_SCAN_CLOUD_CONSENT_VERSION = "ai-roster-v1";
const GUIDED_SCAN_CLOUD_MAX_DATA_URL_CHARS = 2_000_000;
const GUIDED_SCAN_CLOUD_CONSENT_LIFETIME_MS = 60_000;
const GUIDED_SCAN_CLOUD_PRODUCTION_STATE = Object.freeze({ transport: null, mode: "offline", billable: false });
// Keep the transport inside a lexical closure: classic-script top-level
// functions become window properties, and a shipped setter would let any
// page script replace the deliberately-null production transport. Tests
// instrument the `const transport` declaration in their private VM copy;
// production ships no mutation path.
const guidedScanCloudTransportRuntime = (() => {
  const transport = GUIDED_SCAN_CLOUD_PRODUCTION_STATE.transport;
  const available = () => typeof transport === "function";
  const run = (payload, timeoutMs = 15_000) => {
    if (!available()) return Promise.resolve(null);
    let transportPromise;
    try {
      transportPromise = transport(payload);
    } catch (error) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      Promise.resolve(transportPromise).then(finish, () => finish(null));
    });
  };
  return Object.freeze({ available, run });
})();
let guidedScanCloudConsent = null;
let guidedScanCloudConsentExpiryTimer = null;
let guidedScanCloudInFlightGeneration = null;
let pendingScanRosterReviewTemplateKey = "";
let lastScanRosterImportSummary = null;
let scanRosterAiReview = null;
const ACTIVE_SCREEN_STORAGE_KEY = "shiftmate.activeScreen";
let activeScreen = "calendar";

// The web app is local-first. Cloud sharing, when configured, owns its own
// optional magic-link session and must never gate startup or local roster use.
const appAuthSession = Object.freeze({
  identity: () => window.RosterBuddyLegacyMagicLink && typeof window.RosterBuddyLegacyMagicLink.identity === "function"
    ? window.RosterBuddyLegacyMagicLink.identity() : null,
  status: () => window.RosterBuddyLegacyMagicLink && typeof window.RosterBuddyLegacyMagicLink.status === "function"
    ? window.RosterBuddyLegacyMagicLink.status()
    : ({ authenticated: false, offline: true, gate: false, mode: "offline" }),
  accessToken: () => window.RosterBuddyLegacyMagicLink && typeof window.RosterBuddyLegacyMagicLink.accessToken === "function"
    ? window.RosterBuddyLegacyMagicLink.accessToken() : Promise.resolve(null),
  requestMagicLink: (email) => window.RosterBuddyLegacyMagicLink.requestMagicLink(email, false),
  signOut: () => window.RosterBuddyLegacyMagicLink ? window.RosterBuddyLegacyMagicLink.signOut() : Promise.resolve({ ok: true }),
});
window.RosterBuddyCurrentAuth = appAuthSession;

// Central Premium/AI entitlement foundation. Nothing here makes a network
// call or checks real payment -- Google Play Billing verification is a
// later, separate piece of work. This only decides, in one place, which
// features require Premium so call sites never hard-code their own checks.
// Manual entry, backup/import, privacy, and reset intentionally have no
// entry here (or are marked isPremium: false): they must stay free no
// matter what Premium/entitlement work happens later.
const PLAY_PREMIUM_SUBSCRIPTION_ID = "rosterbuddy_premium_monthly";
const PLAY_PREMIUM_BASE_PLAN_ID = "premium-monthly";
const PLAY_PREMIUM_ENTITLEMENT_STORAGE_KEY = "rosterbuddy.playPremiumActive";
const PREMIUM_FEATURES = {
  manualEntry: { label: "Manual shift entry", isPremium: false },
  backup: { label: "Backup & restore", isPremium: false },
  scanner: { label: "Smart Scanner", isPremium: true, isLive: true },
  aiAssist: { label: "AI Roster Assist", isPremium: true, isLive: false },
  // Distinct from aiAssist above: this is the Smart Scanner's optional,
  // fully-offline second-opinion review pass (see AiRosterReviewService).
  // It is genuinely live -- it never calls a network/cloud provider -- so it
  // must never share aiAssist's "not enabled yet" cloud-feature messaging.
  scannerAiAssist: { label: "Scan AI Assist (offline second opinion)", isPremium: true, isLive: true },
};
const PREMIUM_LOCKED_SCANNER_MESSAGE = "Smart Scanner is a Premium feature. Manual shift entry remains free.";
let playPremiumUnlocked = false;
let premiumUnlocked = false;

function refreshPremiumUnlockedState() {
  premiumUnlocked = playPremiumUnlocked === true;
  return premiumUnlocked;
}

function loadPremiumUnlockState() {
  try {
    playPremiumUnlocked = window.localStorage.getItem(PLAY_PREMIUM_ENTITLEMENT_STORAGE_KEY) === "true";
  } catch (error) {
    playPremiumUnlocked = false;
  }
  refreshPremiumUnlockedState();
}

function isPremiumUnlocked() {
  return refreshPremiumUnlockedState() === true;
}

function setPlayPremiumEntitlement(enabled) {
  playPremiumUnlocked = Boolean(enabled);
  try {
    if (playPremiumUnlocked) window.localStorage.setItem(PLAY_PREMIUM_ENTITLEMENT_STORAGE_KEY, "true");
    else window.localStorage.removeItem(PLAY_PREMIUM_ENTITLEMENT_STORAGE_KEY);
  } catch (error) {
    // Storage failures should not block the live Play entitlement for this run.
  }
  return refreshPremiumUnlockedState();
}

function androidBillingBridge() {
  return window.RosterBuddyAndroid || window.RosterMateAndroid || window.ShiftMateAndroid || window.RosterLyteAndroid || null;
}

function updatePremiumBillingStatus(message, tone = "info") {
  const status = document.getElementById("premium-billing-status");
  if (status) {
    status.textContent = message || "";
    status.dataset.tone = tone;
  }
}

function handlePlayBillingResult(result = {}) {
  const active = Boolean(result.premium);
  setPlayPremiumEntitlement(active);
  const message = result.message || (active ? "RosterBuddy Premium is active." : "No active RosterBuddy Premium subscription found.");
  updatePremiumBillingStatus(message, active ? "success" : (result.ok ? "info" : "warning"));
  renderPremiumScreen();
  renderScanRosterPremiumGate();
  if (active) showToast("RosterBuddy Premium is active.", "success");
}

function syncPremiumEntitlementFromPlay(reason = "restore") {
  const bridge = androidBillingBridge();
  if (!bridge || typeof bridge.queryPremiumEntitlement !== "function") {
    updatePremiumBillingStatus("Play Billing is only available in the Google Play Android app build.", "warning");
    return false;
  }
  updatePremiumBillingStatus(reason === "startup" ? "Checking Google Play Premium status…" : "Checking Google Play for an active subscription…");
  bridge.queryPremiumEntitlement(String(reason || "restore"));
  return true;
}

function startPremiumPurchase() {
  const bridge = androidBillingBridge();
  if (!bridge || typeof bridge.startPremiumPurchase !== "function") {
    updatePremiumBillingStatus("Install RosterBuddy from Google Play to subscribe.", "warning");
    return false;
  }
  updatePremiumBillingStatus("Opening Google Play purchase screen…");
  bridge.startPremiumPurchase("purchase");
  return true;
}

// Scanner Lab entitlement: unlocks ONLY the "scanner" feature gate below, for
// the side-loaded, no-Play-Store "RosterBuddy Scanner Lab" debug install
// (com.donkeyworks.rosterbuddy.scannerlab -- see RosterMateBridge#
// isScannerLabBuild and android/app/build.gradle's debug applicationIdSuffix).
// This is deliberately re-derived from the live native bridge call every
// time, never cached in a variable or persisted to localStorage/any other
// JS-settable place -- the real compiled applicationId is the only source of
// truth, so nothing in the web layer (console, a query param, a global) can
// grant it on the real release app.
// A private lexical binding (const, not a top-level function declaration):
// a top-level `function` creates a mutable window.isScannerLabEntitled
// property that outside script/console code could reassign; `const` creates
// no such property at all, so premiumFeatureState's own internal call below
// always resolves this exact binding regardless of what a same-named global
// property is later set to.
const isScannerLabEntitled = function isScannerLabEntitled() {
  try {
    const bridge = androidBillingBridge();
    return Boolean(bridge && typeof bridge.isScannerLabBuild === "function" && bridge.isScannerLabBuild() === true);
  } catch (error) {
    return false;
  }
};

// Single source of truth for "can the app use feature X right now". Call
// sites ask premiumFeatureState(key).allowed instead of re-deriving their
// own hard-coded Premium check.
function premiumFeatureState(featureKey) {
  const feature = PREMIUM_FEATURES[featureKey];
  if (!feature) return { key: featureKey, label: featureKey, isPremium: false, isLive: true, allowed: true };
  const isPremium = Boolean(feature.isPremium);
  const scannerLabOverride = featureKey === "scanner" && isScannerLabEntitled();
  return {
    key: featureKey,
    label: feature.label || featureKey,
    isPremium,
    isLive: feature.isLive !== false,
    allowed: !isPremium || isPremiumUnlocked() || scannerLabOverride,
  };
}
let monthAnimationTimer = null;
let monthTransitionTimer = null;
let monthDragStartX = 0;
let monthDragStartY = 0;
let monthDragCurrentX = 0;
let monthIsDragging = false;
let monthIsTransitioning = false;
let shareRangeMode = "pay-cycle";
let shareWeekStartDate = "";
let currentSharePreviewText = "";
let payCycleViewOffset = 0;
let entryModifierState = { casual: false, higherDuties: false, onCall: false };
const history = ["calendar"];

function clearObject(target) {
  Object.keys(target).forEach((key) => delete target[key]);
}

function migratePayCycleState(saved) {
  if (!saved || typeof saved !== "object") return false;
  let migratedPayCycleStartDate = "";
  if (typeof saved.payCycleStartDate === "string" && parseDateInput(saved.payCycleStartDate)) {
    migratedPayCycleStartDate = dateKeyForDate(parseDateInput(saved.payCycleStartDate));
  } else if (saved.payRules && typeof saved.payRules.payCycleStartDate === "string" && parseDateInput(saved.payRules.payCycleStartDate)) {
    migratedPayCycleStartDate = dateKeyForDate(parseDateInput(saved.payRules.payCycleStartDate));
  }
  const hadLegacyPayCycleStartDate = !!(saved.payRules && Object.prototype.hasOwnProperty.call(saved.payRules, "payCycleStartDate"));
  if (migratedPayCycleStartDate) payCycleStartDate = migratedPayCycleStartDate;
  if (Object.prototype.hasOwnProperty.call(payRules, "payCycleStartDate")) delete payRules.payCycleStartDate;
  return hadLegacyPayCycleStartDate || (migratedPayCycleStartDate && migratedPayCycleStartDate !== saved.payCycleStartDate);
}

function applyStatePayload(saved) {
  if (!saved || typeof saved !== "object") return false;
  // Fail closed on state from a newer build: apply nothing at all, so no
  // half-migrated mixture of new roster data and old templates can be saved.
  if (isUnsupportedTemplateStateVersion(saved)) return false;
  let stateMigrated = false;
  // Read the marker from the incoming payload only, never from module state:
  // replaceStateWithPayload sanitises the same raw payload twice, so a gate
  // that consulted an already-stamped module variable would skip the repair
  // on the second pass.
  const payloadTemplateVersion = templateStateVersionOf(saved);
  const legacyTemplatePayload = payloadTemplateVersion < TEMPLATE_STATE_SCHEMA_VERSION;
  if (saved.templates && typeof saved.templates === "object") {
    clearObject(templates);
    Object.assign(templates, sanitizedTemplatesPayload(saved.templates, DEFAULT_TEMPLATES, { payloadVersion: payloadTemplateVersion }));
    // Force a re-save so the marker is persisted and the repair cannot run
    // a second time. Gated on templates existing so a first launch reading
    // an empty payload does not trigger a spurious save.
    if (legacyTemplatePayload) stateMigrated = true;
  }
  if (saved.payProfiles && typeof saved.payProfiles === "object") {
    clearObject(payProfiles);
    Object.assign(payProfiles, {
      main: { label: "Main role", rate: 48.81 },
      higher: { label: "Higher duties", rate: 51.64 },
    }, saved.payProfiles);
  }
  if (saved.rosters && typeof saved.rosters === "object") {
    clearObject(rosters);
    Object.assign(rosters, saved.rosters);
  }
  if (saved.casualRosters && typeof saved.casualRosters === "object") {
    clearObject(casualRosters);
    Object.assign(casualRosters, saved.casualRosters);
  }
  if (saved.higherDutiesRosters && typeof saved.higherDutiesRosters === "object") {
    clearObject(higherDutiesRosters);
    Object.assign(higherDutiesRosters, saved.higherDutiesRosters);
  }
  if (saved.onCallRosters && typeof saved.onCallRosters === "object") {
    clearObject(onCallRosters);
    Object.assign(onCallRosters, saved.onCallRosters);
  }
  if (saved.additionalHoursRosters && typeof saved.additionalHoursRosters === "object") {
    clearObject(additionalHoursRosters);
    Object.assign(additionalHoursRosters, saved.additionalHoursRosters);
  }
  if (saved.reminders && typeof saved.reminders === "object") {
    clearObject(reminders);
    Object.assign(reminders, saved.reminders);
  }
  if (saved.dayNotes && typeof saved.dayNotes === "object") {
    clearObject(dayNotes);
    Object.assign(dayNotes, saved.dayNotes);
  }
  if (saved.manualPublicHolidays && typeof saved.manualPublicHolidays === "object") {
    clearObject(manualPublicHolidays);
    Object.assign(manualPublicHolidays, saved.manualPublicHolidays);
  }
  if (saved.payRules && typeof saved.payRules === "object") payRules = { ...payRules, ...saved.payRules };
  const payCycleStateMigrated = migratePayCycleState(saved);
  stateMigrated = payCycleStateMigrated || stateMigrated;
  if (payPeriods[saved.selectedPayPeriod]) selectedPayPeriod = saved.selectedPayPeriod;
  // The compact timed legend is part of the fixed Calendar layout, so it always
  // starts expanded; the toggle only hides it for the current session.
  calendarDetailsCollapsed = false;
  if (typeof saved.selectedTheme === "string") {
    const normalizedTheme = normalizeTheme(saved.selectedTheme);
    stateMigrated = stateMigrated || normalizedTheme !== saved.selectedTheme;
    selectedTheme = normalizedTheme;
  }
  if (Number.isInteger(saved.nextCustomTemplate)) nextCustomTemplate = saved.nextCustomTemplate;
  if (Number.isInteger(saved.currentYear)) currentYear = saved.currentYear;
  if (Number.isInteger(saved.currentMonth) && saved.currentMonth >= 0 && saved.currentMonth <= 11) currentMonth = saved.currentMonth;
  if (Number.isInteger(saved.selectedEntryDay)) selectedEntryDay = saved.selectedEntryDay;
  if (Number.isInteger(saved.weekStartDay)) weekStartDay = [0, 1, 6].includes(saved.weekStartDay) ? saved.weekStartDay : 0;
  if (typeof saved.recoveryAlertsEnabled === "boolean") recoveryAlertsEnabled = saved.recoveryAlertsEnabled;
  if (typeof saved.onboardingCompleted === "boolean") onboardingCompleted = saved.onboardingCompleted;
  if (["tasmania", "australia", "manual"].includes(saved.publicHolidayJurisdiction)) publicHolidayJurisdiction = saved.publicHolidayJurisdiction;
  if (typeof saved.backupCreatedAt === "string") backupCreatedAt = saved.backupCreatedAt;
  if (Number.isInteger(saved.backupSchemaVersion)) backupSchemaVersion = saved.backupSchemaVersion;
  if (saved.scanRosterIdentity && typeof saved.scanRosterIdentity === "object") {
    // A blank name+aliases is a real, reachable state since fresh installs
    // start with no identity configured (see applyFreshInstallDefaults) and
    // the Team scan gate relies on that blank surviving save/restore
    // round-trips. It is stored exactly as saved, never reinterpreted as
    // corruption and silently reverted to the legacy Alex Ford default.
    // Legacy state with no scanRosterIdentity key at all (this whole `if`
    // skipped) keeps whatever scanRosterIdentity already held -- the module's
    // Alex Ford default on first load, unchanged.
    scanRosterIdentity = {
      name: typeof saved.scanRosterIdentity.name === "string" ? saved.scanRosterIdentity.name : "",
      aliases: typeof saved.scanRosterIdentity.aliases === "string" ? saved.scanRosterIdentity.aliases : "",
    };
  }
  scanRosterFormat = sanitizedScanRosterFormat(saved.scanRosterFormat);
  clearObject(scanRosterCodeMappings);
  if (saved.scanRosterCodeMappings && typeof saved.scanRosterCodeMappings === "object") {
    Object.entries(saved.scanRosterCodeMappings).forEach(([code, mapping]) => {
      if (!mapping || typeof mapping !== "object") return;
      const key = compactScanCode(code);
      if (!key || !templates[mapping.shiftKey]) return;
      scanRosterCodeMappings[key] = {
        shiftKey: mapping.shiftKey,
        onCall: Boolean(mapping.onCall),
        higherDuties: Boolean(mapping.higherDuties),
      };
    });
  }
  // The in-memory templates have now been sanitised to the current schema,
  // so anything saved or exported from here carries the current marker.
  templateStateVersion = TEMPLATE_STATE_SCHEMA_VERSION;
  return stateMigrated;
}

function replaceStateWithPayload(saved) {
  if (!saved || typeof saved !== "object") return false;
  // Checked before the first clearObject: refusing a future payload halfway
  // through would already have wiped the state it was meant to protect.
  if (isUnsupportedTemplateStateVersion(saved)) return false;
  clearObject(templates);
  clearObject(payProfiles);
  clearObject(rosters);
  clearObject(casualRosters);
  clearObject(higherDutiesRosters);
  clearObject(onCallRosters);
  clearObject(additionalHoursRosters);
  clearObject(reminders);
  clearObject(dayNotes);
  clearObject(manualPublicHolidays);
  Object.assign(templates, sanitizedTemplatesPayload(
    saved.templates && typeof saved.templates === "object" ? saved.templates : DEFAULT_TEMPLATES,
    DEFAULT_TEMPLATES,
    { payloadVersion: templateStateVersionOf(saved) },
  ));
  Object.assign(payProfiles, DEFAULT_PAY_PROFILES, saved.payProfiles && typeof saved.payProfiles === "object" ? saved.payProfiles : {});
  Object.assign(rosters, saved.rosters && typeof saved.rosters === "object" ? saved.rosters : {});
  Object.assign(casualRosters, saved.casualRosters && typeof saved.casualRosters === "object" ? saved.casualRosters : {});
  Object.assign(higherDutiesRosters, saved.higherDutiesRosters && typeof saved.higherDutiesRosters === "object" ? saved.higherDutiesRosters : {});
  Object.assign(onCallRosters, saved.onCallRosters && typeof saved.onCallRosters === "object" ? saved.onCallRosters : {});
  Object.assign(additionalHoursRosters, saved.additionalHoursRosters && typeof saved.additionalHoursRosters === "object" ? saved.additionalHoursRosters : {});
  Object.assign(reminders, saved.reminders && typeof saved.reminders === "object" ? saved.reminders : {});
  Object.assign(dayNotes, saved.dayNotes && typeof saved.dayNotes === "object" ? saved.dayNotes : {});
  Object.assign(manualPublicHolidays, saved.manualPublicHolidays && typeof saved.manualPublicHolidays === "object" ? saved.manualPublicHolidays : {});
  payRules = { ...DEFAULT_PAY_RULES, ...(saved.payRules && typeof saved.payRules === "object" ? saved.payRules : {}) };
  const resetDate = new Date();
  payCycleStartDate = dateKeyForDate(resetDate);
  selectedPayPeriod = "fortnightly";
  selectedTheme = "default";
  calendarDetailsCollapsed = false;
  nextCustomTemplate = 1;
  currentYear = resetDate.getFullYear();
  currentMonth = resetDate.getMonth();
  selectedEntryDay = 1;
  weekStartDay = 0;
  recoveryAlertsEnabled = true;
  onboardingCompleted = false;
  publicHolidayJurisdiction = "tasmania";
  backupCreatedAt = "";
  backupSchemaVersion = null;
  scanRosterIdentity = { ...DEFAULT_SCAN_ROSTER_IDENTITY };
  scanRosterFormat = DEFAULT_SCAN_ROSTER_FORMAT;
  clearObject(scanRosterCodeMappings);
  scanRosterDrafts = [];
  return applyStatePayload(saved);
}

// Fresh is detected purely by absence of any persisted state -- never by
// comparing live values against the old shipped (Alex) defaults, so a
// legacy user whose values happen to still match those defaults is never
// treated as fresh. Module-level initial values (templates, payProfiles,
// payRules, publicHolidayJurisdiction, scanRosterIdentity) and every
// legacy merge/repair fallback inside applyStatePayload/
// sanitizedTemplatesPayload are left exactly as shipped; this is the only
// call site that overwrites them with the neutral shape.
function applyFreshInstallDefaults() {
  clearObject(templates);
  Object.assign(templates, JSON.parse(JSON.stringify(FRESH_TEMPLATES)));
  clearObject(payProfiles);
  Object.assign(payProfiles, JSON.parse(JSON.stringify(FRESH_PAY_PROFILES)));
  payRules = { ...FRESH_PAY_RULES };
  publicHolidayJurisdiction = FRESH_PUBLIC_HOLIDAY_JURISDICTION;
  scanRosterIdentity = { ...FRESH_SCAN_ROSTER_IDENTITY };
  templateStateVersion = TEMPLATE_STATE_SCHEMA_VERSION;
}

function loadSavedState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved = JSON.parse(raw || "{}");
    if (!raw || Object.keys(saved).length === 0) {
      // Nothing was ever persisted (or an explicitly empty object was, which
      // never happens from real saveState() output). Apply the neutral
      // shape directly instead of calling applyStatePayload({}), whose
      // merge logic exists for partial *legacy* state and intentionally
      // falls back to the old Alex-shaped defaults.
      applyFreshInstallDefaults();
      return;
    }
    if (isUnsupportedTemplateStateVersion(saved)) {
      // Written by a newer RosterBuddy (a downgrade or a sideloaded older
      // build). Leave it exactly as it is and run on the shipped defaults;
      // saveState() below refuses to write over it.
      unsupportedSavedTemplateState = true;
      console.warn("Saved roster state uses a newer template format than this app version supports; it was left untouched.");
      return;
    }
    const stateMigrated = applyStatePayload(saved);
    if (stateMigrated) saveState();
  } catch (error) {
    console.warn("Saved roster state could not be loaded.", error);
  }
}

function currentStatePayload() {
  return {
    templateStateVersion,
    templates: JSON.parse(JSON.stringify(templates)),
    payProfiles: JSON.parse(JSON.stringify(payProfiles)),
    rosters: JSON.parse(JSON.stringify(rosters)),
    casualRosters: JSON.parse(JSON.stringify(casualRosters)),
    higherDutiesRosters: JSON.parse(JSON.stringify(higherDutiesRosters)),
    onCallRosters: JSON.parse(JSON.stringify(onCallRosters)),
    additionalHoursRosters: JSON.parse(JSON.stringify(additionalHoursRosters)),
    reminders: JSON.parse(JSON.stringify(reminders)),
    dayNotes: JSON.parse(JSON.stringify(dayNotes)),
    manualPublicHolidays: JSON.parse(JSON.stringify(manualPublicHolidays)),
    payRules: JSON.parse(JSON.stringify(payRules)),
    payCycleStartDate,
    selectedPayPeriod,
    selectedTheme,
    calendarDetailsCollapsed,
    nextCustomTemplate,
    currentYear,
    currentMonth,
    selectedEntryDay,
    weekStartDay,
    recoveryAlertsEnabled,
    onboardingCompleted,
    publicHolidayJurisdiction,
    backupCreatedAt,
    backupSchemaVersion,
    scanRosterIdentity: JSON.parse(JSON.stringify(scanRosterIdentity)),
    scanRosterFormat,
    scanRosterCodeMappings: JSON.parse(JSON.stringify(scanRosterCodeMappings)),
  };
}

function sendAndroidWidgetState(serializedState) {
  try {
    if (window.RosterBuddyAndroid && typeof window.RosterBuddyAndroid.saveRosterState === "function") {
      window.RosterBuddyAndroid.saveRosterState(serializedState);
    } else if (window.ShiftMateAndroid && typeof window.ShiftMateAndroid.saveRosterState === "function") {
      window.ShiftMateAndroid.saveRosterState(serializedState);
    } else if (window.RosterMateAndroid && typeof window.RosterMateAndroid.saveRosterState === "function") {
      window.RosterMateAndroid.saveRosterState(serializedState);
    } else if (window.RosterLyteAndroid && typeof window.RosterLyteAndroid.saveRosterState === "function") {
      window.RosterLyteAndroid.saveRosterState(serializedState);
    }
  } catch (error) {
    console.warn("RosterBuddy Android widget state could not be synced.", error);
  }
}

function syncAndroidWidgetStateFromNative(serializedState) {
  // loadSavedState() leaves newer, unsupported state untouched and runs this
  // older build with shipped defaults. Mirroring those defaults here would
  // still destructively downgrade the Android widget snapshot even though
  // saveState() correctly refuses to replace browser storage. MainActivity's
  // retry ladder calls this guarded public boundary directly.
  if (unsupportedSavedTemplateState) return false;
  sendAndroidWidgetState(serializedState);
  return true;
}

function refreshWidgets() {
  return syncAndroidWidgetStateFromNative(JSON.stringify(currentStatePayload()));
}

function refreshWidgetsWithFeedback() {
  if (refreshWidgets()) {
    showToast("RosterBuddy widgets refreshed. If Android still shows old data, remove and re-add the widget once.", "success");
    return true;
  }
  showToast("Widgets were not refreshed because this device holds RosterBuddy data from a newer version. Update RosterBuddy first; nothing was changed.", "warning");
  return false;
}

function scheduleWidgetSync() {
  refreshWidgets();
  [250, 750, 1500, 3000, 6000, 9000, 15000].forEach((delay) => {
    setTimeout(refreshWidgets, delay);
  });
}

function saveState() {
  try {
    // Saving now would replace the newer-format state loadSavedState()
    // refused to read with this build's defaults, which is exactly the data
    // loss the refusal exists to prevent. Say so once instead of failing
    // silently, and never more than once per session.
    if (unsupportedSavedTemplateState) {
      console.warn("Roster state was not saved: this app version cannot safely replace data saved by a newer RosterBuddy version.");
      if (!unsupportedSavedTemplateStateReported) {
        unsupportedSavedTemplateStateReported = true;
        showToast("This device holds RosterBuddy data from a newer version. Update RosterBuddy to open and change it; nothing was saved.", "warning");
      }
      return;
    }
    const serializedState = JSON.stringify(currentStatePayload());
    window.localStorage.setItem(STORAGE_KEY, serializedState);
    sendAndroidWidgetState(serializedState);
  } catch (error) {
    console.warn("Roster state could not be saved.", error);
  }
}

let toastTimer = null;
let modalConfirmAction = null;

function showToast(message, tone = "info") {
  const toast = document.getElementById("app-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function closeConfirmDialog() {
  const modal = document.getElementById("app-modal");
  if (modal) modal.classList.add("hidden");
  modalConfirmAction = null;
}

function isConfirmDialogOpen() {
  const modal = document.getElementById("app-modal");
  return Boolean(modal && !modal.classList.contains("hidden"));
}

function showInfoDialog(title, message, buttonText = "Done") {
  showConfirmDialog({
    title,
    message,
    confirmText: buttonText,
    cancelText: "Close",
    tone: "info",
    onConfirm: () => {},
  });
}

function showConfirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", requireText = "", inputLabel = "Type to confirm", tone = "danger", onConfirm }) {
  const modal = document.getElementById("app-modal");
  if (!modal) return;
  document.getElementById("app-modal-title").textContent = title;
  document.getElementById("app-modal-message").textContent = message;
  document.getElementById("app-modal-confirm").textContent = confirmText;
  document.getElementById("app-modal-cancel").textContent = cancelText;
  document.getElementById("app-modal-confirm").dataset.tone = tone;
  const inputWrap = document.getElementById("app-modal-input-wrap");
  const input = document.getElementById("app-modal-input");
  document.getElementById("app-modal-input-label").textContent = inputLabel;
  input.value = "";
  inputWrap.classList.toggle("hidden-control", !requireText);
  modalConfirmAction = () => {
    if (requireText && input.value.trim() !== requireText) {
      showToast("Confirmation text did not match. Nothing changed.", "warning");
      return;
    }
    closeConfirmDialog();
    if (typeof onConfirm === "function") onConfirm();
  };
  modal.classList.remove("hidden");
  if (requireText) input.focus();
}

function money(value) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function monthKey(year = currentYear, month = currentMonth) {
  return year + "-" + String(month + 1).padStart(2, "0");
}

function currentRoster() {
  // Always the personal roster. The read-only shared view has its own model
  // (calendarViewProjection) and is only ever read by renderSharedCalendar, so
  // pay, recovery, clear/repeat actions and saved state can never see it.
  const key = monthKey();
  if (!rosters[key]) rosters[key] = {};
  return rosters[key];
}

function currentCasualRoster() {
  const key = monthKey();
  if (!casualRosters[key]) casualRosters[key] = {};
  return casualRosters[key];
}

function currentHigherDutiesRoster() {
  const key = monthKey();
  if (!higherDutiesRosters[key]) higherDutiesRosters[key] = {};
  return higherDutiesRosters[key];
}

function currentOnCallRoster() {
  const key = monthKey();
  if (!onCallRosters[key]) onCallRosters[key] = {};
  return onCallRosters[key];
}

function currentAdditionalHoursRoster() {
  const key = monthKey();
  if (!additionalHoursRosters[key]) additionalHoursRosters[key] = {};
  return additionalHoursRosters[key];
}

function monthName(format = "long") {
  return new Intl.DateTimeFormat("en-AU", { month: format }).format(new Date(currentYear, currentMonth, 1));
}

function daysInCurrentMonth() {
  return new Date(currentYear, currentMonth + 1, 0).getDate();
}

function firstDayOffset() {
  const day = new Date(currentYear, currentMonth, 1).getDay();
  return (day - weekStartDay + 7) % 7;
}

function dayDate(day) {
  return new Date(currentYear, currentMonth, day);
}

function sameLocalDate(a, b) {
  return a instanceof Date && b instanceof Date
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function dayLabel(day) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(dayDate(day));
}

function dateKey(day, year = currentYear, month = currentMonth) {
  return year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function monthKeyForDate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function dateKeyForDate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function makeStrictLocalDate(year, month, day) {
  const parsed = new Date(year, month, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
  return parsed;
}

function parseDateInput(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return makeStrictLocalDate(year, month, day);
}

function parseManualPublicHolidayInput(value) {
  const text = String(value || "").trim();
  const au = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (au) {
    const year = Number(au[3]);
    const month = Number(au[2]) - 1;
    const day = Number(au[1]);
    const parsed = makeStrictLocalDate(year, month, day);
    if (!parsed || parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
    return parsed;
  }
  return parseDateInput(value);
}

function formatManualPublicHolidayDate(key) {
  const parsed = parseDateInput(key);
  if (!parsed) return key;
  return String(parsed.getDate()).padStart(2, "0") + "-" + String(parsed.getMonth() + 1).padStart(2, "0") + "-" + parsed.getFullYear();
}

function formatDateInput(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(date);
}

function formatDateRange(start, end) {
  return formatShortDate(start) + " - " + formatShortDate(end);
}

// Compact range for headers: "2–15 Nov" within a month, "19 Oct – 1 Nov" across two.
function formatCompactDateRange(start, end) {
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return start.getDate() + "–" + formatShortDate(end);
  }
  return formatShortDate(start) + " – " + formatShortDate(end);
}

function refreshWeekdayLabels() {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  document.querySelectorAll("#calendar-weekdays span").forEach((item, index) => {
    item.textContent = labels[(weekStartDay + index) % 7];
  });
}

function getShiftKey(day) {
  return currentRoster()[day];
}

function setShiftKey(day, key) {
  currentRoster()[day] = key;
}

function clearShiftDay(day) {
  delete currentRoster()[day];
  delete currentCasualRoster()[day];
  delete currentHigherDutiesRoster()[day];
  delete currentOnCallRoster()[day];
  delete currentAdditionalHoursRoster()[day];
}

function getDayNote(day) {
  return dayNotes[dateKey(day)] || "";
}

function setDayNote(day, text) {
  const key = dateKey(day);
  const value = String(text || "").trim();
  if (value) dayNotes[key] = value;
  else delete dayNotes[key];
}

function getStoredReminder(day) {
  return reminders[dateKey(day)];
}

function getActiveReminder(day) {
  const exact = getStoredReminder(day);
  if (exact) return exact;

  const current = dayDate(day);
  const currentTime = current.getTime();
  return Object.values(reminders).find((reminder) => {
    if (!reminder || reminder.repeat === "none") return false;
    const start = new Date(reminder.year, reminder.month, reminder.day);
    if (currentTime < start.getTime()) return false;
    if (reminder.repeat === "weekly") return Math.round((current - start) / 864e5) % 7 === 0;
    if (reminder.repeat === "fortnightly") return Math.round((current - start) / 864e5) % 14 === 0;
    if (reminder.repeat === "monthly") return reminder.day === day;
    return false;
  });
}

function isCasualDay(day) {
  return Boolean(currentCasualRoster()[day]);
}

function setCasualDay(day, casual) {
  if (casual) currentCasualRoster()[day] = true;
  else delete currentCasualRoster()[day];
}

function isHigherDutiesDay(day) {
  return Boolean(currentHigherDutiesRoster()[day]);
}

function setHigherDutiesDay(day, higherDuties) {
  if (higherDuties) currentHigherDutiesRoster()[day] = true;
  else delete currentHigherDutiesRoster()[day];
}

function isOnCallDay(day) {
  return Boolean(currentOnCallRoster()[day]);
}

function setOnCallDay(day, onCall) {
  if (onCall) currentOnCallRoster()[day] = true;
  else delete currentOnCallRoster()[day];
}

function getAdditionalHoursDay(day) {
  const entry = currentAdditionalHoursRoster()[day];
  if (!entry || typeof entry !== "object") return { hours: 0, doubleTime: false };
  const hours = Math.max(0, Number(entry.hours) || 0);
  return { hours, doubleTime: Boolean(entry.doubleTime) };
}

function setAdditionalHoursDay(day, hours, doubleTime) {
  const value = Math.max(0, Number(hours) || 0);
  if (value > 0) {
    currentAdditionalHoursRoster()[day] = { hours: value, doubleTime: Boolean(doubleTime) };
  } else {
    delete currentAdditionalHoursRoster()[day];
  }
}

function refreshMonthLabels() {
  const label = monthName() + " " + currentYear;
  document.getElementById("calendar-title").textContent = monthName() + " roster";
  document.getElementById("month-label").textContent = label;
  document.getElementById("pay-title").textContent = monthName() + " pay";
  refreshWeekdayLabels();
}

function screenId(name) {
  return "screen-" + name;
}

function validScreenName(name) {
  return document.getElementById(screenId(name)) ? name : "calendar";
}

function persistActiveScreen(name) {
  try {
    sessionStorage.setItem(ACTIVE_SCREEN_STORAGE_KEY, name);
  } catch (error) {
    // Private/incognito storage failures should not break navigation.
  }
}

function restorePersistedActiveScreen() {
  try {
    const savedScreen = sessionStorage.getItem(ACTIVE_SCREEN_STORAGE_KEY);
    activeScreen = validScreenName(savedScreen || activeScreen);
  } catch (error) {
    activeScreen = validScreenName(activeScreen);
  }
  document.body.dataset.activeScreen = activeScreen;
}

function showScreen(name, push = true) {
  const target = validScreenName(name);
  const scannerWorkflowScreens = new Set(["scan-roster", "scan-diagnostics"]);
  if (scannerWorkflowScreens.has(activeScreen) && !scannerWorkflowScreens.has(target)) {
    // Leaving the scanner is a privacy boundary: revoke the transient native
    // crop capability and clear every pending decision/draft. Moving between
    // the scanner and its diagnostics sub-screen stays inside the workflow;
    // every other destination starts fresh on return.
    clearScanRosterDrafts();
  }
  activeScreen = target;
  document.body.dataset.activeScreen = target;
  document.body.dataset.onboardingComplete = onboardingCompleted ? "true" : "false";
  persistActiveScreen(target);
  document.querySelectorAll(".app-screen").forEach((screen) => {
    screen.classList.toggle("hidden", screen.id !== screenId(target));
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.open === target);
  });

  if (push && history[history.length - 1] !== target) {
    history.push(target);
  }

  if (target === "quick-add") setDayNoteEditing(false);
  if (target === "recovery") updateRecoveryDisplay();
  if (target === "share") updateSharePreview();
  if (target === "scan-diagnostics") renderScanRosterDiagnosticsScreen();
  if (target === "scan-roster") renderScanRosterPremiumGate();
  if (target === "premium") renderPremiumScreen();
  if (target === "onboarding") renderGuidedSetup();
}

let screenReapplyTimer = null;
let screenReapplyTimers = [];

function reapplyActiveScreenAfterLayoutChange() {
  window.clearTimeout(screenReapplyTimer);
  screenReapplyTimers.forEach((timer) => window.clearTimeout(timer));
  screenReapplyTimers = [0, 80, 220, 500].map((delay) => window.setTimeout(() => {
    showScreen(activeScreen, false);
  }, delay));
  screenReapplyTimer = screenReapplyTimers[screenReapplyTimers.length - 1];
}

function bindActiveScreenRestoreEvents() {
  window.addEventListener("orientationchange", reapplyActiveScreenAfterLayoutChange);
  window.addEventListener("resize", reapplyActiveScreenAfterLayoutChange);
  window.addEventListener("focus", reapplyActiveScreenAfterLayoutChange);
  window.addEventListener("pageshow", reapplyActiveScreenAfterLayoutChange);
  document.addEventListener("visibilitychange", () => {
    handleGuidedScanCloudVisibilityChange();
    if (!document.hidden) reapplyActiveScreenAfterLayoutChange();
  });

  const capacitorApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (capacitorApp && typeof capacitorApp.addListener === "function") {
    capacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) reapplyActiveScreenAfterLayoutChange();
    });
    capacitorApp.addListener("backButton", handleAndroidBackButton);
  }
}

function goBack() {
  if (history.length <= 1) {
    showScreen("calendar", false);
    return;
  }
  history.pop();
  showScreen(history[history.length - 1], false);
}

function handleAndroidBackButton(event) {
  if (isConfirmDialogOpen()) {
    closeConfirmDialog();
    return;
  }
  if (!onboardingCompleted) {
    history.length = 0;
    history.push("onboarding");
    showScreen("onboarding", false);
    return;
  }
  if (activeScreen !== "calendar") {
    history.length = 1;
    history[0] = "calendar";
    showScreen("calendar", false);
    return;
  }
  const capacitorApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (event?.canGoBack) {
    window.history.back();
  } else if (capacitorApp && typeof capacitorApp.exitApp === "function") {
    capacitorApp.exitApp();
  }
}

function templateTimeText(template) {
  if (!template.start || !template.finish) return template.type === "leave" ? "Leave day" : "Recovery day";
  return template.start + " - " + template.finish;
}

function templateMatchesDefaultShortcut(key, template) {
  const defaults = DEFAULT_TEMPLATES[key];
  if (!defaults) return false;
  return String(template.label || "") === String(defaults.label || "") &&
    String(template.icon || "") === String(defaults.icon || "");
}

function builtInShortcutCode(key, template) {
  const label = String(template?.label || "").trim();
  if (key === "early") return /^early\b/i.test(label) ? "E" : "";
  if (key === "late") return /^late\b/i.test(label) ? "L" : "";
  if (key === "night") return /^night\b/i.test(label) ? "N" : "";
  if (key === "off") return /^off\b/i.test(label) ? "OFF" : "";
  if (key === "sick") return /^sick\b/i.test(label) ? "SL" : "";
  if (key === "annual") return /^annual\b/i.test(label) ? "AL" : "";
  return "";
}

function calendarShiftCode(shiftKey, template) {
  if (!template) return "";
  const marker = String(template.icon || "").trim();
  if (marker) return marker;
  const label = String(template.label || shiftKey || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return label ? label.slice(0, 3) : "";
}

function scanRosterAliases() {
  const names = [scanRosterIdentity.name, ...(scanRosterIdentity.aliases || "").split(/[\n,;]+/)]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  names.slice().forEach((name) => {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) names.push(parts.slice().reverse().join(" "));
  });
  return [...new Set(names)];
}

function normaliseScanNameToken(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Word-boundary-safe replacement for `normalisedText.includes(alias)`. A raw
// substring check lets a shorter configured alias (e.g. "FORD ALEX") match
// inside an unrelated, longer name that happens to start the same way (e.g.
// "FORD ALEXIS"), misattributing another staff member's row to the
// configured person. Both inputs are expected to already be
// normaliseScanNameToken()-normalised (single-spaced, upper-case tokens).
function normalisedTextHasAliasMatch(normalisedText, alias) {
  if (!alias) return false;
  return ` ${normalisedText} `.includes(` ${alias} `);
}

function normaliseScanToken(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9=#-]+/g, " ").replace(/\s+/g, " ").trim();
}

function compactScanCode(value) {
  return normaliseScanToken(value).replace(/\s+/g, "");
}

function canonicalScanRosterCode(value) {
  const compact = compactScanCode(value);
  if (compact === "97") return "9V";
  return normaliseScanToken(value);
}

function isLikelyRosterCodeToken(value) {
  const compact = compactScanCode(canonicalScanRosterCode(value));
  if (!compact || compact.length > 4) return false;
  if (/^\d+(?:\.\d+)?$/.test(compact)) return false;
  if (/^G\d/.test(compact)) return false;
  if (/^R-?TH/i.test(compact)) return false;
  return /^[A-Z0-9=#-]+$/.test(compact);
}

function isLikelyScanStaffNameToken(value) {
  const token = normaliseScanNameToken(value);
  if (!/^[A-Z][A-Z'-]{2,}$/.test(token)) return false;
  return ![
    "NAME", "UNIT", "HFTE", "AFTE", "TEAM", "COURSE", "LOAD",
    "AUG", "SEP", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN",
  ].includes(token);
}

function looksLikeScanStaffRowStart(tokens, index) {
  if (!isLikelyScanStaffNameToken(tokens[index]) || !isLikelyScanStaffNameToken(tokens[index + 1])) return false;
  const following = tokens.slice(index + 2, index + 9).map((token) => String(token || ""));
  const decimalCount = following.filter((token) => /^\d+(?:\.\d+)?$/.test(token)).length;
  const hasUnitMarker = following.some((token) => /^R[-A-Z0-9]+$/i.test(token) || /PARU/i.test(token));
  return decimalCount >= 2 || (decimalCount >= 1 && hasUnitMarker);
}

function trimRosterTextBeforeNextStaffRow(line) {
  const tokens = String(line || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  const firstKnownIndex = tokens.findIndex((token) => scanRosterShiftForCode(token).status === "ready");
  const searchStart = firstKnownIndex >= 0 ? firstKnownIndex + 1 : 0;
  for (let index = searchStart; index < tokens.length - 2; index += 1) {
    if (looksLikeScanStaffRowStart(tokens, index)) return tokens.slice(0, index).join(" ");
  }
  return tokens.join(" ");
}

function scanRosterLineTrimmedBeforeNextStaff(line, trimmedLine) {
  return String(line || "").trim().split(/\s+/).filter(Boolean).length > String(trimmedLine || "").trim().split(/\s+/).filter(Boolean).length;
}

function matchedScanRosterLineSegment(line, aliases) {
  const rawTokens = String(line || "").trim().split(/\s+/).filter(Boolean);
  const normalisedTokens = rawTokens.map((token) => normaliseScanNameToken(token));
  for (const alias of aliases || []) {
    const aliasTokens = String(alias || "").split(/\s+/).map((token) => normaliseScanNameToken(token)).filter(Boolean);
    if (!aliasTokens.length) continue;
    for (let index = 0; index <= normalisedTokens.length - aliasTokens.length; index += 1) {
      const matches = aliasTokens.every((token, offset) => normalisedTokens[index + offset] === token);
      if (matches) return trimRosterTextBeforeNextStaffRow(rawTokens.slice(index).join(" "));
    }
  }
  return "";
}

function rosterTextAfterMatchedAlias(line, aliases) {
  const matchedSegment = matchedScanRosterLineSegment(line, aliases);
  if (!matchedSegment) return trimRosterTextBeforeNextStaffRow(String(line || ""));
  const rawTokens = matchedSegment.split(/\s+/).filter(Boolean);
  const normalisedTokens = rawTokens.map((token) => normaliseScanNameToken(token));
  for (const alias of aliases || []) {
    const aliasTokens = String(alias || "").split(/\s+/).map((token) => normaliseScanNameToken(token)).filter(Boolean);
    if (!aliasTokens.length) continue;
    for (let index = 0; index <= normalisedTokens.length - aliasTokens.length; index += 1) {
      const matches = aliasTokens.every((token, offset) => normalisedTokens[index + offset] === token);
      if (matches) return rawTokens.slice(index + aliasTokens.length).join(" ");
    }
  }
  return matchedSegment;
}

function scanRosterTextContainsAlias(lines, aliases) {
  return aliases.some((alias) => lines.some((line) => normalisedTextHasAliasMatch(normaliseScanNameToken(line), alias)));
}

function scanRosterCleanDayToken(token) {
  const cleaned = String(token || "").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!/^\d{1,2}$/.test(cleaned)) return null;
  const day = Number(cleaned);
  if (day < 1 || day > 31) return null;
  return day;
}

function scanRosterDateHeaderDays(line) {
  const value = String(line || "");
  const tokens = value.split(/\s+/).filter(Boolean);
  const days = [];
  tokens.forEach((token, index) => {
    const day = scanRosterCleanDayToken(token);
    if (day === null) return;
    const previous = tokens[index - 1] || "";
    const next = tokens[index + 1] || "";
    if (/\.\d{1,2}$/.test(previous) || /^\d{1,2}\./.test(next)) return;
    if (!days.includes(day)) days.push(day);
  });
  return days;
}

function isScanRosterDateHeaderLine(line) {
  const value = String(line || "");
  const days = scanRosterDateHeaderDays(value);
  const hasCalendarWord = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Mo|Tu|We|Th|Fr|Sa|Su)\b/i.test(value);
  return days.length >= 3 || (hasCalendarWord && days.length >= 1);
}

function scanRosterHeaderLine(lines) {
  return lines.find((line) => isScanRosterDateHeaderLine(line)) || "";
}

// Same-table proof for the matched row: its header is whichever date-header
// line is the NEAREST one preceding it, never simply the first header line
// anywhere on the page. A photographed page can show more than one roster
// table (e.g. two different months stacked), and picking the page-wide first
// header would silently combine a date row from one table with a staff row
// from another. If no header line precedes the matched row at all, its
// table's header was not captured -- fail closed (return "") rather than
// guess a date row from a different, unrelated table.
function scanRosterOcrHeaderLineForRow(lines, matchedIndex) {
  for (let index = matchedIndex - 1; index >= 0; index -= 1) {
    if (isScanRosterDateHeaderLine(lines[index])) return lines[index];
  }
  return "";
}

function scanRosterLineCodeTokens(line) {
  return String(line || "").trim().split(/\s+/).filter(isLikelyRosterCodeToken).map((token) => canonicalScanRosterCode(token));
}

function scanRosterRawCodesFromTokens(tokens) {
  const rawCodes = [];
  for (let index = 0; index < (tokens || []).length; index += 1) {
    let rawCode = tokens[index];
    if (tokens[index + 1] && /^(OC|HD|HDA)$/i.test(tokens[index + 1])) {
      rawCode += " " + tokens[index + 1];
      index += 1;
    }
    rawCodes.push(canonicalScanRosterCode(rawCode));
  }
  return rawCodes.filter(Boolean);
}

function scanRosterAdjacentShiftLine(lines, matchedIndex, expectedCount = 0) {
  const candidates = [matchedIndex + 1, matchedIndex - 1];
  for (const index of candidates) {
    if (index < 0 || index >= lines.length) continue;
    const line = lines[index];
    if (isScanRosterDateHeaderLine(line)) continue;
    const tokens = scanRosterLineCodeTokens(line);
    const rawCodes = scanRosterRawCodesFromTokens(tokens);
    if (!rawCodes.length) continue;
    if (expectedCount && rawCodes.length !== expectedCount) continue;
    if (looksLikeScanStaffRowStart(String(line).split(/\s+/).filter(Boolean), 0)) continue;
    return line;
  }
  return "";
}

// scanRosterAliases() can include broad single-word fragments (e.g. a bare
// surname), because a comma inside a "Surname, Given" alias typed into the
// aliases field is also the separator between distinct aliases. A bare
// single-word alias can validly match more than one staff member's line. So
// instead of taking the first line that matches any alias, prefer whichever
// line matches the most specific (most name-parts) alias, and fail closed —
// return no match — if two different lines tie on specificity, rather than
// guessing which line is the configured person. Mirrors
// mediaPipeScannerIdentityBlock's identity selection for the geometry path.
function scanRosterIdentityLineIndex(lines, aliases) {
  let bestIndex = -1;
  let bestSpecificity = 0;
  let tied = false;
  (lines || []).forEach((line, index) => {
    const normalised = normaliseScanNameToken(line);
    const matchedSpecificities = (aliases || [])
      .filter((alias) => normalisedTextHasAliasMatch(normalised, alias))
      .map((alias) => alias.split(" ").filter(Boolean).length);
    if (!matchedSpecificities.length) return;
    const specificity = Math.max(...matchedSpecificities);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestIndex = index;
      tied = false;
    } else if (specificity === bestSpecificity && index !== bestIndex) {
      tied = true;
    }
  });
  return tied ? -1 : bestIndex;
}

function scanRosterOcrTextForReview(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  const aliases = scanRosterAliases().map((alias) => normaliseScanNameToken(alias));
  const matchedIndex = scanRosterIdentityLineIndex(lines, aliases);
  if (matchedIndex < 0) return "";
  const matchedLine = lines[matchedIndex];
  const matchedSegment = matchedScanRosterLineSegment(matchedLine, aliases);
  if (!matchedSegment) return "";
  const header = scanRosterOcrHeaderLineForRow(lines, matchedIndex);
  if (!header) return "";
  const dayMatches = scanRosterDateHeaderDays(header);
  const matchedTokens = rosterCodeTokensFromMatchedLine(rosterTextAfterMatchedAlias(matchedLine, aliases));
  const adjacentShiftLine = matchedTokens.length ? "" : scanRosterAdjacentShiftLine(lines, matchedIndex, dayMatches.length);
  return [header, matchedSegment, adjacentShiftLine].filter(Boolean).join("\n");
}

function rosterCodeTokensFromMatchedLine(line) {
  const tokens = String(line || "").trim().split(/\s+/).filter(Boolean);
  const firstKnownIndex = tokens.findIndex((token) => scanRosterShiftForCode(token).status === "ready");
  if (firstKnownIndex < 0) return [];
  return tokens.slice(firstKnownIndex).filter(isLikelyRosterCodeToken).map((token) => canonicalScanRosterCode(token));
}

function scanRosterTemplateShiftKey(rawCode) {
  const compact = compactScanCode(rawCode);
  const templateMatch = Object.entries(templates).find(([, template]) => {
    const candidates = [template.icon, template.label]
      .filter(Boolean)
      .map((value) => compactScanCode(value));
    return candidates.includes(compact);
  });
  if (templateMatch) return templateMatch[0];
  const timeRange = String(rawCode || "").match(/(\d{1,2}:?\d{2})\s*[-–]\s*(\d{1,2}:?\d{2})/);
  if (!timeRange) return "";
  const start = normaliseTimeText(timeRange[1]);
  const finish = normaliseTimeText(timeRange[2]);
  const timeMatch = Object.entries(templates).find(([, template]) => normaliseTimeText(template.start) === start && normaliseTimeText(template.finish) === finish);
  return timeMatch ? timeMatch[0] : "";
}

function scanRosterMappingKey(rawCode) {
  const code = normaliseScanToken(rawCode);
  if (!code) return "";
  const parts = code.split(" ").filter(Boolean);
  const coreParts = parts.filter((part) => !["OC", "ONCALL", "CALL", "HD", "HDA", "HIGHER", "DUTIES"].includes(part));
  return compactScanCode(coreParts.join(" ") || code);
}

function scanRosterSavedCodeMapping(rawCode) {
  const key = scanRosterMappingKey(rawCode);
  const mapping = key ? scanRosterCodeMappings[key] : null;
  if (!mapping || !templates[mapping.shiftKey]) return null;
  return {
    shiftKey: mapping.shiftKey,
    onCall: Boolean(mapping.onCall),
    higherDuties: Boolean(mapping.higherDuties),
    status: "ready",
    source: "mapped",
  };
}

function registerScanRosterCodeMapping(rawCode, shiftKey, options = {}) {
  const key = scanRosterMappingKey(rawCode);
  if (!key || !templates[shiftKey]) return false;
  scanRosterCodeMappings[key] = {
    shiftKey,
    onCall: Boolean(options.onCall),
    higherDuties: Boolean(options.higherDuties),
  };
  saveState();
  return true;
}

function createScanRosterTemplateForDraft(draft) {
  const rawCode = normaliseScanToken(draft?.rawCode || "");
  if (!rawCode) return "";
  const key = "custom" + nextCustomTemplate;
  nextCustomTemplate += 1;
  templates[key] = {
    label: rawCode,
    icon: rawCode.slice(0, 4),
    start: "",
    finish: "",
    breakMinutes: 0,
    colour: "aqua",
    hours: 0,
    type: "work",
  };
  selectedShift = key;
  registerScanRosterCodeMapping(rawCode, key, { onCall: draft.onCall, higherDuties: draft.higherDuties });
  return key;
}

function applyScanRosterCodeMappingToDraft(draft) {
  if (!draft || draft.status === "ready") return draft;
  const mapped = scanRosterShiftForCode(draft.rawCode);
  if (mapped.status !== "ready" || !mapped.shiftKey) return draft;
  draft.shiftKey = mapped.shiftKey;
  draft.onCall = Boolean(draft.onCall || mapped.onCall);
  draft.higherDuties = Boolean(draft.higherDuties || mapped.higherDuties);
  draft.status = "ready";
  draft.mappingSource = mapped.source || "mapped";
  // AI-only/conflicting AI Assist suggestions, and shifts whose date-column
  // alignment was low confidence, still require an explicit user selection
  // after mapping -- teaching the app what an unfamiliar code means is not
  // the same as confirming an AI suggestion or an uncertain date for import.
  // dateUnresolved is checked explicitly here, not merely inferred from
  // dateConfidence === "low": they happen to coincide for every draft this
  // app currently builds, but the invariant this line exists to protect
  // (an unresolved date must never become selected) must not silently
  // depend on that coincidence holding forever.
  draft.selected = draft.dateUnresolved || draft.reviewState === "ai-only" || draft.reviewState === "conflict" || draft.dateConfidence === "low" ? false : true;
  return draft;
}

function applyScanRosterCodeMappingsToDrafts(drafts) {
  return (drafts || []).map((draft) => applyScanRosterCodeMappingToDraft(draft));
}

function scanRosterShiftForCode(rawCode) {
  const code = canonicalScanRosterCode(rawCode);
  if (!code) return { shiftKey: "", onCall: false, higherDuties: false, status: "needs-review" };
  const parts = code.split(" ").filter(Boolean);
  const onCall = parts.includes("OC") || parts.includes("ONCALL") || parts.includes("CALL") || parts.includes("CZ");
  const higherDuties = parts.includes("HD") || parts.includes("HDA") || parts.includes("HIGHER");
  const coreParts = parts.filter((part) => !["OC", "ONCALL", "CALL", "CZ", "HD", "HDA", "HIGHER", "DUTIES"].includes(part));
  const core = coreParts.join(" ") || (onCall ? "OC" : "");
  const compact = compactScanCode(core);
  let shiftKey = scanRosterTemplateShiftKey(core) || scanRosterTemplateShiftKey(rawCode);
  if (!shiftKey && ["OC", "ONCALL", "CALL"].includes(compact)) shiftKey = "off";
  else if (!shiftKey && ["OFF", "X", "RDO", "REST", "DO", "DAYOFF", "-", "-R"].includes(compact)) shiftKey = "off";
  else if (!shiftKey && ["NB", "ON", "OVERNIGHT"].includes(compact)) shiftKey = "overnight";
  else if (!shiftKey && ["9=", "CM", "MID", "MIDDLE"].includes(compact)) shiftKey = "mid";
  else if (!shiftKey && ["9S", "AFTERNOON", "AFT"].includes(compact)) shiftKey = "afternoon";
  else if (!shiftKey && ["9V", "9W", "L", "PM", "LATE"].includes(compact)) shiftKey = "late";
  else if (!shiftKey && ["N", "NS", "NIGHT", "ND"].includes(compact)) shiftKey = "night";
  else if (!shiftKey && ["E", "EARLY", "AM", "9T"].includes(compact)) shiftKey = "early";
  if (shiftKey) return { shiftKey, onCall, higherDuties, status: "ready", source: "known" };
  const savedMapping = scanRosterSavedCodeMapping(core);
  if (savedMapping) {
    return {
      shiftKey: savedMapping.shiftKey,
      onCall: Boolean(onCall || savedMapping.onCall),
      higherDuties: Boolean(higherDuties || savedMapping.higherDuties),
      status: "ready",
      source: "mapped",
    };
  }
  return { shiftKey: "", onCall, higherDuties, status: "needs-review", source: "needs-review" };
}

function scanRosterDraft(day, rawCode, options = {}) {
  const mapped = scanRosterShiftForCode(rawCode);
  // An EXPLICIT null (as opposed to simply omitted) month/year means the
  // caller (only the guided geometry path -- see
  // mediaPipeScannerColumnsFromDayBlocks) found no trustworthy local
  // evidence at all for this date, not merely "didn't bother resolving it
  // and it's fine to assume the current calendar" (the legitimate case for
  // every other caller, which never passes null). scanRosterDraftMonth/
  // scanRosterDraftYear's currentMonth/currentYear fallback is correct for
  // that legitimate case, but would silently re-fabricate whatever month the
  // app currently has open for THIS one -- see scanRosterDraftDateLabel and
  // importScanRosterDrafts, which both refuse on dateUnresolved instead.
  const dateUnresolved = options.month === null || options.year === null;
  return {
    day,
    month: Number.isInteger(options.month) ? options.month : undefined,
    year: Number.isInteger(options.year) ? options.year : undefined,
    dateUnresolved,
    rawCode: canonicalScanRosterCode(rawCode),
    shiftKey: mapped.shiftKey,
    onCall: mapped.onCall,
    higherDuties: mapped.higherDuties,
    selected: mapped.status === "ready" && !dateUnresolved,
    status: mapped.status,
    mappingSource: mapped.source,
  };
}

function scanRosterCodeFromRawText(rawCode) {
  const tokens = String(rawCode).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  for (let width = Math.min(4, tokens.length); width >= 1; width -= 1) {
    const candidate = tokens.slice(0, width).join(" ");
    if (scanRosterShiftForCode(candidate).status === "ready") return candidate;
  }
  const modifierWidth = /^(OC|HD|HDA)$/i.test(tokens[1] || "") ? 2 : 1;
  const fallback = tokens.slice(0, modifierWidth).join(" ");
  return isLikelyRosterCodeToken(tokens[0]) ? fallback : "";
}

function scanRosterMonthIndex(value) {
  const key = String(value || "").trim().slice(0, 3).toLowerCase();
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key);
}

function scanRosterYearForExplicitMonth(month, baseMonth = currentMonth, baseYear = currentYear) {
  if (!Number.isInteger(month)) return baseYear;
  if (baseMonth >= 9 && month <= 2) return baseYear + 1;
  if (baseMonth <= 2 && month >= 9) return baseYear - 1;
  return baseYear;
}

function scanRosterDraftMonth(draft) {
  return Number.isInteger(draft?.month) ? draft.month : currentMonth;
}

function scanRosterDraftYear(draft) {
  return Number.isInteger(draft?.year) ? draft.year : currentYear;
}

function scanRosterDraftMonthKey(draft) {
  return monthKey(scanRosterDraftYear(draft), scanRosterDraftMonth(draft));
}

function scanRosterDraftDateLabel(draft) {
  if (!draft) return "?";
  // See scanRosterDraft: an explicitly unresolved date must never render as
  // if it were a real date in the currently displayed month/year.
  if (draft.dateUnresolved) return "Date unresolved";
  const month = scanRosterDraftMonth(draft);
  const year = scanRosterDraftYear(draft);
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month] || "";
  return monthName ? monthName + " " + draft.day + (year !== currentYear ? " " + year : "") : dayLabel(draft.day);
}

function scanRosterExplicitMonthTarget(lines) {
  const counts = new Map();
  (lines || []).forEach((line) => {
    const match = String(line || "").trim().match(/^([A-Za-z]{3,9})\s+\d{1,2}(?:\s+[A-Za-z]{3,9})?\s*[-–:]?\s+(.+)$/);
    if (!match) return;
    const month = scanRosterMonthIndex(match[1]);
    if (month < 0) return;
    if (!scanRosterCodeFromRawText(match[2])) return;
    counts.set(month, (counts.get(month) || 0) + 1);
  });
  if (!counts.size) return null;
  if (counts.has(currentMonth)) return { month: currentMonth, year: currentYear };
  let bestMonth = null;
  let bestCount = -1;
  counts.forEach((count, month) => {
    if (count > bestCount) {
      bestCount = count;
      bestMonth = month;
    }
  });
  return bestMonth === null ? null : { month: bestMonth, year: scanRosterYearForExplicitMonth(bestMonth, currentMonth, currentYear) };
}

function parseSimpleScanRosterLines(lines) {
  const explicitTarget = scanRosterExplicitMonthTarget(lines);
  const effectiveMonth = explicitTarget ? explicitTarget.month : currentMonth;
  const effectiveYear = explicitTarget ? explicitTarget.year : currentYear;
  const drafts = [];
  lines.forEach((line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    const dateMatch = trimmed.match(/^(?:[A-Za-z]{3,9}\s+)?(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\s*[-–:]?\s+(.+)$/);
    const dayCodeMatch = trimmed.match(/^(?:([A-Za-z]{3,9})\s+)?(\d{1,2})(?:\s+[A-Za-z]{3,9})?\s*[-–:]?\s+(.+)$/);
    let day = 0;
    let rawCode = "";
    let draftMonth = effectiveMonth;
    let draftYear = effectiveYear;
    if (dateMatch) {
      day = Number(dateMatch[1]);
      const month = Number(dateMatch[2]) - 1;
      const yearText = dateMatch[3];
      const year = yearText ? Number(yearText.length === 2 ? `20${yearText}` : yearText) : scanRosterYearForExplicitMonth(month, effectiveMonth, effectiveYear);
      draftMonth = month;
      draftYear = year;
      rawCode = dateMatch[4];
    } else if (dayCodeMatch) {
      const monthText = dayCodeMatch[1] || "";
      if (monthText) {
        const monthIndex = scanRosterMonthIndex(monthText);
        if (monthIndex >= 0) {
          draftMonth = monthIndex;
          draftYear = scanRosterYearForExplicitMonth(monthIndex, effectiveMonth, effectiveYear);
        }
      }
      day = Number(dayCodeMatch[2]);
      rawCode = dayCodeMatch[3];
    } else {
      return;
    }
    const draftMonthDays = new Date(draftYear, draftMonth + 1, 0).getDate();
    if (day < 1 || day > draftMonthDays) return;
    rawCode = scanRosterCodeFromRawText(rawCode);
    if (!rawCode) return;
    const hasExplicitMonth = Boolean(dateMatch || dayCodeMatch[1]);
    drafts.push(scanRosterDraft(day, rawCode, hasExplicitMonth ? { month: draftMonth, year: draftYear } : {}));
  });
  if (drafts.length && explicitTarget && (currentMonth !== effectiveMonth || currentYear !== effectiveYear)) {
    currentMonth = effectiveMonth;
    currentYear = effectiveYear;
    selectedEntryDay = drafts[0].day;
  }
  return drafts;
}

function parseScanRosterText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const aliases = scanRosterAliases().map((alias) => normaliseScanNameToken(alias));
  const containsConfiguredPerson = scanRosterTextContainsAlias(lines, aliases);
  if (!containsConfiguredPerson) {
    const simpleDrafts = parseSimpleScanRosterLines(lines);
    if (simpleDrafts.length) return simpleDrafts;
  }
  const header = scanRosterHeaderLine(lines);
  const dayMatches = scanRosterDateHeaderDays(header);
  const matchIndex = scanRosterIdentityLineIndex(lines, aliases);
  if (matchIndex < 0) return [];
  const matchLine = lines[matchIndex];
  const matchedRosterText = rosterTextAfterMatchedAlias(matchLine, aliases);
  const matchedLineWasTrimmed = scanRosterLineTrimmedBeforeNextStaff(matchLine, matchedScanRosterLineSegment(matchLine, aliases));
  let tokens = rosterCodeTokensFromMatchedLine(matchedRosterText);
  let tokensFromAdjacentSelectedRow = false;
  if (!tokens.length) {
    const adjacentShiftLine = scanRosterAdjacentShiftLine(lines, matchIndex, dayMatches.length);
    tokens = scanRosterLineCodeTokens(adjacentShiftLine);
    tokensFromAdjacentSelectedRow = Boolean(tokens.length);
  }
  if (!tokens.length) {
    let rosterPart = matchedRosterText;
    aliases.forEach((alias) => {
      if (!alias) return;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      rosterPart = rosterPart.replace(new RegExp(escaped, "i"), " ");
    });
    tokens = scanRosterLineCodeTokens(rosterPart);
  }
  const rawCodes = scanRosterRawCodesFromTokens(tokens);
  const daysForDrafts = dayMatches.length ? dayMatches : rawCodes.map((_, index) => index + 1);
  if (containsConfiguredPerson && !dayMatches.length) return [];
  if (!daysForDrafts.length || !rawCodes.length) return [];
  if (containsConfiguredPerson && dayMatches.length && rawCodes.length !== dayMatches.length && !matchedLineWasTrimmed) return [];
  const drafts = [];
  for (let index = 0; index < rawCodes.length; index += 1) {
    const rawCode = rawCodes[index];
    const mapped = scanRosterShiftForCode(rawCode);
    drafts.push({
      day: daysForDrafts[index],
      rawCode: canonicalScanRosterCode(rawCode),
      shiftKey: mapped.shiftKey,
      onCall: mapped.onCall,
      higherDuties: mapped.higherDuties,
      selected: mapped.status === "ready",
      status: mapped.status,
      mappingSource: mapped.source,
    });
  }
  return drafts;
}

// Privacy-safe evidence for why a real scan missed shifts: counts of what
// was detected/aligned/rejected at each stage, never the full multi-staff
// OCR text. Logged via appendScanRosterOcrDebug so Alex can screenshot or
// copy the Diagnostics screen from the phone without pasting a colleague's
// roster row into a bug report.
function scanRosterAlignmentDiagnostics(filteredLines) {
  const lines = Array.isArray(filteredLines) ? filteredLines : [];
  const header = scanRosterHeaderLine(lines);
  const dateHeadersDetected = scanRosterDateHeaderDays(header).length;
  const aliases = scanRosterAliases().map((alias) => normaliseScanNameToken(alias));
  const matchIndex = scanRosterIdentityLineIndex(lines, aliases);
  const configuredRowDetected = matchIndex >= 0;
  let shiftLikeTokens = [];
  if (configuredRowDetected) {
    const matchedLine = lines[matchIndex];
    const matchedRosterText = rosterTextAfterMatchedAlias(matchedLine, aliases);
    shiftLikeTokens = rosterCodeTokensFromMatchedLine(matchedRosterText);
    if (!shiftLikeTokens.length) {
      const adjacentShiftLine = scanRosterAdjacentShiftLine(lines, matchIndex, dateHeadersDetected);
      shiftLikeTokens = scanRosterLineCodeTokens(adjacentShiftLine);
    }
  }
  const rawCodes = scanRosterRawCodesFromTokens(shiftLikeTokens);
  const alignedTokens = dateHeadersDetected ? Math.min(rawCodes.length, dateHeadersDetected) : 0;
  const unalignedTokens = Math.max(0, rawCodes.length - alignedTokens);
  const rejectedTokens = Math.max(0, shiftLikeTokens.length - rawCodes.length);
  return {
    dateHeadersDetected,
    configuredRowDetected,
    shiftLikeTokensDetected: shiftLikeTokens.length,
    alignedTokens,
    unalignedTokens,
    rejectedTokens,
  };
}

function scanRosterDatesFromHeaderLine(line) {
  const tokens = String(line || "").split(/\s+/).filter(Boolean);
  const dates = [];
  let activeMonth = currentMonth;
  for (let index = 0; index < tokens.length; index += 1) {
    const monthIndex = scanRosterMonthIndex(tokens[index]);
    if (monthIndex >= 0) {
      activeMonth = monthIndex;
      continue;
    }
    const day = scanRosterCleanDayToken(tokens[index]);
    if (day === null) continue;
    const year = scanRosterYearForExplicitMonth(activeMonth, currentMonth, currentYear);
    const maxDay = new Date(year, activeMonth + 1, 0).getDate();
    if (day > maxDay) continue;
    dates.push({ day, month: activeMonth, year });
  }
  return dates;
}

// Detects the native automatic-row-strip/column-geometry OCR shape: one
// already-resolved "<Month> <Day> <code...>" line per shift (e.g. "Sep 14
// 9T", "Oct 2 9T CZ"), where on-device column matching has already paired
// each code with its date -- there is no separate shared header row to pick.
// This shape is the COMMON case on a real photographed roster (see
// buildAutomaticRowStripLines/buildColumnAlignedRosterLines on the native
// side), not an edge case. A line here also happens to match "one day number
// plus a calendar word", which is exactly what isScanRosterDateHeaderLine
// treats as a genuine date-header row -- so without this check every one of
// these lines gets misclassified as a date candidate, leaving nothing for
// rowCandidates and a nonsensical "date row" picker full of individual
// shifts. Requiring an explicit, real month name (not a day-of-week word)
// plus at least one trailing shift-code token keeps this from ever matching
// a genuine multi-day header line (which carries no code tokens) or a bare
// row-continuation fragment like "14 9T" with no month prefix at all (native
// per-shift lines always carry one; see monthPrefixForDateElement).
function guidedScanResolvedLineInfo(line) {
  const trimmed = String(line || "").trim();
  const match = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(.+)$/);
  if (!match) return null;
  const monthText = match[1];
  if (!/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(monthText)) return null;
  const day = Number(match[2]);
  if (!day || day < 1 || day > 31) return null;
  const codeTokens = scanRosterLineCodeTokens(match[3]).filter((token) => !/^(ON|CALL)$/i.test(token));
  const rawCodes = scanRosterRawCodesFromTokens(codeTokens);
  if (!rawCodes.length) return null;
  return { monthText, day, rawCodes, line: trimmed };
}

// --- Guided scan geometry candidates ---------------------------------------
// The native Android path always supplies result.textBlocks (ML Kit word-level
// boxes). When it does, the guided picker is built from real row geometry
// rather than from flattened OCR text, so the user's confirmed date row and
// confirmed staff row can drive an X-coordinate match instead of a positional
// zip of two whitespace-split token lists. The automatic identity/header
// detection is reused only to PRESELECT a candidate -- never to remove the
// choice.

const GUIDED_SCAN_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A date/header band is one carrying at least two real day numbers IN
// PLAUSIBLE CALENDAR ORDER left-to-right. Token count alone is not enough: a
// staff/shift-code row can shed bare 1-31 fragments too (the leading "9" of
// "9V"/"9S", a misread "I5" as "15", ...) with no real header structure
// behind them -- see the real-roster false candidate this guards against,
// built from scattered fragments like 9, 9, 10, 1, 12 that read as October
// dates once fed through month resolution. A genuine printed date row never
// repeats a day and never drops backwards mid-row except at a real
// end-of-month rollover (a high day, 28 or above, followed by a low day, 3
// or below -- e.g. 31 -> 1). Any other backward step, or an exact repeat, is
// not a calendar and disqualifies the whole band.
function guidedScanGeometryIsDateBand(band) {
  const dayBlocks = band.blocks
    .filter((block) => mediaPipeScannerDayNumber(block.text) !== null)
    .sort((a, b) => a.centerX - b.centerX);
  if (dayBlocks.length < 2) return false;
  let previousDay = null;
  for (const block of dayBlocks) {
    const day = mediaPipeScannerDayNumber(block.text);
    if (previousDay !== null) {
      const isForwardStep = day > previousDay;
      const isPlausibleRollover = day <= 3 && previousDay >= 28;
      if (!isForwardStep && !isPlausibleRollover) return false;
    }
    previousDay = day;
  }
  return true;
}

// Left edge of the name gutter, derived from the date-column grid. A shift
// code is printed under its date column, so its centre sits at (or within OCR
// jitter of) that column's centre; a staff name sits in the name column to the
// left of the whole grid. Half a typical block width is a principled bound for
// that jitter -- deliberately NOT a fraction of column spacing, which on a
// wide grid would reach back far enough to swallow the name column.
function guidedScanGeometryGutterX(columns, blocks) {
  if (!columns.length) return -Infinity;
  const firstColumnX = Math.min(...columns.map((column) => column.x));
  const widths = blocks.map((block) => block.boundingBox.width).filter(Number.isFinite);
  return firstColumnX - Math.max(15, mediaPipeScannerMedian(widths) * 0.5);
}

// Shift-code tokens for a band, selected SPATIALLY rather than lexically.
//
// The old lexical test (isLikelyScanStaffNameToken) rejected any 3-4 letter
// alphabetic token, which silently destroyed real roster codes -- OFF, AFT,
// MID, LATE, HDA and any unfamiliar alphabetic code. Worse, if it stripped
// every code from the configured person's row, that row stopped being a
// candidate at all and a neighbouring staff member's row could be labelled as
// theirs. Position is the reliable discriminator and is also what keeps staff
// names (including one- and two-letter initials, which no lexical name test
// can catch) out of the UI: anything left of the date grid is name-column
// material, anything under the grid is a shift cell.
// Excludes the exact OCR blocks that made up the identity name match from
// code extraction, by block identity rather than by where a block's centre
// falls relative to the gutter -- a wide/misjudged OCR box for a short name
// (e.g. "Alex") can have its centre cross the gutter, and centre-only gutter
// position cannot tell that apart from a real code sitting under the first
// date column. Matching the exact member blocks (not a box-overlap test)
// avoids also excluding a genuine, merely-adjacent shift code whose own box
// happens to reach a few pixels into the name box's span.
function guidedScanGeometryCodeBlocks(band, gutterX = -Infinity, identityMembers = null) {
  if (!band || !Array.isArray(band.blocks)) return [];
  return band.blocks.filter((block) => isLikelyRosterCodeToken(block.text)
    && scanRosterMonthIndex(block.text) < 0
    && block.centerX >= gutterX
    && !(identityMembers && identityMembers.includes(block)));
}

// Widens identity.members (the minimal alias-matching block window from
// mediaPipeScannerIdentityBlock) to the full identity/name region on that
// same row, so a same-row fragment that does not itself match the alias
// text still fails closed instead of being treated as a shift code. Trigger
// is deliberately narrow and gutter-independent: the fragment's CENTRE
// falls inside the matched name's (growing) box -- a split/adjacent piece
// of the same name, however OCR happened to tokenise it (a wide/misjudged
// name box, or a name split across two OCR boxes where one reads as a
// code-shaped token). Centre, not box-edge overlap: fixed-width/padded OCR
// boxes for short adjacent tokens routinely touch by a few px even when
// they are visually and semantically distinct, so an edge-overlap test
// would wrongly swallow a genuine neighbouring code.
//
// Does NOT also exclude a fragment merely because it straddles the
// statistical gutter (guidedScanGeometryGutterX) by centre-position alone --
// that gutter sits within half a token width of the first date column BY
// CONSTRUCTION, so "straddles the gutter" and "is a real code under column
// 1" are the same geometric fact on their own (proved by a real code case: a
// token can legitimately straddle the gutter while being the unambiguous,
// correctly-aligned code for its column -- see C10's 9T). Geometry alone
// cannot tell a gutter-straddling fragment apart from a genuine column-1
// code. See guidedScanAmbiguousBoundaryBlocks below for how that ambiguity
// is actually resolved: by privacy-first withholding, scoped narrowly to
// the case a naive suppression rule would otherwise also wrongly catch.
//
// Runs to a fixed point so a chain of adjacent fragments is fully absorbed,
// not just the one immediately touching the original match.
function guidedScanExpandIdentityMembers(identity, rowScopeBlocks) {
  if (!identity || !Array.isArray(identity.members) || !identity.members.length) return identity ? identity.members : null;
  const heights = rowScopeBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const rowTolerance = Math.max(12, mediaPipeScannerMedian(heights) * 0.75);
  const rowBlocks = rowScopeBlocks.filter((block) => Math.abs(block.centerY - identity.centerY) <= rowTolerance);
  const members = new Set(identity.members);
  let unionLeft = identity.boundingBox.x;
  let unionRight = identity.boundingBox.x + identity.boundingBox.width;
  let changed = true;
  while (changed) {
    changed = false;
    rowBlocks.forEach((block) => {
      if (members.has(block)) return;
      const left = block.boundingBox.x;
      const right = left + block.boundingBox.width;
      const centreInsideIdentity = block.centerX > unionLeft && block.centerX < unionRight;
      if (centreInsideIdentity) {
        members.add(block);
        unionLeft = Math.min(unionLeft, left);
        unionRight = Math.max(unionRight, right);
        changed = true;
      }
    });
  }
  return [...members];
}

// Privacy-fail-closed resolution for the gutter-straddling ambiguity
// guidedScanExpandIdentityMembers deliberately leaves alone. A code-like
// block whose OWN box straddles the gutter (spans across it -- part of the
// block sits in name-column territory, part in the date grid) cannot be
// told apart from a torn-off continuation of the configured person's name
// by geometry alone. Also requires the block to sit immediately adjacent to
// the identity's own (expanded) box -- a gutter-straddling block far from
// the identity is just an ordinary code near column 1, not a plausible name
// continuation.
//
// The decision is GEOMETRY-first and unconditional: straddling + adjacent is
// always withheld, whatever the fragment happens to say. There is no content
// test and no comparative "is it nearer its column or nearer the name?"
// rescue, because neither survives contact with real OCR:
//
//  - Content cannot carry it. An earlier version exempted any token
//    containing a digit, on the premise that a digit-bearing token cannot be
//    part of a name. OCR tears name boxes into code-shaped pieces routinely
//    (a badge/roster id fragment reading "A9", a smudged initial plus a
//    column edge reading "9T"), so that premise leaks exactly the fragments
//    this function exists to catch -- see C54, which pins A9 and 9T at the
//    same boundary geometry C51 pins OFF at.
//  - Comparative geometry cannot carry it either. "Nearer a date column than
//    the identity's own edge" is a continuous quantity that necessarily
//    flips at some pixel, and C51/C54 pin both sides of that former tie: a
//    privacy decision may not hinge on a sub-pixel coincidence.
//
// What keeps this from swallowing genuine column-1 codes is the adjacency
// requirement, not content. gutterX sits exactly half a token-width left of
// column 1 by construction (see guidedScanGeometryGutterX), so a code
// centred on its column does not straddle the gutter at all, and a
// gutter-straddling code further down the table is nowhere near the
// identity's right edge -- see C10's 9T, which straddles while sitting a
// full name-column away from the matched name.
//
// A SINGLE-block identity match ("Alex", no surname/alias block beside it)
// has no internal evidence at all of where the name ends versus where an
// adjacent fragment begins (C45/C47); a MULTI-block match ("Ford" + "Alex")
// has matched text on both sides of the boundary, which is SOME evidence the
// name has ended but never enough to trust an adjacent straddling fragment
// (C50). Both are therefore treated identically here.
//
// Per the product privacy rule, any remaining ambiguity is resolved by
// withholding the token (never guessing it into either "identity" or
// "code"), not by exposing it -- callers must surface a generic
// withheld-count, never the raw token text, so nothing silently vanishes
// without explanation.
function guidedScanAmbiguousBoundaryBlocks(identity, expandedMembers, gutterX, rowScopeBlocks) {
  if (!identity || !Number.isFinite(gutterX)) return [];
  const heights = rowScopeBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const rowTolerance = Math.max(12, mediaPipeScannerMedian(heights) * 0.75);
  const rowBlocks = rowScopeBlocks.filter((block) => Math.abs(block.centerY - identity.centerY) <= rowTolerance);
  const widths = rowScopeBlocks.map((block) => block.boundingBox.width).filter(Number.isFinite);
  const adjacencyMargin = Math.max(15, mediaPipeScannerMedian(widths) * 0.5);
  const members = Array.isArray(expandedMembers) ? expandedMembers : [];
  let unionRight = identity.boundingBox.x + identity.boundingBox.width;
  members.forEach((block) => {
    unionRight = Math.max(unionRight, block.boundingBox.x + block.boundingBox.width);
  });
  return rowBlocks.filter((block) => {
    if (members.includes(block)) return false;
    if (!isLikelyRosterCodeToken(block.text)) return false;
    const left = block.boundingBox.x;
    const right = left + block.boundingBox.width;
    const straddlesGutter = left < gutterX && right > gutterX;
    if (!straddlesGutter) return false;
    const identityEdgeGap = left - unionRight;
    if (identityEdgeGap > adjacencyMargin) return false;
    return true;
  });
}

// Shared table-boundary model: how far a header band's own table reaches
// vertically, given the Y positions of every OTHER date-header band on the
// page. A table's own content is bounded by the midpoint to the nearest
// header band above it and the midpoint to the nearest header band below it
// -- never by a fixed pixel distance, which on a page with tables printed
// close together (a real photographed page, not just a synthetic one 800px
// apart) reaches straight across into a neighbouring table. No header above
// or below means no boundary on that side (a single-table photo has nothing
// else on the page to wrongly include).
function guidedScanTableYBounds(bandY, otherHeaderYs) {
  const above = otherHeaderYs.filter((y) => y < bandY).sort((a, b) => b - a)[0];
  const below = otherHeaderYs.filter((y) => y > bandY).sort((a, b) => a - b)[0];
  return {
    minY: above !== undefined ? (above + bandY) / 2 : -Infinity,
    maxY: below !== undefined ? (bandY + below) / 2 : Infinity,
  };
}

// Month/year context for ONE header band, bounded to that band's own table.
// A photographed page can show a second roster table (often a different month)
// above or below the one being confirmed; resolving months from every block on
// the page lets that other table donate its month to these dates. Restrict to
// this table's own Y boundary (see guidedScanTableYBounds) and an X window
// around the band's own extent so only this table's own month words and date
// range can apply.
function guidedScanLocalTableBlocks(band, blocks, otherHeaderYs = []) {
  const { minY, maxY } = guidedScanTableYBounds(band.y, otherHeaderYs);
  const bandXs = band.blocks.map((block) => block.centerX);
  const minX = Math.min(...bandXs);
  const maxX = Math.max(...bandXs);
  const xReach = Math.max(200, (maxX - minX) * 0.5);
  return blocks
    .filter((block) => block.centerY >= minY && block.centerY <= maxY)
    .filter((block) => block.centerX >= minX - xReach && block.centerX <= maxX + xReach);
}

function guidedScanGeometryDateLabel(columns) {
  // A column with no trustworthy local month evidence (month === null, see
  // mediaPipeScannerColumnsFromDayBlocks) must say so explicitly, never show
  // a blank/invented month label.
  const shown = columns.slice(0, 10)
    .map((column) => (column.month === null ? "Day " + column.day + " (unresolved)" : (GUIDED_SCAN_MONTH_LABELS[column.month] || "") + " " + column.day))
    .join(" · ");
  return columns.length > 10 ? shown + " …" : shown;
}

// Privacy/isolation: guidedScanGeometryStaffCandidatesForDate only ever
// builds a candidate for the configured person's own identity row (see
// there), so this always labels that row -- never another staff member's.
function guidedScanGeometryRowLabel(codes, withheldCount = 0) {
  const shown = codes.slice(0, 12).join(" ") + (codes.length > 12 ? " …" : "");
  const prefix = "Your row (auto-matched)";
  // Generic, privacy-safe note only -- never the withheld token's own text --
  // so a withheld entry still shows as SOMETHING rather than silently
  // vanishing from the row the user is about to pick. See
  // guidedScanAmbiguousBoundaryBlocks for what gets withheld and why.
  const withheldNote = withheldCount > 0 ? " (" + withheldCount + " entry withheld for privacy)" : "";
  return (shown ? prefix + " — " + shown : prefix) + withheldNote;
}

// How much real calendar evidence a band carries on its own, independent of
// any other band on the page -- used both to rank candidates (see
// preselection below) and to decide whether a band is trustworthy enough to
// act as a TABLE BOUNDARY against a different candidate (see
// guidedScanGeometryIsWeakerFragment). Deliberately cheap/local: just the
// band's own blocks, so it never depends on any other band having been
// resolved first.
function guidedScanGeometryBandDayCount(band) {
  return band.blocks.filter((block) => mediaPipeScannerDayNumber(block.text) !== null).length;
}
function guidedScanGeometryBandHasMonthWord(band) {
  return band.blocks.some((block) => scanRosterMonthIndex(block.text) >= 0);
}

// A band can resolve its own month/year without printing a 3-letter month
// WORD at all -- a literal printed date range ("13/09/2026 - 24/09/2026", the
// same DD/MM/YYYY shape mediaPipeScannerDateRange already trusts for
// monthResolvedLocally) is just as real local evidence. Checked over the
// band's OWN blocks only, exactly like guidedScanGeometryBandHasMonthWord --
// still deliberately cheap/local, never depending on any other band having
// been resolved first (see the comment above).
function guidedScanGeometryBandIsMonthAnchored(band) {
  return guidedScanGeometryBandHasMonthWord(band) || Boolean(mediaPipeScannerDateRange(band.blocks));
}

// A weaker/sparser fragment must never outrank, nor act as a table boundary
// against, a genuinely stronger neighbouring header -- real-photo evidence:
// a torn "9 10" shift-code fragment (no month word, two bare day numbers)
// was both preselected over, and then truncated the table of, a genuine
// broad Sep 13-24 header sitting further away. This is NOT a blanket
// rejection of sparse bands -- a bare two-date header is still a completely
// legitimate candidate on its own (see SA3) when nothing stronger is
// competing with it; a real second table with the same modest evidence as
// its neighbour (see C35, where both tables are equally sparse) must still
// bound its neighbour normally. So the comparison is always RELATIVE to
// whichever specific band it is being measured against, never an absolute
// threshold: `other` only counts as a weaker fragment once `current` is
// both actually bigger and either month-anchored itself or at least twice
// `other`'s own day coverage.
//
// Real-device evidence (2026-09-24, Test 5): `otherBand` having ANY month
// word used to grant it unconditional immunity from ever being "weaker",
// with no regard for how few dates it actually resolves. A sparse 2-date
// fragment that merely happened to OCR its own stray/real month word still
// bounded and truncated a genuinely bigger, itself month-resolved
// neighbouring header's table scope, hiding the configured person's row
// entirely after the correct broad header had already been confirmed. The
// month-word immunity is now scoped to protect a smaller RESOLVED table
// from an unresolved larger neighbour (`currentBand` has no month word of
// its own) -- once `currentBand` is itself month-anchored, `otherBand`'s
// month word alone is no longer enough; the day-count comparison below
// still applies, exactly as it already does when neither band has one.
//
// Real-device evidence (2026-09-25, Test 5): a broad header can resolve its
// own month/year purely from a printed date-range literal (see
// guidedScanGeometryBandIsMonthAnchored) with no month WORD anywhere in its
// own row. guidedScanGeometryBandHasMonthWord alone missed that evidence
// entirely, so `currentHasMonthWord` still came back false for a genuinely
// resolved broad header and the immunity above never engaged -- a sparser
// fragment that merely carried its own month WORD still bounded and
// truncated the broad header's table scope even though the header was
// itself fully, locally resolved. Both sides of the comparison now use the
// wider month-ANCHORED check (word or date-range), not the word-only one.
// Real-device evidence (2026-09-25, Test 5): a candidate can resolve its own
// month/year from surrounding LOCAL table evidence outside its own header
// band (see guidedScanGeometryCandidates' monthResolvedLocally, e.g. a
// date-range literal printed elsewhere in the table body) -- band-level
// evidence alone (guidedScanGeometryBandIsMonthAnchored) cannot see that.
// guidedScanDateTableScope's own boundary comparison must credit the
// SELECTED CANDIDATE's already-proven monthResolvedLocally state, not just
// its raw band, or a sparser in-band-month-anchored fragment still reads as
// not-weaker and truncates the table scope above the identity row.
// currentResolvedLocally is only ever passed by that call site; the
// candidate-construction call site (which builds monthResolvedLocally in the
// first place) omits it, so behaviour there is unchanged.
function guidedScanGeometryIsWeakerFragment(otherBand, currentBand, currentResolvedLocally) {
  const otherCount = guidedScanGeometryBandDayCount(otherBand);
  const currentCount = guidedScanGeometryBandDayCount(currentBand);
  if (currentCount <= otherCount) return false;
  const currentIsMonthAnchored = Boolean(currentResolvedLocally) || guidedScanGeometryBandIsMonthAnchored(currentBand);
  if (guidedScanGeometryBandIsMonthAnchored(otherBand) && !currentIsMonthAnchored) return false;
  return currentIsMonthAnchored || otherCount * 2 <= currentCount;
}

// Adjacent OCR bands that are clearly torn fragments of ONE physical header
// row (a camera-skewed photo can OCR the left and right halves of a wide
// header a few pixels apart in Y, landing them in different row-bands --
// see mediaPipeScannerRowBands) must be consolidated into one candidate
// before evaluation. Real-photo evidence: a genuine Aug->Sep header
// fragmented into several disconnected, individually weaker candidates
// instead of the one real calendar grid it actually is.
//
// Deliberately conservative: two bands merge ONLY when they sit close
// enough in Y to plausibly be one torn row (the same row-height-scaled
// bound guidedScanGeometryContinuationBands uses, never an arbitrary fixed
// distance) AND their combined day sequence, read in X order, is itself a
// single valid calendar run (reusing guidedScanGeometryIsDateBand's own
// forward/rollover rule on the union). Two genuinely separate tables
// printed close together (see C35) fail that combined check -- their day
// numbers repeat/go backward when merged -- and are correctly left apart.
// Chains only to the immediate next candidate by Y order; a non-mergeable
// neighbour stops the chain rather than being skipped over.
function guidedScanGeometryConsolidateDateBands(bands) {
  const heights = bands.flatMap((band) => band.blocks.map((block) => block.boundingBox.height)).filter(Number.isFinite);
  const rowHeightUnit = Math.max(12, mediaPipeScannerMedian(heights));
  const maxGap = Math.max(24, rowHeightUnit * 2);
  const withDayNumbers = bands.filter((band) => band.blocks.some((block) => mediaPipeScannerDayNumber(block.text) !== null));
  const withoutDayNumbers = bands.filter((band) => !band.blocks.some((block) => mediaPipeScannerDayNumber(block.text) !== null));
  const ordered = withDayNumbers.slice().sort((a, b) => a.y - b.y);
  const consolidated = [];
  let index = 0;
  while (index < ordered.length) {
    let composite = ordered[index];
    let next = index + 1;
    while (next < ordered.length && ordered[next].y - composite.y <= maxGap) {
      const mergedBand = { y: (composite.y + ordered[next].y) / 2, blocks: composite.blocks.concat(ordered[next].blocks) };
      if (!guidedScanGeometryIsDateBand(mergedBand)) break;
      composite = mergedBand;
      next += 1;
    }
    consolidated.push(composite);
    index = next;
  }
  return consolidated.concat(withoutDayNumbers);
}

// Step 1 ONLY builds Date candidates. Staff candidates must not exist yet --
// building them here (as an earlier version did, from a single page-wide
// gutter spanning every table) is exactly how another table's short names/
// initials could leak into a Staff picker before the user has even chosen
// which table they mean. See guidedScanGeometryStaffCandidatesForDate, which
// builds Staff candidates only after a Date row is confirmed, scoped to that
// row's own table.
// The exact native table capability (see RosterMateBridge.recognizedTextBlocksJson
// / mediaPipeScannerNormalisedBlockCapability) this band's header proved, or
// null when it cannot be attributed to exactly one validated table. Requires
// EVERY block in the band to carry the identical non-empty value -- not "at
// least one" -- so a band JS consolidated from a genuine native table plus a
// stray fragment native never tagged (or tagged for a DIFFERENT table) never
// inherits a capability it cannot actually prove end to end. An empty band,
// or one where native never ran a validated-header pass at all (the ordinary
// case for every non-row-strip scan), simply has nothing to inherit -- null,
// not a guessed/derived substitute.
function guidedScanGeometryBandTableCapability(band) {
  const blocks = (band && Array.isArray(band.blocks)) ? band.blocks : [];
  if (!blocks.length) return null;
  const first = blocks[0].tableCapability;
  if (typeof first !== "string" || !first) return null;
  return blocks.every((block) => block.tableCapability === first) ? first : null;
}

function guidedScanGeometryCandidates(textBlocks) {
  const blocks = mediaPipeScannerNormalisedBlocks(textBlocks);
  if (!blocks.length) return null;
  const bands = mediaPipeScannerRowBands(blocks);
  if (!bands.length) return null;
  const identity = mediaPipeScannerIdentityBlock(blocks);

  const dateBands = guidedScanGeometryConsolidateDateBands(bands).filter(guidedScanGeometryIsDateBand);
  const dateCandidates = dateBands.map((band, index) => {
    const dayBlocks = band.blocks.filter((block) => mediaPipeScannerDayNumber(block.text) !== null);
    // Month/year come only from this band's own table neighbourhood, and
    // never from a sparser/weaker fragment merely masquerading as a
    // competing header (see guidedScanGeometryIsWeakerFragment).
    const otherHeaderYs = dateBands
      .filter((otherBand) => otherBand !== band && !guidedScanGeometryIsWeakerFragment(otherBand, band))
      .map((otherBand) => otherBand.y);
    const localBlocks = guidedScanLocalTableBlocks(band, blocks, otherHeaderYs);
    const localRange = mediaPipeScannerDateRange(localBlocks);
    const columns = mediaPipeScannerColumnsFromDayBlocks(dayBlocks, localBlocks, localRange, false);
    // "Resolved" must mean every column this candidate actually offers has a
    // real month/year, not merely that some month word exists somewhere in
    // scope -- the latter is true even when a rollover/contradiction leaves
    // some or all of those columns' months null (see
    // mediaPipeScannerResolveSegmentMonths), which used to suppress this
    // candidate-level warning despite the columns still being unresolved.
    const monthResolvedLocally = Boolean(localRange) || (columns.length > 0 && columns.every((column) => column.month !== null));
    return {
      index,
      band,
      columns,
      monthResolvedLocally,
      dates: columns.map((column) => ({ day: column.day, month: column.month, year: column.year })),
      line: guidedScanGeometryDateLabel(columns),
      y: band.y,
      source: "geometry",
      // The native table capability this date candidate's own header proved
      // -- see guidedScanGeometryBandTableCapability. Inherited only when
      // EVERY block making up this consolidated band agrees, so a band built
      // from fragments native validated as two different tables (or one
      // validated table plus one native never saw/validated at all) never
      // silently inherits either one's capability.
      tableCapability: guidedScanGeometryBandTableCapability(band),
    };
  }).filter((candidate) => candidate.columns.length >= 2);

  if (!dateCandidates.length) return null;

  // Preselection only. The automatically detected header band is offered as
  // the starting point so the common case stays one tap, but it remains fully
  // changeable, and choosing it is never treated as confirmation. Ranked by
  // the candidate's OWN evidence strength first -- real local month
  // resolution, then column coverage -- and only falls back to Y proximity
  // to break a genuine tie. A merely-nearer sparse fragment must never
  // outrank a broader, month-bearing header just because it happens to sit
  // closer to the configured person's row.
  const headerY = mediaPipeScannerHeaderY(blocks, identity);
  const preselectedDateIndex = dateCandidates
    .slice()
    .sort((a, b) => {
      if (a.monthResolvedLocally !== b.monthResolvedLocally) return a.monthResolvedLocally ? -1 : 1;
      if (b.columns.length !== a.columns.length) return b.columns.length - a.columns.length;
      return Math.abs(a.y - headerY) - Math.abs(b.y - headerY);
    })[0].index;
  return {
    blocks,
    dateCandidates,
    preselectedDateIndex,
  };
}

// Step 2. Only runs once a Date row is confirmed, and is scoped entirely to
// that row's own table: a table's rows are claimed from its own header down
// to the midpoint with the NEXT header band below it, never by an absolute
// pixel distance. A single-table photo (the common case) has no other header
// band below it, so every row on the page belongs to it, however far apart
// they are printed -- exactly like the previous (unscoped) behaviour for that
// common case. A row must always be physically BELOW its own header -- never
// merely below the midpoint with a DIFFERENT, earlier table's header --
// otherwise a late row belonging to the previous table can fall below that
// midpoint while still sitting above this header, and get claimed by this
// table instead of its own. The header band's own blocks are excluded by
// identity (not just by Y) because a header band's mean Y can sit above some
// of its own member blocks.
// One date candidate's own table scope, plus everything derived from it that
// both the Staff-candidate build below and the pre-session privacy sanitation
// pass (scanRosterPrivacyWithheldBlocks) need. Shared so the withholding
// decision made before any state is retained is byte-for-byte the same
// decision the guided picker makes afterwards -- two separate copies of this
// derivation could disagree and leak exactly the token the sanitation pass
// exists to remove.
function guidedScanDateTableScope(dateCandidate, blocks) {
  const bandY = dateCandidate.band.y;
  const headerBlocks = new Set(dateCandidate.band.blocks);
  const otherHeaderYs = guidedScanGeometryConsolidateDateBands(mediaPipeScannerRowBands(blocks))
    .filter((band) => guidedScanGeometryIsDateBand(band) && band.y !== bandY)
    .filter((band) => !guidedScanGeometryIsWeakerFragment(band, dateCandidate.band, dateCandidate.monthResolvedLocally))
    .map((band) => band.y);
  // A row must always be physically below its OWN header (never merely
  // below the midpoint with a different, earlier table's header), so the
  // lower bound stays bandY itself -- only the upper bound comes from the
  // shared boundary model.
  const { maxY } = guidedScanTableYBounds(bandY, otherHeaderYs);
  const tableBlocks = blocks.filter((block) => !headerBlocks.has(block) && block.centerY > bandY && block.centerY < maxY);
  const gutterX = guidedScanGeometryGutterX(dateCandidate.columns, tableBlocks);
  const identity = mediaPipeScannerIdentityBlock(tableBlocks);
  const identityMembers = guidedScanExpandIdentityMembers(identity, tableBlocks);
  const ambiguousBoundaryBlocks = guidedScanAmbiguousBoundaryBlocks(identity, identityMembers, gutterX, tableBlocks);
  return { tableBlocks, gutterX, identity, identityMembers, ambiguousBoundaryBlocks };
}

// Right edge of the NAME column specifically, as opposed to anything else
// printed left of the date gutter (a real roster can print a separate Unit/
// team-metadata column -- e.g. "HFTE"/"AFTE"-style -- between the Name
// column and the date grid). Derived from the identity's own matched name
// blocks (identityMembers, the same geometry guidedScanExpandIdentityMembers
// already computes for privacy withholding) rather than the date-column
// gutter, so metadata that sits left of the gutter but right of the actual
// name text is never mistaken for name-column content. A small adjacency
// margin (half a typical token width, the same principle guidedScanGeometryGutterX
// uses) allows for a modestly longer name on a different row than the
// configured person's own.
function guidedScanGeometryNameColumnRight(identityMembers, rowScopeBlocks) {
  if (!identityMembers || !identityMembers.length) return -Infinity;
  const widths = rowScopeBlocks.map((block) => block.boundingBox.width).filter(Number.isFinite);
  const margin = Math.max(15, mediaPipeScannerMedian(widths) * 0.5);
  const right = Math.max(...identityMembers.map((block) => block.boundingBox.x + block.boundingBox.width));
  return right + margin;
}

// The configured person's roster allocation can span more than one physical
// row: a named row plus one or more directly-following UNLABELLED
// continuation bands carrying further codes for the same person (a common
// layout -- e.g. an on-call marker printed on its own line under the name).
// Absorbs only bands that are:
//  - within a tight, bounded vertical gap of the last absorbed row (a small
//    multiple of the table's own row height) -- never merely "somewhere
//    below, with no name row seen yet", which would let a distant, unrelated
//    row whose name simply failed OCR silently donate its codes here;
//  - carrying no block in the NAME column itself (see
//    guidedScanGeometryNameColumnRight) -- NOT merely "anything left of the
//    date gutter", which would also catch a repeating Unit/team-metadata
//    column printed between the Name column and the date grid, wrongly
//    treating the configured person's own continuation row (which still
//    carries that same metadata) as a different, newly named staff row. A
//    block in the actual name column IS positive evidence of a different,
//    named staff row and stops absorption immediately, however close it
//    sits -- absence of a name is ambiguous, not itself a boundary, so it is
//    the bounded gap (not an unbounded walk) that keeps that ambiguity from
//    being resolved by silently absorbing an unrelated row.
// Running past the bound with no positive name-boundary found simply stops;
// it is never license to keep scanning arbitrarily far down the table.
function guidedScanGeometryContinuationBands(identityBand, nameColumnRight, candidateBands, rowHeightUnit) {
  const maxGap = Math.max(24, rowHeightUnit * 2);
  const below = candidateBands
    .filter((band) => band !== identityBand && band.y > identityBand.y)
    .sort((a, b) => a.y - b.y);
  const continuation = [];
  let previousY = identityBand.y;
  for (const band of below) {
    if (band.y - previousY > maxGap) break;
    // Bounding-box evidence (the block's LEFT edge), not its centre: a real
    // long staff name can arrive as one wide, un-split OCR block whose left
    // edge sits flush in the Name column but whose centre a centre-only test
    // would push past this (fairly narrow, derived from the configured
    // person's own shorter name) boundary -- see guidedScanGeometryNameColumnRight.
    // Any overlap with the Name column region at all is positive evidence.
    const hasNameColumnContent = band.blocks.some((block) => block.boundingBox.x < nameColumnRight);
    if (hasNameColumnContent) break;
    continuation.push(band);
    previousY = band.y;
  }
  return continuation;
}

// Personal mode: there is no configured-identity row to find -- the whole
// table below the header IS the user's own grid, by definition of "my own
// electronic roster, only my shifts are shown". This duplicates ONLY the
// pure Y-scoping half of guidedScanDateTableScope (header exclusion plus the
// shared table-boundary model); it never calls mediaPipeScannerIdentityBlock
// or anything else identity-shaped, so this path never requires or
// simulates Staff/name matching (see CLAUDE.md Personal/Team contract).
function guidedScanPersonalGridTableBlocks(dateCandidate, blocks) {
  const bandY = dateCandidate.band.y;
  const headerBlocks = new Set(dateCandidate.band.blocks);
  const otherHeaderYs = guidedScanGeometryConsolidateDateBands(mediaPipeScannerRowBands(blocks))
    .filter((band) => guidedScanGeometryIsDateBand(band) && band.y !== bandY)
    .filter((band) => !guidedScanGeometryIsWeakerFragment(band, dateCandidate.band, dateCandidate.monthResolvedLocally))
    .map((band) => band.y);
  const { maxY } = guidedScanTableYBounds(bandY, otherHeaderYs);
  return blocks.filter((block) => !headerBlocks.has(block) && block.centerY > bandY && block.centerY < maxY);
}

// Whole-token weekday match only (mirrors guidedScanIsMonthAnchorText's own
// reasoning: a staff nickname or unrelated word must never anchor real
// calendar evidence merely by sharing a prefix). Index matches JS
// Date.getUTCDay()/getDay() (0 = Sunday) so it can be compared directly
// against a real calendar date.
const GUIDED_SCAN_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function guidedScanIsWeekdayAnchorText(text) {
  const key = String(text || "").trim().toLowerCase();
  if (!key) return -1;
  return GUIDED_SCAN_WEEKDAY_LABELS.findIndex((label) => label.toLowerCase() === key);
}

// Personal-only structural header gate (see CLAUDE.md Personal/Team contract
// and the "approved format requires a consecutive weekday + day-number
// header" requirement). Team's own header acceptance (guidedScanGeometryIsDateBand)
// is untouched by this -- a personal grid additionally requires a
// day-of-week row directly above the day-number row, one weekday token per
// day-number column, advancing in exact lockstep: the day number steps by
// exactly 1 (at most one end-of-month rollover, the same shape
// guidedScanGeometryIsDateBand already treats as plausible) and the weekday
// index steps by exactly 1 (mod 7) every column, with no gap. This is
// deliberately independent of any month/year context -- it is a pure
// self-consistency check of the header's own printed geometry, checked
// BEFORE any date-context confirmation exists (see
// guidedScanPersonalGridResolveDatesAgainstContext for the separate,
// context-bound check that runs afterwards).
// Returns an ordered (left-to-right) array of { day, weekdayIndex } pairs
// when the header is valid, or null when it is not -- a header lacking a
// day-of-week row, a count mismatch against the day-number row, a
// non-consecutive day step, more than one rollover, or a weekday that does
// not advance in lockstep with the day numbers all collapse to null (fail
// closed) rather than being partially trusted.
function guidedScanPersonalGridHeaderWeekdayPairs(dateCandidate, blocks) {
  const dayBlocks = dateCandidate.band.blocks
    .filter((block) => mediaPipeScannerDayNumber(block.text) !== null)
    .sort((a, b) => a.centerX - b.centerX);
  if (dayBlocks.length < 2) return null;
  const bandY = dateCandidate.band.y;
  const heights = dayBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const rowTolerance = Math.max(12, mediaPipeScannerMedian(heights) * 0.75);
  const weekdayBand = mediaPipeScannerRowBands(blocks)
    .filter((band) => band.y < bandY - rowTolerance)
    .sort((a, b) => b.y - a.y)[0];
  if (!weekdayBand) return null;
  const weekdayBlocks = weekdayBand.blocks
    .filter((block) => guidedScanIsWeekdayAnchorText(block.text) >= 0)
    .sort((a, b) => a.centerX - b.centerX);
  if (weekdayBlocks.length !== dayBlocks.length) return null;
  const spacing = mediaPipeScannerMedian(
    dayBlocks.slice(1).map((block, index) => Math.abs(block.centerX - dayBlocks[index].centerX)).filter(Boolean)
  );
  const columnTolerance = Math.max(30, spacing * 0.6);
  const pairs = [];
  for (let i = 0; i < dayBlocks.length; i += 1) {
    if (Math.abs(weekdayBlocks[i].centerX - dayBlocks[i].centerX) > columnTolerance) return null;
    pairs.push({ day: mediaPipeScannerDayNumber(dayBlocks[i].text), weekdayIndex: guidedScanIsWeekdayAnchorText(weekdayBlocks[i].text) });
  }
  let rolloverCount = 0;
  for (let i = 1; i < pairs.length; i += 1) {
    const isRollover = pairs[i].day <= 3 && pairs[i - 1].day >= 28;
    if (isRollover) {
      rolloverCount += 1;
    } else if (pairs[i].day - pairs[i - 1].day !== 1) {
      return null;
    }
    if (rolloverCount > 1) return null;
    const weekdayStep = (pairs[i].weekdayIndex - pairs[i - 1].weekdayIndex + 7) % 7;
    if (weekdayStep !== 1) return null;
  }
  return pairs;
}

// Builds the single "whole grid" candidate a Personal-format scan offers in
// place of Team's configured-identity row. Every non-header row below the
// date header is folded in -- a personal grid has no per-row name/label
// column to pick one row out from the rest.
//
// Fail-closed misuse guard: if any body-row block sits left of the same
// name-gutter boundary Team's own gutter derivation (guidedScanGeometryGutterX)
// uses, this table has a leading name/label column and is Team-roster
// shaped, not a personal grid -- return no candidate at all rather than
// sweep a co-worker's row into "my" drafts.
function guidedScanPersonalGridRowCandidates(dateCandidate, blocks) {
  const tableBlocks = guidedScanPersonalGridTableBlocks(dateCandidate, blocks);
  if (!tableBlocks.length) return [];
  const bodyBands = mediaPipeScannerRowBands(tableBlocks).filter((band) => !guidedScanGeometryIsDateBand(band));
  if (!bodyBands.length) return [];
  const gutterX = guidedScanGeometryGutterX(dateCandidate.columns, tableBlocks);
  const hasLeadingColumnText = bodyBands.some((band) => band.blocks.some((block) => block.centerX < gutterX));
  if (hasLeadingColumnText) return [];
  const orderedBands = bodyBands.slice().sort((a, b) => a.y - b.y);
  const compositeBlocks = orderedBands.flatMap((band) => band.blocks);
  const codes = compositeBlocks.map((block) => block.text);
  if (!codes.length) return [];
  const compositeBand = { y: orderedBands[0].y, blocks: compositeBlocks };
  return [{
    index: 0,
    band: compositeBand,
    // One real band per physical grid row (NOT collapsed to one composite):
    // guidedScanGeometrySameColumnConflicts tells a genuine second shift on
    // the same date apart from a single block by whether two colliding
    // blocks trace back to different memberBands entries. Collapsing every
    // row into one band here would make two different rows' same-date codes
    // indistinguishable from each other, so one of them would be silently
    // discarded as "already claimed" instead of staged side by side (see
    // confirmGuidedScanStaffRow's source === "personal-grid" guard, which
    // stops this same array from also being read as a Step 3 continuation-
    // band count -- that concept does not apply to a personal grid).
    memberBands: orderedBands,
    codes,
    gutterX: -Infinity,
    identityMembers: [],
    // Honestly false: Personal mode must never require OR SIMULATE a
    // Staff/name match (see CLAUDE.md Personal/Team contract). This
    // candidate still stages, but only through its own explicit
    // permission gate -- see guidedScanPersonalGridAuthorized -- not by
    // posing as a real identity match.
    isIdentity: false,
    ambiguousWithheldCount: 0,
    line: guidedScanGeometryRowLabel(codes, 0),
    y: orderedBands[0].y,
    source: "personal-grid",
  }];
}

function guidedScanGeometryStaffCandidatesForDate(dateCandidate, blocks) {
  const bandY = dateCandidate.band.y;
  // Merge the privacy-withheld gutter-straddling blocks (see
  // guidedScanAmbiguousBoundaryBlocks) into the identity members so they are
  // excluded from code extraction identically to a real identity member,
  // everywhere identityMembers is consulted below and later in
  // buildGuidedScanGeometryDrafts (which reuses this same merged set from
  // the row candidate it was given).
  const { tableBlocks, gutterX, identity, identityMembers, ambiguousBoundaryBlocks } = guidedScanDateTableScope(dateCandidate, blocks);
  const excludedIdentityBlocks = ambiguousBoundaryBlocks.length
    ? (identityMembers || []).concat(ambiguousBoundaryBlocks)
    : identityMembers;
  const candidateBands = mediaPipeScannerRowBands(tableBlocks).filter((band) => !guidedScanGeometryIsDateBand(band));
  // Only treat a band as the configured person's row if it is genuinely on the
  // identity's own line. Picking the merely-nearest band would, whenever the
  // real row failed to yield candidates, promote a neighbouring staff member's
  // row to "Your row". Determined over EVERY candidate band (not yet filtered
  // by code count) so the zero-code-but-withheld case below can still find
  // its own identity band.
  const rowHeights = tableBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const identityRowReach = Math.max(24, mediaPipeScannerMedian(rowHeights) * 1.5);
  const nearestToIdentity = identity
    ? candidateBands.slice().sort((a, b) => Math.abs(a.y - identity.centerY) - Math.abs(b.y - identity.centerY))[0]
    : null;
  const identityBand = nearestToIdentity && Math.abs(nearestToIdentity.y - identity.centerY) <= identityRowReach
    ? nearestToIdentity
    : null;
  // Privacy/isolation: the configured person's own row is the ONLY row that
  // may ever become a candidate. A neighbouring staff member's row must never
  // be shown or selectable, even labelled positionally with its name
  // withheld -- its shift CODES are themselves that other person's private
  // roster data. If no identity band is found on this table at all, fail
  // closed with zero candidates rather than falling back to offering any
  // other row.
  if (!identityBand) return [];
  // The configured person's allocation can span more than one physical row
  // (see guidedScanGeometryContinuationBands): fold any directly-following
  // unlabelled continuation band(s) into one composite row BEFORE code
  // extraction, so a code printed on a continuation line is never lost. The
  // composite band is also what is returned below (as `band`) so
  // buildGuidedScanGeometryDrafts, which re-derives its own gutter/codes from
  // the confirmed row's `band.blocks`, sees every member block too -- not
  // just the named row's.
  const rowHeightUnit = Math.max(12, mediaPipeScannerMedian(rowHeights));
  const nameColumnRight = guidedScanGeometryNameColumnRight(identityMembers, tableBlocks);
  const continuationBands = guidedScanGeometryContinuationBands(identityBand, nameColumnRight, candidateBands, rowHeightUnit);
  const compositeBand = continuationBands.length
    ? { y: identityBand.y, blocks: [identityBand, ...continuationBands].flatMap((band) => band.blocks) }
    : identityBand;
  const codes = guidedScanGeometryCodeBlocks(compositeBand, gutterX, excludedIdentityBlocks).map((block) => block.text);
  // A zero-code identity band is still kept when its sole token was withheld
  // by the ambiguous-boundary privacy rule above, so the withheld-count
  // warning can still reach the user rather than the row silently vanishing.
  if (!codes.length && !ambiguousBoundaryBlocks.length) return [];
  const ambiguousWithheldCount = ambiguousBoundaryBlocks.length;
  return [{
    index: 0,
    band: compositeBand,
    memberBands: [identityBand, ...continuationBands],
    codes,
    gutterX,
    identityMembers: excludedIdentityBlocks,
    isIdentity: true,
    ambiguousWithheldCount,
    line: guidedScanGeometryRowLabel(codes, ambiguousWithheldCount),
    y: identityBand.y,
    source: "geometry",
  }];
}

// Verdict-neutral, counts-only diagnostic explaining WHY
// guidedScanGeometryStaffCandidatesForDate returned zero staff-row candidates
// for this date candidate (the "no selectable rows were found in that date
// row's table" empty state) -- real-device evidence could not otherwise tell
// apart "no configured-identity text match anywhere on the page" from "a
// genuine match that falls outside this table's own row reach," two very
// different root causes behind the same empty array. Read-only: reuses
// guidedScanDateTableScope (the exact table-scoping logic the real candidate
// builder uses) and only duplicates the reach/code-count arithmetic that
// happens after it, so the two can disagree only if guidedScanDateTableScope
// itself changes -- see the T6 consistency test in
// tests/web/guided-scan-staff-row-diagnostic.test.js, which pins reason ===
// 'CANDIDATE_PRODUCED' to agree with the real builder's own empty/non-empty
// verdict across every fixture. Deliberately does NOT modify
// guidedScanGeometryStaffCandidatesForDate itself, and this function's result
// is never consulted by candidate selection, staging, or import -- only
// rendered as read-only diagnostics text (see
// guidedScanStaffRowDiagnosticsSummaryLine).
//
// Every field is a boolean, a non-negative integer, a finite ratio, or a
// member of the closed GUIDED_SCAN_STAFF_ROW_DIAGNOSTIC_REASONS enum: no
// name, raw OCR text, filename, or absolute coordinate is ever included,
// matching this project's existing closed-schema diagnostic practice (see
// RejectionReason.java / FreshScanResult's "count-only" rule).
const GUIDED_SCAN_STAFF_ROW_DIAGNOSTIC_REASONS = Object.freeze([
  "NO_PAGE_MATCH",
  "MATCH_OUTSIDE_TABLE",
  "NO_CANDIDATE_BANDS",
  "OUTSIDE_ROW_REACH",
  "ZERO_CODES",
  "CANDIDATE_PRODUCED",
]);

function guidedScanStaffRowDiagnosticResult(reason, overrides = {}) {
  return Object.assign({
    reason,
    identityMatchFound: false,
    candidateWithinTable: false,
    candidateBandCount: 0,
    rejectedByRowReach: false,
    nearestBandOffsetRatio: null,
  }, overrides);
}

function guidedScanStaffRowDiagnostic(dateCandidate, blocks) {
  const pageIdentity = mediaPipeScannerIdentityBlock(blocks);
  if (!pageIdentity) return guidedScanStaffRowDiagnosticResult("NO_PAGE_MATCH");

  const { tableBlocks, gutterX, identity, identityMembers, ambiguousBoundaryBlocks } = guidedScanDateTableScope(dateCandidate, blocks);
  if (!identity) {
    return guidedScanStaffRowDiagnosticResult("MATCH_OUTSIDE_TABLE", { identityMatchFound: true });
  }

  const candidateBands = mediaPipeScannerRowBands(tableBlocks).filter((band) => !guidedScanGeometryIsDateBand(band));
  const candidateBandCount = candidateBands.length;
  if (!candidateBandCount) {
    return guidedScanStaffRowDiagnosticResult("NO_CANDIDATE_BANDS", { identityMatchFound: true, candidateWithinTable: true });
  }

  const rowHeights = tableBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const identityRowReach = Math.max(24, mediaPipeScannerMedian(rowHeights) * 1.5);
  const nearestToIdentity = candidateBands.slice().sort((a, b) => Math.abs(a.y - identity.centerY) - Math.abs(b.y - identity.centerY))[0];
  const nearestDistance = Math.abs(nearestToIdentity.y - identity.centerY);
  const rejectedByRowReach = nearestDistance > identityRowReach;
  const nearestBandOffsetRatio = identityRowReach > 0 ? Math.round((nearestDistance / identityRowReach) * 100) / 100 : null;
  if (rejectedByRowReach) {
    return guidedScanStaffRowDiagnosticResult("OUTSIDE_ROW_REACH", { identityMatchFound: true, candidateWithinTable: true, candidateBandCount, rejectedByRowReach: true, nearestBandOffsetRatio });
  }

  // Identity band located within reach -- fold continuation bands and count
  // codes exactly as guidedScanGeometryStaffCandidatesForDate does, so
  // ZERO_CODES vs CANDIDATE_PRODUCED agrees with its real return exactly.
  const identityBand = nearestToIdentity;
  const rowHeightUnit = Math.max(12, mediaPipeScannerMedian(rowHeights));
  const nameColumnRight = guidedScanGeometryNameColumnRight(identityMembers, tableBlocks);
  const continuationBands = guidedScanGeometryContinuationBands(identityBand, nameColumnRight, candidateBands, rowHeightUnit);
  const compositeBand = continuationBands.length
    ? { y: identityBand.y, blocks: [identityBand, ...continuationBands].flatMap((band) => band.blocks) }
    : identityBand;
  const excludedIdentityBlocks = ambiguousBoundaryBlocks.length
    ? (identityMembers || []).concat(ambiguousBoundaryBlocks)
    : identityMembers;
  const codes = guidedScanGeometryCodeBlocks(compositeBand, gutterX, excludedIdentityBlocks);
  if (!codes.length && !ambiguousBoundaryBlocks.length) {
    return guidedScanStaffRowDiagnosticResult("ZERO_CODES", { identityMatchFound: true, candidateWithinTable: true, candidateBandCount, nearestBandOffsetRatio });
  }
  return guidedScanStaffRowDiagnosticResult("CANDIDATE_PRODUCED", { identityMatchFound: true, candidateWithinTable: true, candidateBandCount, nearestBandOffsetRatio });
}

function prepareGuidedScanSession(text, textBlocks = [], rosterFormat = "team") {
  // Exact-match only: anything other than literally "personal" -- missing,
  // unknown, legacy, wrong case -- resolves to "team" so a caller that
  // forgets to pass this (every existing call site) keeps today's behaviour
  // unchanged. See sanitizedScanRosterFormat for the equivalent settings-load
  // rule.
  const format = rosterFormat === "personal" ? "personal" : "team";
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dateCandidatesRaw = lines
    .map((line, index) => ({ index, line, dates: scanRosterDatesFromHeaderLine(line) }))
    .filter((candidate) => candidate.dates.length >= 2 || isScanRosterDateHeaderLine(candidate.line));
  // Pull already-resolved per-shift lines (see guidedScanResolvedLineInfo) out
  // for the read-only summary below. This is the only informational value
  // text-only OCR can offer -- see the no-geometry branch below for why
  // nothing built from text alone may ever become selectable/importable.
  const resolvedLines = [];
  dateCandidatesRaw.forEach((candidate) => {
    const resolved = guidedScanResolvedLineInfo(candidate.line);
    if (resolved) resolvedLines.push(resolved);
  });
  // Geometry wins whenever ML Kit text blocks are available: it is the only
  // path that can match a code to a date by where it physically sits, and it
  // is the only path that lets the user correct a misidentified row. The
  // already-resolved per-shift lines are kept as an informational summary of
  // what the automatic pass found -- never as a reason to remove the pickers.
  const geometry = guidedScanGeometryCandidates(textBlocks);
  if (geometry) {
    // Staff candidates for EVERY table are derived HERE, synchronously,
    // while `geometry.blocks` (the whole page) is only a local argument to
    // guidedScanGeometryStaffCandidatesForDate -- it is never assigned onto
    // guidedScanSession. Each date candidate keeps its own header band
    // (dates are not private) plus, if one was found, its own configured-
    // identity row candidate (name + own shift codes only). Privacy/
    // isolation: this is what stops guidedScanSession from ever having to
    // retain another staff member's blocks just so a LATER call to
    // confirmGuidedScanDateRow can re-derive the row for whichever table the
    // user eventually picks -- see scanRosterPrivacySafeGeometryBlocks for
    // the equivalent rule applied to lastScanRosterOcrResult.textBlocks.
    // Personal mode: a page offering more than one plausible date header/
    // table is never safe to auto-sweep into "my" grid (which table is the
    // user's own personal roster, with no name/row to disambiguate it, is
    // exactly the ambiguity Team resolves via identity). Fail closed for
    // every candidate rather than let one get silently picked.
    const personalCompetingTables = format === "personal" && geometry.dateCandidates.length > 1;
    const dateCandidates = geometry.dateCandidates.map((dateCandidate) => {
      // Personal-only structural header gate (see
      // guidedScanPersonalGridHeaderWeekdayPairs): computed once here, per
      // candidate, and carried on the candidate so a later date-context
      // confirmation (see confirmGuidedScanPersonalDateContext) can reuse the
      // exact same validated day/weekday pairs rather than re-deriving them
      // from the whole page's blocks a second time.
      const personalWeekdayPairs = format === "personal" ? guidedScanPersonalGridHeaderWeekdayPairs(dateCandidate, geometry.blocks) : null;
      const personalHeaderInvalid = format === "personal" && !personalWeekdayPairs;
      return Object.assign({}, dateCandidate, {
      personalWeekdayPairs,
      rowCandidates: format === "personal"
        ? ((personalCompetingTables || personalHeaderInvalid) ? [] : guidedScanPersonalGridRowCandidates(dateCandidate, geometry.blocks))
        : guidedScanGeometryStaffCandidatesForDate(dateCandidate, geometry.blocks),
      // Identity-based diagnostics/table-ownership signal: meaningless (and,
      // per the Personal contract, must never be computed by simulating
      // Staff/name matching) outside Team mode.
      staffRowDiagnostic: format === "personal" ? null : guidedScanStaffRowDiagnostic(dateCandidate, geometry.blocks),
      // Table-ownership signal (see TO1/TO1b in tests/web/guided-scan-resolved-shape.test.js):
      // whether THIS table's own scope contains the configured identity at
      // all, independent of whether it yielded any codes. rowCandidates
      // alone cannot answer this -- guidedScanGeometryStaffCandidatesForDate
      // returns [] both when identity is absent AND when identity is present
      // with zero geometry-detected codes (the exact case native row-strip
      // recovery exists for), so a gate built on rowCandidates.some(isIdentity)
      // would miss the second case entirely. A boolean only, never the
      // blocks themselves -- preserves the existing rule that another
      // table's content is never retained on the session (see geometryBlocks
      // below).
      identityPresentInTable: format === "personal" ? false : Boolean(guidedScanDateTableScope(dateCandidate, geometry.blocks).identity),
      });
    });
    guidedScanSession = {
      rawText: String(text || ""),
      lines,
      mode: "geometry",
      rosterFormat: format,
      resolvedLines,
      // Step 1 offers Date candidates only. The already-derived Staff
      // candidates for the confirmed table are copied across by
      // confirmGuidedScanDateRow -- they are not exposed here, so nothing
      // about another table's rows is visible before its own Date row is
      // confirmed.
      rowCandidates: [],
      dateCandidates,
      // Always empty: the whole-page blocks used to derive dateCandidates
      // above are never retained. See the comment above.
      geometryBlocks: [],
      automaticDrafts: [],
      // Preselection below is visual only. Both flags start false: the user
      // must explicitly confirm each row before anything can be staged.
      requiresConfirmation: true,
      dateRowConfirmed: false,
      staffRowConfirmed: false,
      // Personal mode's own, honestly-named completion flag (see
      // confirmGuidedScanPersonalDateContext) -- never aliased to
      // staffRowConfirmed, which would fake a Staff/name match Personal
      // never performs.
      personalContextConfirmed: false,
      personalDateContext: null,
      selectedRowIndex: -1,
      selectedDateIndex: geometry.preselectedDateIndex,
      warning: "",
    };
    return guidedScanSession;
  }
  // No geometry available (browser/self-test paths, or an image ML Kit
  // returned no boxes for). Text alone can never prove which table a staff
  // row belongs to -- a "nearest preceding header" line can just as easily
  // belong to an earlier table whose own row was already matched, while the
  // row's real header was cropped out of the photo entirely. That is
  // unwinnable from text alone, so photo OCR lacking trustworthy geometry is
  // never importable here: show whatever the automatic pass matched as a
  // read-only summary and ask for a rescan, exactly like the already-resolved
  // per-shift-line shape below. This applies even to a single, unambiguous
  // header+row shape -- the point is never inventing selectors the text
  // cannot support, not just refusing implausible ones.
  guidedScanSession = {
    rawText: String(text || ""),
    lines,
    mode: "resolved-summary",
    rosterFormat: format,
    resolvedLines,
    rowCandidates: [],
    dateCandidates: [],
    geometryBlocks: [],
    automaticDrafts: [],
    requiresConfirmation: false,
    dateRowConfirmed: false,
    staffRowConfirmed: false,
    personalContextConfirmed: false,
    personalDateContext: null,
    selectedRowIndex: -1,
    selectedDateIndex: -1,
    warning: "",
  };
  return guidedScanSession;
}

// Matches the confirmed row's shift codes to the confirmed date row's columns
// by X coordinate. Blank/skipped days simply have no token above them, so no
// later code is pulled left or right -- the failure mode of the old positional
// zip. Reuses mediaPipeScannerColumnAssignments so the tight/loose confidence
// bands, the collision handling and the unaligned reporting are identical to
// the automatic path.
// Generic, privacy-safe note only -- see guidedScanAmbiguousBoundaryBlocks.
// Never names the withheld token: a raw code sitting this close to the
// matched name is geometrically indistinguishable from a fragment of the
// name itself, so surfacing its text here would defeat the point of
// withholding it in the first place.
function guidedScanAmbiguousWithheldWarning(count) {
  return count + " entry next to your matched name could not be safely told apart from the name itself, so it was withheld to protect privacy. Rescan with clear spacing between the name and shift codes if a real shift is missing.";
}

// Two or more code blocks in the confirmed row can be genuinely centred on
// the SAME date column -- a real same-date multiple-entry conflict printed
// on the roster itself (e.g. two codes for one person on one day, one above
// the other across a named row and its continuation row -- see Slice C),
// not an assignment ambiguity to be resolved by picking a winner.
// mediaPipeScannerColumnAssignments lets exactly one block claim a column,
// which is correct when a second block's true home is a NEIGHBOURING column
// it was merely displaced from (see C10) -- but wrong here, where displacing
// (or dropping) either block would silently misdate or lose a real second
// shift.
//
// The threshold is a small, scale-relative fraction of column spacing with
// a small floor -- NOT the disproportionate max(15, spacing*0.2) this
// replaces, whose fixed 15px floor was 37.5% of a realistic 40px column grid
// and so also caught an ORDINARY displaced token (C10/C7b: a block can be
// confidently assigned to a column 5px away while a second, genuinely
// displaced block independently prefers that same column from 15-48px off)
// -- that is ordinary displacement, which must keep resolving as a
// displacement, not a fabricated same-date conflict on the wrong date.
//
// Distance alone is still not sufficient: a genuine same-date conflict is
// two SEPARATE PRINTED ROWS for one person on one date (Aug 26 in SD1 --
// a named row plus its continuation row), not two tokens sitting close
// together on the SAME row. Two same-row tokens aligned to one column are
// far more likely a compound code split into modifier fragments by OCR
// (e.g. "9V" + "HD", or "OC") than two independent shifts, and must be left
// to the ordinary column-assignment path unchanged -- so a same-column
// group is only ever treated as a conflict when its blocks provably come
// from at least two DIFFERENT member bands (memberBands, see Slice C).
function guidedScanGeometryBlockBandIndex(block, memberBands) {
  if (!Array.isArray(memberBands)) return -1;
  return memberBands.findIndex((band) => band && Array.isArray(band.blocks) && band.blocks.includes(block));
}

function guidedScanGeometrySameColumnConflicts(codeBlocks, columns, memberBands) {
  if (!columns.length) return { conflicts: [], remaining: codeBlocks };
  const orderedColumns = [...columns].sort((a, b) => a.x - b.x);
  const spacing = mediaPipeScannerMedian(orderedColumns.slice(1).map((column, index) => Math.abs(column.x - orderedColumns[index].x)).filter(Boolean));
  const conflictDistance = Math.max(6, spacing * 0.1);
  const byColumn = new Map();
  codeBlocks.forEach((block) => {
    const nearest = orderedColumns.slice().sort((a, b) => Math.abs(a.x - block.centerX) - Math.abs(b.x - block.centerX))[0];
    if (!nearest || Math.abs(nearest.x - block.centerX) > conflictDistance) return;
    if (!byColumn.has(nearest)) byColumn.set(nearest, []);
    byColumn.get(nearest).push(block);
  });
  const conflictBlocks = new Set();
  const conflicts = [];
  byColumn.forEach((blocksForColumn, column) => {
    if (blocksForColumn.length < 2) return;
    const bandIndices = new Set(blocksForColumn.map((block) => guidedScanGeometryBlockBandIndex(block, memberBands)));
    if (bandIndices.size < 2) return;
    blocksForColumn.forEach((block) => conflictBlocks.add(block));
    conflicts.push({ column, blocks: blocksForColumn });
  });
  const remaining = codeBlocks.filter((block) => !conflictBlocks.has(block));
  return { conflicts, remaining };
}

// A confirmed date header must account for every calendar day between its
// first and last printed column -- an OCR-dropped header digit anywhere in
// the middle (real-device evidence: the FreshRosterScanner gate's
// DATE_HEADER_NOT_CONSECUTIVE images) silently narrows the staged set to only
// the columns that happened to survive, with nothing left over to say a date
// is missing (see T5 above, which leaves a stray unaligned code behind only
// by fixture coincidence -- a real OCR drop can lose the header digit AND the
// code beneath it together, leaving no trace at all). CLAUDE.md requires
// failing closed on uncertain date alignment rather than pretending the scan
// worked, so this must block staging entirely, not just downgrade confidence.
//
// Deliberately scoped to monthResolvedLocally only: when the month could not
// be read, every draft already carries its own "confirm the date before
// importing" reason and stages unchecked (see below) -- a human must already
// verify every date by hand in that case, so the silent-truncation failure
// mode this guards against cannot occur there. It also avoids diffing across
// a rollover whose month resolution is itself unproven, which this is not
// equipped to call "backward" or "forward" with no safe mathematical/calendar
// footing to compare it against.
function guidedScanDateColumnsGapLabel(dateCandidate) {
  const columns = dateCandidate.columns || [];
  if (!dateCandidate.monthResolvedLocally || columns.length < 2) return null;
  for (let i = 1; i < columns.length; i += 1) {
    const previous = columns[i - 1];
    const current = columns[i];
    const dayDiff = Math.round(
      (Date.UTC(current.year, current.month, current.day) - Date.UTC(previous.year, previous.month, previous.day)) / 86400000
    );
    if (dayDiff !== 1) return guidedScanGeometryDateLabel([previous]) + " to " + guidedScanGeometryDateLabel([current]);
  }
  return null;
}

function buildGuidedScanGeometryDrafts(dateCandidate, rowCandidate) {
  const columns = dateCandidate.columns || [];
  const dateGapLabel = guidedScanDateColumnsGapLabel(dateCandidate);
  if (dateGapLabel) {
    guidedScanSession.warning = "This scan's date row looks incomplete: it skips from " + dateGapLabel
      + " with no column for the day(s) in between, so shifts on those dates may be missing from this scan."
      + " Rescan with the full date header clearly visible, then reconfirm the date row before staging shifts.";
    return [];
  }
  // Re-derive the gutter from the header band the user actually confirmed, so
  // the code/name split matches the grid in play rather than the page-wide one.
  const selectedGutterX = columns.length
    ? guidedScanGeometryGutterX(columns, rowCandidate.band ? rowCandidate.band.blocks : [])
    : rowCandidate.gutterX;
  const codeBlocks = guidedScanGeometryCodeBlocks(rowCandidate.band, selectedGutterX, rowCandidate.identityMembers);
  if (!columns.length || !codeBlocks.length) {
    if (!columns.length) {
      guidedScanSession.warning = "That date row has no readable dates. Choose another date row, or rescan with the date header fully visible.";
    } else if (rowCandidate.ambiguousWithheldCount) {
      // The only token detected in this row was withheld for privacy -- say
      // so specifically, rather than the generic "no readable shift codes"
      // message, so nothing about this row's zero drafts looks unexplained.
      guidedScanSession.warning = guidedScanAmbiguousWithheldWarning(rowCandidate.ambiguousWithheldCount);
    } else {
      guidedScanSession.warning = "That row has no readable shift codes. Choose another row, or rescan with your shifts fully visible.";
    }
    return [];
  }
  // Same-date multiple-entry conflicts (see guidedScanGeometrySameColumnConflicts)
  // are pulled out BEFORE column assignment: mediaPipeScannerColumnAssignments
  // lets only one block claim a column, which would silently misdate or drop
  // whichever entry loses that claim.
  const { conflicts, remaining } = guidedScanGeometrySameColumnConflicts(codeBlocks, columns, rowCandidate.memberBands);
  const { assignments, unaligned } = mediaPipeScannerColumnAssignments(remaining, columns);
  // Personal-only (see CLAUDE.md Personal/Team contract's "code geometry
  // overlapping/competing between columns" fail-closed requirement). Team
  // tolerates a displaced/ambiguous-margin code by staging it unchecked
  // under whichever column it got pushed onto -- acceptable there because a
  // human name-matched row already proves whose codes these are, and the
  // displaced flag keeps it visibly unconfirmed on that one row. A personal
  // grid has no such corroborating signal, and a displaced code's assigned
  // column is, by construction (see mediaPipeScannerColumnAssignments), NOT
  // the column nearest its printed position -- staging it would put a code
  // under a date it is not actually printed near. Fail the whole candidate
  // closed instead, exactly like the date-gap guard above, rather than
  // silently relocate it.
  if (rowCandidate.source === "personal-grid") {
    const personalColumnAmbiguityFloor = (item) => Math.max(12, (item.spacing || 0) * 0.25);
    const hasColumnCompetition = assignments.some((item) => item.displaced || item.margin < personalColumnAmbiguityFloor(item));
    if (hasColumnCompetition) {
      guidedScanSession.warning = "Two or more shift codes on this grid are too close together to tell which date column they belong to, so nothing from this row could be safely staged. Rescan with your codes clearly separated under each date.";
      return [];
    }
  }
  // Absolute distance to the assigned column is not sufficient evidence on its
  // own. A token can sit close to a column and still be a guess -- because it
  // was pushed there by a collision, or because the runner-up column is almost
  // exactly as close. Both cases become needs-review/unchecked.
  const ambiguityFloor = (item) => Math.max(12, (item.spacing || 0) * 0.25);
  let downgraded = 0;
  const drafts = assignments
    .map((item) => {
      const { block, column, confidence, displaced, margin } = item;
      const draft = scanRosterDraft(column.day, block.text, { month: column.month, year: column.year });
      // Which physical member band (see rowCandidate.memberBands, Slice C)
      // this code was printed on. Band 0 is always the named identity row
      // itself; any index >= 1 is an unlabelled continuation band, whose
      // ownership is ambiguous -- see guidedScanGeometryContinuationBands.
      // Tagging every draft here (never filtering here) keeps this function
      // a pure "everything this row could contribute" builder; the actual
      // Step 3 accept/reject gate is applied afterwards, at staging time
      // (confirmGuidedScanStaffRow / rebuildGuidedScanStagedDrafts).
      const bandIndex = guidedScanGeometryBlockBandIndex(block, rowCandidate.memberBands);
      draft.bandIndex = bandIndex === -1 ? 0 : bandIndex;
      const ambiguous = margin < ambiguityFloor(item);
      // Reasons accumulate: a token can be both displaced and sitting in a
      // header whose month could not be read, and the reviewer needs to see
      // every reason it was held back, not just the last one assigned.
      const reasons = [];
      if (displaced) reasons.push("This code was displaced from its nearest date column by a collision with another code.");
      if (ambiguous) reasons.push("This code sits almost midway between two date columns.");
      if (!displaced && !ambiguous && confidence === "low") reasons.push("Date alignment was not tight.");
      if (!dateCandidate.monthResolvedLocally) reasons.push("The month could not be read from the selected date row.");
      if (reasons.length) {
        draft.selected = false;
        draft.dateConfidence = "low";
        draft.reason = reasons.join(" ") + " Confirm the date before importing.";
        downgraded += 1;
      }
      return draft;
    });
  // Every block in a same-date conflict stages, side by side, never
  // auto-selected -- silently picking a winner (or dropping either one)
  // would misdate or lose a real second shift the roster itself printed.
  conflicts.forEach(({ column, blocks: conflictingBlocks }) => {
    conflictingBlocks.forEach((block) => {
      const draft = scanRosterDraft(column.day, block.text, { month: column.month, year: column.year });
      const bandIndex = guidedScanGeometryBlockBandIndex(block, rowCandidate.memberBands);
      draft.bandIndex = bandIndex === -1 ? 0 : bandIndex;
      const reasons = ["Another entry was also detected for this same date. Review both before importing."];
      if (!dateCandidate.monthResolvedLocally) reasons.push("The month could not be read from the selected date row.");
      draft.selected = false;
      draft.dateConfidence = "low";
      draft.reason = reasons.join(" ");
      downgraded += 1;
      drafts.push(draft);
    });
  });
  // Trusted native auto-row-strip recovered lines (see
  // guidedScanSession.trustedRowStripDrafts, set only for the
  // native-auto-row-strip-mlkit-success stage -- see
  // preferDirectScanRosterDrafts) are a recessive recovery source: the
  // native re-OCR pass already scoped itself to this row's own crop, so a
  // date/code it resolved that the raw text-block geometry above missed or
  // misread still belongs to the row the user just confirmed. Restricted to
  // dates this confirmed date row actually offers as columns, so nothing
  // outside this table can be pulled in. Never auto-selected: geometry
  // could not independently prove the alignment, so it stages unchecked --
  // visible for review, never silently dropped, exactly like any other
  // low-confidence match above.
  //
  // result.text carries no bounding-box/band provenance at all, so this
  // merge is only safe when the confirmed row has exactly ONE physical band
  // (rowCandidate.memberBands.length <= 1) -- i.e. no unlabelled
  // continuation band was found at all, so there is nowhere else a code
  // could belong. The moment a genuine continuation band exists, a
  // recovered-only code (one neither band's own geometry independently
  // found) cannot be attributed to either band without guessing, so it must
  // stay out of drafts/fullDrafts entirely rather than being unconditionally
  // tagged bandIndex 0 -- that would let it bypass the Step 3
  // accept/reject gate and stage as if it were proven identity-row
  // evidence. It remains visible in guidedScanSession.automaticDrafts as
  // informational context, so it is withheld, never invented or destroyed.
  // Table-ownership gate (see TO1 in tests/web/guided-scan-resolved-shape.test.js):
  // result.text carries no table/band provenance at all, only a date/code
  // pair, so when more than one table on the page independently offers the
  // configured identity as a row candidate, there is no way to tell which
  // table the native row-strip pass actually scoped its crop to. Matching
  // the confirmed table's own date columns is not ownership proof by
  // itself -- two genuinely separate tables can trivially share the same
  // date range. Fail closed by withholding the entire recessive merge
  // below rather than guessing; this never affects a scan where only one
  // table on the page offers the configured identity at all, which is the
  // overwhelmingly common real case and the one every other trusted-merge
  // test in this file already covers.
  const multipleTablesClaimIdentity = (guidedScanSession.dateCandidates || [])
    .filter((candidate) => candidate.identityPresentInTable)
    .length > 1;
  // Native table-capability gate: an unforgeable, in-memory, per-request
  // capability (see RosterMateBridge.recognizedTextBlocksJson /
  // runAutomaticRowStripOcr's mint) that must exactly match between the
  // row-strip recovery's own owning table (guidedScanSession.
  // trustedRowStripCapability, stamped in applyScanRosterOcrResult) and the
  // table the user actually confirmed here (dateCandidate.tableCapability,
  // inherited only when every block in its header band agreed -- see
  // guidedScanGeometryBandTableCapability). The request/generation this
  // capability was captured under must ALSO still be the one currently
  // active: a newer scan replaces guidedScanSession wholesale and so already
  // clears all three fields together, but this re-proves that invariant
  // rather than trusting it blindly, so a future code path that mutates
  // previewRequestId/previewGeneration without a full session replacement
  // cannot silently let a stale/superseded capability through. Missing
  // (either side null/undefined), malformed (already rejected to null at the
  // scanRosterPrivacySafeOcrResult choke point), wrong-table (equal strings
  // required, not merely both truthy), and stale/superseded (request or
  // generation mismatch) all collapse to the same withheld outcome as
  // multipleTablesClaimIdentity below -- a genuinely independent
  // defence-in-depth layer, not replaced or weakened by this gate.
  const rowStripAuthorized = Boolean(
    guidedScanSession.trustedRowStripCapability
    && dateCandidate.tableCapability
    && guidedScanSession.trustedRowStripCapability === dateCandidate.tableCapability
    && guidedScanSession.trustedRowStripRequestId === guidedScanSession.previewRequestId
    && guidedScanSession.trustedRowStripGeneration === guidedScanSession.previewGeneration
  );
  const memberBandCount = Array.isArray(rowCandidate.memberBands) ? rowCandidate.memberBands.length : 1;
  if (multipleTablesClaimIdentity) {
    // Withheld entirely -- see the gate comment above.
  } else if (!rowStripAuthorized) {
    // Withheld entirely -- see the rowStripAuthorized gate comment above.
  } else if (memberBandCount <= 1) {
    (guidedScanSession.trustedRowStripDrafts || []).forEach((trusted) => {
      const onThisHeader = columns.some((column) => column.day === trusted.day && column.month === trusted.month && column.year === trusted.year);
      if (!onThisHeader) return;
      const alreadyPresent = drafts.some((draft) => draft.day === trusted.day && draft.month === trusted.month && draft.year === trusted.year && draft.rawCode === trusted.rawCode);
      if (alreadyPresent) return;
      const draft = scanRosterDraft(trusted.day, trusted.rawCode, { month: trusted.month, year: trusted.year });
      draft.bandIndex = 0;
      draft.selected = false;
      draft.dateConfidence = "low";
      draft.reason = "Recovered from a higher-fidelity rescan of this row, not confirmed by row geometry. Confirm before importing.";
      drafts.push(draft);
    });
  } else if (guidedScanSession.rowStripProvenance && guidedScanSession.rowStripProvenance.bandCount === memberBandCount) {
    // Phase 3B: a genuine continuation band exists AND native's
    // rowStripProvenance unanimously proved which physical band each
    // row-strip-only code belongs to (see guidedScanNormalizeRowStripProvenance
    // / guidedScanRowStripProvenanceBandForCode). A mismatched bandCount means
    // no provenance-based merge at all -- see the mismatch guard above. Bound
    // strictly to trustedRowStripDrafts (this scan's own already-parsed
    // row-strip text), never to provenance line values directly, so this can
    // never invent a date or code outside what the row-strip pass itself
    // recovered. Still restricted to this confirmed date row's own columns,
    // still never a duplicate of an existing geometry draft, and still never
    // auto-selected -- the proven band is tagged, not trusted outright; Step 3
    // (confirmGuidedScanStaffRow / rebuildGuidedScanStagedDrafts) remains the
    // sole authority over whether anything above band 0 may stage.
    (guidedScanSession.trustedRowStripDrafts || []).forEach((trusted) => {
      const onThisHeader = columns.some((column) => column.day === trusted.day && column.month === trusted.month && column.year === trusted.year);
      if (!onThisHeader) return;
      const alreadyPresent = drafts.some((draft) => draft.day === trusted.day && draft.month === trusted.month && draft.year === trusted.year && draft.rawCode === trusted.rawCode);
      if (alreadyPresent) return;
      const provenBand = guidedScanRowStripProvenanceBandForCode(
        guidedScanSession.rowStripProvenance, trusted.day, trusted.month, trusted.rawCode,
        guidedScanSession.trustedRowStripDrafts || []
      );
      if (provenBand < 0) return;
      const draft = scanRosterDraft(trusted.day, trusted.rawCode, { month: trusted.month, year: trusted.year });
      draft.bandIndex = provenBand;
      draft.selected = false;
      draft.dateConfidence = "low";
      draft.reason = "Recovered from a higher-fidelity rescan of this row and matched to a proven physical row by native re-OCR evidence, not confirmed by row geometry. Confirm before importing.";
      drafts.push(draft);
    });
  }
  drafts.sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.day - b.day));
  lastScanRosterGeometryDiagnostics = {
    dateColumnsDetected: columns.length,
    // Personal's single "whole grid" candidate is honestly isIdentity: false
    // (see guidedScanPersonalGridRowCandidates) -- it is never a real name
    // match, so Boolean(rowCandidate.isIdentity) alone already reports that
    // correctly for both formats.
    identityFound: Boolean(rowCandidate.isIdentity),
    shiftTokensDetected: codeBlocks.length,
    alignedTokens: assignments.length + conflicts.reduce((sum, conflict) => sum + conflict.blocks.length, 0),
    lowConfidenceAligned: downgraded,
    displacedTokens: assignments.filter((item) => item.displaced).length,
    ambiguousTokens: assignments.filter((item) => item.margin < ambiguityFloor(item)).length,
    monthResolvedLocally: Boolean(dateCandidate.monthResolvedLocally),
    unalignedTokens: unaligned.length,
    finalDraftCount: drafts.length,
    guidedDateRowIndex: dateCandidate.index,
    guidedStaffRowIndex: rowCandidate.index,
    // Count only -- see guidedScanAmbiguousBoundaryBlocks. Never the raw
    // token text: this diagnostics object is user/log-facing.
    ambiguousBoundaryWithheldCount: rowCandidate.ambiguousWithheldCount || 0,
    // Count of DATES carrying a same-date multiple-entry conflict, not a raw
    // token count -- see guidedScanGeometrySameColumnConflicts.
    sameDateConflicts: conflicts.length,
  };
  // Never silently drop a shift token that was detected in the row the user
  // confirmed: if it cannot be placed under a date column with confidence,
  // say so and leave it unstaged rather than guessing a date for it.
  const warnings = [];
  if (unaligned.length) {
    // C62: count, not values. An unaligned token is by definition one the
    // geometry pass could not identify, so the set routinely holds a
    // neighbouring staff member's initials or an unresolved fragment of the
    // configured person's own name. The count is what stops a dropped shift
    // being silent; quoting the text adds nothing the user can act on.
    warnings.push(unaligned.length + " shift code(s) in the selected row could not be matched to a date column in the selected date row, so they were not staged."
      + " Check the date row selection, or rescan with the whole table visible.");
  }
  if (rowCandidate.ambiguousWithheldCount) {
    warnings.push(guidedScanAmbiguousWithheldWarning(rowCandidate.ambiguousWithheldCount));
  }
  if (warnings.length) guidedScanSession.warning = warnings.join(" ");
  return drafts;
}

// Shared permission check for Personal's whole-grid candidate, which is
// honestly isIdentity: false (see guidedScanPersonalGridRowCandidates) --
// Personal mode must never require OR SIMULATE a Staff/name match. It may
// still stage, but only when every one of Personal's own explicit steps is
// genuinely done: the session is really in Personal format, this candidate
// really is the personal-grid row, Date-row confirmation and the roster's
// own confirmed start month/year have both happened, and the index being
// authorized is the one the user actually confirmed -- never merely "a
// personal-grid row exists somewhere." Used by both buildGuidedScanDrafts
// and stageGuidedScanRowCandidate so neither can drift out of agreement with
// the other about what "authorized" means.
function guidedScanPersonalGridAuthorized(row, index) {
  return Boolean(row)
    && row.source === "personal-grid"
    && guidedScanSession.rosterFormat === "personal"
    && guidedScanSession.dateRowConfirmed
    && guidedScanSession.personalContextConfirmed
    && index === guidedScanSession.selectedRowIndex;
}

// Argument order follows the guided workflow: date row first, then staff row.
function buildGuidedScanDrafts(dateCandidateIndex = guidedScanSession.selectedDateIndex, rowCandidateIndex = guidedScanSession.selectedRowIndex) {
  const row = guidedScanSession.rowCandidates[rowCandidateIndex];
  const dateRow = guidedScanSession.dateCandidates[dateCandidateIndex];
  guidedScanSession.warning = "";
  // Belt and braces alongside confirmGuidedScanStaffRow's own guard: only the
  // configured identity row (Team) or an explicitly authorized personal-grid
  // row (Personal -- see guidedScanPersonalGridAuthorized) may ever
  // contribute drafts, however it was reached.
  if (!row || !dateRow || !(row.isIdentity || guidedScanPersonalGridAuthorized(row, rowCandidateIndex))) {
    guidedScanSession.warning = "Choose the date row and then your row before Review.";
    return [];
  }
  // Text-only sessions never populate rowCandidates/dateCandidates (see
  // prepareGuidedScanSession), so any row/dateRow that survives the guard
  // above is geometry-sourced -- geometry is the only path with proof of
  // table membership by physical position.
  return buildGuidedScanGeometryDrafts(dateRow, row);
}

// True while a scan offers real row choices that the user has not finished
// confirming. Nothing may be staged for Review or Import in that state.
function guidedScanAwaitingConfirmation() {
  // No photo-derived shape is ever exempt from this: a shape that cannot
  // offer a Date/Staff row to confirm (requiresConfirmation false) never
  // reaches "confirmed" either, so it stays permanently awaiting -- it must
  // never be treated as if there were nothing left to confirm. Personal
  // mode's own step is personalContextConfirmed, never staffRowConfirmed --
  // see confirmGuidedScanPersonalDateContext and guidedScanFlowComplete.
  return !guidedScanFlowComplete() || guidedScanPendingContinuationBandDecisions().length > 0;
}

// Format-aware "has the user finished every step this format actually has?"
// gate. Team's second step is Staff-row confirmation; Personal has no Staff
// step at all (see CLAUDE.md Personal/Team contract) and must never read
// staffRowConfirmed, which Personal deliberately never sets true.
function guidedScanFlowComplete() {
  return guidedScanSession.rosterFormat === "personal"
    ? guidedScanSession.dateRowConfirmed && guidedScanSession.personalContextConfirmed
    : guidedScanSession.dateRowConfirmed && guidedScanSession.staffRowConfirmed;
}

// Step 3. Every unlabelled continuation band folded into the confirmed
// staff row (see guidedScanGeometryContinuationBands) is ambiguous -- it may
// be the configured person's own overflow line, or a different, unnamed
// staff member's row. Each one needs its own explicit human decision, made
// against a visual crop of just that band (see guidedScanRequestContinuationBandPreview);
// none of them may be inferred from the others or defaulted to "accepted".
function guidedScanPendingContinuationBandDecisions() {
  return (guidedScanSession.continuationBandDecisions || []).filter((decision) => decision.status === "pending");
}

// Rebuilds the staged draft list from the full per-band draft set computed
// once at Step 2 confirmation (guidedScanSession.fullDrafts) plus whichever
// continuation bands have since been accepted. The identity band (index 0)
// is unconditionally included; every other band must appear in an
// "accepted" decision to contribute anything. Called after every Step 3
// decision so scanRosterDrafts always reflects exactly the currently
// accepted set -- never a stale union of everything ever seen.
function guidedScanCloudCheckEligible() {
  return isPremiumUnlocked()
    && Boolean(guidedScanCloudArtifact)
    && guidedScanCloudInFlightGeneration !== guidedScanCloudArtifact.cloudGeneration
    && guidedScanPendingContinuationBandDecisions().length === 0
    && guidedScanCloudTransportRuntime.available();
}

function renderGuidedScanCloudCheck() {
  const button = document.getElementById("scan-roster-cloud-check");
  const status = document.getElementById("scan-cloud-status");
  const eligible = guidedScanCloudCheckEligible();
  if (button) button.disabled = !eligible;
  if (status) {
    status.textContent = !isPremiumUnlocked()
      ? "Premium is required for the private cloud check."
      : (!guidedScanCloudArtifact
        ? "Complete the guided scan to prepare a masked image."
        : (!guidedScanCloudTransportRuntime.available()
          ? "Private cloud checking is not configured in this build."
          : (eligible ? "Ready to review the exact masked image before sending." : "Finish every row decision first.")));
  }
}

const openGuidedScanCloudConsent = () => {
  if (!guidedScanCloudCheckEligible()) return false;
  cancelGuidedScanCloudConsent();
  const artifact = guidedScanCloudArtifact;
  if (!guidedScanAiCompositeResult({ ok: true, dataUrl: artifact.imageDataUrl })) return false;
  const issuedAt = Date.now();
  guidedScanCloudConsent = Object.freeze({
    consentVersion: GUIDED_SCAN_CLOUD_CONSENT_VERSION,
    scanSessionId: artifact.scanSessionId,
    cloudGeneration: artifact.cloudGeneration,
    imageDataUrl: artifact.imageDataUrl,
    imageReady: false,
    issuedAt,
    expiresAt: issuedAt + GUIDED_SCAN_CLOUD_CONSENT_LIFETIME_MS,
  });
  const image = document.getElementById("cloud-ai-consent-image");
  const approve = document.getElementById("cloud-ai-consent-approve");
  if (approve) approve.disabled = true;
  if (image) {
    image.onload = () => {
      const consent = guidedScanCloudConsent;
      if (!consent || consent.imageDataUrl !== artifact.imageDataUrl || image.src !== artifact.imageDataUrl) return;
      guidedScanCloudConsent = Object.freeze({ ...consent, imageReady: true });
      if (approve) approve.disabled = false;
    };
    image.onerror = () => cancelGuidedScanCloudConsent();
    image.src = artifact.imageDataUrl;
  }
  const modal = document.getElementById("cloud-ai-consent-modal");
  if (modal) modal.classList.remove("hidden");
  const scheduledConsent = guidedScanCloudConsent;
  const scheduledTimer = setTimeout(() => {
    // A replaced consent owns a different timer. A stale callback must not
    // retire that newer timer or clear its artifact/preview state.
    if (guidedScanCloudConsentExpiryTimer !== scheduledTimer) return;
    guidedScanCloudConsentExpiryTimer = null;
    clearTimeout(scheduledTimer);
    const consent = guidedScanCloudConsent;
    // image.onload replaces the frozen consent object to record readiness, so
    // expiry is bound to immutable consent identifiers rather than identity.
    if (consent
      && consent.scanSessionId === scheduledConsent.scanSessionId
      && consent.cloudGeneration === scheduledConsent.cloudGeneration
      && consent.imageDataUrl === scheduledConsent.imageDataUrl
      && consent.issuedAt === scheduledConsent.issuedAt
      && guidedScanCloudArtifact === artifact) {
      clearGuidedScanCloudArtifact();
    }
  }, GUIDED_SCAN_CLOUD_CONSENT_LIFETIME_MS);
  guidedScanCloudConsentExpiryTimer = scheduledTimer;
  return true;
};

const cancelGuidedScanCloudConsent = () => {
  if (guidedScanCloudConsentExpiryTimer !== null) {
    clearTimeout(guidedScanCloudConsentExpiryTimer);
    guidedScanCloudConsentExpiryTimer = null;
  }
  guidedScanCloudConsent = null;
  const image = document.getElementById("cloud-ai-consent-image");
  if (image) {
    image.onload = null;
    image.onerror = null;
    if (typeof image.removeAttribute === "function") image.removeAttribute("src");
    image.src = "";
  }
  const approve = document.getElementById("cloud-ai-consent-approve");
  if (approve) approve.disabled = true;
  const modal = document.getElementById("cloud-ai-consent-modal");
  if (modal) modal.classList.add("hidden");
  return false;
};

function handleGuidedScanCloudVisibilityChange() {
  if (document.hidden && (guidedScanCloudConsent || guidedScanCloudArtifact)) clearGuidedScanCloudArtifact();
}

const GUIDED_SCAN_CLOUD_WARNING_CODES = new Set([
  "low-confidence",
  "possible-conflict",
  "partial-roster",
  "review-required",
]);

function guidedScanCloudCanonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : "";
}

function guidedScanOrdinaryArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length || value.length > maxLength) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[names.length - 1] !== "length") return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set || lengthDescriptor.value !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) return false;
  }
  return true;
}

function guidedScanPlainDataRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return Boolean(descriptor && !descriptor.get && !descriptor.set);
  });
}

function guidedScanCloudResponseStructuralSize(value) {
  let size = 0;
  const add = (part) => {
    if (typeof part === "string") size += part.length;
    else if (typeof part === "boolean" || typeof part === "number" || part === null) size += String(part).length;
    else return false;
    return size <= 16_384;
  };
  if (!add(value.ok) || !add(value.status)) return -1;
  for (const item of value.suggestedShifts) {
    if (!add(item.date) || !add(item.code) || !add(item.confidence)) return -1;
  }
  for (const warning of value.warnings) if (!add(warning)) return -1;
  return size;
}

function validateGuidedScanCloudResponse(value, artifact) {
  if (!guidedScanPlainDataRecord(value, ["ok", "status", "suggestedShifts", "warnings"])
    || value.ok !== true
    || !["ok", "ambiguous"].includes(value.status)
    || !guidedScanOrdinaryArray(value.suggestedShifts, 40)
    || !guidedScanOrdinaryArray(value.warnings, 20)
    || value.suggestedShifts.some((item) => !guidedScanPlainDataRecord(item, ["date", "code", "confidence"]))
    || guidedScanCloudResponseStructuralSize(value) < 0) return null;
  const baselineDates = new Set((artifact?.immutableOcrCandidates || []).map((candidate) => candidate.date));
  const seenPairs = new Set();
  const suggestedShifts = [];
  for (const item of value.suggestedShifts) {
    if (!guidedScanExactKeys(item, ["date", "code", "confidence"])) return null;
    const date = guidedScanCloudCanonicalDate(item.date);
    // Bound the provider's raw string before trim/canonicalisation. Otherwise
    // arbitrarily large punctuation padding normalises down to a tiny valid
    // token and bypasses the response-size invariant.
    if (typeof item.code !== "string" || item.code.length > 24) return null;
    const code = item.code.trim();
    if (!date || !baselineDates.has(date) || !code || !isLikelyRosterCodeToken(code)
      || !["high", "medium", "low"].includes(item.confidence)) return null;
    const pair = date + "\u0000" + canonicalScanRosterCode(code);
    if (seenPairs.has(pair)) return null;
    seenPairs.add(pair);
    suggestedShifts.push({ date, code, confidence: item.confidence });
  }
  if (value.warnings.some((warning) => typeof warning !== "string" || !GUIDED_SCAN_CLOUD_WARNING_CODES.has(warning))
    || new Set(value.warnings).size !== value.warnings.length) return null;
  return { ok: true, status: value.status, suggestedShifts, warnings: value.warnings.slice() };
}

function guidedScanCloudLocalWarnings(codes) {
  const copy = {
    "low-confidence": "Some private cloud suggestions had low confidence and require review.",
    "possible-conflict": "The private cloud check found a possible disagreement. Review both entries.",
    "partial-roster": "The private cloud check may cover only part of the confirmed roster grid.",
    "review-required": "Review every private cloud suggestion before importing.",
  };
  return codes.map((code) => copy[code]);
}

function applyGuidedScanCloudResponse(response, baselineDrafts) {
  const merged = mergeScanRosterAiReview(baselineDrafts, {
    suggestedShifts: response.suggestedShifts,
    warnings: guidedScanCloudLocalWarnings(response.warnings),
  });
  scanRosterDrafts = merged.items;
  scanRosterAiReview = {
    status: response.status,
    summary: "Private cloud check complete. Review all disagreements before importing.",
    providerLabel: "Private cloud roster check",
    isLive: false,
    warnings: merged.warnings,
    diagnostics: merged.diagnostics,
  };
  renderScanRosterReview();
  renderScanRosterAiReview();
  const status = document.getElementById("scan-cloud-status");
  if (status) status.textContent = "Private cloud check complete. Review the staged comparison before importing.";
  return response;
}

const approveGuidedScanCloudConsent = async () => {
  const consent = guidedScanCloudConsent;
  const artifact = guidedScanCloudArtifact;
  const baselineDrafts = Array.isArray(artifact?.immutableOcrBaseline)
    ? artifact.immutableOcrBaseline.map((draft) => guidedScanCloudImmutableCopy(draft)) : [];
  cancelGuidedScanCloudConsent();
  if (!consent || !artifact || !guidedScanCloudTransportRuntime.available()
    || !guidedScanCloudBaselineStillCurrent(artifact)
    || consent.imageReady !== true
    || consent.imageDataUrl !== artifact.imageDataUrl
    || !Number.isFinite(consent.issuedAt)
    || !Number.isFinite(consent.expiresAt)
    || consent.expiresAt - consent.issuedAt !== GUIDED_SCAN_CLOUD_CONSENT_LIFETIME_MS
    || Date.now() > consent.expiresAt
    || guidedScanCloudInFlightGeneration === artifact.cloudGeneration
    || consent.consentVersion !== GUIDED_SCAN_CLOUD_CONSENT_VERSION
    || consent.scanSessionId !== artifact.scanSessionId
    || consent.cloudGeneration !== artifact.cloudGeneration) return null;
  guidedScanCloudInFlightGeneration = artifact.cloudGeneration;
  const payload = {
    imageDataUrl: artifact.imageDataUrl,
    consentVersion: GUIDED_SCAN_CLOUD_CONSENT_VERSION,
    requestId: artifact.cloudGeneration,
  };
  if (artifact.immutableOcrCandidates.length) payload.ocrCandidates = artifact.immutableOcrCandidates.map((candidate) => ({ ...candidate }));
  try {
    const rawResult = await guidedScanCloudTransportRuntime.run(payload);
    if (guidedScanCloudArtifact !== artifact) return null;
    if (!guidedScanCloudBaselineStillCurrent(artifact)) {
      clearGuidedScanCloudArtifact();
      return null;
    }
    const result = validateGuidedScanCloudResponse(rawResult, artifact);
    clearGuidedScanCloudArtifact();
    if (!result) {
      const status = document.getElementById("scan-cloud-status");
      if (status) status.textContent = "Private cloud check could not be used. Your scanned shifts were not changed.";
      return null;
    }
    return applyGuidedScanCloudResponse(result, baselineDrafts);
  } catch (error) {
    if (guidedScanCloudArtifact === artifact) {
      clearGuidedScanCloudArtifact();
      const status = document.getElementById("scan-cloud-status");
      if (status) status.textContent = "Private cloud check failed. Your scanned shifts were not changed.";
    }
    return null;
  } finally {
    if (guidedScanCloudInFlightGeneration === artifact.cloudGeneration) guidedScanCloudInFlightGeneration = null;
  }
};

function clearGuidedScanCloudArtifact() {
  guidedScanCloudArtifact = null;
  cancelGuidedScanCloudConsent();
  renderGuidedScanCloudCheck();
}

function rebuildGuidedScanStagedDrafts() {
  clearGuidedScanCloudArtifact();
  const fullDrafts = guidedScanSession.fullDrafts || [];
  const selectedRow = guidedScanSession.rowCandidates[guidedScanSession.selectedRowIndex];
  // Personal-grid rows have no "unlabelled continuation row -- is this
  // really mine?" question to ask: every physical row below the header IS
  // the user's own grid by definition (see guidedScanPersonalGridRowCandidates),
  // so every bandIndex stages immediately rather than waiting on a Step 3
  // decision that confirmGuidedScanStaffRow deliberately never creates for
  // this source.
  if (selectedRow && selectedRow.source === "personal-grid") {
    scanRosterDrafts = fullDrafts;
    lastScanRosterImportSummary = null;
    scanRosterAiReview = null;
    return;
  }
  const acceptedBandIndices = new Set(
    (guidedScanSession.continuationBandDecisions || [])
      .filter((decision) => decision.status === "accepted")
      .map((decision) => decision.bandIndex)
  );
  scanRosterDrafts = fullDrafts.filter((draft) => draft.bandIndex === 0 || acceptedBandIndices.has(draft.bandIndex));
  lastScanRosterImportSummary = null;
  scanRosterAiReview = null;
}

// Gate 2 native bootstrap: requestId correlates a scan, but only the exact
// generation authorises manifest/read/release operations. Native may post this
// before its OCR result, so hold a bounded transient mapping until that result
// builds the matching guided session. Nothing here is persisted or logged.
function guidedScanOpaqueUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function handleGuidedScanPreviewBootstrap(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (Object.keys(payload).sort().join(",") !== "generation,requestId") return false;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  const generation = typeof payload.generation === "string" ? payload.generation : "";
  if (!requestId || !guidedScanOpaqueUuid(generation)) return false;
  if (guidedScanSession.previewRequestId === requestId) guidedScanSession.previewGeneration = generation;
  else {
    guidedScanPreviewBootstraps.clear();
    guidedScanPreviewBootstraps.set(requestId, generation);
  }
  return true;
}
window.handleGuidedScanPreviewBootstrap = handleGuidedScanPreviewBootstrap;

function guidedScanExactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function guidedScanParseBridgeJson(value) {
  try {
    return JSON.parse(typeof value === "string" ? value : "");
  } catch (error) {
    return null;
  }
}

function guidedScanImmutableOcrCandidates() {
  const candidates = [];
  for (const draft of scanRosterDrafts) {
    if (!draft || draft.source === "ai" || draft.dateUnresolved) continue;
    const year = Number(draft.year);
    const month = Number(draft.month);
    const day = Number(draft.day);
    const roundTrip = new Date(year, month, day);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
      || year < 2000 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31
      || roundTrip.getFullYear() !== year || roundTrip.getMonth() !== month || roundTrip.getDate() !== day) continue;
    const code = canonicalScanRosterCode(draft.rawCode);
    if (!code || code.length > 24 || !/^[A-Z0-9][A-Z0-9 :+./-]{0,23}$/.test(code)) continue;
    candidates.push(Object.freeze({ date: dateKey(day, year, month), code }));
    if (candidates.length >= 40) break;
  }
  return Object.freeze(candidates);
}

function guidedScanCloudImmutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(guidedScanCloudImmutableCopy));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  Object.keys(value).sort().forEach((key) => {
    if (value[key] !== undefined) copy[key] = guidedScanCloudImmutableCopy(value[key]);
  });
  return Object.freeze(copy);
}

function guidedScanCloudDraftProjection(draft) {
  const protectedForReview = Boolean(draft.dateUnresolved)
    || draft.dateConfidence === "low"
    || draft.selected === false
    || Boolean(draft.reason)
    || Boolean(draft.requiresConfirmation)
    || Boolean(draft.reviewState);
  const source = ["ocr", "both"].includes(draft.source) ? draft.source : "ocr";
  const status = draft.status === "ready" ? "ready" : "needs-review";
  const mappingSource = ["known", "mapped", "needs-review"].includes(draft.mappingSource)
    ? draft.mappingSource : "needs-review";
  const reviewState = ["ocr-review", "ocr-only", "agreed", "conflict"].includes(draft.reviewState)
    ? draft.reviewState : (protectedForReview ? "ocr-review" : "");
  const confidence = ["high", "medium", "low"].includes(draft.confidence) ? draft.confidence : undefined;
  const dateConfidence = ["high", "medium", "low"].includes(draft.dateConfidence) ? draft.dateConfidence : undefined;
  const shiftKey = typeof draft.shiftKey === "string" && /^(?:early|mid|afternoon|late|overnight|night|sick|annual|off|custom\d+)$/.test(draft.shiftKey)
    ? draft.shiftKey : "";
  return {
    day: Number.isInteger(draft.day) ? draft.day : 0,
    month: Number.isInteger(draft.month) ? draft.month : undefined,
    year: Number.isInteger(draft.year) ? draft.year : undefined,
    dateUnresolved: Boolean(draft.dateUnresolved),
    dateConfidence,
    rawCode: canonicalScanRosterCode(draft.rawCode).slice(0, 24),
    shiftKey,
    onCall: Boolean(draft.onCall),
    higherDuties: Boolean(draft.higherDuties),
    status,
    mappingSource,
    selected: draft.dateUnresolved ? false : Boolean(draft.selected),
    source,
    confidence,
    reason: protectedForReview ? "Review and confirm this scanned shift before importing." : "",
    requiresConfirmation: protectedForReview,
    reviewState,
  };
}

function guidedScanCloudReviewProjection(review) {
  if (!review || typeof review !== "object") return null;
  const diagnostics = review.diagnostics && typeof review.diagnostics === "object" ? review.diagnostics : {};
  const safeDiagnostics = {};
  ["ocrDraftCount", "aiSuggestedCount", "agreedCount", "aiOnlyCount", "ocrOnlyCount", "conflictCount", "warningCount"]
    .forEach((key) => {
      if (Number.isInteger(diagnostics[key]) && diagnostics[key] >= 0 && diagnostics[key] <= 1000) safeDiagnostics[key] = diagnostics[key];
    });
  return {
    status: ["ok", "ambiguous"].includes(review.status) ? review.status : "",
    isLive: Boolean(review.isLive),
    diagnostics: safeDiagnostics,
  };
}

function guidedScanCloudBaselineSnapshot() {
  const drafts = scanRosterDrafts
    .filter((draft) => draft && draft.source !== "ai")
    .map((draft) => guidedScanCloudDraftProjection(draft));
  const snapshot = guidedScanCloudImmutableCopy(drafts);
  const reviewSnapshot = guidedScanCloudImmutableCopy(guidedScanCloudReviewProjection(scanRosterAiReview));
  return Object.freeze({
    snapshot,
    reviewSnapshot,
    version: JSON.stringify({ drafts: snapshot, review: reviewSnapshot }),
  });
}

function guidedScanCloudBaselineArtifactFields() {
  const bound = guidedScanCloudBaselineSnapshot();
  return {
    immutableOcrBaseline: bound.snapshot,
    immutableReviewBaseline: bound.reviewSnapshot,
    ocrBaselineVersion: bound.version,
  };
}

function guidedScanCloudBaselineStillCurrent(artifact) {
  if (!artifact || !Array.isArray(artifact.immutableOcrBaseline)
    || typeof artifact.ocrBaselineVersion !== "string") return false;
  return guidedScanCloudBaselineSnapshot().version === artifact.ocrBaselineVersion;
}

function mintGuidedScanCloudGeneration() {
  guidedScanCloudGenerationSeq += 1;
  return "c" + Date.now() + "-" + guidedScanCloudGenerationSeq;
}

function guidedScanAiDescriptor(value, expectedGeneration) {
  if (!guidedScanExactKeys(value, ["ok", "manifestGeneration", "headerCapabilityId", "identityCapabilityId", "continuationCapabilityIds"])) return null;
  if (value.ok !== true || value.manifestGeneration !== expectedGeneration
    || !guidedScanOpaqueUuid(value.headerCapabilityId) || !guidedScanOpaqueUuid(value.identityCapabilityId)
    || !Array.isArray(value.continuationCapabilityIds) || value.continuationCapabilityIds.length > 6
    || value.continuationCapabilityIds.some((id) => !guidedScanOpaqueUuid(id))) return null;
  const ids = [value.headerCapabilityId, value.identityCapabilityId, ...value.continuationCapabilityIds];
  return new Set(ids).size === ids.length ? value : null;
}

function guidedScanAiCompositeResult(value) {
  if (!guidedScanExactKeys(value, ["ok", "dataUrl"]) || value.ok !== true || typeof value.dataUrl !== "string") return null;
  const dataUrl = value.dataUrl;
  const prefix = "data:image/jpeg;base64,";
  const encoded = dataUrl.slice(prefix.length);
  if (dataUrl.length > GUIDED_SCAN_CLOUD_MAX_DATA_URL_CHARS
    || !dataUrl.startsWith(prefix)
    || encoded.length < 8
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    || !encoded.startsWith("/9j/")) return null;
  return dataUrl;
}

function finalizeGuidedScanCloudArtifactAndRelease() {
  const requestId = guidedScanSession.previewRequestId;
  const generation = guidedScanSession.previewGeneration;
  const scanSessionId = guidedScanSession.scanSessionId || requestId;
  const bridge = androidBridge();
  const decisions = Array.isArray(guidedScanSession.continuationBandDecisions)
    ? guidedScanSession.continuationBandDecisions : [];
  // Pending Step 3 still needs the retained source for exact local previews.
  // Never enter the consuming/releasing path until every decision is terminal.
  if (decisions.some((decision) => !decision || decision.status === "pending")) return null;
  cancelGuidedScanCloudConsent();
  guidedScanCloudArtifact = null;
  try {
    if (!requestId || !guidedScanOpaqueUuid(generation) || !scanSessionId
      || !bridge || typeof bridge.getGuidedScanAiManifest !== "function"
      || typeof bridge.requestGuidedScanAiComposite !== "function") return null;
    const descriptor = guidedScanAiDescriptor(
      guidedScanParseBridgeJson(bridge.getGuidedScanAiManifest(requestId, generation)), generation
    );
    if (!descriptor || descriptor.continuationCapabilityIds.length !== decisions.length) return null;
    const acceptedContinuationIds = descriptor.continuationCapabilityIds.filter((id, index) => decisions[index].status === "accepted");
    const selection = {
      headerCapabilityId: descriptor.headerCapabilityId,
      identityCapabilityId: descriptor.identityCapabilityId,
      continuationCapabilityIds: acceptedContinuationIds,
    };
    const imageDataUrl = guidedScanAiCompositeResult(guidedScanParseBridgeJson(
      bridge.requestGuidedScanAiComposite(requestId, generation, JSON.stringify(selection))
    ));
    if (!imageDataUrl) return null;
    guidedScanCloudArtifact = Object.freeze({
      scanSessionId,
      cloudGeneration: mintGuidedScanCloudGeneration(),
      imageDataUrl,
      immutableOcrCandidates: guidedScanImmutableOcrCandidates(),
      ...guidedScanCloudBaselineArtifactFields(),
    });
    renderGuidedScanCloudCheck();
    return guidedScanCloudArtifact;
  } catch (error) {
    guidedScanCloudArtifact = null;
    return null;
  } finally {
    guidedScanSession.previewRequestId = null;
    guidedScanSession.previewGeneration = null;
    guidedScanSession.activePreview = null;
    releaseGuidedScanPreviewSourceRequest(requestId, generation);
  }
}

// Releases whatever native-side retained image source backs the current
// guided-scan session's Step 3 previews, and clears the local reference to
// it. Safe to call when nothing is retained (no bridge, no requestId, no
// support for the method) -- always a best-effort no-op in that case, never
// a thrown error. Must be called on every path that ends the need for that
// source: all bands decided, a new/superseded scan, Clear results/reset, or
// leaving the scanner -- see clearGuidedScanSession, the sole place session
// state is torn down, and rebuildGuidedScanStagedDrafts's callers.
function releaseGuidedScanPreviewSourceRequest(requestId, generation) {
  if (!requestId || !guidedScanOpaqueUuid(generation)) return;
  const bridge = androidBridge();
  if (!bridge || typeof bridge.releaseGuidedScanPreviewSource !== "function") return;
  try {
    bridge.releaseGuidedScanPreviewSource(requestId, generation);
  } catch (error) {
    // Best-effort only -- releasing a preview source must never surface as
    // a user-facing failure.
  }
}

function releaseGuidedScanPreviewSourceIfHeld() {
  const requestId = guidedScanSession.previewRequestId;
  const generation = guidedScanSession.previewGeneration;
  guidedScanSession.previewRequestId = null;
  guidedScanSession.previewGeneration = null;
  guidedScanSession.activePreview = null;
  releaseGuidedScanPreviewSourceRequest(requestId, generation);
}

function guidedScanExcludeUnavailableContinuationBand(bandIndex) {
  const decision = (guidedScanSession.continuationBandDecisions || []).find((entry) => entry.bandIndex === bandIndex);
  if (!decision || decision.status !== "pending") return;
  decision.status = "rejected";
  decision.unavailable = true;
  guidedScanSession.warning = "A visual preview for one ambiguous row could not be produced, so it was excluded for safety. Rescan to try again if it was really yours.";
  rebuildGuidedScanStagedDrafts();
  if (!guidedScanPendingContinuationBandDecisions().length) finalizeGuidedScanCloudArtifactAndRelease();
  renderGuidedScanChoices();
  renderScanRosterReview();
  renderScanRosterAiReview();
}

function guidedScanPreviewDescriptor(value, expectedGeneration, expectedContinuationCount) {
  if (!guidedScanExactKeys(value, ["ok", "generation", "identityCapabilityId", "continuationCapabilityIds"])
    || value.ok !== true || value.generation !== expectedGeneration
    || !guidedScanOpaqueUuid(value.identityCapabilityId)
    || !guidedScanOrdinaryArray(value.continuationCapabilityIds, 6)
    || value.continuationCapabilityIds.length !== expectedContinuationCount
    || value.continuationCapabilityIds.some((id) => !guidedScanOpaqueUuid(id))) return null;
  const ids = [value.identityCapabilityId, ...value.continuationCapabilityIds];
  return new Set(ids).size === ids.length ? value : null;
}

// Asks native to resolve one generation-bound opaque capability into a local
// Step-3 preview. Web code never submits crop geometry: native owns the proven
// full-row bounds and capability-to-band mapping.
function guidedScanRequestContinuationBandPreview(bandIndex) {
  const decisions = guidedScanSession.continuationBandDecisions || [];
  const decisionIndex = decisions.findIndex((entry) => entry.bandIndex === bandIndex);
  const decision = decisions[decisionIndex];
  if (!decision || decision.status !== "pending") return null;
  const requestId = guidedScanSession.previewRequestId;
  const generation = guidedScanSession.previewGeneration;
  const bridge = androidBridge();
  if (!requestId || !guidedScanOpaqueUuid(generation) || !bridge
    || typeof bridge.getGuidedScanPreviewManifest !== "function"
    || typeof bridge.requestGuidedScanBandPreviewByCapability !== "function") {
    guidedScanExcludeUnavailableContinuationBand(bandIndex);
    return null;
  }
  let parsed;
  try {
    const descriptor = guidedScanPreviewDescriptor(
      guidedScanParseBridgeJson(bridge.getGuidedScanPreviewManifest(requestId, generation)),
      generation,
      decisions.length
    );
    const capabilityId = descriptor && descriptor.continuationCapabilityIds[decisionIndex];
    parsed = capabilityId ? guidedScanParseBridgeJson(
      bridge.requestGuidedScanBandPreviewByCapability(requestId, generation, capabilityId)
    ) : null;
  } catch (error) {
    parsed = null;
  }
  const previewDataUrl = parsed && typeof parsed.dataUrl === "string" ? parsed.dataUrl : "";
  const isBoundedJpegDataUrl = previewDataUrl.length > "data:image/jpeg;base64,".length
    && previewDataUrl.length <= 2_000_000
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(previewDataUrl);
  if (!parsed || !parsed.ok || !isBoundedJpegDataUrl) {
    guidedScanExcludeUnavailableContinuationBand(bandIndex);
    return null;
  }
  guidedScanSession.activePreview = { bandIndex, dataUrl: previewDataUrl };
  renderGuidedScanChoices();
  return previewDataUrl;
}

// The user's explicit answer to "is this extra row really yours?" for one
// specific continuation band. Never inferred from another band's decision --
// each call resolves exactly the one bandIndex given. A stale bandIndex
// (from a superseded/reset session -- see beginScanRosterRequest ->
// clearGuidedScanSession) simply finds no matching pending decision and is a
// safe no-op, never a throw and never a mutation of the current session.
function guidedScanResolveContinuationBand(bandIndex, accepted) {
  const decision = (guidedScanSession.continuationBandDecisions || []).find((entry) => entry.bandIndex === bandIndex);
  if (!decision || decision.status !== "pending") return scanRosterDrafts;
  decision.status = accepted ? "accepted" : "rejected";
  rebuildGuidedScanStagedDrafts();
  if (!guidedScanPendingContinuationBandDecisions().length) finalizeGuidedScanCloudArtifactAndRelease();
  else guidedScanSession.activePreview = null;
  renderGuidedScanChoices();
  renderScanRosterReview();
  renderScanRosterAiReview();
  showToast(accepted
    ? "That extra row was included in Review."
    : "That extra row was excluded from Review.", accepted ? "success" : "info");
  return scanRosterDrafts;
}

function clearGuidedScanStagedDrafts() {
  scanRosterDrafts = [];
  lastScanRosterImportSummary = null;
  scanRosterAiReview = null;
}

// Step 1. Confirming a date row never stages anything: it only fixes the date
// grid the staff row will be read against. Confirming a *different* date row
// invalidates any staff confirmation made against the previous grid, so the
// user has to name their row again for the new dates.
function confirmGuidedScanDateRow(dateCandidateIndex) {
  const index = Number(dateCandidateIndex);
  const dateCandidate = guidedScanSession.dateCandidates[index];
  if (!dateCandidate) return [];
  guidedScanSession.selectedDateIndex = index;
  guidedScanSession.dateRowConfirmed = true;
  guidedScanSession.staffRowConfirmed = false;
  guidedScanSession.selectedRowIndex = -1;
  guidedScanSession.warning = "";
  // Staff candidates only exist for the table the user just confirmed -- a
  // different table's rows (different header, different gutter, different
  // month) are never valid choices here. They were already derived, once,
  // for every table by prepareGuidedScanSession (see there) -- this just
  // exposes the confirmed table's own precomputed set; it never needs the
  // whole page's blocks again. Text-mode sessions have no per-table concept,
  // so their rowCandidates (built once from the whole text at
  // prepareGuidedScanSession time) are left as-is.
  if (guidedScanSession.mode === "geometry") {
    const rowCandidates = dateCandidate.rowCandidates || [];
    guidedScanSession.rowCandidates = rowCandidates;
    // Personal's whole-grid candidate is honestly isIdentity: false (see
    // guidedScanPersonalGridRowCandidates), so it must be matched on its own
    // source tag here too -- isIdentity alone would never find it, leaving
    // Personal's selectedRowIndex stuck at -1 and the start-month/year step
    // below (which keys off selectedRowIndex === 0) never reached.
    const identityCandidate = rowCandidates.find((candidate) => candidate.isIdentity || candidate.source === "personal-grid");
    guidedScanSession.selectedRowIndex = identityCandidate ? identityCandidate.index : -1;
    if (!rowCandidates.length) {
      guidedScanSession.warning = guidedScanSession.rosterFormat === "personal"
        ? "No readable grid rows could be matched under this date row -- this may be a team roster rather than a personal grid. Rescan your own electronic roster, or switch Roster format to Team."
        : "No staff rows could be found in this date row's table. Choose another date row, or rescan with your row fully visible.";
    }
    // Personal mode has no Staff step to confirm -- the one "whole grid"
    // candidate above IS the row, so Date confirmation does NOT stage
    // straight to Review (contract: Personal flow is Date -> [confirm the
    // roster's own start month/year] -> Review, never Date -> Staff ->
    // Review, and never a Date->Review skip either -- see
    // confirmGuidedScanPersonalDateContext). staffRowConfirmed is
    // deliberately left false here and never set true for Personal: it
    // would otherwise fake a Staff/name match this path never performs.
    // guidedScanFlowComplete() is the format-aware gate that actually
    // decides whether Review may show staged drafts.
    if (guidedScanSession.rosterFormat === "personal" && guidedScanSession.selectedRowIndex === 0) {
      guidedScanSession.personalContextConfirmed = false;
      guidedScanSession.personalDateContext = null;
      guidedScanSession.warning = "Confirm the roster's starting month and year before staging shifts -- Personal grids have no printed year to read automatically.";
      clearGuidedScanStagedDrafts();
      renderGuidedScanChoices();
      renderScanRosterReview();
      renderScanRosterAiReview();
      showToast("Date row confirmed. Confirm the roster's starting month and year to continue.", "success");
      return scanRosterDrafts;
    }
  }
  clearGuidedScanStagedDrafts();
  renderGuidedScanChoices();
  renderScanRosterReview();
  renderScanRosterAiReview();
  showToast("Date row confirmed. Now confirm your row.", "success");
  return scanRosterDrafts;
}

// Personal-only. Resolves the confirmed date header's own validated
// weekday/day-number pairs (see guidedScanPersonalGridHeaderWeekdayPairs)
// into absolute calendar dates anchored at the user-confirmed start
// month/year, never at scan time or today's date. Column 0's date is
// (year, month, pairs[0].day); every later column is exactly one calendar
// day later, which both resolves any Dec->Jan-style year rollover via plain
// Date arithmetic and re-proves the weekday row actually matches a real
// calendar for that confirmed year -- a header that is internally
// consistent (see guidedScanPersonalGridHeaderWeekdayPairs) can still
// conflict with a WRONG confirmed year (the same day-of-week pattern does
// not repeat every year). Returns an ordered array of real Date objects, or
// null if the confirmed start day is impossible for that month (e.g. day 31
// confirmed against a 30-day month) or if any column's weekday disagrees
// with the confirmed calendar -- both fail closed rather than guessing.
function guidedScanPersonalGridResolveDatesAgainstContext(weekdayPairs, month, year) {
  if (!Array.isArray(weekdayPairs) || !weekdayPairs.length) return null;
  const start = new Date(Date.UTC(year, month, weekdayPairs[0].day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month) return null;
  const resolvedDates = weekdayPairs.map((pair, index) => mediaPipeScannerAddDays(start, index));
  const weekdayMismatch = resolvedDates.some((date, index) => date.getUTCDay() !== weekdayPairs[index].weekdayIndex);
  if (weekdayMismatch) return null;
  return resolvedDates;
}

// Step 2 for Personal mode only (replaces Team's Staff step -- see
// confirmGuidedScanStaffRow). Never sets staffRowConfirmed/isIdentity-style
// flags: guidedScanSession.personalContextConfirmed is its own, honestly
// named completion flag, read by guidedScanFlowComplete() wherever Team
// would otherwise have read staffRowConfirmed. month is 0-indexed (matches
// every other month field already used throughout this file).
function confirmGuidedScanPersonalDateContext(month, year) {
  if (guidedScanSession.rosterFormat !== "personal" || !guidedScanSession.dateRowConfirmed) return scanRosterDrafts;
  const dateCandidate = guidedScanSession.dateCandidates[guidedScanSession.selectedDateIndex];
  const rowCandidate = guidedScanSession.rowCandidates[0];
  const monthNum = Number(month);
  const yearNum = Number(year);
  const validInput = Number.isInteger(monthNum) && monthNum >= 0 && monthNum <= 11 && Number.isInteger(yearNum) && yearNum >= 1970 && yearNum <= 9999;
  const resolvedDates = validInput && dateCandidate && rowCandidate && rowCandidate.source === "personal-grid"
    ? guidedScanPersonalGridResolveDatesAgainstContext(dateCandidate.personalWeekdayPairs, monthNum, yearNum)
    : null;
  if (!resolvedDates) {
    guidedScanSession.personalContextConfirmed = false;
    guidedScanSession.personalDateContext = null;
    guidedScanSession.warning = !validInput
      ? "Enter a valid roster start month and year before staging shifts."
      : "That month/year doesn't match this roster's own day-of-week header. Check the month and year, or rescan.";
    clearGuidedScanStagedDrafts();
    renderGuidedScanChoices();
    renderScanRosterReview();
    renderScanRosterAiReview();
    showToast(guidedScanSession.warning, "warning");
    return scanRosterDrafts;
  }
  // The confirmed context is now genuinely proven (by explicit user
  // confirmation, re-checked against the header's own weekday row above) --
  // overwrite this candidate's columns with the resolved absolute dates so
  // every downstream reader (buildGuidedScanGeometryDrafts, the date-gap
  // check, Review rendering) sees real, confirmed dates. x stays unchanged:
  // it is the column's on-page position, not derived from date context.
  dateCandidate.columns = dateCandidate.columns.map((column, index) => ({
    x: column.x,
    day: resolvedDates[index].getUTCDate(),
    month: resolvedDates[index].getUTCMonth(),
    year: resolvedDates[index].getUTCFullYear(),
  }));
  dateCandidate.monthResolvedLocally = true;
  // dates/line are read-only display fields (Step 1's own button label and
  // the JSON summary) -- keep them in sync with the just-confirmed columns
  // so re-rendering Step 1 after confirmation never shows the pre-
  // confirmation guess (possibly month: null) instead of the real dates.
  dateCandidate.dates = dateCandidate.columns.map((column) => ({ day: column.day, month: column.month, year: column.year }));
  dateCandidate.line = guidedScanGeometryDateLabel(dateCandidate.columns);
  guidedScanSession.personalContextConfirmed = true;
  guidedScanSession.personalDateContext = { month: monthNum, year: yearNum };
  guidedScanSession.selectedRowIndex = 0;
  guidedScanSession.warning = "";
  clearGuidedScanStagedDrafts();
  // stageGuidedScanRowCandidate renders Review and shows its own toast
  // (staged count, or its own warning) -- the same shared staging core Team
  // uses, so no separate toast/render is added here.
  return stageGuidedScanRowCandidate(0);
}

// Step 2. Inert until the date row is confirmed, so the sequence can only run
// date-first. This is an explicit per-scan override and never touches
// scanRosterIdentity -- picking a different row for one photo must not change
// the saved roster identity.
function confirmGuidedScanStaffRow(rowCandidateIndex) {
  const index = Number(rowCandidateIndex);
  if (!guidedScanSession.dateRowConfirmed) {
    guidedScanSession.warning = "Confirm the date row first, then choose your row.";
    clearGuidedScanStagedDrafts();
    renderGuidedScanChoices();
    renderScanRosterReview();
    showToast("Confirm the date row first.", "warning");
    return scanRosterDrafts;
  }
  // Belt and braces on top of guidedScanGeometryStaffCandidatesForDate only
  // ever building an identity candidate: even if some future caller placed a
  // non-identity entry into rowCandidates, it must still never become
  // selectable here. Personal's own whole-grid candidate is honestly
  // isIdentity: false (see guidedScanPersonalGridRowCandidates), so this
  // check alone should already exclude it.
  if (!guidedScanSession.rowCandidates[index] || !guidedScanSession.rowCandidates[index].isIdentity) return [];
  // This is Team's Staff-row confirmation specifically. Kept as an explicit,
  // named belt-and-braces guard independent of the isIdentity check above --
  // it must remain impossible for this to become a side door into staging
  // for Personal (bypassing the required date-context confirmation and
  // faking staffRowConfirmed) even if isIdentity's meaning ever changes
  // again. Personal must only ever stage through
  // confirmGuidedScanPersonalDateContext.
  if (guidedScanSession.rowCandidates[index].source === "personal-grid") return scanRosterDrafts;
  guidedScanSession.selectedRowIndex = index;
  guidedScanSession.staffRowConfirmed = true;
  clearGuidedScanStagedDrafts();
  return stageGuidedScanRowCandidate(index);
}

// Shared staging core for BOTH Team's Staff-row confirmation
// (confirmGuidedScanStaffRow) and Personal's date-context confirmation
// (confirmGuidedScanPersonalDateContext). Deliberately contains no
// staffRowConfirmed/isIdentity-style assignment of its own -- each caller
// sets whichever completion flag is honestly its own BEFORE calling this,
// so this core can never be the place that fakes either contract.
function stageGuidedScanRowCandidate(index) {
  const row = guidedScanSession.rowCandidates[index];
  // Fail closed immediately for an unauthorized personal-grid row, rather
  // than relying solely on buildGuidedScanDrafts below to notice: this is
  // the single shared staging core both formats funnel through, so it must
  // never stage a personal-grid row reached some way other than Personal's
  // own fully-confirmed path (see guidedScanPersonalGridAuthorized). Team
  // rows (row.source !== "personal-grid") are never affected by this check.
  if (row && row.source === "personal-grid" && !guidedScanPersonalGridAuthorized(row, index)) {
    guidedScanSession.fullDrafts = [];
    guidedScanSession.continuationBandDecisions = [];
    guidedScanSession.warning = "Choose the date row and then your row before Review.";
    scanRosterDrafts = [];
    lastScanRosterImportSummary = null;
    scanRosterAiReview = null;
    renderGuidedScanChoices();
    renderScanRosterReview();
    renderScanRosterAiReview();
    showToast(guidedScanSession.warning, "warning");
    return scanRosterDrafts;
  }
  // The full "everything this row could contribute" set, tagged per band
  // (see buildGuidedScanGeometryDrafts). Kept on the session so every Step 3
  // decision can cheaply rebuild scanRosterDrafts without re-running the
  // whole geometry pass -- see rebuildGuidedScanStagedDrafts.
  guidedScanSession.fullDrafts = buildGuidedScanDrafts(guidedScanSession.selectedDateIndex, guidedScanSession.selectedRowIndex);
  // Step 3: one pending decision per unlabelled continuation band folded
  // into this composite row (memberBands[0] is always the named identity
  // band itself and needs no decision). A row with no continuation bands at
  // all produces zero decisions, so the gate below clears immediately and
  // the pre-Step-3 happy path is unaffected. Personal-grid candidates reuse
  // memberBands to tell physical rows apart for same-date conflict detection
  // (see guidedScanPersonalGridRowCandidates), not to mean "unlabelled
  // continuation row needing a yes/no decision" -- every row in a personal
  // grid is unambiguously the user's own, so that concept never applies here.
  const continuationBandCount = row && row.source !== "personal-grid" && Array.isArray(row.memberBands) ? row.memberBands.length - 1 : 0;
  guidedScanSession.continuationBandDecisions = [];
  for (let bandIndex = 1; bandIndex <= continuationBandCount; bandIndex += 1) {
    guidedScanSession.continuationBandDecisions.push({ bandIndex, status: "pending" });
  }
  rebuildGuidedScanStagedDrafts();
  if (!continuationBandCount) finalizeGuidedScanCloudArtifactAndRelease();
  renderGuidedScanChoices();
  renderScanRosterReview();
  renderScanRosterAiReview();
  if (continuationBandCount) {
    showToast(continuationBandCount + " extra ambiguous row(s) need your visual confirmation before they can be staged — see Step 3.", "warning");
  } else if (scanRosterDrafts.length) {
    showToast("Guided scan staged " + scanRosterDrafts.length + " shifts for Review." + (guidedScanSession.warning ? " Some codes need attention — see Step 1." : ""), guidedScanSession.warning ? "warning" : "success");
  } else {
    showToast(guidedScanSession.warning || "No shifts could be matched from that row and date row.", "warning");
  }
  return scanRosterDrafts;
}

// Confirms both steps in the guided order. Kept as the single entry point for
// tests and fixtures; the UI drives the two steps separately.
function stageGuidedScanDrafts(dateCandidateIndex, rowCandidateIndex) {
  confirmGuidedScanDateRow(dateCandidateIndex);
  return confirmGuidedScanStaffRow(rowCandidateIndex);
}

function mediaPipeScannerBlockBox(block) {
  const box = block && (block.boundingBox || block.box || block.frame);
  if (!box) return null;
  const x = Number(box.x ?? box.left ?? 0);
  const y = Number(box.y ?? box.top ?? 0);
  const width = Number(box.width ?? ((box.right ?? x) - x));
  const height = Number(box.height ?? ((box.bottom ?? y) - y));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

// tableCapability (see RosterMateBridge.recognizedTextBlocksJson) is carried
// through onto the normalised shape, never computed or guessed here -- a
// malformed value (not a real, bounded string) is treated as absent rather
// than coerced, so a block can never acquire a capability this layer itself
// invented. guidedScanGeometryCandidates is the only reader: it requires
// every block in a consolidated date band to carry the identical value
// before that candidate inherits it (see its own comment).
function mediaPipeScannerNormalisedBlockCapability(block) {
  const value = block && block.tableCapability;
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function mediaPipeScannerNormalisedBlocks(textBlocks = []) {
  return (Array.isArray(textBlocks) ? textBlocks : [])
    .map((block) => {
      const box = mediaPipeScannerBlockBox(block);
      const text = String(block?.text || "").trim();
      if (!box || !text) return null;
      return { text, boundingBox: box, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2, tableCapability: mediaPipeScannerNormalisedBlockCapability(block) };
    })
    .filter(Boolean)
    .sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX);
}

// A roster date-range header describes one printed table/page, never
// spans a year -- 366 days covers any single leap year in full and is a
// deliberately generous upper bound, not a measured product limit.
const MEDIAPIPE_SCANNER_MAX_DATE_RANGE_SPAN_DAYS = 366;

// JS Date silently rolls an impossible day/month over into the next real
// date (e.g. 31/02/2026 -> 3 March 2026) instead of rejecting it, so every
// parsed endpoint must round-trip back to the exact day/month/year it was
// parsed from before the range can be trusted. If ANY matched endpoint fails
// that round trip, the whole range is unusable -- reject it entirely rather
// than silently use a normalised, invented date within it, and never let it
// grant local month confidence to the caller.
//
// A single literal match is an unambiguous degenerate range (start===end) --
// there is only one date printed, nothing to compare it against. TWO matches
// are only trustworthy as a range if they are forward (end truly after
// start, never reversed or identical -- a repeated endpoint is exactly as
// likely to be an OCR duplicate/misread as a genuine one-day range, so it is
// rejected rather than guessed at) and within a plausible span.
function mediaPipeScannerDateRange(blocks) {
  const matches = blocks.map((block) => block.text).join(" ").match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || [];
  if (!matches.length) return null;
  const dates = matches.map((text) => {
    const parts = text.split("/").map(Number);
    const [day, month, year] = parts;
    const date = new Date(Date.UTC(year, month - 1, day));
    const roundTrips = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return roundTrips ? date : null;
  });
  if (dates.some((date) => date === null)) return null;
  const start = dates[0];
  const end = dates.length > 1 ? dates[1] : dates[0];
  if (dates.length > 1) {
    if (end.getTime() <= start.getTime()) return null;
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000);
    if (spanDays > MEDIAPIPE_SCANNER_MAX_DATE_RANGE_SPAN_DAYS) return null;
  }
  return { start, end };
}

function mediaPipeScannerDayNumber(text) {
  const cleaned = String(text || "").trim();
  if (!/^\d{1,2}$/.test(cleaned)) return null;
  const day = Number(cleaned);
  return day >= 1 && day <= 31 ? day : null;
}

function mediaPipeScannerHeaderY(blocks, identity) {
  // A real photographed multi-page roster can show the tail of a *different*
  // page's table still in the same frame above the current one (confirmed
  // on-device). Averaging every month/day-number-shaped block's Y across the
  // whole image pulls the header estimate toward a meaningless midpoint
  // between two unrelated tables. When we know where the configured person's
  // row is, prefer the nearest qualifying date-row band above it instead of
  // an average over the entire page.
  if (identity) {
    const rows = mediaPipeScannerRowBands(blocks);
    const qualifying = rows
      .filter((row) => row.y < identity.centerY)
      .filter((row) => row.blocks.filter((block) => mediaPipeScannerDayNumber(block.text) !== null).length >= 2 || row.blocks.some((block) => scanRosterMonthIndex(block.text) >= 0))
      .sort((a, b) => Math.abs(a.y - identity.centerY) - Math.abs(b.y - identity.centerY));
    if (qualifying.length) return qualifying[0].y;
  }
  const months = blocks.filter((block) => scanRosterMonthIndex(block.text) >= 0);
  if (months.length) return months.reduce((sum, block) => sum + block.centerY, 0) / months.length;
  const days = blocks.filter((block) => mediaPipeScannerDayNumber(block.text) !== null).slice(0, 24);
  return days.length ? days.reduce((sum, block) => sum + block.centerY, 0) / days.length : 0;
}

function mediaPipeScannerAddDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function mediaPipeScannerDateFromRange(day, previous, range) {
  if (!range) return null;
  const span = Math.max(0, Math.round((range.end.getTime() - range.start.getTime()) / 86400000));
  for (let offset = 0; offset <= span; offset += 1) {
    const candidate = mediaPipeScannerAddDays(range.start, offset);
    if (candidate.getUTCDate() === day && (!previous || candidate > previous)) return candidate;
  }
  return null;
}

// Resolves a set of already-chosen day-number blocks into dated columns.
// Split out of mediaPipeScannerDateColumns so the guided picker can reuse the
// exact same month/year resolution against a header band the *user* confirmed,
// instead of one this code guessed at via mediaPipeScannerHeaderY.
//
// allowCurrentMonthFallback distinguishes the two callers' genuinely
// different correct behaviour when NO local month word or range exists at
// all: the automatic pipeline (mediaPipeScannerDateColumns, the default)
// has an established, regression-tested layout it must keep resolving this
// way -- a day-of-week-plus-day-number header (Mon/Tue above 14/15, no month
// word printed anywhere) that legitimately relies on the app's current month
// as context (see tests/fixtures/rosters/day-of-week-plus-day-number-header).
// The guided picker (which passes false) instead lets the user pick ANY
// band on the page as a Date candidate, including one that only looks like a
// header because of coincidental OCR number fragments -- inheriting
// currentMonth there is exactly how a false candidate built from unrelated
// fragments (see guidedScanGeometryIsDateBand) turned into fabricated dates
// in a completely different, unrelated month on a real photographed roster.
// Splits an ordered (by centerX) run of day-number blocks into calendar
// segments at the same 31->1-style transitions guidedScanGeometryIsDateBand
// already treats as a plausible rollover (previous day >= 28, next day <= 3).
// A month word sitting nearest-left of one individual day (the old
// per-day rule below) cannot tell a genuine post-rollover date apart from a
// pre-rollover one -- only the day SEQUENCE can, which is exactly what a
// segment boundary encodes.
function mediaPipeScannerCalendarSegments(orderedDayBlocks) {
  const segments = [];
  let current = [];
  let previousDay = null;
  orderedDayBlocks.forEach((block) => {
    const day = mediaPipeScannerDayNumber(block.text);
    if (previousDay !== null && day <= 3 && previousDay >= 28) {
      segments.push(current);
      current = [];
    }
    current.push(block);
    previousDay = day;
  });
  if (current.length) segments.push(current);
  return segments;
}

// Given calendar segments (mediaPipeScannerCalendarSegments) and the month
// words found in this table's local scope, resolves {month, year} per
// segment or leaves it null when no anchor can be trusted. Only ever called
// with 2+ segments (a single segment has no rollover to reason about, so the
// caller keeps the original nearest-left behaviour for it unchanged).
function mediaPipeScannerResolveSegmentMonths(segments, monthBlocks) {
  const results = new Array(segments.length).fill(null);
  const monthIndexOf = (block) => scanRosterMonthIndex(block.text);
  const spans = segments.map((segment) => ({
    minX: Math.min(...segment.map((block) => block.centerX)),
    maxX: Math.max(...segment.map((block) => block.centerX)),
  }));

  const step = (base, delta) => {
    let month = base.month + delta;
    let year = base.year;
    while (month > 11) { month -= 12; year += 1; }
    while (month < 0) { month += 12; year -= 1; }
    return { month, year };
  };
  const applyFromAnchor = (anchorSegmentIndex, anchorMonth, anchorYear) => {
    for (let i = 0; i < segments.length; i += 1) {
      results[i] = step({ month: anchorMonth, year: anchorYear }, i - anchorSegmentIndex);
    }
  };

  // Strategy 1: the month words found, read in on-page left-to-right order,
  // exactly match the number of segments AND form a valid chronological
  // sequence (a segment boundary IS a rollover, so consecutive segments are
  // always consecutive calendar months) -- map them in reading order rather
  // than letting the rightmost word win for every day.
  if (monthBlocks.length === segments.length) {
    const indices = monthBlocks.map(monthIndexOf);
    const validSequence = indices.every((idx) => idx >= 0)
      && indices.every((idx, i) => i === 0 || idx === (indices[i - 1] + 1) % 12);
    if (!validSequence) return results; // contradictory -- fail closed, never guess
    applyFromAnchor(0, indices[0], scanRosterYearForExplicitMonth(indices[0]));
    return results;
  }

  // Strategy 2: exactly one trustworthy month word anywhere in scope. Decide
  // which segment it anchors by spatial position, then propagate both
  // directions from it.
  if (monthBlocks.length === 1) {
    const anchor = monthBlocks[0];
    const anchorIndex = monthIndexOf(anchor);
    if (anchorIndex < 0) return results;
    let anchorSegmentIndex = spans.findIndex((span) => anchor.centerX >= span.minX && anchor.centerX <= span.maxX);
    if (anchorSegmentIndex === -1 && anchor.centerX < spans[0].minX) anchorSegmentIndex = 0;
    if (anchorSegmentIndex === -1) {
      const rightOf = spans
        .map((span, index) => ({ index, distance: span.minX - anchor.centerX }))
        .filter((entry) => entry.distance >= 0)
        .sort((a, b) => a.distance - b.distance)[0];
      anchorSegmentIndex = rightOf ? rightOf.index : spans.length - 1;
    }
    applyFromAnchor(anchorSegmentIndex, anchorIndex, scanRosterYearForExplicitMonth(anchorIndex));
    return results;
  }

  // Any other shape (no month words, or a count that cannot be mapped
  // unambiguously to the segments) is not trustworthy enough to guess from.
  return results;
}

const GUIDED_SCAN_MONTH_FULL_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// A strict discriminator for the GUIDED picker's own month-anchor evidence,
// deliberately narrower than scanRosterMonthIndex's first-three-character
// match (which exists to parse a genuine printed date like "August 20" and
// must keep matching any prefix of a real month word there -- changing it
// would ripple into every other caller). A staff name/nickname can share a
// month's first three letters purely by coincidence ("Julie"/"Julian" ->
// "jul"), so an anchor used to resolve OTHER rows' dates must never be
// granted from a text prefix alone: this requires the whole (trimmed) token
// to BE a month abbreviation or full name, not merely start with one.
function guidedScanIsMonthAnchorText(text) {
  const key = String(text || "").trim().toLowerCase();
  if (!key) return false;
  return GUIDED_SCAN_MONTH_LABELS.some((label) => label.toLowerCase() === key) || GUIDED_SCAN_MONTH_FULL_NAMES.includes(key);
}

// Restricts month-anchor evidence to the confirmed date header's own
// geometry, because text content alone is not enough (see
// guidedScanIsMonthAnchorText) -- a staff row can carry a token that IS a
// real, exactly-spelled month word (e.g. a generic staff nickname "March")
// and must still never anchor a date it merely happens to sit near.
//   - Same row as the header's own day-number blocks: trusted at any X --
//     this is the header band printing its own month word(s) (see SI1-SI5).
//   - Strictly ABOVE the header (a title/banner row): trusted ONLY when it
//     sits squarely over one specific calendar segment's own day columns.
//     "Left of everything" or "nearest segment to the right" cannot tell a
//     genuine per-segment title apart from an unrelated heading printed
//     anywhere above the table, so neither fallback is extended here --
//     that discrimination stays reserved for a same-row anchor, where the
//     header band itself is the evidence (see JC).
//   - Anywhere BELOW the header (a staff/name row, a continuation row, or
//     any other row under the date grid) is never a valid anchor. This is
//     what stops another staff member's row -- or the configured person's
//     own name column -- from ever donating a month to a date it has
//     nothing to do with (see JA1/JA2/JB).
function mediaPipeScannerGuidedMonthAnchors(blocks, orderedDayBlocks, segments) {
  const headerY = mediaPipeScannerMedian(orderedDayBlocks.map((block) => block.centerY));
  const heights = orderedDayBlocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const rowTolerance = Math.max(12, mediaPipeScannerMedian(heights) * 0.75);
  const spans = segments.map((segment) => ({
    minX: Math.min(...segment.map((block) => block.centerX)),
    maxX: Math.max(...segment.map((block) => block.centerX)),
  }));
  return blocks
    .filter((block) => guidedScanIsMonthAnchorText(block.text))
    .filter((block) => {
      const dy = block.centerY - headerY;
      if (Math.abs(dy) <= rowTolerance) return true;
      if (dy < -rowTolerance) return spans.some((span) => block.centerX >= span.minX && block.centerX <= span.maxX);
      return false;
    })
    .sort((a, b) => a.centerX - b.centerX);
}

function mediaPipeScannerColumnsFromDayBlocks(headerDays, blocks, range, allowCurrentMonthFallback = true) {
  const ordered = [...headerDays].sort((a, b) => a.centerX - b.centerX);
  // Guided-path-only (see allowCurrentMonthFallback): the guided picker's day
  // blocks are pre-validated as a monotonic calendar sequence by
  // guidedScanGeometryIsDateBand, so a rollover found here is trustworthy
  // enough to segment on, and its month-anchor evidence is qualified by
  // mediaPipeScannerGuidedMonthAnchors (see there for why: text and
  // geometry both matter). The automatic pipeline's headerDays carry
  // neither guarantee, so it keeps the original page-wide, prefix-matched
  // month search and the original per-day nearest-left resolution below,
  // completely unchanged.
  const segments = !allowCurrentMonthFallback ? mediaPipeScannerCalendarSegments(ordered) : null;
  const monthBlocks = !allowCurrentMonthFallback
    ? mediaPipeScannerGuidedMonthAnchors(blocks, ordered, segments)
    : blocks.filter((block) => scanRosterMonthIndex(block.text) >= 0).sort((a, b) => a.centerX - b.centerX);
  const segmentMonths = segments && segments.length > 1
    ? mediaPipeScannerResolveSegmentMonths(segments, monthBlocks)
    : null;
  // A segment's resolved month must actually be able to hold every day
  // printed in it -- if it cannot (see mediaPipeScannerResolveSegmentMonths,
  // which only checks anchor validity, not calendar length), the whole
  // segment is unresolved rather than confidently wrong. This is scoped to
  // the segment path (2+ segments) only: the single-segment guided fallback
  // below keeps its own long-standing, separately-tested behaviour of
  // dropping just the one impossible day (see C15/C16 -- Feb 30/Apr 31 stay
  // rejected outright there, not surfaced as an unresolved column).
  if (segmentMonths) {
    segments.forEach((segment, index) => {
      const resolved = segmentMonths[index];
      if (!resolved) return;
      const maxDay = new Date(resolved.year, resolved.month + 1, 0).getDate();
      const impossible = segment.some((block) => mediaPipeScannerDayNumber(block.text) > maxDay);
      if (impossible) segmentMonths[index] = null;
    });
  }
  const segmentIndexByBlock = segmentMonths && new Map();
  if (segmentMonths) segments.forEach((segment, index) => segment.forEach((block) => segmentIndexByBlock.set(block, index)));

  let previous = null;
  return ordered
    .map((block) => {
      const day = mediaPipeScannerDayNumber(block.text);
      const ranged = mediaPipeScannerDateFromRange(day, previous, range);
      if (ranged) {
        previous = ranged;
        return { x: block.centerX, day, month: ranged.getUTCMonth(), year: ranged.getUTCFullYear() };
      }
      if (segmentMonths) {
        // Impossible-day segments were already invalidated to null above --
        // this never re-drops a single day out of an otherwise-valid
        // segment, so the full date-column geometry (e.g. day 31) is always
        // retained even when its month could not be trusted.
        const resolved = segmentMonths[segmentIndexByBlock.get(block)];
        if (!resolved) return { x: block.centerX, day, month: null, year: null };
        return { x: block.centerX, day, month: resolved.month, year: resolved.year };
      }
      const monthBlock = monthBlocks.filter((month) => month.centerX <= block.centerX + 20).pop() || monthBlocks[0];
      if (!monthBlock && !allowCurrentMonthFallback) {
        // No local month word anywhere in this table's own scope, and this
        // caller does not trust the app's currently displayed month as
        // context: leave the day explicitly unresolved instead of inventing
        // a month for it.
        return { x: block.centerX, day, month: null, year: null };
      }
      const month = monthBlock ? scanRosterMonthIndex(monthBlock.text) : currentMonth;
      const year = scanRosterYearForExplicitMonth(month);
      // Unlike the range walk above (which can only ever land on a real
      // calendar date), this fallback guesses the month from nearby text with
      // no calendar arithmetic behind it, so an impossible day for that month
      // (Feb 30, Apr 31) must be rejected here explicitly rather than handed
      // out as a selectable/stageable date column.
      const maxDay = new Date(year, month + 1, 0).getDate();
      if (day > maxDay) return null;
      return { x: block.centerX, day, month, year };
    })
    .filter(Boolean);
}

function mediaPipeScannerDateColumns(textBlocks = [], identity) {
  const blocks = mediaPipeScannerNormalisedBlocks(textBlocks);
  const range = mediaPipeScannerDateRange(blocks);
  const headerY = mediaPipeScannerHeaderY(blocks, identity);
  const headerDays = blocks
    .filter((block) => mediaPipeScannerDayNumber(block.text) !== null)
    .filter((block) => Math.abs(block.centerY - headerY) <= Math.max(70, block.boundingBox.height * 3));
  return mediaPipeScannerColumnsFromDayBlocks(headerDays, blocks, range);
}

function mediaPipeScannerMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Assigns each shift-like block to the date column it belongs under, using
// two widths of tolerance instead of one fixed cutoff:
//   - "tight" (the old single threshold): a token this close to a column is
//     high confidence -- it stays preselected for import like before.
//   - "loose" (wider, up to most of a column's own width): a token this
//     close is still almost certainly the right column on a real photographed
//     roster (perspective skew, a slightly cropped cell, a wide multi-char
//     code drifting the OCR bounding-box center) -- but a token this far off
//     is staged as needs-review/unselected with a reason, never silently
//     imported and never silently dropped either. Only a token with no
//     column inside the loose tolerance is treated as truly unaligned.
// Columns already claimed by a closer, more confident token are skipped in
// favour of the next-nearest still-open column within tolerance, so two
// blocks that both happen to sit nearest the same column (a real risk when
// columns are narrow) don't collide onto one date while a genuine shift for
// the neighbouring column silently vanishes.
function mediaPipeScannerColumnAssignments(blocks, columns) {
  if (!columns.length) {
    return { assignments: [], unaligned: blocks.map((block) => ({ block, reason: "no date columns detected" })) };
  }
  const orderedColumns = [...columns].sort((a, b) => a.x - b.x);
  const spacing = mediaPipeScannerMedian(orderedColumns.slice(1).map((column, index) => Math.abs(column.x - orderedColumns[index].x)).filter(Boolean));
  const tightDistance = Math.max(40, spacing ? spacing * 0.55 : 0);
  const looseDistance = Math.max(tightDistance, spacing ? spacing * 0.9 : tightDistance);
  // Claim columns in order of confidence (smallest nearest-column distance
  // first), so an unambiguous placement always wins its column before a more
  // uncertain block can be forced onto it.
  const ranked = blocks
    .map((block) => ({
      block,
      byDistance: [...orderedColumns].sort((a, b) => Math.abs(a.x - block.centerX) - Math.abs(b.x - block.centerX)),
    }))
    .sort((a, b) => Math.abs(a.byDistance[0].x - a.block.centerX) - Math.abs(b.byDistance[0].x - b.block.centerX));

  const used = new Set();
  const assignments = [];
  const unaligned = [];
  ranked.forEach(({ block, byDistance }) => {
    const candidate = byDistance.find((column) => !used.has(column) && Math.abs(column.x - block.centerX) <= looseDistance);
    if (!candidate) {
      const nearestStillOpen = byDistance.find((column) => !used.has(column));
      const blockedByCollision = Boolean(nearestStillOpen) && Math.abs(nearestStillOpen.x - block.centerX) > looseDistance && byDistance.some((column) => used.has(column) && Math.abs(column.x - block.centerX) <= looseDistance);
      unaligned.push({ block, reason: blockedByCollision ? "nearest date column already used by a closer shift" : "no date column close enough" });
      return;
    }
    used.add(candidate);
    // Provenance the guided path needs to judge trust, beyond raw distance:
    //  - displaced: this token's nearest column overall was already claimed by
    //    a closer token, so it was pushed onto a different column. That is a
    //    guess about which of two shifts owns which date, however close the
    //    replacement column happens to be.
    //  - margin: how much closer the assigned column is than the runner-up. A
    //    token sitting near the midpoint between two columns has a margin near
    //    zero and must never be treated as a confident date.
    const assignedDistance = Math.abs(candidate.x - block.centerX);
    const runnerUp = byDistance.find((column) => column !== candidate);
    const margin = runnerUp ? Math.abs(runnerUp.x - block.centerX) - assignedDistance : Infinity;
    assignments.push({
      block,
      column: candidate,
      confidence: assignedDistance <= tightDistance ? "high" : "low",
      displaced: byDistance[0] !== candidate,
      margin,
      spacing,
    });
  });
  return { assignments, unaligned };
}

// ML Kit reports recognised text element-by-element (one block per word), so
// on a real photographed roster a two-word configured name like "Ford, Alex"
// almost never arrives as a single block -- it arrives as separate "Ford,"
// and "Alex" blocks sitting on the same physical row. Group blocks into
// horizontal row bands by Y-proximity first, independent of anything
// identity-related, so both identity matching and the staff-row-boundary
// check below can work against joined, reading-order row text instead of
// isolated single-word blocks.
function mediaPipeScannerRowBands(blocks) {
  const heights = blocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const tolerance = Math.max(12, mediaPipeScannerMedian(heights) * 0.75);
  const rows = [];
  blocks.forEach((block) => {
    let row = rows.find((candidate) => Math.abs(candidate.y - block.centerY) <= tolerance);
    if (!row) {
      row = { y: block.centerY, blocks: [] };
      rows.push(row);
    }
    row.blocks.push(block);
    row.y = row.blocks.reduce((sum, item) => sum + item.centerY, 0) / row.blocks.length;
  });
  rows.forEach((row) => row.blocks.sort((a, b) => a.centerX - b.centerX));
  return rows;
}

function mediaPipeScannerRowText(row) {
  return row.blocks.map((block) => block.text).join(" ");
}

// scanRosterAliases() can include broad single-word fragments (e.g. a bare
// surname), because a comma inside a "Surname, Given" alias is also the
// separator between distinct aliases. A bare single-word alias can validly
// match more than one staff member sharing that name. So instead of taking
// the first row that matches any alias, prefer whichever row matches the
// most specific (most name-parts) alias, and fail closed — return no
// identity — if two different rows tie on specificity, rather than
// guessing which one is the configured person.
function mediaPipeScannerIdentityBlock(blocks) {
  const aliases = scanRosterAliases().map((alias) => normaliseScanNameToken(alias)).filter(Boolean);
  if (!aliases.length) return null;
  const rows = mediaPipeScannerRowBands(blocks);
  let bestBlock = null;
  let bestRowY = null;
  let bestSpecificity = 0;
  let tied = false;
  rows.forEach((row) => {
    // Join up to 4 consecutive same-row blocks, in reading order, so a
    // multi-word alias can still match a name OCR split across elements.
    for (let start = 0; start < row.blocks.length; start += 1) {
      let joinedText = "";
      let joinedBox = null;
      for (let end = start; end < Math.min(row.blocks.length, start + 4); end += 1) {
        const block = row.blocks[end];
        joinedText = joinedText ? joinedText + " " + block.text : block.text;
        joinedBox = joinedBox
          ? {
            x: Math.min(joinedBox.x, block.boundingBox.x),
            y: Math.min(joinedBox.y, block.boundingBox.y),
            width: Math.max(joinedBox.x + joinedBox.width, block.boundingBox.x + block.boundingBox.width) - Math.min(joinedBox.x, block.boundingBox.x),
            height: Math.max(joinedBox.y + joinedBox.height, block.boundingBox.y + block.boundingBox.height) - Math.min(joinedBox.y, block.boundingBox.y),
          }
          : { ...block.boundingBox };
        const normalised = normaliseScanNameToken(joinedText);
        const matchedSpecificities = aliases
          .filter((alias) => normalisedTextHasAliasMatch(normalised, alias))
          .map((alias) => alias.split(" ").length);
        if (!matchedSpecificities.length) continue;
        const specificity = Math.max(...matchedSpecificities);
        // Strictly-greater only: once a window reaches a given specificity,
        // keep the smallest (first-found) box for it, so a wider join that
        // still satisfies the same alias doesn't needlessly grow the
        // identity box to include unrelated trailing text.
        const candidateBlock = { text: joinedText, boundingBox: joinedBox, centerX: joinedBox.x + joinedBox.width / 2, centerY: joinedBox.y + joinedBox.height / 2, members: row.blocks.slice(start, end + 1) };
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          bestBlock = candidateBlock;
          bestRowY = row.y;
          tied = false;
        } else if (specificity === bestSpecificity && bestRowY !== null && Math.abs(row.y - bestRowY) > 1) {
          tied = true;
        }
      }
    }
  });
  return tied ? null : bestBlock;
}

// Shared name-column staff-row boundary: identifies identity's own row band
// and the X gutter separating the name column from the shift-code grid, plus
// a predicate for "this OTHER row band belongs to a different, named staff
// member" -- independent of any date-table geometry. ANY block sitting in
// the name column (left of the gutter, whatever it says) on a row that isn't
// identity's own is evidence that row is a different, named staff member's
// row, not an unlabelled continuation of the configured person's own row. A
// real continuation row (e.g. a bare CZ/CM row directly under the name)
// never has anything printed in the name column -- there is no one left to
// name there. This is deliberately NOT a name-format/dictionary check (those
// cannot cover every real name layout -- a two-word name split across two
// OCR blocks with no comma, e.g. "Ng" "Bo", never matches a "Surname, Given"
// pattern), so it catches every other staff row by position instead of by
// how their name happens to be printed.
//
// Shared by mediaPipeScannerTargetRowBlocks (to bound its own row search) and
// scanRosterPrivacySafeGeometryBlocks (to decide whether a page with no
// provable date table is still safe to retain anything from) so the two
// notions of "another staff member is on this page" can never disagree.
function mediaPipeScannerStaffRowBoundary(blocks, identity) {
  const rowBands = mediaPipeScannerRowBands(blocks);
  // Identify whichever row band is identity's own (the row a same-row block
  // like a lone shift code sitting close enough to merge bands with the name
  // can drift its average Y slightly past identity.centerY) by nearest-Y,
  // and exclude it by reference -- not by a fixed epsilon around
  // identity.centerY, which a merged band can slip past in either
  // direction and get mistaken for a neighboring staff member's row.
  let identityRowBand = null;
  let identityRowBandDistance = Infinity;
  rowBands.forEach((row) => {
    const distance = Math.abs(row.y - identity.centerY);
    if (distance < identityRowBandDistance) {
      identityRowBandDistance = distance;
      identityRowBand = row;
    }
  });
  // The name-column boundary: identical to the margin `candidates` in
  // mediaPipeScannerTargetRowBlocks uses to keep shift codes out of the name
  // column, reused here so the two notions of "name column" can never drift
  // apart.
  const identityGutterX = identity.centerX + Math.max(60, identity.boundingBox.width * 0.55);
  const isOtherStaffNameRow = (row) => row !== identityRowBand
    && row.blocks.some((block) => block.centerX <= identityGutterX);
  return { rowBands, identityRowBand, identityGutterX, isOtherStaffNameRow };
}

// Whether the page has a genuinely different, named staff member's row
// anywhere, by the same geometric boundary mediaPipeScannerTargetRowBlocks
// uses to scope its own row search -- independent of whether a full date
// table can be proven.
function mediaPipeScannerHasOtherStaffNameRow(blocks, identity) {
  const { rowBands, isOtherStaffNameRow } = mediaPipeScannerStaffRowBoundary(blocks, identity);
  return rowBands.some(isOtherStaffNameRow);
}

function mediaPipeScannerTargetRowBlocks(blocks) {
  const identity = mediaPipeScannerIdentityBlock(blocks);
  if (!identity) return [];
  const heights = blocks.map((block) => block.boundingBox.height).filter(Number.isFinite);
  const rowTolerance = Math.max(18, mediaPipeScannerMedian(heights) * 1.35);
  const staffGap = Math.max(34, mediaPipeScannerMedian(heights) * 2.6);
  // Fail-closed fallback: if no other staff row is recognisable by name format,
  // still cap how far below the identity row we search instead of scanning the
  // whole page — otherwise an unrelated employee's row further down can win as
  // "primary" simply by having more recognised shift codes than the configured
  // person's real row. Match against each row's *joined* text (not a single
  // block's text): a name like "Smith, Pat" usually arrives as separate
  // "Smith," and "Pat" OCR elements rather than one block, so checking each
  // block in isolation would never recognise the next-staff name pattern.
  const { rowBands, identityGutterX, isOtherStaffNameRow } = mediaPipeScannerStaffRowBoundary(blocks, identity);
  const previousStaffY = rowBands
    .filter((row) => row.y < identity.centerY)
    .filter(isOtherStaffNameRow)
    .map((row) => row.y)
    .sort((a, b) => b - a)[0];
  const nextStaffY = rowBands
    .filter((row) => row.y > identity.centerY)
    .filter(isOtherStaffNameRow)
    .map((row) => row.y)
    .sort((a, b) => a - b)[0];
  // Bisect the gap to each neighboring staff member's own name row rather
  // than using a fixed tolerance: a real photographed roster packs rows
  // tightly enough (often with an unlabelled continuation row between two
  // name rows) that a fixed-distance search from the identity row alone can
  // reach past a neighbor's name row into their own continuation row. The
  // midpoint always attributes a continuation row to whichever name row it
  // physically sits closer to.
  const lowerBound = previousStaffY !== undefined ? Math.max(identity.centerY - rowTolerance, (previousStaffY + identity.centerY) / 2) : identity.centerY - rowTolerance;
  const upperBound = nextStaffY !== undefined ? (identity.centerY + nextStaffY) / 2 : identity.centerY + staffGap * 3;
  const candidates = blocks
    .filter((block) => block.centerY > lowerBound)
    .filter((block) => block.centerY < upperBound)
    .filter((block) => block.centerX > identityGutterX);
  const rows = [];
  candidates.forEach((block) => {
    let row = rows.find((candidate) => Math.abs(candidate.y - block.centerY) <= rowTolerance);
    if (!row) {
      row = { y: block.centerY, blocks: [] };
      rows.push(row);
    }
    row.blocks.push(block);
    row.y = row.blocks.reduce((sum, item) => sum + item.centerY, 0) / row.blocks.length;
  });
  // A code-shaped token counts as a shift cell for row detection purposes
  // regardless of whether the app already has a mapping for it -- a row
  // where every code is unfamiliar to the app must still be recognised as
  // the shift row, not silently treated as if it had no shifts at all.
  const shiftRows = rows
    .map((row) => ({
      ...row,
      shiftBlocks: row.blocks.filter((block) => isLikelyRosterCodeToken(block.text)),
    }))
    .filter((row) => row.shiftBlocks.length > 0)
    .sort((a, b) => {
      const count = b.shiftBlocks.length - a.shiftBlocks.length;
      if (count) return count;
      return Math.abs(a.y - identity.centerY) - Math.abs(b.y - identity.centerY);
    });
  if (!shiftRows.length) return [];
  const primary = shiftRows[0];
  const primaryXs = primary.shiftBlocks.map((block) => block.centerX);
  const spacing = mediaPipeScannerMedian(primaryXs.slice(1).map((x, index) => Math.abs(x - primaryXs[index])).filter(Boolean));
  const sameColumnTolerance = Math.max(36, spacing ? spacing * 0.45 : mediaPipeScannerMedian(heights) * 2.2);
  // Every row here already passed the identity/next-staff Y bounds above, so
  // it belongs to the configured person (e.g. a name row plus a second,
  // unlabelled continuation row directly below it holding on-call markers
  // like CZ/CM — a common roster layout). Don't additionally require the
  // row to sit above the primary row: a real continuation row is just as
  // often below the row picked as primary as above it.
  const supplemental = shiftRows
    .slice(1)
    .flatMap((row) => row.shiftBlocks)
    .filter((block) => !primaryXs.some((x) => Math.abs(x - block.centerX) <= sameColumnTolerance));
  return [...primary.blocks, ...supplemental];
}

function scanRosterDraftsFromMediaPipeTextBlocks(textBlocks = []) {
  const blocks = mediaPipeScannerNormalisedBlocks(textBlocks);
  const identity = mediaPipeScannerIdentityBlock(blocks);
  const targetBlocks = mediaPipeScannerTargetRowBlocks(blocks);
  const columns = mediaPipeScannerDateColumns(textBlocks, identity);
  // Unlike the guided pipeline, this pipeline's own row scoping
  // (mediaPipeScannerTargetRowBlocks) already excludes anything
  // guidedScanExpandIdentityMembers' centre-inside-identity-box test would
  // additionally catch: its margin (identity.centerX + max(60, width*0.55))
  // is always at or beyond the identity box's own right edge, so a
  // same-row fragment centred inside that box can never pass the margin in
  // the first place. No separate identity-region filter needed here.
  const shiftBlocks = targetBlocks.filter((block) => isLikelyRosterCodeToken(block.text));
  // Build a draft for every code-shaped block, known to the app or not --
  // scanRosterDraft() already resolves status to "ready" vs "needs-review"
  // via scanRosterShiftForCode, and needs-review drafts still reach the
  // Review screen's "Register code as" / "Create new shift" controls so an
  // unfamiliar code can be taught to the app instead of silently vanishing.
  // Column assignment itself now never silently drops a shift-like token
  // just because it wasn't perfectly centred or its nearest column was
  // already claimed -- see mediaPipeScannerColumnAssignments. A token that
  // still can't be placed with real confidence is recorded in
  // lastScanRosterGeometryDiagnostics.unaligned for the Diagnostics screen
  // instead of vanishing without a trace.
  const { assignments, unaligned } = mediaPipeScannerColumnAssignments(shiftBlocks, columns);
  const drafts = assignments
    .map(({ block, column, confidence }) => {
      const draft = scanRosterDraft(column.day, block.text, { month: column.month, year: column.year });
      if (confidence === "low") {
        draft.selected = false;
        draft.dateConfidence = "low";
        draft.reason = "Date alignment was not tight -- verify this date before importing.";
      }
      return draft;
    })
    .sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.day - b.day));
  lastScanRosterGeometryDiagnostics = {
    dateColumnsDetected: columns.length,
    identityFound: Boolean(identity),
    shiftTokensDetected: shiftBlocks.length,
    alignedTokens: assignments.length,
    lowConfidenceAligned: assignments.filter((item) => item.confidence === "low").length,
    unalignedTokens: unaligned.length,
    finalDraftCount: drafts.length,
  };
  return drafts;
}

function scanRosterShiftObjectsFromDrafts(drafts = []) {
  return (Array.isArray(drafts) ? drafts : [])
    .filter((draft) => draft.status === "ready" && templates[draft.shiftKey])
    .map((draft) => {
      const template = templates[draft.shiftKey];
      return {
        title: "Work Shift",
        date: dateKey(draft.day, draft.year, draft.month),
        startTime: template.start,
        endTime: template.finish,
      };
    });
}

function scanRosterImageFromMediaPipeTextBlocks(textBlocks = []) {
  return scanRosterShiftObjectsFromDrafts(scanRosterDraftsFromMediaPipeTextBlocks(textBlocks));
}

// Keyed by requestId, one entry per in-flight native bridge.scanRosterImageUri
// round trip -- NOT a single slot. A single shared slot meant a second
// overlapping native request overwrote the first attempt's {resolve,reject}
// reference entirely, permanently orphaning the first caller's promise (it
// could then neither resolve nor reject -- an unresolved promise has no
// visible symptom of its own, it just hangs its awaiter forever). Each
// entry also carries its own timeout handle so a request that never gets
// ANY native echo at all (lost callback, not just superseded) still settles
// eventually -- see resolvePendingScanRosterImage and
// SCAN_ROSTER_NATIVE_TIMEOUT_MS.
const pendingScanRosterImageResolvers = new Map();
const scanRosterTransactions = new Map();
// A single slot, NOT a growing tombstone map: overwritten by whichever
// transaction reaches a terminal state most recently. transitionScanRosterTransaction
// below deletes a transaction's own scanRosterTransactions entry the instant
// it goes terminal, so page-lifetime memory stays proportional to
// concurrently in-flight scans instead of growing once per scan attempt ever
// made. The few call sites that need a transaction's final state (or id)
// AFTER that deletion -- see scanRosterTransactionSnapshot below -- fall
// back to this exact-id match instead of the Map.
let lastScanRosterTransactionOutcome = null;

// Reads a transaction's {state, timeoutId} whether it is still active
// (present in scanRosterTransactions) or has just gone terminal (removed
// from the Map -- answered only by the single-slot lastScanRosterTransactionOutcome
// above). Returns undefined for an id that was never minted, or whose
// terminal outcome has since been overwritten by a LATER transaction's own
// termination -- which is fine: nothing may ever need a transaction's state
// after some newer, unrelated transaction has already gone terminal too.
function scanRosterTransactionSnapshot(requestId) {
  if (requestId == null) return undefined;
  const transaction = scanRosterTransactions.get(requestId);
  if (transaction) return { state: transaction.state, timeoutId: transaction.timeoutId };
  if (lastScanRosterTransactionOutcome && lastScanRosterTransactionOutcome.id === requestId) {
    return { state: lastScanRosterTransactionOutcome.state, timeoutId: null };
  }
  return undefined;
}

function scanRosterTransactionState(requestId) {
  const snapshot = scanRosterTransactionSnapshot(requestId);
  return snapshot ? snapshot.state : undefined;
}
// Mutable (not const) so a test can shorten it to exercise the timeout path
// without a real multi-minute wait. 120s is the upper bound on how long a
// native round trip may stay unanswered before the transaction is force-
// settled -- long enough that a slow on-device OCR pass over a large roster
// photo is never cut off mid-scan, short enough that a lost callback cannot
// strand the session indefinitely.
let SCAN_ROSTER_NATIVE_TIMEOUT_MS = 120000;
// The transaction record is the sole source of lifecycle truth: only an
// ACTIVE record can own callbacks, timers, or current UI state. Final records
// remain for diagnostics/tests but can never transition or settle again.
// Monotonic per-attempt correlation id. Every photo transaction -- native
// round trip or in-process (web MediaPipeTextDetector / MediaPipeScannerService)
// -- mints a real, non-null id via beginScanRosterRequest() below and stamps
// it on its own eventual result. A null id is never treated as "current":
// two overlapping untagged attempts used to be indistinguishable from each
// other (whichever answered first won, success OR failure, even if it was
// the stale one) precisely because null-to-null was accepted as a match.
// See scanRosterOcrResultIsCurrent for the acceptance rule this enables:
// pure non-null id equality, nothing else.
let currentScanRosterRequestId = null;
let scanRosterRequestSeq = 0;
// True whenever the current transaction is still expecting its own result.
// Bookkeeping only now (see scanRosterOcrResultIsCurrent) -- currency is
// decided purely by request id equality, not by this flag -- but kept as an
// observable "is anything outstanding" signal.
let scanRosterOcrAwaitingResult = true;

// True once the user has entered a name or alias to match against a Team
// roster. Personal format never needs this -- it scans the user's own
// electronic grid with no name/staff-row matching at all.
function scanRosterTeamIdentityConfigured() {
  return Boolean((scanRosterIdentity.name || "").trim() || (scanRosterIdentity.aliases || "").trim());
}

// Starts a new scan attempt/generation and mints its real, non-null
// correlation id. Returns the id so the caller can pass it to native / a
// result object, or capture it for later comparison. Returns null and
// starts nothing when Team format has no identity configured yet -- fail
// closed rather than silently matching every row (or matching nothing and
// looking like a scan failure instead of a setup gap). Checked before
// touching any existing active transaction, so a refused attempt never
// supersedes or resets a scan that is already in flight.
function beginScanRosterRequest() {
  if (scanRosterFormat !== "personal" && !scanRosterTeamIdentityConfigured()) return null;
  const previousId = currentScanRosterRequestId;
  if (scanRosterTransactionIsActive(previousId)) {
    transitionScanRosterTransaction(previousId, "superseded", {
      error: new Error("Superseded by a newer roster scan attempt."),
    });
  }
  resetScanRosterSessionState(true);
  scanRosterRequestSeq += 1;
  currentScanRosterRequestId = "r" + Date.now() + "-" + scanRosterRequestSeq;
  scanRosterOcrAwaitingResult = true;
  scanRosterTransactions.set(currentScanRosterRequestId, {
    id: currentScanRosterRequestId, state: "active", resolve: null, reject: null, timeoutId: null, supersedeRejectors: [],
    // Snapshotted here, at scan-start, not read live when the OCR result
    // arrives: the user can flip Settings -> Roster format while a native
    // OCR call for an earlier scan is still in flight, and that later
    // change must never silently flip an already-running Team scan onto
    // the name-free Personal path (or vice versa) for a result it has not
    // seen yet.
    rosterFormat: scanRosterFormat,
  });
  return currentScanRosterRequestId;
}

// Reads the Roster format a scan transaction was started under (see
// beginScanRosterRequest). Exact-match only, same rule as
// sanitizedScanRosterFormat/prepareGuidedScanSession: a missing/unknown
// transaction (should never happen, but fail safe) resolves to "team".
function scanRosterTransactionFormat(requestId) {
  const transaction = requestId != null ? scanRosterTransactions.get(requestId) : null;
  return transaction && transaction.rosterFormat === "personal" ? "personal" : "team";
}

function scanRosterTransactionIsActive(requestId) {
  const transaction = requestId != null ? scanRosterTransactions.get(requestId) : null;
  return Boolean(transaction && transaction.state === "active");
}

function scanRosterTransactionIsCurrent(requestId) {
  return requestId != null && requestId === currentScanRosterRequestId && scanRosterTransactionIsActive(requestId);
}

function transitionScanRosterTransaction(requestId, finalState, options = {}) {
  const transaction = requestId != null ? scanRosterTransactions.get(requestId) : null;
  if (!transaction || transaction.state !== "active") return false;
  if (transaction.timeoutId != null) clearTimeout(transaction.timeoutId);
  transaction.timeoutId = null;
  transaction.state = finalState;
  const pending = pendingScanRosterImageResolvers.get(requestId);
  pendingScanRosterImageResolvers.delete(requestId);
  const resolve = transaction.resolve || pending?.resolve;
  const reject = transaction.reject || pending?.reject;
  transaction.resolve = null;
  transaction.reject = null;
  if (finalState === "superseded") {
    (transaction.supersedeRejectors || []).forEach((rejectSuperseded) => rejectSuperseded(options.error || new Error("Superseded by a newer roster scan attempt.")));
  }
  transaction.supersedeRejectors = [];
  if (currentScanRosterRequestId === requestId) {
    currentScanRosterRequestId = null;
    scanRosterOcrAwaitingResult = false;
  }
  // Bounded bookkeeping: once a transaction is terminal it can never
  // transition again (the state !== "active" guard above already enforces
  // that), so nothing needs its Map entry to persist -- only its final
  // {id, state} in the single overwritable slot above.
  lastScanRosterTransactionOutcome = { id: requestId, state: finalState };
  scanRosterTransactions.delete(requestId);
  if (options.error) {
    if (typeof reject === "function") reject(options.error);
  } else if (typeof resolve === "function") {
    resolve(options.value);
  }
  return true;
}

async function runScanRosterProviderCall(requestId, providerCall, retireFailure) {
  const transaction = scanRosterTransactions.get(requestId);
  if (!transaction || transaction.state !== "active") throw new Error("Superseded by a newer roster scan attempt.");
  const superseded = new Promise((_, reject) => transaction.supersedeRejectors.push(reject));
  try {
    return await Promise.race([providerCall(), superseded]);
  } catch (error) {
    // A direct exported scanRosterImage() call has no outer transaction owner
    // to retire it. A processCapturedRosterImageUri() continuation does: keep
    // that explicit caller context active so its catch can also update status,
    // toast, and processing UI before performing the same terminal transition.
    if (retireFailure && scanRosterTransactionIsCurrent(requestId)) {
      transitionScanRosterTransaction(requestId, "failed", { error });
    }
    throw error;
  }
}

function setScanRosterProcessing(active) {
  const indicator = document && typeof document.getElementById === "function" ? document.getElementById("scan-roster-processing") : null;
  const button = document && typeof document.getElementById === "function" ? document.getElementById("scan-roster-photo-picker") : null;
  if (indicator && indicator.classList) indicator.classList.toggle("hidden-control", !active);
  if (button) button.disabled = Boolean(active);
}

function scanRosterTemplateKeyForShiftObject(shift) {
  const start = normaliseTimeText(shift?.startTime || "");
  const end = normaliseTimeText(shift?.endTime || "");
  return Object.entries(templates).find(([, template]) => normaliseTimeText(template.start) === start && normaliseTimeText(template.finish) === end)?.[0] || "";
}

function ingestScannedCalendarShifts(shifts = []) {
  let saved = 0;
  (Array.isArray(shifts) ? shifts : []).forEach((shift) => {
    if (!shift || shift.title !== "Work Shift") return;
    const parsed = parseDateInput(shift.date);
    const templateKey = scanRosterTemplateKeyForShiftObject(shift);
    if (!parsed || !templateKey || !templates[templateKey]) return;
    const key = dateKeyForDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1)).slice(0, 7);
    const day = parsed.getDate();
    if (!rosters[key]) rosters[key] = {};
    rosters[key][day] = templateKey;
    saved += 1;
  });
  if (saved > 0) {
    saveState();
    if (document && typeof document.getElementById === "function") {
      renderCalendar();
      renderQuickGrid();
      updateSelectedCount();
      updatePayDisplay();
    }
  }
  return { saved, skipped: Math.max(0, (Array.isArray(shifts) ? shifts.length : 0) - saved) };
}

function scanRosterDraftsFromShiftObjects(shifts = []) {
  return (Array.isArray(shifts) ? shifts : [])
    .map((shift) => {
      if (!shift || shift.title !== "Work Shift") return null;
      const parsed = parseDateInput(shift.date);
      const shiftKey = scanRosterTemplateKeyForShiftObject(shift);
      if (!parsed || !shiftKey || !templates[shiftKey]) return null;
      const rawCode = templates[shiftKey].icon || shiftKey;
      return scanRosterDraft(parsed.getDate(), rawCode, { month: parsed.getMonth(), year: parsed.getFullYear() });
    })
    .filter(Boolean)
    .sort((a, b) => (scanRosterDraftYear(a) - scanRosterDraftYear(b)) || (scanRosterDraftMonth(a) - scanRosterDraftMonth(b)) || (a.day - b.day));
}

function stageScannedCalendarShiftsForReview(shifts = []) {
  scanRosterDrafts = scanRosterDraftsFromShiftObjects(shifts);
  lastScanRosterImportSummary = null;
  scanRosterAiReview = null;
  renderScanRosterReview();
  renderScanRosterAiReview();
  return { staged: scanRosterDrafts.length, skipped: Math.max(0, (Array.isArray(shifts) ? shifts.length : 0) - scanRosterDrafts.length) };
}

// Unlike stageScannedCalendarShiftsForReview (which rebuilds drafts from
// plain {title,date,startTime,endTime} shift objects -- a shape that can
// only represent an already-resolved, importable shift), this stages the
// full draft list a scan actually produced, needs-review candidates
// included. A needs-review draft has no template/times to reconstruct from
// a shift object, so once a candidate is reduced to that shape it can never
// come back -- see resolvePendingScanRosterImage.
function stageScanRosterDraftsForReview(drafts = []) {
  scanRosterDrafts = Array.isArray(drafts) ? drafts : [];
  lastScanRosterImportSummary = null;
  scanRosterAiReview = null;
  renderScanRosterReview();
  renderScanRosterAiReview();
  return { staged: scanRosterDrafts.length, skipped: 0 };
}

// The real captured-image path: the native bridge scans off-thread and calls
// back into window.handleScanRosterOcrResult once it has a result, which
// resolves the pending scanRosterImage() promise via this function. This
// used to build its own drafts directly from the raw result and hand them
// straight to processCapturedRosterImageUri for staging -- bypassing Guided
// Scan/confirmation entirely (the exact bypass that let a real photo scan's
// automatic match reach Review as already-tickable rows). It now routes
// through the SAME applyScanRosterOcrResult choke point every other OCR
// result uses, so this path can never produce anything importable before the
// date row and staff row are both explicitly confirmed.
// isCurrent is decided by the caller (handleScanRosterOcrResult) BEFORE this
// runs, via the exact same non-null request-id equality every other seam
// uses. Settlement itself (looking up and removing this exact requestId's
// entry) always happens regardless of currency -- an overlapping request's
// promise must never be left hanging just because a newer attempt
// superseded it. Only the CONTENT of that settlement differs: a stale
// (isCurrent === false) result rejects with a generic superseded error and
// touches nothing else -- no clearScanRosterDrafts, no applyScanRosterOcrResult
// -- exactly like any other stale result is required to mutate nothing.
// geometryBlocks is the unredacted block array for the guided geometry pass --
// see scanRosterPrivacySafeOcrResult. Omitted (as on the stale/superseded
// branches, which apply nothing) it falls back to result.textBlocks.
function resolvePendingScanRosterImage(result = {}, isCurrent, geometryBlocks) {
  const requestId = result && result.requestId != null ? result.requestId : null;
  if (requestId === null || !scanRosterTransactionIsActive(requestId)) return false;
  if (!isCurrent) return transitionScanRosterTransaction(requestId, "superseded", {
    error: new Error("Superseded by a newer roster scan attempt."),
  });
  if (!result.ok) return false;
  applyScanRosterOcrResult(result, geometryBlocks);
  setScanRosterProcessing(false);
  return transitionScanRosterTransaction(requestId, "succeeded", {
    value: { staged: scanRosterDrafts.length },
  });
}

// Single choke point every scan-starting seam that calls scanRosterImage()
// acquires ownership through -- replaces the old beginOrContinueScanRosterRequest,
// which could not tell "continue the transaction I already own" apart from
// "this is a new, independent invocation" and so sometimes REUSED an
// already-active id for what was actually a second, unrelated attempt (two
// overlapping exported scanRosterImage() calls would collide onto one
// transaction instead of the second superseding the first).
//
// ownRequestId is the caller's explicit, unambiguous declaration of intent:
//   - omitted/null: a new, independent invocation (the exported
//     scanRosterImage() entry point called directly, or any other seam with
//     no transaction of its own yet). Always mints a fresh id and supersedes
//     whatever was active -- see beginScanRosterRequest.
//   - a real id: the caller is continuing a transaction it already owns
//     (processCapturedRosterImageUri, after its own ownership gate already
//     validated/restored that id). Honoured ONLY when it exactly equals the
//     current transaction; otherwise something else has already superseded
//     the caller between it acquiring ownRequestId and calling this, so this
//     returns null and the caller must not start OCR or mutate anything.
function beginScanRosterTransaction(ownRequestId) {
  if (ownRequestId == null) return beginScanRosterRequest();
  if (!scanRosterTransactionIsCurrent(ownRequestId)) return null;
  scanRosterOcrAwaitingResult = true;
  return ownRequestId;
}

async function scanRosterImage(imageUri, ownRequestId, handoffToken) {
  if (!imageUri) throw new Error("No roster image URI was provided.");
  const requestId = beginScanRosterTransaction(ownRequestId);
  if (requestId === null) return;
  if (window.MediaPipeScannerService && typeof window.MediaPipeScannerService.scanRosterImage === "function") {
    // This service resolves ready-only shift objects with no OCR geometry at
    // all, so a guided Date/Staff confirmation cannot be built from it. Per
    // the authoritative product rule it must fail closed rather than stage
    // anything: route it through the same choke point with no textBlocks/
    // text so it surfaces as "nothing could be confirmed, rescan" like any
    // other shape that cannot support guided confirmation.
    await runScanRosterProviderCall(requestId, () => window.MediaPipeScannerService.scanRosterImage(imageUri), ownRequestId == null);
    if (!scanRosterTransactionIsCurrent(requestId)) throw new Error("Superseded by a newer roster scan attempt.");
    handleScanRosterOcrResult({ ok: true, stage: "mediapipe-scanner-service-ready-only", text: "", textBlocks: [], requestId });
    return;
  }
  const detector = window.RosterBuddyMediaPipeTextDetector || window.MediaPipeTextDetector || window.google_mediapipe;
  if (detector && (typeof detector.recognizeText === "function" || typeof detector.detectText === "function" || typeof detector.recognize === "function")) {
    const blocks = await runScanRosterProviderCall(requestId, () => detector.recognizeText ? detector.recognizeText(imageUri) : (detector.detectText ? detector.detectText(imageUri) : detector.recognize(imageUri)), ownRequestId == null);
    if (!scanRosterTransactionIsCurrent(requestId)) throw new Error("Superseded by a newer roster scan attempt.");
    handleScanRosterOcrResult({ ok: true, stage: "web-mediapipe-text-detector", text: "", textBlocks: Array.isArray(blocks) ? blocks : [], requestId });
    return;
  }
  const bridge = androidBridge();
  // handoffToken present -> this call is continuing a REAL native picker
  // handoff, and native's scanRosterImageUri is capability-mandatory: it
  // refuses anything without the exact token minted for this exact
  // requestId (see RosterMateBridge.scanRosterImageUri). No token -> this is
  // a legitimate direct/self-test/dev caller that never went through a
  // picker handoff and holds no capability at all, so it uses the separate,
  // explicitly ungated scanRosterImageUriDirect entry point instead of
  // sending a fabricated/absent token to the capability-mandatory method.
  const nativeMethodName = handoffToken ? "scanRosterImageUri" : "scanRosterImageUriDirect";
  if (bridge && typeof bridge[nativeMethodName] === "function") {
    // Reject a duplicate explicit id that is already in flight rather than
    // silently overwriting its Map entry -- a Map.set overwrite here would
    // orphan the original caller's {resolve, reject} pair permanently (no
    // future callback could ever reach it again), the exact single-slot
    // failure mode this per-id map replaced.
    if (pendingScanRosterImageResolvers.has(requestId)) {
      return Promise.reject(new Error("A roster OCR request with id " + requestId + " is already in flight."));
    }
    return new Promise((resolve, reject) => {
      const transaction = scanRosterTransactions.get(requestId);
      transaction.resolve = resolve;
      transaction.reject = reject;
      transaction.timeoutId = setTimeout(() => {
        if (!scanRosterTransactionIsCurrent(requestId)) return;
        const error = new Error("Native roster OCR timed out waiting for a result.");
        resetScanRosterSessionState(false);
        setScanRosterProcessing(false);
        setScanRosterPhotoStatus("Local roster scan failed: " + error.message);
        transitionScanRosterTransaction(requestId, "timed-out", { error });
      }, SCAN_ROSTER_NATIVE_TIMEOUT_MS);
      pendingScanRosterImageResolvers.set(requestId, transaction);
      const payload = { imageUri, identityText: scanRosterOcrIdentityText(), requestId };
      if (handoffToken) payload.handoffToken = handoffToken;
      bridge[nativeMethodName](JSON.stringify(payload));
    });
  }
  // Provider discovery happens AFTER the transaction has already been started
  // (it has to: beginScanRosterTransaction is what supersedes any previous
  // attempt before this one can look at anything). So this branch must retire
  // the transaction it started, or the scanner is left logically busy forever
  // with nothing able to answer it -- and, worse, a late echo carrying that
  // still-current id would be accepted and allowed to mutate drafts/status.
  // Only a caller that OWNS this transaction retires it: when ownRequestId was
  // supplied, the owner (processCapturedRosterImageUri) performs the same
  // terminal transition in its own catch, after updating status/toast/busy UI
  // -- exactly the split runScanRosterProviderCall's retireFailure flag uses.
  const error = new Error("No local MediaPipe/native OCR scanner is available on this device.");
  if (ownRequestId == null && scanRosterTransactionIsCurrent(requestId)) {
    setScanRosterProcessing(false);
    transitionScanRosterTransaction(requestId, "failed", { error });
  }
  throw error;
}

// The closed set of deliberate, content-free user copy this seam may display
// verbatim. Everything else that reaches the scanner's failure display is an
// error this app did not mint -- a provider, platform or detector failure
// whose message routinely quotes the offending content:// URI, and therefore
// the user's own roster filename, straight into the status line, the toast
// and the copyable diagnostics. That is the same leak class C59 closed on the
// native side (see RosterMateBridge.failureClass), reopened in JS.
const SCAN_ROSTER_DISPLAYABLE_MESSAGES = new Set([
  PREMIUM_LOCKED_SCANNER_MESSAGE,
  "No local MediaPipe/native OCR scanner is available on this device.",
  "Photo OCR needs the Android app build.",
  "Native roster OCR timed out waiting for a result.",
  "Superseded by a newer roster scan attempt.",
  "Roster scan cancelled.",
]);

// Closed vocabulary, exactly like failureClass(): an exception's own `name`
// is attacker-of-convenience text too (a custom error type can carry
// anything), so an unrecognised class degrades to "Error" rather than being
// echoed. Which stage failed is already carried separately.
const SCAN_ROSTER_ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "DOMException", "AbortError", "NotAllowedError",
  "NotFoundError", "SecurityError",
]);

function scanRosterDisplayableErrorMessage(error) {
  const raw = error && error.message ? String(error.message) : String(error);
  if (SCAN_ROSTER_DISPLAYABLE_MESSAGES.has(raw)) return raw;
  const name = error && error.name ? String(error.name) : "Error";
  const safeClass = SCAN_ROSTER_ERROR_CLASSES.has(name) ? name : "Error";
  return "Could not read that roster image on this device (" + safeClass + ").";
}

async function processCapturedRosterImageUri(imageUri, requestId, handoffToken) {
  if (requestId && !scanRosterTransactionIsCurrent(requestId)) return;
  const ownRequestId = requestId || beginScanRosterRequest();
  if (requestId) resetScanRosterSessionState(true);
  setScanRosterProcessing(true);
  setScanRosterPhotoStatus("Reading roster image locally…");
  try {
    if (!premiumFeatureState("scanner").allowed) {
      renderScanRosterPremiumGate();
      throw new Error(PREMIUM_LOCKED_SCANNER_MESSAGE);
    }
    await scanRosterImage(imageUri, ownRequestId, handoffToken);
    // scanRosterImage's own await may already have carried ownRequestId to a
    // terminal state, whose scanRosterTransactions Map entry is deleted the
    // instant that happens (see transitionScanRosterTransaction) -- reading
    // through scanRosterTransactionState instead of the Map directly is what
    // still finds it via the single-slot lastScanRosterTransactionOutcome.
    const finalState = scanRosterTransactionState(ownRequestId);
    if (finalState === "superseded") throw new Error("Superseded by a newer roster scan attempt.");
    if (finalState === "succeeded") showScreen("scan-roster");
    return { staged: scanRosterDrafts.length };
  } catch (error) {
    // Classification still reads the ORIGINAL message, so no state-machine
    // behaviour changes with the display copy; only what the user sees (and
    // copies) is sanitized. See scanRosterDisplayableErrorMessage.
    const rawMessage = error && error.message ? String(error.message) : String(error);
    const message = scanRosterDisplayableErrorMessage(error);
    if (scanRosterTransactionIsCurrent(ownRequestId)) {
      resetScanRosterSessionState(false);
      setScanRosterProcessing(false);
      setScanRosterPhotoStatus("Local roster scan failed: " + message);
      showToast(message, "warning");
      transitionScanRosterTransaction(ownRequestId, /cancel/i.test(rawMessage) ? "cancelled" : "failed", { error });
    }
    throw error;
  } finally {
    if (scanRosterTransactionIsCurrent(ownRequestId)) setScanRosterProcessing(false);
  }
}

function importScanRosterDrafts(drafts) {
  let imported = 0;
  let skipped = 0;
  let ready = 0;
  let needsReview = 0;
  let conflicts = 0;
  const codes = [];
  const list = drafts || [];
  // Fail closed on same-date conflicts (e.g. an AI Assist suggestion left
  // selected alongside a disagreeing OCR draft for the same day): rosters[
  // key][day] is a single slot, so importing both would silently let
  // whichever draft happens to be processed last win. Refuse to import
  // either side rather than guess.
  const selectedReadyDateKeys = new Map();
  list.forEach((draft) => {
    if (!draft || !draft.selected || draft.status !== "ready" || !draft.shiftKey || !templates[draft.shiftKey] || draft.dateUnresolved) return;
    const dateKey = scanRosterDraftMonthKey(draft) + "-" + draft.day;
    selectedReadyDateKeys.set(dateKey, (selectedReadyDateKeys.get(dateKey) || 0) + 1);
  });
  const conflictedDateKeys = new Set([...selectedReadyDateKeys.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  list.forEach((draft) => {
    if (draft?.status === "ready") ready += 1;
    else needsReview += 1;
    if (draft?.rawCode && !codes.includes(draft.rawCode)) codes.push(draft.rawCode);
    const dateKey = draft ? scanRosterDraftMonthKey(draft) + "-" + draft.day : "";
    // A date this app could not itself resolve must never be imported, no
    // matter what .selected says -- see scanRosterDraft. Checked
    // independently of .selected so a forced/compromised selection (e.g. a
    // UI checkbox override) still cannot write a fabricated date.
    if (!draft || !draft.selected || draft.status !== "ready" || !draft.shiftKey || !templates[draft.shiftKey] || draft.dateUnresolved) {
      skipped += 1;
      return;
    }
    if (conflictedDateKeys.has(dateKey)) {
      conflicts += 1;
      skipped += 1;
      return;
    }
    const key = scanRosterDraftMonthKey(draft);
    if (!rosters[key]) rosters[key] = {};
    if (!onCallRosters[key]) onCallRosters[key] = {};
    if (!higherDutiesRosters[key]) higherDutiesRosters[key] = {};
    rosters[key][draft.day] = draft.shiftKey;
    if (draft.onCall) onCallRosters[key][draft.day] = true;
    else delete onCallRosters[key][draft.day];
    if (draft.higherDuties) higherDutiesRosters[key][draft.day] = true;
    else delete higherDutiesRosters[key][draft.day];
    imported += 1;
  });
  saveState();
  if (document && typeof document.getElementById === "function") {
    renderCalendar();
    renderQuickGrid();
    updateSelectedCount();
    updatePayDisplay();
  }
  lastScanRosterImportSummary = { imported, skipped, ready, needsReview, conflicts, codes };
  return lastScanRosterImportSummary;
}

// ---- AI Assist: optional, offline second-opinion review layer ----
//
// AiRosterReviewService is a small provider abstraction so a real backend
// can be swapped in later without touching the merge/import logic below.
// The only provider wired up today is the offline stub: it runs entirely
// on-device, makes no network call, and never invents a date or shift code
// that is not backed by an actual token found in the OCR text. It is a
// second *opinion*, not a source of truth -- nothing it returns is ever
// selected for import automatically; see mergeScanRosterAiReview.
function stubAiRosterReviewProvider(context = {}) {
  const ocrText = String(context.ocrText || "");
  const lines = ocrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const aliases = (Array.isArray(context.aliases) ? context.aliases : scanRosterAliases()).map((alias) => normaliseScanNameToken(alias));
  const warnings = [];

  if (!lines.length) {
    return { status: "error", summary: "No OCR text was available for AI Assist to check.", suggestedShifts: [], warnings: ["No OCR text was captured for this scan."] };
  }

  const matchingLineIndexes = [];
  lines.forEach((line, index) => {
    const normalised = normaliseScanNameToken(line);
    if (aliases.some((alias) => normalisedTextHasAliasMatch(normalised, alias))) matchingLineIndexes.push(index);
  });

  if (!matchingLineIndexes.length) {
    return {
      status: "ambiguous",
      summary: "AI Assist could not find a row matching the configured name/aliases in this OCR text.",
      suggestedShifts: [],
      warnings: ["No row in the OCR text matched the configured roster name/aliases."],
    };
  }

  const matchedIndex = scanRosterIdentityLineIndex(lines, aliases);
  if (matchedIndex < 0) {
    return {
      status: "ambiguous",
      summary: "AI Assist found more than one equally-likely row for the configured name and could not safely pick one.",
      suggestedShifts: [],
      warnings: ["Two or more rows tied on the configured name/aliases -- wrong-person risk, review the roster image manually."],
    };
  }

  if (matchingLineIndexes.length > 1) {
    warnings.push("More than one row in the OCR text matched the configured name/aliases; AI Assist used the most specific match.");
  }

  const matchedLine = lines[matchedIndex];
  const header = scanRosterHeaderLine(lines);
  const dateEntries = scanRosterDatesFromHeaderLine(header);
  const matchedSegment = matchedScanRosterLineSegment(matchedLine, aliases) || rosterTextAfterMatchedAlias(matchedLine, aliases);
  // Deliberately a simpler/different extraction than the primary OCR
  // pipeline (which anchors on the first *known* code token): a plain
  // position-for-position token scan, so this second pass can surface codes
  // the primary pipeline's stricter anchoring may have skipped.
  const codeTokens = scanRosterLineCodeTokens(matchedSegment);
  const rawCodes = scanRosterRawCodesFromTokens(codeTokens);

  if (!dateEntries.length || !rawCodes.length) {
    return {
      status: "ambiguous",
      summary: "AI Assist found the configured person's row but no clear date header or shift codes to check against.",
      suggestedShifts: [],
      warnings: warnings.concat(["No usable date header and/or shift codes were found near the matched row."]),
    };
  }

  if (rawCodes.length !== dateEntries.length) {
    warnings.push("The matched row has " + rawCodes.length + " shift code(s) but the date header has " + dateEntries.length + " date(s) -- only the overlapping columns were checked.");
  }

  // Fail closed: never pair a code with a date the header does not actually
  // provide evidence for.
  const zipLength = Math.min(rawCodes.length, dateEntries.length);
  const suggestedShifts = [];
  for (let index = 0; index < zipLength; index += 1) {
    const rawCode = rawCodes[index];
    const dateEntry = dateEntries[index];
    const mapped = scanRosterShiftForCode(rawCode);
    const confidence = mapped.status !== "ready" ? "low" : (mapped.source === "mapped" ? "medium" : "high");
    suggestedShifts.push({
      date: String(dateEntry.year) + "-" + String(dateEntry.month + 1).padStart(2, "0") + "-" + String(dateEntry.day).padStart(2, "0"),
      code: rawCode,
      confidence,
      source: "ai",
      reason: mapped.status === "ready" ? "Second-pass row scan matched this date column to a recognised code." : "Second-pass row scan found this code but it is not a recognised or previously-mapped shift code.",
      requiresConfirmation: true,
    });
  }

  return {
    status: warnings.length ? "ambiguous" : "ok",
    summary: "AI Assist checked " + suggestedShifts.length + " date/code pair(s) against the matched row.",
    suggestedShifts,
    warnings,
  };
}

const AiRosterReviewService = {
  providerLabel: "Offline second-opinion check (built in) -- no cloud AI provider is connected in this build.",
  isLive: false,
  review(context) {
    return stubAiRosterReviewProvider(context);
  },
};

function scanRosterAiMergedItem(base, { source, selected, requiresConfirmation, reviewState, confidence, reason }) {
  // dateUnresolved (see scanRosterDraft) is a fail-closed invariant on the
  // underlying OCR draft, not a per-branch merge decision -- it must survive
  // AI Assist merge UNCONDITIONALLY, whichever branch (ocr-only/ai-only/
  // agreed/conflict) produced this item, and whatever selected/
  // requiresConfirmation that branch would otherwise compute. An AI-only
  // suggestion's own `base` (a freshly parsed real date, never
  // dateUnresolved) is unaffected. dateConfidence is copied alongside it so
  // any later transformation (e.g. applyScanRosterCodeMappingToDraft) still
  // has both signals available on the merged item, not just the raw draft.
  const dateUnresolved = Boolean(base.dateUnresolved);
  return {
    day: base.day,
    month: base.month,
    year: base.year,
    dateUnresolved,
    dateConfidence: base.dateConfidence,
    rawCode: base.rawCode,
    shiftKey: base.shiftKey,
    onCall: Boolean(base.onCall),
    higherDuties: Boolean(base.higherDuties),
    status: base.status,
    mappingSource: base.mappingSource,
    selected: dateUnresolved ? false : Boolean(selected),
    source,
    confidence: confidence || (base.status === "ready" ? "high" : "low"),
    reason: reason || "",
    requiresConfirmation: dateUnresolved ? true : Boolean(requiresConfirmation),
    reviewState,
  };
}

// Pure comparison/merge: takes the existing OCR drafts plus one AI provider
// result and produces the single annotated list the Review screen renders
// and importScanRosterDrafts consumes. This is the function the AI Assist
// regression tests exercise directly with synthetic AI output, independent
// of the (much fuzzier) stub provider's own OCR re-parsing.
function mergeScanRosterAiReview(ocrDrafts, aiResult) {
  const ocr = Array.isArray(ocrDrafts) ? ocrDrafts : [];
  const rawAiShifts = aiResult && Array.isArray(aiResult.suggestedShifts) ? aiResult.suggestedShifts : [];
  const warnings = Array.isArray(aiResult?.warnings) ? aiResult.warnings.slice() : [];

  const ocrByKey = new Map();
  ocr.forEach((draft) => {
    const key = scanRosterDraftMonthKey(draft) + "-" + draft.day;
    if (!ocrByKey.has(key)) ocrByKey.set(key, []);
    ocrByKey.get(key).push(draft);
  });

  const aiByKey = new Map();
  rawAiShifts.forEach((item) => {
    const parsedDate = parseDateInput(item?.date);
    const rawCode = String(item?.code || "").trim();
    const confidence = ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "";
    if (!parsedDate || !rawCode || !isLikelyRosterCodeToken(rawCode) || !confidence) {
      warnings.push("Ignored an AI Assist suggestion with an invalid or missing date/code/confidence (" + (item?.date || "?") + " " + (item?.code || "?") + ").");
      return;
    }
    const day = parsedDate.getDate();
    const month = parsedDate.getMonth();
    const year = parsedDate.getFullYear();
    const key = monthKey(year, month) + "-" + day;
    const mapped = scanRosterShiftForCode(rawCode);
    const entry = {
      day, month, year,
      rawCode: canonicalScanRosterCode(rawCode),
      shiftKey: mapped.shiftKey,
      onCall: mapped.onCall,
      higherDuties: mapped.higherDuties,
      status: mapped.status,
      mappingSource: mapped.source,
      confidence,
      reason: String(item?.reason || "").trim(),
    };
    if (!aiByKey.has(key)) aiByKey.set(key, []);
    aiByKey.get(key).push(entry);
  });

  const items = [];
  let agreedCount = 0;
  let aiOnlyCount = 0;
  let ocrOnlyCount = 0;
  let conflictCount = 0;
  const allKeys = new Set([...ocrByKey.keys(), ...aiByKey.keys()]);

  allKeys.forEach((key) => {
    const ocrEntries = ocrByKey.get(key) || [];
    const aiEntries = aiByKey.get(key) || [];

    if (ocrEntries.length && !aiEntries.length) {
      ocrOnlyCount += 1;
      ocrEntries.forEach((draft) => {
        const hasExistingReviewProtection = draft.dateUnresolved
          || draft.dateConfidence === "low"
          || draft.selected === false
          || Boolean(draft.reason)
          || Boolean(draft.requiresConfirmation)
          || Boolean(draft.reviewState);
        items.push(scanRosterAiMergedItem(draft, {
          source: "ocr",
          selected: Boolean(draft.selected) && !hasExistingReviewProtection,
          requiresConfirmation: Boolean(draft.requiresConfirmation) || draft.status !== "ready",
          reviewState: draft.reviewState || "ocr-only",
          reason: draft.reason,
        }));
      });
      return;
    }

    if (!ocrEntries.length && aiEntries.length) {
      aiOnlyCount += 1;
      aiEntries.forEach((ai) => {
        // AI-only suggestions require explicit user confirmation and are
        // never preselected, regardless of confidence.
        items.push(scanRosterAiMergedItem(ai, {
          source: "ai",
          selected: false,
          requiresConfirmation: true,
          reviewState: "ai-only",
          confidence: ai.confidence,
          reason: ai.reason,
        }));
      });
      return;
    }

    // Both OCR and AI produced something for this date. Agreement means the
    // same *resolved* shift (shiftKey/onCall/higherDuties), not the same raw
    // code string -- e.g. CZ (OCR) and CZ (AI) both resolve to off+on-call
    // and agree, while CZ vs N CZ (night+on-call) do not.
    const agreedPairs = [];
    ocrEntries.forEach((ocrDraft) => {
      const agreeing = aiEntries.find((ai) => ai.shiftKey && ai.shiftKey === ocrDraft.shiftKey && Boolean(ai.onCall) === Boolean(ocrDraft.onCall) && Boolean(ai.higherDuties) === Boolean(ocrDraft.higherDuties));
      if (agreeing) agreedPairs.push({ ocrDraft, agreeing });
    });

    if (agreedPairs.length === ocrEntries.length && agreedPairs.length === aiEntries.length) {
      agreedCount += 1;
      agreedPairs.forEach(({ ocrDraft, agreeing }) => {
        // High-confidence agreement may preselect only a previously trusted OCR
        // draft. Existing review protection is stronger evidence than the
        // second opinion: unresolved/low-confidence dates, an explicit
        // deselection, or any retained OCR warning must remain review-only.
        const hasExistingReviewProtection = ocrDraft.dateUnresolved
          || ocrDraft.dateConfidence === "low"
          || ocrDraft.selected === false
          || Boolean(ocrDraft.reason)
          || Boolean(ocrDraft.requiresConfirmation)
          || Boolean(ocrDraft.reviewState);
        const preselect = ocrDraft.status === "ready"
          && agreeing.confidence === "high"
          && !hasExistingReviewProtection;
        items.push(scanRosterAiMergedItem(ocrDraft, {
          source: "both",
          selected: preselect,
          requiresConfirmation: !preselect,
          reviewState: ocrDraft.reviewState || "agreed",
          confidence: agreeing.confidence,
          reason: ocrDraft.reason || agreeing.reason,
        }));
      });
      return;
    }

    // Conflict: OCR and AI disagree about this date. Fail closed -- both
    // sides are surfaced but neither is preselected, and they can never both
    // be imported (importScanRosterDrafts also enforces this at write time).
    conflictCount += 1;
    warnings.push("AI Assist disagrees with the scanned shift on " + key + " -- review before importing.");
    ocrEntries.forEach((draft) => {
      items.push(scanRosterAiMergedItem(draft, { source: "ocr", selected: false, requiresConfirmation: true, reviewState: "conflict" }));
    });
    aiEntries.forEach((ai) => {
      items.push(scanRosterAiMergedItem(ai, { source: "ai", selected: false, requiresConfirmation: true, reviewState: "conflict", confidence: ai.confidence, reason: ai.reason }));
    });
  });

  items.sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.day - b.day));

  return {
    items,
    warnings,
    diagnostics: {
      ocrDraftCount: ocr.length,
      aiSuggestedCount: rawAiShifts.length,
      agreedCount,
      aiOnlyCount,
      ocrOnlyCount,
      conflictCount,
      warningCount: warnings.length,
    },
  };
}

function scanRosterAiReviewContext() {
  return {
    ocrText: guidedScanSession.rawText || "",
    // Exclude pure AI-only suggestions from a prior run: they are not OCR
    // evidence, so re-running AI Assist must not let its own earlier
    // suggestions "agree" with themselves on a second pass and get
    // preselected. ocr-only/agreed/conflict entries are still backed by an
    // actual OCR draft and stay in the baseline.
    ocrDrafts: scanRosterDrafts.filter((draft) => draft.source !== "ai"),
    aliases: scanRosterAliases(),
  };
}

function runScanRosterAiAssist() {
  if (!premiumFeatureState("scannerAiAssist").allowed) {
    showToast("AI Assist is part of RosterBuddy Premium.", "info");
    return null;
  }
  // Defence in depth, same as importReviewedScanRosterDrafts: check the
  // CURRENT session's confirmation flags directly rather than trusting that
  // scanRosterDrafts is only ever non-empty when confirmed. A stale draft
  // array left over from before the date row changed must not be treated as
  // real evidence.
  if (guidedScanAwaitingConfirmation()) {
    showToast("Confirm the date row, then your row, then any extra ambiguous rows, before running AI Assist.", "warning");
    return null;
  }
  if (!scanRosterDrafts.length) {
    showToast("Scan a roster first, then run AI Assist.", "info");
    return null;
  }
  const context = scanRosterAiReviewContext();
  const providerResult = AiRosterReviewService.review(context);
  const merged = mergeScanRosterAiReview(context.ocrDrafts, providerResult);
  scanRosterDrafts = merged.items;
  scanRosterAiReview = {
    status: providerResult.status || "ok",
    summary: providerResult.summary || "",
    providerLabel: AiRosterReviewService.providerLabel,
    isLive: AiRosterReviewService.isLive,
    warnings: merged.warnings,
    diagnostics: merged.diagnostics,
  };
  appendScanRosterOcrDebug(
    "ai-assist",
    "ocrDrafts=" + merged.diagnostics.ocrDraftCount
      + ", aiSuggested=" + merged.diagnostics.aiSuggestedCount
      + ", agreed=" + merged.diagnostics.agreedCount
      + ", aiOnly=" + merged.diagnostics.aiOnlyCount
      + ", conflicts=" + merged.diagnostics.conflictCount
      + ", warnings=" + merged.diagnostics.warningCount
  );
  renderScanRosterReview();
  renderScanRosterAiReview();
  return scanRosterAiReview;
}

function normaliseTimeText(value) {
  const text = String(value || "").trim().replace(".", ":");
  const colon = text.match(/^(\d{1,2}):(\d{2})$/);
  if (colon) return colon[1].padStart(2, "0") + ":" + colon[2];
  const digits = text.replace(/\D/g, "");
  const compact = digits.match(/^(\d{1,2})(\d{2})$/);
  if (compact) return compact[1].padStart(2, "0") + ":" + compact[2];
  return text;
}

function splitTimeRange(start, finish) {
  const startText = String(start || "").trim();
  const finishText = String(finish || "").trim();

  if (startText.includes("-") || startText.includes("–")) {
    const parts = startText.split(/[-–]/).map((part) => part.trim());
    if (parts.length >= 2) return [normaliseTimeText(parts[0]), normaliseTimeText(parts[1])];
  }

  return [normaliseTimeText(startText), normaliseTimeText(finishText)];
}

function parseClock(value) {
  const match = normaliseTimeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Whole calendar days between two local dates. Uses UTC midnights so a 23h or
// 25h local day (DST change) can never shift a pay-cycle boundary by one day.
function calendarDaysBetween(from, to) {
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000);
}

function shiftHours(start, finish, breakMinutes) {
  const [startValue, finishValue] = splitTimeRange(start, finish);
  const startMinutes = parseClock(startValue);
  const finishMinutes = parseClock(finishValue);
  if (startMinutes === null || finishMinutes === null) return 0;

  let duration = finishMinutes - startMinutes;
  if (duration <= 0) duration += 24 * 60;

  const breakValue = Number(breakMinutes);
  return Math.max(0, (duration - (Number.isFinite(breakValue) ? Math.max(0, breakValue) : 0)) / 60);
}

function parseNumber(value, fallback = 0) {
  const text = String(value ?? "");
  if (!/[0-9]/.test(text)) return fallback;
  // Negative or exponent input must not be silently turned into a different positive number.
  if (/-\s*[$]?\s*[0-9.]/.test(text) || /[0-9][eE][+-]?[0-9]/.test(text)) return fallback;
  const result = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(result) ? result : fallback;
}

function formatNumber(value, decimals = 2) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(decimals)).toString();
}

function formatHours(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value) {
  return formatNumber(value, 2) + "%";
}

function formatMultiplier(value) {
  return formatNumber(value, 2) + "x";
}

function formatMoneyInput(value) {
  return "$" + formatNumber(value, 2);
}

function formatOvertimeAfter(value) {
  return formatHours(value) + " hours per fortnight";
}

function formatMinutes(value) {
  return formatHours(value) + " min";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function isWeekend(day) {
  const dayOfWeek = dayDate(day).getDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function isNightShift(key, template) {
  return key === "night" || /night/i.test(template.label);
}

function shiftTriggersAfterHours(template) {
  const start = parseClock(template.start);
  const finish = parseClock(template.finish);
  const threshold = parseClock(payRules.afterHoursStart);
  if (start === null || finish === null || threshold === null) return false;

  let adjustedFinish = finish;
  let adjustedThreshold = threshold;
  if (adjustedFinish <= start) adjustedFinish += 24 * 60;
  if (adjustedThreshold < start) adjustedThreshold += 24 * 60;
  return adjustedFinish > adjustedThreshold;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function addHoliday(holidays, date, label) {
  holidays[date.getMonth() + "-" + date.getDate()] = label;
}

function addHolidayDateKey(holidays, date, label) {
  holidays[dateKeyForDate(date)] = label;
}

function addObservedHoliday(holidays, date, label) {
  addHolidayDateKey(holidays, date, label);
  const day = date.getDay();
  if (day === 6) addHolidayDateKey(holidays, addDays(date, 2), label + " observed");
  if (day === 0) addHolidayDateKey(holidays, addDays(date, 1), label + " observed");
}

function nextAvailableObservedDate(holidays, date) {
  const candidate = new Date(date);
  while (holidays[dateKeyForDate(candidate)]) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function addChristmasBoxingDayHolidays(holidays, year) {
  const christmas = new Date(year, 11, 25);
  const boxing = new Date(year, 11, 26);
  addHolidayDateKey(holidays, christmas, "Christmas Day");
  addHolidayDateKey(holidays, boxing, "Boxing Day");
  if (christmas.getDay() === 6 || christmas.getDay() === 0) {
    addHolidayDateKey(holidays, nextAvailableObservedDate(holidays, addDays(christmas, christmas.getDay() === 6 ? 2 : 1)), "Christmas Day observed");
  }
  if (boxing.getDay() === 6 || boxing.getDay() === 0) {
    addHolidayDateKey(holidays, nextAvailableObservedDate(holidays, addDays(boxing, boxing.getDay() === 6 ? 2 : 1)), "Boxing Day observed");
  }
}

function firstWeekdayInMonth(year, month, weekday) {
  const date = new Date(year, month, 1);
  while (date.getDay() !== weekday) date.setDate(date.getDate() + 1);
  return date;
}

function secondWeekdayInMonth(year, month, weekday) {
  return addDays(firstWeekdayInMonth(year, month, weekday), 7);
}

function jurisdictionPublicHolidaysForYear(year, jurisdiction = publicHolidayJurisdiction) {
  if (jurisdiction === "manual") return {};
  const holidays = {};
  addObservedHoliday(holidays, new Date(year, 0, 1), "New Year's Day");
  addObservedHoliday(holidays, new Date(year, 0, 26), "Australia Day");
  addObservedHoliday(holidays, new Date(year, 3, 25), "Anzac Day");
  addChristmasBoxingDayHolidays(holidays, year);

  const easter = easterSunday(year);
  addHolidayDateKey(holidays, addDays(easter, -2), "Good Friday");
  addHolidayDateKey(holidays, addDays(easter, 1), "Easter Monday");

  if (jurisdiction === "tasmania") {
    addHolidayDateKey(holidays, secondWeekdayInMonth(year, 1, 1), "Royal Hobart Regatta");
    addHolidayDateKey(holidays, secondWeekdayInMonth(year, 2, 1), "Eight Hours Day");
    addHolidayDateKey(holidays, secondWeekdayInMonth(year, 5, 1), "King's Birthday");
  }
  return holidays;
}

function automaticPublicHolidaysForYear(year) {
  return jurisdictionPublicHolidaysForYear(year, publicHolidayJurisdiction);
}

function nationalPublicHolidays(year) {
  const legacy = {};
  Object.entries(automaticPublicHolidaysForYear(year)).forEach(([key, label]) => {
    const parsed = parseDateInput(key);
    if (parsed) legacy[parsed.getMonth() + "-" + parsed.getDate()] = label;
  });
  return legacy;
}

function automaticPublicHolidayLabelForDate(date) {
  return automaticPublicHolidaysForYear(date.getFullYear())[dateKeyForDate(date)] || "";
}

function publicHolidayForDay(day) {
  const date = new Date(currentYear, currentMonth, day);
  return manualPublicHolidays[dateKeyForDate(date)] ? "Manual public holiday" : automaticPublicHolidayLabelForDate(date);
}

function manualPublicHolidayDatesText() {
  return Object.keys(manualPublicHolidays).filter((key) => manualPublicHolidays[key]).sort().map(formatManualPublicHolidayDate).join(", ");
}

function setManualPublicHolidayDates(text) {
  clearObject(manualPublicHolidays);
  const invalidDates = [];
  String(text || "").split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean).forEach((value) => {
    const parsed = parseManualPublicHolidayInput(value);
    if (parsed) manualPublicHolidays[dateKeyForDate(parsed)] = true;
    else invalidDates.push(value);
  });
  if (invalidDates.length) showToast("Ignored invalid public holiday date" + (invalidDates.length === 1 ? "" : "s") + ": " + invalidDates.join(", "), "warning");
  return invalidDates;
}

function isManualPublicHolidayDate(date) {
  return Boolean(manualPublicHolidays[dateKeyForDate(date)]);
}

function isPublicHolidayDate(date) {
  return isManualPublicHolidayDate(date) || Boolean(automaticPublicHolidayLabelForDate(date));
}

function minutesOverlap(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function afterHoursMinutesForSegment(segmentStart, segmentEnd, thresholdMinutes) {
  if (thresholdMinutes === null) return 0;
  const threshold = new Date(segmentStart);
  threshold.setHours(0, thresholdMinutes, 0, 0);
  return Math.max(0, (segmentEnd - Math.max(segmentStart, threshold)) / 60000);
}

function splitShiftIntoPaidSegments(date, template) {
  const startMinutes = parseClock(template.start);
  const finishMinutes = parseClock(template.finish);
  if (startMinutes === null || finishMinutes === null) return [];
  const shiftStart = new Date(date);
  shiftStart.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  const shiftEnd = new Date(date);
  shiftEnd.setHours(Math.floor(finishMinutes / 60), finishMinutes % 60, 0, 0);
  if (shiftEnd <= shiftStart) shiftEnd.setDate(shiftEnd.getDate() + 1);
  const totalMinutes = Math.max(0, (shiftEnd - shiftStart) / 60000);
  if (!totalMinutes) return [];
  const breakMinutes = Math.min(totalMinutes, Math.max(0, Number(template.breakMinutes) || 0));
  const segments = [];
  for (let cursor = new Date(shiftStart); cursor < shiftEnd;) {
    const nextMidnight = new Date(cursor);
    nextMidnight.setHours(24, 0, 0, 0);
    const segmentEnd = new Date(Math.min(shiftEnd, nextMidnight));
    const rawMinutes = Math.max(0, (segmentEnd - cursor) / 60000);
    const paidMinutes = Math.max(0, rawMinutes - breakMinutes * (rawMinutes / totalMinutes));
    segments.push({ date: new Date(cursor), start: new Date(cursor), end: segmentEnd, rawMinutes, paidMinutes, paidHours: paidMinutes / 60 });
    cursor = segmentEnd;
  }
  return segments;
}

function scaleSegmentsToPaidHours(segments, template) {
  const templatePaidHours = Number(template.hours);
  if (!Number.isFinite(templatePaidHours) || templatePaidHours <= 0 || !segments.length) return segments;
  const totalPaidMinutes = segments.reduce((total, segment) => total + segment.paidMinutes, 0);
  if (totalPaidMinutes <= 0) return segments;
  const scale = (templatePaidHours * 60) / totalPaidMinutes;
  return segments.map((segment) => {
    const scaledPaidMinutes = segment.paidMinutes * scale;
    return {
      ...segment,
      paidMinutes: scaledPaidMinutes,
      paidHours: scaledPaidMinutes / 60,
    };
  });
}

function calculateShiftPaySegments(date, template) {
  const thresholdMinutes = parseClock(payRules.afterHoursStart);
  return scaleSegmentsToPaidHours(splitShiftIntoPaidSegments(date, template), template).map((segment) => {
    const afterRawMinutes = afterHoursMinutesForSegment(segment.start, segment.end, thresholdMinutes);
    const afterHours = segment.rawMinutes ? (afterRawMinutes * (segment.paidMinutes / segment.rawMinutes)) / 60 : 0;
    const day = segment.date.getDay();
    const publicHoliday = isPublicHolidayDate(segment.date);
    return {
      ...segment,
      afterHours,
      saturdayHours: !publicHoliday && day === 6 ? segment.paidHours : 0,
      sundayHours: !publicHoliday && day === 0 ? segment.paidHours : 0,
      publicHolidayHours: publicHoliday ? segment.paidHours : 0,
    };
  });
}

function calculateMonthlyStats() {
  return calculateRosterStatsForRange(new Date(currentYear, currentMonth, 1), new Date(currentYear, currentMonth + 1, 0));
}

function getRosterForDate(date) {
  return rosters[monthKeyForDate(date)] || {};
}

function allRosteredDates() {
  return Object.entries(rosters).flatMap(([key, roster]) => {
    const parts = key.split("-").map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return [];
    return Object.entries(roster || {}).filter(([, shiftKey]) => templates[shiftKey]).map(([day]) => new Date(parts[0], parts[1] - 1, Number(day)));
  }).filter((date) => !Number.isNaN(date.getTime())).sort((a, b) => a - b);
}

function rosteredDatesInRange(startDate, endDate) {
  return allRosteredDates().filter((date) => date >= startDate && date <= endDate);
}

function visibleCycleStartDate(cycleLength) {
  const cycleStart = parseDateInput(payCycleStartDate);
  if (!cycleStart) return null;
  const visibleStart = new Date(currentYear, currentMonth, 1);
  const visibleEnd = new Date(currentYear, currentMonth + 1, 0);
  const daysToVisibleMonth = calendarDaysBetween(cycleStart, visibleStart);
  const cyclesToVisibleMonth = Math.max(0, Math.ceil(daysToVisibleMonth / cycleLength));
  const visibleCycleStart = addDays(cycleStart, cyclesToVisibleMonth * cycleLength);
  return visibleCycleStart <= visibleEnd ? visibleCycleStart : null;
}

function findPayPeriodTargetDate(cycleLength) {
  const selectedDate = dayDate(selectedEntryDay);
  const visibleCycleStart = visibleCycleStartDate(cycleLength);
  const isFutureVisibleCycleStart = visibleCycleStart && visibleCycleStart > selectedDate;
  if (isFutureVisibleCycleStart) return visibleCycleStart;
  const visibleStart = new Date(currentYear, currentMonth, 1);
  const visibleEnd = new Date(currentYear, currentMonth + 1, 0);
  const visibleRostered = rosteredDatesInRange(visibleStart, visibleEnd);
  const selectedHasRoster = Boolean(getRosterForDate(selectedDate)[selectedDate.getDate()]);
  if (selectedHasRoster) return selectedDate;
  const sameCycle = visibleRostered.find((date) => {
    const selectedCycle = Math.floor(calendarDaysBetween(parseDateInput(payCycleStartDate) || visibleStart, selectedDate) / cycleLength);
    const dateCycle = Math.floor(calendarDaysBetween(parseDateInput(payCycleStartDate) || visibleStart, date) / cycleLength);
    return selectedCycle === dateCycle;
  });
  return sameCycle || selectedDate;
}

function isCasualDate(date) {
  return Boolean((casualRosters[monthKeyForDate(date)] || {})[date.getDate()]);
}

function isHigherDutiesDate(date) {
  return Boolean((higherDutiesRosters[monthKeyForDate(date)] || {})[date.getDate()]);
}

function isOnCallDate(date) {
  return Boolean((onCallRosters[monthKeyForDate(date)] || {})[date.getDate()]);
}

function additionalHoursForDate(date) {
  const entry = (additionalHoursRosters[monthKeyForDate(date)] || {})[date.getDate()];
  if (!entry || typeof entry !== "object") return { hours: 0, doubleTime: false };
  return { hours: Math.max(0, Number(entry.hours) || 0), doubleTime: Boolean(entry.doubleTime) };
}

function baseRateForManualExtras() {
  const mainRate = Number(payProfiles.main?.rate);
  return Number.isFinite(mainRate) && mainRate > 0 ? mainRate : payRules.baseRate;
}

function rateForDate(date) {
  const profile = isHigherDutiesDate(date) ? payProfiles.higher : payProfiles.main;
  const rate = Number(profile?.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : payRules.baseRate;
}

function calculateRosterStatsForRange(startDate, endDate) {
  let hours = 0;
  let nights = 0;
  let leaveDays = 0;
  let saturdayHours = 0;
  let sundayHours = 0;
  let afterHours = 0;
  let casualHours = 0;
  let publicHolidayHours = 0;
  let basePay = 0;
  let nightPay = 0;
  let casualPay = 0;
  let saturdayPay = 0;
  let sundayPay = 0;
  let publicHolidayPay = 0;
  let additionalHours = 0;
  let additionalHoursPay = 0;
  let onCallDays = 0;
  let onCallPay = 0;

  for (let date = new Date(startDate); date <= endDate; date = addDays(date, 1)) {
    const shiftKey = getRosterForDate(date)[date.getDate()];
    const template = templates[shiftKey];
    const extra = additionalHoursForDate(date);
    if (extra.hours > 0) {
      const manualRate = baseRateForManualExtras();
      additionalHours += extra.hours;
      additionalHoursPay += extra.hours * manualRate * (extra.doubleTime ? 2 : 1);
    }
    if (isOnCallDate(date)) {
      onCallDays += 1;
      onCallPay += Math.max(0, Number(payRules.onCallAllowance) || 0);
    }
    if (!template) continue;

    if (template.type === "leave") leaveDays += 1;
    if (isNightShift(shiftKey, template)) nights += 1;
    if (template.type !== "work") continue;

    const rate = rateForDate(date);
    const segments = calculateShiftPaySegments(date, template);
    segments.forEach((segment) => {
      hours += segment.paidHours;
      saturdayHours += segment.saturdayHours;
      sundayHours += segment.sundayHours;
      afterHours += segment.afterHours;
      publicHolidayHours += segment.publicHolidayHours;
      if (isCasualDate(date)) casualHours += segment.paidHours;

      basePay += segment.paidHours * rate;
      nightPay += segment.afterHours * rate * payRules.nightLoading;
      if (isCasualDate(date)) casualPay += segment.paidHours * rate * FIXED_CASUAL_LOADING;
      saturdayPay += segment.saturdayHours * rate * payRules.saturdayExtra;
      sundayPay += segment.sundayHours * rate * payRules.sundayExtra;
      publicHolidayPay += segment.publicHolidayHours * rate * Math.max(0, payRules.publicHolidayMultiplier - 1);
    });
  }

  const weekendPay = saturdayPay + sundayPay;
  const gross = basePay + nightPay + casualPay + weekendPay + publicHolidayPay + additionalHoursPay + onCallPay;
  const averageRate = hours > 0 ? basePay / hours : payRules.baseRate;

  return { hours, rosteredHours: hours, additionalHours, totalHours: hours + additionalHours, nights, leaveDays, afterHours, casualHours, saturdayHours, sundayHours, publicHolidayHours, nightPay, casualPay, weekendPay, publicHolidayPay, additionalHoursPay, onCallDays, onCallPay, gross, basePay, averageRate, startDate, endDate };
}

function selectedPeriodRange(offset = 0) {
  if (selectedPayPeriod === "monthly") {
    return {
      startDate: new Date(currentYear, currentMonth, 1),
      endDate: new Date(currentYear, currentMonth + 1, 0),
    };
  }

  const cycleLength = payPeriods[selectedPayPeriod].days;
  const fallbackStart = new Date(currentYear, currentMonth, 1);
  const cycleStart = parseDateInput(payCycleStartDate) || fallbackStart;
  const target = findPayPeriodTargetDate(cycleLength);
  const daysSinceStart = calendarDaysBetween(cycleStart, target);
  const cyclesSinceStart = Math.floor(daysSinceStart / cycleLength);
  const viewOffset = selectedPayPeriod === "fortnightly" ? Math.max(0, Number(offset) || 0) : 0;
  const startDate = addDays(cycleStart, (cyclesSinceStart + viewOffset) * cycleLength);
  const endDate = addDays(startDate, cycleLength - 1);
  return { startDate, endDate };
}

function estimateAnnualTaxFromBrackets(annualTaxableGross, taxFreeThreshold = true) {
  const taxable = Math.max(0, annualTaxableGross);
  if (!taxFreeThreshold) {
    if (taxable <= 45000) return taxable * 0.16;
    if (taxable <= 135000) return 7200 + (taxable - 45000) * 0.30;
    if (taxable <= 190000) return 34200 + (taxable - 135000) * 0.37;
    return 54550 + (taxable - 190000) * 0.45;
  }
  if (taxable <= 18200) return 0;
  if (taxable <= 45000) return (taxable - 18200) * 0.16;
  if (taxable <= 135000) return 4288 + (taxable - 45000) * 0.30;
  if (taxable <= 190000) return 31288 + (taxable - 135000) * 0.37;
  return 51638 + (taxable - 190000) * 0.45;
}

function estimateMedicareLevyFromAnnualIncome(annualTaxableGross) {
  return Math.max(0, annualTaxableGross) * 0.02;
}

function estimatePaygTax(taxableGross, periodKey = selectedPayPeriod, taxFreeThreshold = payRules.taxFreeThreshold) {
  const periodWeeks = periodKey === "weekly" ? 1 : periodKey === "monthly" ? 52 / 12 : 2;
  const annualTaxableGross = Math.max(0, taxableGross) / periodWeeks * 52;
  const annualTax = estimateAnnualTaxFromBrackets(annualTaxableGross, taxFreeThreshold) + estimateMedicareLevyFromAnnualIncome(annualTaxableGross);
  return Math.min(Math.max(0, taxableGross), Math.round(annualTax / 52 * periodWeeks));
}

function calculateTaxForMethod(taxableGross, periodKey = selectedPayPeriod) {
  const method = payRules.taxMethod || "percentage";
  if (method === "manual") return Math.min(Math.max(0, taxableGross), Math.max(0, payRules.paygTaxOverride || 0));
  if (method === "payg") return estimatePaygTax(taxableGross, periodKey, payRules.taxFreeThreshold !== false);
  return Math.min(Math.max(0, taxableGross), Math.max(0, taxableGross * payRules.taxRate));
}

function calculateStats() {
  const monthly = calculateMonthlyStats();
  const range = selectedPeriodRange(payCycleViewOffset);
  const period = calculateRosterStatsForRange(range.startDate, range.endDate);
  const thresholdFactor = selectedPayPeriod === "weekly" ? 0.5 : selectedPayPeriod === "monthly" ? 2 : 1;
  const monthlyOvertimeHours = Math.max(0, monthly.hours - payRules.overtimeAfterHours * 2);
  const monthlyOvertimePay = monthlyOvertimeHours * monthly.averageRate * Math.max(0, payRules.overtimeMultiplier - 1);
  const monthlyGross = monthly.gross + monthlyOvertimePay;
  const monthlySalarySacrifice = Math.min(monthlyGross, payRules.salarySacrifice);
  const monthlyMealsEntertainmentSacrifice = Math.min(
    Math.max(0, monthlyGross - monthlySalarySacrifice),
    payRules.mealsEntertainmentSacrifice,
  );
  const monthlyPackageValue = monthlySalarySacrifice + monthlyMealsEntertainmentSacrifice;
  const monthlyTaxableGross = Math.max(0, monthlyGross - monthlyPackageValue);
  const monthlyTax = calculateTaxForMethod(monthlyTaxableGross, "monthly");
  const monthlyAdditionalTax = Math.min(monthlyTaxableGross, payRules.additionalTax);
  const monthlyNet = Math.max(0, monthlyTaxableGross - monthlyTax - monthlyAdditionalTax);
  const monthlyUsableTakeHome = monthlyNet + monthlyPackageValue;
  const periodRosteredHours = period.rosteredHours;
  const periodAdditionalHours = period.additionalHours;
  const periodHours = period.totalHours;
  const overtimeThreshold = payRules.overtimeAfterHours * thresholdFactor;
  const periodOvertimeHours = Math.max(0, periodRosteredHours - overtimeThreshold);
  const periodBasePay = period.basePay;
  const periodOvertimePay = periodOvertimeHours * period.averageRate * Math.max(0, payRules.overtimeMultiplier - 1);
  const periodNightPay = period.nightPay;
  const periodCasualPay = period.casualPay;
  const periodWeekendPay = period.weekendPay;
  const periodPublicHolidayPay = period.publicHolidayPay;
  const periodAdditionalHoursPay = period.additionalHoursPay;
  const periodOnCallPay = period.onCallPay;
  const gross = periodBasePay + periodNightPay + periodCasualPay + periodWeekendPay + periodPublicHolidayPay + periodOvertimePay + periodAdditionalHoursPay + periodOnCallPay;
  const salarySacrifice = Math.min(gross, payRules.salarySacrifice);
  const mealsEntertainmentSacrifice = Math.min(
    Math.max(0, gross - salarySacrifice),
    payRules.mealsEntertainmentSacrifice,
  );
  const packageValue = salarySacrifice + mealsEntertainmentSacrifice;
  const taxableGross = Math.max(0, gross - packageValue);
  const tax = calculateTaxForMethod(taxableGross, selectedPayPeriod);
  const additionalTax = Math.min(taxableGross, payRules.additionalTax);
  const net = Math.max(0, taxableGross - tax - additionalTax);
  const usableTakeHome = net + packageValue;

  return {
    ...monthly,
    periodStartDate: range.startDate,
    periodEndDate: range.endDate,
    periodGross: gross,
    periodSalarySacrifice: salarySacrifice,
    periodMealsEntertainmentSacrifice: mealsEntertainmentSacrifice,
    periodPackageValue: packageValue,
    periodTaxableGross: taxableGross,
    periodTax: tax,
    periodTaxMethod: payRules.taxMethod || "percentage",
    periodAdditionalTax: additionalTax,
    periodNet: net,
    periodUsableTakeHome: usableTakeHome,
    periodHours,
    periodRosteredHours,
    periodAdditionalHours,
    periodAdditionalHoursPay,
    periodOnCallDays: period.onCallDays,
    periodOnCallPay,
    periodNights: period.nights,
    periodBasePay,
    periodNightPay,
    periodCasualPay,
    periodWeekendPay,
    periodPublicHolidayPay,
    periodOvertimePay,
    periodOvertimeHours,
    monthlyGross,
    monthlyNet,
    monthlyPackageValue,
    monthlyUsableTakeHome,
    monthlyOvertimeHours,
  };
}

function setPayCycleViewOffset(offset) {
  // Choosing Current/Next fortnight always means a fortnightly view, so the
  // selector is usable even when Weekly or Monthly was last picked.
  const wasFortnightly = selectedPayPeriod === "fortnightly";
  selectedPayPeriod = "fortnightly";
  payCycleViewOffset = Math.max(0, Number(offset) || 0);
  if (!wasFortnightly) {
    document.querySelectorAll("[data-period]").forEach((item) => {
      item.classList.toggle("active", item.dataset.period === selectedPayPeriod);
    });
    saveState();
  }
  syncPayCycleViewControls();
  updatePayDisplay();
}

function syncPayCycleViewControls() {
  if (selectedPayPeriod !== "fortnightly") payCycleViewOffset = 0;
  const showingCycle = selectedPayPeriod === "fortnightly";
  document.querySelectorAll("[data-pay-cycle-offset]").forEach((button) => {
    const active = showingCycle && Number(button.dataset.payCycleOffset) === payCycleViewOffset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function updatePayDisplay() {
  const stats = calculateStats();
  const period = payPeriods[selectedPayPeriod].label.toLowerCase();
  const isNextFortnight = selectedPayPeriod === "fortnightly" && payCycleViewOffset > 0;
  const cycleLabel = isNextFortnight ? "Next fortnight" : payPeriods[selectedPayPeriod].label;

  // A baseRate <= 0 means pay has never been configured (see
  // applyFreshInstallDefaults) rather than a genuinely zero rate, so the two
  // headline earnings figures must not present an authoritative-looking
  // $0.00. The detailed per-category breakdown rows below stay as plain
  // money() -- they are all consistently zero in that state, which is
  // truthful, not misleading.
  const payConfigured = Number(payRules.baseRate) > 0;
  const payNotSetUpLabel = "Pay not set up";
  syncPayCycleViewControls();
  document.getElementById("period-rostered-hours").textContent = formatHours(stats.periodRosteredHours);
  document.getElementById("period-additional-hours").textContent = formatHours(stats.periodAdditionalHours);
  document.getElementById("period-total-hours").textContent = formatHours(stats.periodHours);
  document.getElementById("pay-hero-total").textContent = payConfigured ? money(stats.periodUsableTakeHome) : payNotSetUpLabel;
  document.getElementById("pay-hero-label").textContent = payConfigured
    ? ("True usable " + (isNextFortnight ? "next fortnight" : period) + " value")
    : "Estimates only — set your pay rate in Settings";
  document.getElementById("pay-hero-detail").textContent = payConfigured
    ? (money(stats.periodNet) + " employer bank deposit · " + money(stats.periodPackageValue) + " salary sacrifice value · " + money(stats.periodGross) + " gross")
    : "Add a pay rate in Settings → Pay rules to see estimates.";
  const cycleName = selectedPayPeriod === "fortnightly" ? (isNextFortnight ? "Next fortnight" : "Current fortnight") : cycleLabel;
  document.getElementById("pay-cycle-name").textContent = cycleName;
  document.getElementById("pay-cycle-detail").textContent = formatCompactDateRange(stats.periodStartDate, stats.periodEndDate) + (selectedPayPeriod === "fortnightly" ? (isNextFortnight ? " · Upcoming, rostered so far" : " · In progress") : "");
  document.querySelectorAll("#screen-pay .optional-row").forEach((row) => {
    const value = row.querySelector("strong");
    row.classList.toggle("is-zero", Boolean(value) && !/[1-9]/.test(value.textContent));
  });
  document.getElementById("base-pay").textContent = money(stats.periodBasePay);
  document.getElementById("night-pay").textContent = money(stats.periodNightPay);
  document.getElementById("casual-pay").textContent = money(stats.periodCasualPay);
  document.getElementById("weekend-pay").textContent = money(stats.periodWeekendPay);
  document.getElementById("public-holiday-pay").textContent = money(stats.periodPublicHolidayPay);
  document.getElementById("additional-hours-pay").textContent = money(stats.periodAdditionalHoursPay);
  document.getElementById("on-call-pay").textContent = money(stats.periodOnCallPay);
  document.getElementById("overtime-pay").textContent = money(stats.periodOvertimePay);
  document.getElementById("gross-pay").textContent = money(stats.periodGross);
  document.getElementById("salary-sacrifice-pay").textContent = "-" + money(stats.periodSalarySacrifice);
  document.getElementById("meals-entertainment-pay").textContent = "-" + money(stats.periodMealsEntertainmentSacrifice);
  document.getElementById("tax-pay").textContent = "-" + money(stats.periodTax);
  document.getElementById("extra-tax-pay").textContent = "-" + money(stats.periodAdditionalTax);
  document.getElementById("net-pay").textContent = money(stats.periodNet);
  document.getElementById("package-value-pay").textContent = money(stats.periodPackageValue);
  document.getElementById("usable-pay").textContent = money(stats.periodUsableTakeHome);
  document.getElementById("pay-period-copy").textContent = payPeriods[selectedPayPeriod].label;
  document.getElementById("settings-pay-rate").textContent = money(payProfiles.main.rate) + "/hr main";
  updateRecoveryDisplay();
}

function saveManualPublicHolidayDraft() {
  setManualPublicHolidayDates(document.getElementById("public-holiday-dates").value);
  document.getElementById("public-holiday-dates").value = manualPublicHolidayDatesText();
  saveState();
  updatePayDisplay();
}

function applyPayCycleStartDate(value) {
  const nextStart = parseDateInput(value);
  if (!nextStart) {
    document.getElementById("pay-cycle-start").value = payCycleStartDate;
    return false;
  }
  payCycleStartDate = dateKeyForDate(nextStart);
  if (nextStart.getFullYear() === currentYear && nextStart.getMonth() === currentMonth) {
    selectedEntryDay = nextStart.getDate();
  }
  document.getElementById("pay-cycle-start").value = payCycleStartDate;
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
  return true;
}

function savePayRules() {
  applyPayCycleStartDate(document.getElementById("pay-cycle-start").value);
  const mainRate = parseNumber(document.getElementById("pay-profile-main-rate").value, payProfiles.main.rate);
  const higherRate = parseNumber(document.getElementById("pay-profile-higher-rate").value, payProfiles.higher.rate);
  payProfiles = {
    main: { label: "Main role", rate: mainRate },
    higher: { label: "Higher duties", rate: higherRate },
  };
  payRules = {
    baseRate: mainRate,
    nightLoading: parseNumber(document.getElementById("night-rate").value, 0) / 100,
    afterHoursStart: normaliseTimeText(document.getElementById("after-hours-start").value) || "19:00",
    saturdayExtra: Math.max(0, parseNumber(document.getElementById("sat-rate").value, 1.5) - 1),
    sundayExtra: Math.max(0, parseNumber(document.getElementById("sun-rate").value, 1.75) - 1),
    overtimeAfterHours: parseNumber(document.getElementById("overtime-after").value, 76),
    overtimeMultiplier: parseNumber(document.getElementById("overtime-rate").value, 1.5),
    taxMethod: document.getElementById("tax-method").value || "payg",
    taxRate: parseNumber(document.getElementById("tax-rate").value, 22) / 100,
    taxFreeThreshold: document.getElementById("tax-free-threshold").checked,
    paygTaxOverride: parseNumber(document.getElementById("payg-tax-override").value, 0),
    salarySacrifice: parseNumber(document.getElementById("salary-sacrifice").value, 0),
    mealsEntertainmentSacrifice: parseNumber(document.getElementById("meals-entertainment-sacrifice").value, 0),
    additionalTax: parseNumber(document.getElementById("extra-tax").value, 0),
    publicHolidayMultiplier: parseNumber(document.getElementById("public-holiday-rate").value, 2.5),
    onCallAllowance: parseNumber(document.getElementById("on-call-allowance").value, 0),
  };
  setManualPublicHolidayDates(document.getElementById("public-holiday-dates").value);
  publicHolidayJurisdiction = document.getElementById("public-holiday-jurisdiction").value || "tasmania";
  formatPayRuleInputs();
  saveState();
  updatePayDisplay();
  showScreen("pay");
}

function formatPayRuleInputs() {
  document.getElementById("pay-profile-main-rate").value = formatMoneyInput(parseNumber(document.getElementById("pay-profile-main-rate").value, payProfiles.main.rate));
  document.getElementById("pay-profile-higher-rate").value = formatMoneyInput(parseNumber(document.getElementById("pay-profile-higher-rate").value, payProfiles.higher.rate));
  document.getElementById("sat-rate").value = formatMultiplier(parseNumber(document.getElementById("sat-rate").value, payRules.saturdayExtra + 1));
  document.getElementById("sun-rate").value = formatMultiplier(parseNumber(document.getElementById("sun-rate").value, payRules.sundayExtra + 1));
  document.getElementById("night-rate").value = formatPercent(parseNumber(document.getElementById("night-rate").value, payRules.nightLoading * 100));
  document.getElementById("after-hours-start").value = normaliseTimeText(document.getElementById("after-hours-start").value) || payRules.afterHoursStart;
  document.getElementById("pay-cycle-start").value = payCycleStartDate;
  document.getElementById("overtime-after").value = formatOvertimeAfter(parseNumber(document.getElementById("overtime-after").value, payRules.overtimeAfterHours));
  document.getElementById("overtime-rate").value = formatMultiplier(parseNumber(document.getElementById("overtime-rate").value, payRules.overtimeMultiplier));
  document.getElementById("default-break").value = formatMinutes(parseNumber(document.getElementById("default-break").value, 30));
  document.getElementById("tax-method").value = payRules.taxMethod || "payg";
  document.getElementById("tax-rate").value = formatPercent(parseNumber(document.getElementById("tax-rate").value, payRules.taxRate * 100));
  document.getElementById("tax-free-threshold").checked = payRules.taxFreeThreshold !== false;
  document.getElementById("payg-tax-override").value = formatMoneyInput(parseNumber(document.getElementById("payg-tax-override").value, payRules.paygTaxOverride || 0));
  document.getElementById("salary-sacrifice").value = formatMoneyInput(parseNumber(document.getElementById("salary-sacrifice").value, payRules.salarySacrifice));
  document.getElementById("meals-entertainment-sacrifice").value = formatMoneyInput(parseNumber(document.getElementById("meals-entertainment-sacrifice").value, payRules.mealsEntertainmentSacrifice));
  document.getElementById("extra-tax").value = formatMoneyInput(parseNumber(document.getElementById("extra-tax").value, payRules.additionalTax));
  document.getElementById("public-holiday-rate").value = formatMultiplier(parseNumber(document.getElementById("public-holiday-rate").value, payRules.publicHolidayMultiplier));
  document.getElementById("on-call-allowance").value = formatMoneyInput(parseNumber(document.getElementById("on-call-allowance").value, payRules.onCallAllowance || 0));
  document.getElementById("public-holiday-jurisdiction").value = publicHolidayJurisdiction;
  document.getElementById("public-holiday-dates").value = manualPublicHolidayDatesText();
}

function populatePayRuleInputs() {
  document.getElementById("pay-profile-main-rate").value = formatMoneyInput(payProfiles.main.rate);
  document.getElementById("pay-profile-higher-rate").value = formatMoneyInput(payProfiles.higher.rate);
  document.getElementById("sat-rate").value = formatMultiplier(payRules.saturdayExtra + 1);
  document.getElementById("sun-rate").value = formatMultiplier(payRules.sundayExtra + 1);
  document.getElementById("night-rate").value = formatPercent(payRules.nightLoading * 100);
  document.getElementById("after-hours-start").value = payRules.afterHoursStart;
  document.getElementById("pay-cycle-start").value = payCycleStartDate;
  document.getElementById("overtime-after").value = formatOvertimeAfter(payRules.overtimeAfterHours);
  document.getElementById("overtime-rate").value = formatMultiplier(payRules.overtimeMultiplier);
  document.getElementById("default-break").value = formatMinutes(parseNumber(document.getElementById("default-break").value, 30));
  document.getElementById("tax-method").value = payRules.taxMethod || "payg";
  document.getElementById("tax-rate").value = formatPercent(payRules.taxRate * 100);
  document.getElementById("tax-free-threshold").checked = payRules.taxFreeThreshold !== false;
  document.getElementById("payg-tax-override").value = formatMoneyInput(payRules.paygTaxOverride || 0);
  document.getElementById("salary-sacrifice").value = formatMoneyInput(payRules.salarySacrifice);
  document.getElementById("meals-entertainment-sacrifice").value = formatMoneyInput(payRules.mealsEntertainmentSacrifice);
  document.getElementById("extra-tax").value = formatMoneyInput(payRules.additionalTax);
  document.getElementById("public-holiday-rate").value = formatMultiplier(payRules.publicHolidayMultiplier);
  document.getElementById("on-call-allowance").value = formatMoneyInput(payRules.onCallAllowance || 0);
  document.getElementById("public-holiday-jurisdiction").value = publicHolidayJurisdiction;
  document.getElementById("public-holiday-dates").value = manualPublicHolidayDatesText();
}

function bindPayRuleFormatting() {
  [
    "pay-profile-main-rate",
    "pay-profile-higher-rate",
    "sat-rate",
    "sun-rate",
    "night-rate",
    "after-hours-start",
    "overtime-after",
    "overtime-rate",
    "default-break",
    "tax-rate",
    "payg-tax-override",
    "salary-sacrifice",
    "meals-entertainment-sacrifice",
    "extra-tax",
    "public-holiday-rate",
    "on-call-allowance",
  ].forEach((id) => {
    document.getElementById(id).addEventListener("blur", formatPayRuleInputs);
  });
  document.getElementById("public-holiday-dates").addEventListener("change", saveManualPublicHolidayDraft);
  document.getElementById("pay-cycle-start").addEventListener("change", (event) => {
    applyPayCycleStartDate(event.target.value);
  });
  document.getElementById("public-holiday-jurisdiction").addEventListener("change", (event) => {
    publicHolidayJurisdiction = event.target.value || "tasmania";
    saveState();
    renderCalendar();
    updatePayDisplay();
  });
}

function syncCalendarDetailsControl() {
  const details = document.getElementById("calendar-details");
  const content = document.getElementById("calendar-details-content");
  const toggle = document.getElementById("toggle-calendar-details");
  if (!details || !content || !toggle) return;
  details.classList.toggle("is-collapsed", calendarDetailsCollapsed);
  content.classList.toggle("hidden-control", calendarDetailsCollapsed);
  toggle.setAttribute("aria-expanded", String(!calendarDetailsCollapsed));
  const label = calendarDetailsCollapsed ? "Show shift legend" : "Hide shift legend";
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("title", label);
  toggle.classList.toggle("is-collapsed", calendarDetailsCollapsed);
}

function toggleCalendarDetails() {
  calendarDetailsCollapsed = !calendarDetailsCollapsed;
  syncCalendarDetailsControl();
  saveState();
}

function renderCalendar(direction = 0) {
  refreshMonthLabels();
  const grid = document.getElementById("calendar-grid");
  grid.classList.remove("month-slide-next", "month-slide-prev", "month-slide-out-next", "month-slide-out-prev", "month-dragging");
  grid.style.removeProperty("--month-drag-x");
  grid.innerHTML = "";
  if (calendarViewProjection) {
    renderSharedCalendar(grid, direction);
    return;
  }
  const roster = currentRoster();
  const emptyState = document.getElementById("calendar-empty-state");
  const hasShifts = Object.values(roster).some((shiftKey) => Boolean(shiftKey && templates[shiftKey]));
  if (emptyState) emptyState.classList.toggle("hidden-control", hasShifts);
  const offset = firstDayOffset();
  const days = daysInCurrentMonth();
  const totalCells = Math.ceil((offset + days) / 7) * 7;
  grid.dataset.rows = String(totalCells / 7);
  const cycleRange = selectedPeriodRange(0);
  const cycleStartKey = dateKeyForDate(cycleRange.startDate);
  const cycleEndKey = dateKeyForDate(cycleRange.endDate);

  for (let cell = 0; cell < totalCells; cell += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day";
    const day = cell - offset + 1;

    if (day < 1 || day > days) {
      button.classList.add("empty");
      button.innerHTML = "<strong></strong>";
      button.disabled = true;
      grid.appendChild(button);
      continue;
    }

    const cellKey = dateKey(day);
    button.classList.toggle("cyc-d", cellKey >= cycleStartKey && cellKey <= cycleEndKey);
    const shiftKey = roster[day];
    const shift = shiftKey ? templates[shiftKey] : null;
    const isToday = day === selectedEntryDay;
    const cellDate = dayDate(day);
    const isCurrentDate = sameLocalDate(cellDate, new Date());
    const holiday = publicHolidayForDay(day);
    const reminder = getActiveReminder(day);
    const note = getDayNote(day);
    const casual = shift && isCasualDay(day);
    const higherDuties = shift && isHigherDutiesDay(day);
    const onCall = isOnCallDay(day);
    const extraHours = additionalHoursForDate(dayDate(day)).hours > 0;

    button.classList.toggle("entry-target", isToday);
    button.classList.toggle("today", isCurrentDate);
    button.classList.toggle("holiday", Boolean(holiday));
    const calendarCode = shift ? calendarShiftCode(shiftKey, shift) : "";
    const markerHtml = (shift || onCall || extraHours) && (casual || higherDuties || onCall || extraHours)
      ? "<span class=\"calendar-marker-row\">" + (casual ? "<i class=\"casual-pill\">CAS</i>" : "") + (higherDuties ? "<i class=\"on-call-pill\">HD</i>" : "") + (onCall ? "<i class=\"on-call-pill\">OC</i>" : "") + (extraHours ? "<i class=\"on-call-pill\">+H</i>" : "") + "</span>"
      : "";
    const calendarTextHtml = calendarCode ? "<em class=\"calendar-main-marker\">" + escapeHtml(calendarCode) + "</em>" : "";
    button.innerHTML = "<strong>" + day + "</strong>" + (note ? "<i class=\"nd\" aria-hidden=\"true\"></i>" : "") +
      (shift ? "<span class=\"badge " + shift.colour + (markerHtml ? " has-markers" : "") + "\">" + calendarTextHtml + markerHtml + "</span>" : (markerHtml ? "<span class=\"day-meta note-meta\">" + markerHtml + "</span>" : "")) +
      (holiday ? "<span class=\"day-meta holiday-meta\">" + escapeHtml(holiday) + "</span>" : "") +
      (reminder ? "<span class=\"day-meta reminder-meta\">🔔 " + escapeHtml(reminder.text) + "</span>" : "");
    button.addEventListener("click", () => {
      if (calendarViewReadOnly) return;
      // Tapping a date only selects it; the selected-day strip's "Edit shifts"
      // action opens the editor.
      selectEntryDay(day);
      renderCalendar();
    });
    grid.appendChild(button);
  }
  if (direction) {
    window.clearTimeout(monthAnimationTimer);
    void grid.offsetWidth;
    grid.classList.add(direction > 0 ? "month-slide-next" : "month-slide-prev");
    monthAnimationTimer = window.setTimeout(() => grid.classList.remove("month-slide-next", "month-slide-prev"), 360);
  }
  renderCalendarLegend();
  renderCalendarSummary();
  renderCalendarDayStrip();
  renderCalendarPayCycle(cycleRange);
}

function renderCalendarPayCycle(range) {
  const pill = document.getElementById("calendar-pay-cycle");
  if (!pill) return;
  const cycle = range || selectedPeriodRange(0);
  pill.textContent = "Pay cycle: " + formatDateRange(cycle.startDate, cycle.endDate).replace(" - ", " – ");
}

function renderCalendarSummary() {
  const hours = document.getElementById("calendar-summary-hours");
  const net = document.getElementById("calendar-summary-net");
  const nights = document.getElementById("calendar-summary-nights");
  if (!hours || !net || !nights) return;
  const stats = calculateStats();
  const payConfigured = Number(payRules.baseRate) > 0;
  hours.textContent = formatHours(stats.periodHours) + "h";
  net.textContent = payConfigured ? money(stats.periodUsableTakeHome).replace(/\.\d{2}$/, "") : "Not set";
  nights.textContent = String(stats.periodNights);
}

function renderCalendarDayStrip() {
  const title = document.getElementById("calendar-day-strip-title");
  const detail = document.getElementById("calendar-day-strip-detail");
  const badge = document.getElementById("calendar-day-strip-badge");
  if (!title || !detail) return;
  const day = selectedEntryDay;
  const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "short" }).format(dayDate(day));
  title.textContent = weekday + " " + dayLabel(day) + (sameLocalDate(dayDate(day), new Date()) ? " · Today" : "");
  const shiftKey = getShiftKey(day);
  const shift = shiftKey ? templates[shiftKey] : null;
  const parts = [];
  if (shift) {
    const code = calendarShiftCode(shiftKey, shift);
    const name = String(shift.label || "").trim();
    parts.push(name && name.toUpperCase() !== code.toUpperCase() ? name : code);
    if (shift.start && shift.finish) parts.push(shift.start + "–" + shift.finish);
    if (Number(shift.hours) > 0) parts.push(formatHours(shift.hours) + " h");
    if (isCasualDay(day)) parts.push("Casual");
    if (isHigherDutiesDay(day)) parts.push("Higher duties");
  } else {
    parts.push("No shift");
  }
  if (isOnCallDay(day)) parts.push("On-call");
  const holiday = publicHolidayForDay(day);
  if (holiday) parts.push(holiday);
  detail.textContent = parts.join(" · ");
  if (badge) {
    badge.className = "dbadge " + (shift ? "badge " + shift.colour : "none");
    badge.textContent = shift ? calendarShiftCode(shiftKey, shift) : "–";
  }
}

function renderSharedCalendar(grid, direction) {
  const model = window.RosterBuddySharedCalendarModel;
  const emptyState = document.getElementById("calendar-empty-state");
  if (emptyState) emptyState.classList.add("hidden-control");
  const legend = document.getElementById("calendar-legend");
  if (legend) { legend.innerHTML = ""; legend.classList.add("hidden-control"); }
  const byDay = model.entriesByDay(calendarViewProjection, monthKey(), calendarViewFilter);
  const offset = firstDayOffset();
  const days = daysInCurrentMonth();
  const totalCells = Math.ceil((offset + days) / 7) * 7;
  for (let cell = 0; cell < totalCells; cell += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day shared-day";
    const day = cell - offset + 1;
    if (day < 1 || day > days) {
      button.classList.add("empty");
      button.innerHTML = "<strong></strong>";
      button.disabled = true;
      grid.appendChild(button);
      continue;
    }
    const entries = byDay[day] || [];
    button.classList.toggle("today", sameLocalDate(dayDate(day), new Date()));
    button.classList.toggle("entry-target", calendarViewSelectedDay === day);
    const chips = entries.slice(0, 3).map((entry) => "<i class=\"shared-chip\">" + escapeHtml(model.memberInitial(entry.displayName)) + escapeHtml(entry.shiftCode || "•") + "</i>").join("");
    const more = entries.length > 3 ? "<i class=\"shared-chip shared-more\">+" + (entries.length - 3) + "</i>" : "";
    button.innerHTML = "<strong>" + day + "</strong><span class=\"shared-chips\">" + chips + more + "</span>";
    // Read-only: tapping only reveals who is on that day. It never opens entry screens.
    button.addEventListener("click", () => {
      calendarViewSelectedDay = day;
      renderSharedCalendarDetail(byDay[day] || []);
      grid.querySelectorAll(".entry-target").forEach((node) => node.classList.remove("entry-target"));
      button.classList.add("entry-target");
    });
    grid.appendChild(button);
  }
  renderSharedCalendarFilters();
  renderSharedCalendarDetail(calendarViewSelectedDay ? (byDay[calendarViewSelectedDay] || []) : null);
  const empty = document.getElementById("calendar-shared-empty");
  if (empty) empty.classList.toggle("hidden-control", Object.keys(byDay).length > 0);
  if (direction) {
    window.clearTimeout(monthAnimationTimer);
    void grid.offsetWidth;
    grid.classList.add(direction > 0 ? "month-slide-next" : "month-slide-prev");
    monthAnimationTimer = window.setTimeout(() => grid.classList.remove("month-slide-next", "month-slide-prev"), 360);
  }
}

function renderSharedCalendarFilters() {
  const host = document.getElementById("calendar-shared-filters");
  if (!host) return;
  const members = (calendarViewProjection && calendarViewProjection.members) || [];
  host.innerHTML = members.length > 1
    ? members.map((member) => "<button type=\"button\" class=\"shared-filter" + (calendarViewFilter == null || calendarViewFilter.has(member.id) ? " active" : "") + "\" data-shared-member=\"" + escapeHtml(member.id) + "\" aria-pressed=\"" + String(calendarViewFilter == null || calendarViewFilter.has(member.id)) + "\">" + escapeHtml(member.name) + "</button>").join("")
    : "";
}

function renderSharedCalendarDetail(entries) {
  const host = document.getElementById("calendar-shared-detail");
  if (!host) return;
  if (!entries) { host.innerHTML = ""; host.classList.add("hidden-control"); return; }
  const model = window.RosterBuddySharedCalendarModel;
  host.classList.remove("hidden-control");
  host.innerHTML = entries.length
    ? entries.map((entry) => "<div>" + escapeHtml(model.describeEntry(entry)) + "</div>").join("")
    : "<div class=\"muted\">Nobody is rostered on this day.</div>";
}

function setSharedCalendarChrome(active) {
  if (document.body && document.body.classList) document.body.classList.toggle("shared-calendar-view", Boolean(active));
  const panel = document.getElementById("calendar-shared-panel");
  if (panel) panel.classList.toggle("hidden-control", !active);
}

function renderCalendarLegend() {
  const container = document.getElementById("calendar-legend");
  if (!container) return;
  if (calendarViewProjection) { container.innerHTML = ""; container.classList.add("hidden-control"); return; }
  const roster = currentRoster();
  const days = daysInCurrentMonth();
  const counts = new Map();
  for (let day = 1; day <= days; day += 1) {
    const shiftKey = roster[day];
    if (!shiftKey) continue;
    const shift = templates[shiftKey];
    if (!shift) continue;
    const code = calendarShiftCode(shiftKey, shift);
    const name = String(shift.label || "").trim();
    const entry = counts.get(shiftKey) || { label: (code || name) + (code && name && name.toUpperCase() !== code.toUpperCase() ? " " + name : ""), time: shift.start && shift.finish ? templateTimeText(shift).replace(" - ", "–") : "", colour: shift.colour, count: 0 };
    entry.count += 1;
    counts.set(shiftKey, entry);
  }
  if (!counts.size) {
    container.innerHTML = "";
    container.classList.add("hidden-control");
    return;
  }
  container.classList.remove("hidden-control");
  container.innerHTML = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((entry) => "<span class=\"legend-chip " + entry.colour + "\">" + escapeHtml(entry.label) + (entry.time ? " <em>(" + escapeHtml(entry.time) + ")</em>" : "") + "<b class=\"legend-count\"> " + entry.count + "</b></span>")
    .join("") + "<span class=\"legend-chip legend-cycle\">Shaded: this pay cycle</span>";
}

function loadDemoMonth() {
  const roster = currentRoster();
  const casualRoster = currentCasualRoster();
  const higherDutiesRoster = currentHigherDutiesRoster();
  const onCallRoster = currentOnCallRoster();
  const additionalHoursRoster = currentAdditionalHoursRoster();
  Object.keys(roster).forEach((day) => delete roster[day]);
  Object.keys(casualRoster).forEach((day) => delete casualRoster[day]);
  Object.keys(higherDutiesRoster).forEach((day) => delete higherDutiesRoster[day]);
  Object.keys(onCallRoster).forEach((day) => delete onCallRoster[day]);
  Object.keys(additionalHoursRoster).forEach((day) => delete additionalHoursRoster[day]);
  Object.entries(demoRoster).forEach(([day, shift]) => {
    if (Number(day) <= daysInCurrentMonth()) roster[day] = shift;
  });
  selectedEntryDay = 1;
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function clearMonth() {
  showConfirmDialog({
    title: "Clear " + monthName() + " " + currentYear + "?",
    message: "This deletes roster entries, casual markers, and on-call markers for the current month only. Notes, reminders, shift templates, pay rules, and other months stay untouched.",
    confirmText: "Clear month",
    cancelText: "Keep roster",
    tone: "danger",
    onConfirm: () => {
      const roster = currentRoster();
      const casualRoster = currentCasualRoster();
      const higherDutiesRoster = currentHigherDutiesRoster();
      const onCallRoster = currentOnCallRoster();
      const additionalHoursRoster = currentAdditionalHoursRoster();
      Object.keys(roster).forEach((day) => delete roster[day]);
      Object.keys(casualRoster).forEach((day) => delete casualRoster[day]);
      Object.keys(higherDutiesRoster).forEach((day) => delete higherDutiesRoster[day]);
      Object.keys(onCallRoster).forEach((day) => delete onCallRoster[day]);
      Object.keys(additionalHoursRoster).forEach((day) => delete additionalHoursRoster[day]);
      selectedEntryDay = 1;
      saveState();
      renderCalendar();
      renderQuickGrid();
      updateSelectedCount();
      updatePayDisplay();
      showToast(monthName() + " roster cleared.", "success");
    },
  });
}

function repeatFirstWeek() {
  const roster = currentRoster();
  const casualRoster = currentCasualRoster();
  const higherDutiesRoster = currentHigherDutiesRoster();
  const onCallRoster = currentOnCallRoster();
  const days = daysInCurrentMonth();
  for (let day = 8; day <= days; day += 1) {
    const source = roster[day - 7];
    if (source) {
      roster[day] = source;
      if (casualRoster[day - 7]) casualRoster[day] = true;
      else delete casualRoster[day];
      if (higherDutiesRoster[day - 7]) higherDutiesRoster[day] = true;
      else delete higherDutiesRoster[day];
      if (onCallRoster[day - 7]) onCallRoster[day] = true;
      else delete onCallRoster[day];
    } else {
      delete roster[day];
      delete casualRoster[day];
      delete higherDutiesRoster[day];
      delete onCallRoster[day];
    }
  }
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function renderQuickGrid() {
  const grid = document.getElementById("quick-grid");
  grid.innerHTML = "";
  const roster = currentRoster();
  const offset = firstDayOffset();
  const days = daysInCurrentMonth();
  const totalCells = Math.ceil((offset + days) / 7) * 7;

  for (let cell = 0; cell < totalCells; cell += 1) {
    const button = document.createElement("button");
    const day = cell - offset + 1;
    if (day < 1 || day > days) {
      button.type = "button";
      button.className = "mini-day empty";
      button.disabled = true;
      grid.appendChild(button);
      continue;
    }

    const shift = templates[roster[day]];
    const reminder = getActiveReminder(day);
    const note = getDayNote(day);
    button.type = "button";
    button.className = "mini-day";
    button.classList.toggle("selected", selectedEntryDay === day);
    button.innerHTML = "<strong>" + day + "</strong>" + (shift ? "<span class=\"mini-code " + shift.colour + "\">" + escapeHtml(shift.icon || shift.label.slice(0, 2)) + "</span>" : "") + (isCasualDay(day) ? "<span class=\"casual-dot\">CAS</span>" : "") + (isHigherDutiesDay(day) ? "<span class=\"on-call-dot\">HD</span>" : "") + (isOnCallDay(day) ? "<span class=\"on-call-dot\">OC</span>" : "") + (getAdditionalHoursDay(day).hours > 0 ? "<span class=\"on-call-dot\">+H</span>" : "") + (note ? "<span class=\"note-dot\">📝</span>" : "") + (reminder ? "<span class=\"reminder-dot\">🔔</span>" : "");
    button.addEventListener("click", () => {
      selectEntryDay(day);
    });
    grid.appendChild(button);
  }
  renderQuickWeek();
}

function renderQuickWeek() {
  const host = document.getElementById("quick-week");
  if (!host) return;
  const roster = currentRoster();
  const selected = dayDate(selectedEntryDay);
  const start = addDays(selected, -((selected.getDay() - weekStartDay + 7) % 7));
  const weekdayFormat = new Intl.DateTimeFormat("en-AU", { weekday: "short" });
  host.innerHTML = "";
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(start, i);
    const inMonth = date.getFullYear() === currentYear && date.getMonth() === currentMonth;
    const day = date.getDate();
    const shift = inMonth ? templates[roster[day]] : null;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.disabled = !inMonth;
    pill.setAttribute("aria-pressed", String(inMonth && day === selectedEntryDay));
    pill.setAttribute("aria-label", weekdayFormat.format(date) + " " + day + (shift ? ", " + shift.label : ""));
    pill.innerHTML = "<small>" + weekdayFormat.format(date) + "</small><b>" + day + "</b>" +
      (shift ? "<span class=\"mini-code " + shift.colour + "\">" + escapeHtml(shift.icon || shift.label.slice(0, 2)) + "</span>" : "<span class=\"none\"></span>");
    if (inMonth) pill.addEventListener("click", () => selectEntryDay(day));
    host.appendChild(pill);
  }
}

function syncEntryModifiersToSelectedDay() {
  const current = templates[getShiftKey(selectedEntryDay)];
  entryModifierState = {
    casual: Boolean(current && isCasualDay(selectedEntryDay)),
    higherDuties: Boolean(current && isHigherDutiesDay(selectedEntryDay)),
    onCall: Boolean(isOnCallDay(selectedEntryDay)),
  };
  const casualInput = document.getElementById("casual-day");
  const higherDutiesInput = document.getElementById("higher-duties-day");
  const onCallInput = document.getElementById("on-call-day");
  if (casualInput) casualInput.checked = entryModifierState.casual;
  if (higherDutiesInput) higherDutiesInput.checked = entryModifierState.higherDuties;
  if (onCallInput) onCallInput.checked = entryModifierState.onCall;
}

function selectEntryDay(day, options = {}) {
  selectedEntryDay = Math.max(1, Math.min(daysInCurrentMonth(), Number(day) || 1));
  if (options.syncModifiers !== false) syncEntryModifiersToSelectedDay();
  renderQuickGrid();
  renderShiftPicker();
  updateSelectedCount();
}

function updateSelectedCount() {
  document.getElementById("selected-count").textContent = dayLabel(selectedEntryDay);
  const current = templates[getShiftKey(selectedEntryDay)];
  document.getElementById("selected-shift-label").textContent = current ? current.label + (isCasualDay(selectedEntryDay) ? " · Casual" : "") + (isHigherDutiesDay(selectedEntryDay) ? " · Higher duties" : "") + (isOnCallDay(selectedEntryDay) ? " · On-call" : "") : (isOnCallDay(selectedEntryDay) ? "On-call" : "No shift");
  const selectedHoliday = publicHolidayForDay(selectedEntryDay);
  const extra = getAdditionalHoursDay(selectedEntryDay);
  document.getElementById("selected-public-holiday").textContent = selectedHoliday ? "Public holiday: " + selectedHoliday : "";
  document.getElementById("additional-hours-day").value = extra.hours ? formatHours(extra.hours) : "";
  document.getElementById("additional-hours-double-time").checked = extra.doubleTime;
  document.getElementById("casual-day").checked = Boolean(document.getElementById("casual-day")?.checked);
  document.getElementById("higher-duties-day").checked = Boolean(document.getElementById("higher-duties-day")?.checked);
  document.getElementById("on-call-day").checked = Boolean(document.getElementById("on-call-day")?.checked);
  document.getElementById("reminder-date-label").textContent = dayLabel(selectedEntryDay);
  document.getElementById("day-note-date-label").textContent = dayLabel(selectedEntryDay);
  document.getElementById("day-note-text").value = getDayNote(selectedEntryDay);
  syncDayNoteRow();
  const reminder = getStoredReminder(selectedEntryDay) || { text: "", repeat: "none" };
  document.getElementById("reminder-text").value = reminder.text || "";
  document.getElementById("reminder-repeat").value = reminder.repeat || "none";
  updateAdditionalHoursToggle();
}

function updateAdditionalHoursToggle() {
  const button = document.getElementById("toggle-additional-hours");
  if (!button) return;
  const extra = getAdditionalHoursDay(selectedEntryDay);
  const hasHours = extra.hours > 0;
  button.textContent = hasHours ? "+ " + formatHours(extra.hours) + "h" + (extra.doubleTime ? " DT" : "") : "+ Hours";
  button.classList.toggle("active", hasHours);
}

function toggleAdditionalHoursPanel(forceOpen) {
  const panel = document.getElementById("manual-hours-panel");
  const button = document.getElementById("toggle-additional-hours");
  if (!panel || !button) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : panel.classList.contains("hidden-control");
  panel.classList.toggle("hidden-control", !shouldOpen);
  button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function entryModifiers() {
  entryModifierState.casual = Boolean(document.getElementById("casual-day")?.checked);
  entryModifierState.higherDuties = Boolean(document.getElementById("higher-duties-day")?.checked);
  entryModifierState.onCall = Boolean(document.getElementById("on-call-day")?.checked);
  return entryModifierState;
}

function applyEntryModifiersToDay(day, shiftKey) {
  const template = templates[shiftKey];
  const modifiers = entryModifiers();
  const isWorkShift = !template || (template.type || "work") === "work";
  setCasualDay(day, isWorkShift && modifiers.casual);
  setHigherDutiesDay(day, isWorkShift && modifiers.higherDuties);
  setOnCallDay(day, isWorkShift && modifiers.onCall);
}

function applyEntryModifierCheckboxChange() {
  entryModifiers();
  const shiftKey = getShiftKey(selectedEntryDay);
  const template = templates[shiftKey];
  const isWorkShift = template && (template.type || "work") === "work";
  setCasualDay(selectedEntryDay, isWorkShift && entryModifierState.casual);
  setHigherDutiesDay(selectedEntryDay, isWorkShift && entryModifierState.higherDuties);
  setOnCallDay(selectedEntryDay, entryModifierState.onCall);
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function saveSelectedDayAdditionalHours() {
  const input = document.getElementById("additional-hours-day");
  const doubleTime = document.getElementById("additional-hours-double-time")?.checked;
  setAdditionalHoursDay(selectedEntryDay, parseNumber(input?.value || "0", 0), doubleTime);
  if (input) input.value = getAdditionalHoursDay(selectedEntryDay).hours ? formatHours(getAdditionalHoursDay(selectedEntryDay).hours) : "";
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function saveQuickEntryAndReturn() {
  saveSelectedDayAdditionalHours();
  saveState();
  renderCalendar();
  renderQuickGrid();
  updatePayDisplay();
  showToast("Shifts saved");
  showScreen("calendar");
}

function applySelectedShiftToDay(day, shiftKey) {
  setShiftKey(day, shiftKey);
  applyEntryModifiersToDay(day, shiftKey);
  selectedEntryDay = Math.min(daysInCurrentMonth(), day + 1);
  syncEntryModifiersToSelectedDay();
  saveState();
  renderShiftPicker();
  renderQuickGrid();
  renderCalendar();
  updateSelectedCount();
  updatePayDisplay();
}

// A chip already shows the template's code in bold; printing a descriptive
// label underneath that says the same word again just reads as duplication
// (the built-in Off chip rendered "OFF" over "Off"). Compared on letters and
// digits only so case and punctuation differences do not hide a real repeat.
// Genuinely different wording (code "9T", label "Early") is kept.
function shiftChipSubLabel(template) {
  const code = String(template.icon || "").trim();
  const label = String(template.label || "").trim();
  const compare = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code || !label) return label;
  return compare(code) === compare(label) ? "" : label;
}

function renderShiftPicker() {
  const picker = document.getElementById("shift-picker");
  picker.innerHTML = "";
  const currentKey = getShiftKey(selectedEntryDay);

  Object.entries(templates).forEach(([key, template]) => {
    const chip = document.createElement("button");
    chip.className = "shift-chip choice";
    chip.type = "button";
    chip.dataset.shift = key;
    chip.setAttribute("role", "radio");
    const checked = currentKey === key;
    chip.setAttribute("aria-checked", String(checked));
    chip.classList.toggle("selected", checked);
    const subLabel = shiftChipSubLabel(template);
    const detail = template.start && template.finish ? templateTimeText(template).replace(" - ", "–") : "";
    const paid = Number(template.hours) > 0 ? formatHours(template.hours) + " h paid" : "";
    chip.innerHTML = "<span class=\"cbadge badge " + template.colour + "\">" + escapeHtml(template.icon || template.label.slice(0, 2)) + "</span>" +
      "<span class=\"tx\"><span class=\"t\">" + escapeHtml(template.label) + "</span><span class=\"s\">" + escapeHtml([detail, paid].filter(Boolean).join(" · ") || subLabel || "No shift times") + "</span></span>" +
      "<span class=\"ck\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg></span>";
    chip.addEventListener("click", () => {
      selectedShift = key;
      applySelectedShiftToDay(selectedEntryDay, key);
    });
    picker.appendChild(chip);
  });
}

function updateCalculatedHoursPreview() {
  const start = document.getElementById("template-start").value.trim();
  const finish = document.getElementById("template-finish").value.trim();
  const breakMinutes = parseNumber(document.getElementById("template-break").value, 0);
  const [startValue, finishValue] = splitTimeRange(start, finish);
  const calculated = shiftHours(startValue, finishValue, breakMinutes);

  if (document.activeElement !== document.getElementById("template-start") && startValue !== start && finishValue) {
    document.getElementById("template-start").value = startValue;
    document.getElementById("template-finish").value = finishValue;
  }

  if (calculated > 0) {
    if (!templateHoursManuallyEdited) document.getElementById("template-hours").value = formatHours(calculated);
    document.getElementById("template-hours-hint").textContent = templateHoursManuallyEdited ? "Manual paid hours override" : "Auto-calculated from shift time";
  } else {
    document.getElementById("template-hours-hint").textContent = "Enter manually for unpaid/leave-style shifts";
  }
}

function openTemplateEditor(key) {
  editingTemplateKey = key;
  const template = templates[key];
  document.getElementById("edit-template-eyebrow").textContent = key.startsWith("custom") ? "Custom template" : "Edit template";
  document.getElementById("edit-template-title").textContent = template.label;
  document.getElementById("template-name").value = template.label;
  document.getElementById("template-icon").value = template.icon || "";
  document.getElementById("template-start").value = template.start || "";
  document.getElementById("template-finish").value = template.finish || "";
  document.getElementById("template-break").value = (template.breakMinutes || 0) + " min";
  document.getElementById("template-hours").value = template.hours || 0;
  document.getElementById("template-type").value = template.type || "work";

  templateHoursManuallyEdited = false;
  document.getElementById("delete-template").classList.toggle("hidden-control", !key.startsWith("custom"));
  document.querySelectorAll(".swatch").forEach((swatch) => {
    swatch.classList.toggle("selected", swatch.dataset.colour === template.colour);
  });
  updateCalculatedHoursPreview();
  showScreen("edit-template");
}

function openNewTemplate() {
  const key = "custom" + nextCustomTemplate;
  nextCustomTemplate += 1;
  templates[key] = {
    label: "Custom",
    icon: "C",
    start: "14:00",
    finish: "22:30",
    breakMinutes: 30,
    colour: "aqua",
    hours: 8,
    type: "work",

  };
  selectedShift = key;
  saveState();
  openTemplateEditor(key);
}

function renderTemplates() {
  const list = document.getElementById("template-list");
  list.innerHTML = "";

  Object.entries(templates).forEach(([key, template]) => {
    const row = document.createElement("article");
    const hoursText = template.hours ? formatHours(template.hours) + "h paid" : (template.type === "leave" ? "Leave code" : "Unpaid");
    row.className = "template-row";
    row.innerHTML = "<div><strong><span class=\"template-icon " + template.colour + "\">" + escapeHtml(template.icon || template.label.slice(0, 2)) + "</span>" + escapeHtml(template.label) + "</strong><small>" + escapeHtml(templateTimeText(template)) + " · " + hoursText + "</small></div><button class=\"ghost-button\" type=\"button\" aria-label=\"Edit " + escapeHtml(template.label) + "\">›</button>";
    row.querySelector("button").addEventListener("click", () => openTemplateEditor(key));
    list.appendChild(row);
  });
}

function selectedColour() {
  return document.querySelector(".swatch.selected")?.dataset.colour || "aqua";
}

function saveTemplate() {
  const template = templates[editingTemplateKey];
  const label = document.getElementById("template-name").value.trim() || template.label;
  const icon = document.getElementById("template-icon").value.trim() || label.slice(0, 2).toUpperCase();
  const [start, finish] = splitTimeRange(document.getElementById("template-start").value, document.getElementById("template-finish").value);
  const breakMinutes = parseNumber(document.getElementById("template-break").value, template.breakMinutes || 0);
  const calculatedHours = shiftHours(start, finish, breakMinutes);
  const enteredHours = parseNumber(document.getElementById("template-hours").value, template.hours || 0);
  const type = document.getElementById("template-type").value;

  const hours = templateHoursManuallyEdited || calculatedHours <= 0 ? enteredHours : calculatedHours;

  templates[editingTemplateKey] = {
    ...template,
    label,
    icon,
    start,
    finish,
    breakMinutes,
    colour: selectedColour(),
    hours,
    type,
  };

  saveState();
  renderTemplates();
  renderShiftPicker();
  renderCalendar();
  updateSelectedCount();
  updatePayDisplay();
  if (pendingScanRosterReviewTemplateKey === editingTemplateKey) {
    scanRosterDrafts = applyScanRosterCodeMappingsToDrafts(scanRosterDrafts);
    pendingScanRosterReviewTemplateKey = "";
    renderScanRosterReview();
    showScreen("scan-roster");
  } else {
    showScreen("templates");
  }
}

function deleteTemplate() {
  if (!editingTemplateKey.startsWith("custom")) return;
  Object.values(rosters).forEach((roster) => {
    if (!roster || typeof roster !== "object") return;
    Object.keys(roster).forEach((day) => {
      if (roster[day] === editingTemplateKey) roster[day] = "off";
    });
  });
  delete templates[editingTemplateKey];
  selectedShift = templates[selectedShift] ? selectedShift : "early";
  saveState();
  renderTemplates();
  renderShiftPicker();
  renderCalendar();
  updateSelectedCount();
  updatePayDisplay();
  showScreen("templates");
}

function clearCurrentDay() {
  clearShiftDay(selectedEntryDay);
  selectedEntryDay = Math.min(daysInCurrentMonth(), selectedEntryDay + 1);
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function saveReminder() {
  const text = document.getElementById("reminder-text").value.trim();
  const repeat = document.getElementById("reminder-repeat").value;
  if (!text) {
    delete reminders[dateKey(selectedEntryDay)];
  } else {
    reminders[dateKey(selectedEntryDay)] = {
      day: selectedEntryDay,
      month: currentMonth,
      year: currentYear,
      text,
      repeat,
    };
  }
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
}

function clearReminder() {
  delete reminders[dateKey(selectedEntryDay)];
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
}

function syncDayNoteRow() {
  const note = getDayNote(selectedEntryDay);
  const summary = document.getElementById("day-note-summary");
  const open = document.getElementById("day-note-open");
  if (summary) {
    summary.textContent = note || "No note for this day";
    summary.classList.toggle("empty-note", !note);
  }
  if (open) open.textContent = note ? "Edit note" : "Add note";
}

function setDayNoteEditing(editing) {
  const editor = document.getElementById("day-note-editor");
  const row = document.getElementById("day-note-row");
  if (!editor || !row) return;
  editor.classList.toggle("hidden-control", !editing);
  row.classList.toggle("hidden-control", editing);
  if (editing) {
    document.getElementById("day-note-text").value = getDayNote(selectedEntryDay);
    document.getElementById("day-note-text").focus();
  }
}

function saveDayNote() {
  setDayNote(selectedEntryDay, document.getElementById("day-note-text").value);
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  setDayNoteEditing(false);
}

function clearDayNote() {
  setDayNote(selectedEntryDay, "");
  saveState();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  setDayNoteEditing(false);
}

function undoStep() {
  selectedEntryDay = Math.max(1, selectedEntryDay - 1);
  renderQuickGrid();
  renderCalendar();
  updateSelectedCount();
}

function changeMonth(delta) {
  if (monthIsTransitioning) return;
  const grid = document.getElementById("calendar-grid");
  if (grid) {
    monthIsTransitioning = true;
    grid.classList.remove("month-slide-next", "month-slide-prev", "month-slide-out-next", "month-slide-out-prev", "month-dragging");
    grid.style.removeProperty("--month-drag-x");
    void grid.offsetWidth;
    grid.classList.add(delta > 0 ? "month-slide-out-next" : "month-slide-out-prev");
    window.clearTimeout(monthTransitionTimer);
    monthTransitionTimer = window.setTimeout(() => {
      applyMonthChange(delta);
      monthIsTransitioning = false;
    }, 150);
    return;
  }
  applyMonthChange(delta);
}

function applyMonthChange(delta) {
  const next = new Date(currentYear, currentMonth + delta, 1);
  currentYear = next.getFullYear();
  currentMonth = next.getMonth();
  selectedEntryDay = Math.min(selectedEntryDay, daysInCurrentMonth());
  saveState();
  renderCalendar(delta);
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
}

function handleMonthSwipe(startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const swipeThreshold = 48;
  if (Math.abs(deltaX) < swipeThreshold || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return false;
  if (deltaX < 0) changeMonth(1);
  else changeMonth(-1);
  return true;
}

function bindMonthSwipe() {
  const calendar = document.getElementById("calendar-grid");
  if (!calendar) return;
  calendar.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    monthDragStartX = touch.clientX;
    monthDragStartY = touch.clientY;
    monthDragCurrentX = touch.clientX;
    monthIsDragging = false;
  }, { passive: true });
  calendar.addEventListener("touchmove", (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch || monthIsTransitioning) return;
    const deltaX = touch.clientX - monthDragStartX;
    const deltaY = touch.clientY - monthDragStartY;
    if (Math.abs(deltaX) < 10 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
    monthIsDragging = true;
    monthDragCurrentX = touch.clientX;
    calendar.classList.add("month-dragging");
    calendar.style.setProperty("--month-drag-x", Math.max(-54, Math.min(54, deltaX)) + "px");
  }, { passive: true });
  calendar.addEventListener("touchend", (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    calendar.classList.remove("month-dragging");
    calendar.style.removeProperty("--month-drag-x");
    const endX = monthIsDragging ? monthDragCurrentX : touch.clientX;
    if (handleMonthSwipe(monthDragStartX, monthDragStartY, endX, touch.clientY)) event.preventDefault();
    monthIsDragging = false;
  });
}

function shiftStartDate(day, template) {
  const minutes = parseClock(template.start);
  if (minutes === null) return null;
  const date = dayDate(day);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

function shiftEndDate(day, template) {
  const start = parseClock(template.start);
  const finish = parseClock(template.finish);
  if (start === null || finish === null) return null;
  const date = dayDate(day);
  date.setHours(Math.floor(finish / 60), finish % 60, 0, 0);
  if (finish <= start) date.setDate(date.getDate() + 1);
  return date;
}

function recoveryStats() {
  const roster = currentRoster();
  const entries = Object.entries(roster)
    .map(([dayText, shiftKey]) => ({ day: Number(dayText), shiftKey, template: templates[shiftKey] }))
    .filter((entry) => entry.template)
    .sort((a, b) => a.day - b.day);
  const workEntries = entries.filter((entry) => entry.template.type === "work");

  let nightCount = 0;
  let maxNightRun = 0;
  let currentNightRun = 0;
  let weekendDays = 0;
  let recoveryBlocks = 0;
  let shortTurnarounds = 0;
  let shortestTurnaround = Infinity;
  let previousEnd = null;
  let previousEntry = null;
  const shortTurnaroundDetails = [];

  workEntries.forEach((entry) => {
    if (isNightShift(entry.shiftKey, entry.template)) {
      nightCount += 1;
      currentNightRun += 1;
      maxNightRun = Math.max(maxNightRun, currentNightRun);
    } else {
      currentNightRun = 0;
    }
    if (isWeekend(entry.day)) weekendDays += 1;

    const start = shiftStartDate(entry.day, entry.template);
    const end = shiftEndDate(entry.day, entry.template);
    if (start && previousEnd) {
      const gapHours = (start - previousEnd) / 36e5;
      if (gapHours > 0 && gapHours < 10) {
        shortTurnarounds += 1;
        shortestTurnaround = Math.min(shortestTurnaround, gapHours);
        shortTurnaroundDetails.push({
          fromDay: previousEntry ? previousEntry.day : null,
          fromLabel: previousEntry ? previousEntry.template.label : "Previous shift",
          toDay: entry.day,
          toLabel: entry.template.label,
          gapHours,
        });
      }
    }
    if (end) {
      previousEnd = end;
      previousEntry = entry;
    }
  });

  recoveryBlocks = entries.length - workEntries.length;

  return { entries, workEntries, nightCount, maxNightRun, weekendDays, recoveryBlocks, shortTurnarounds, shortestTurnaround, shortTurnaroundDetails };
}

function showShortTurnaroundDetails(details) {
  if (!details.length) return;
  const lines = details.map((item) => (
    dayLabel(item.fromDay) + " " + item.fromLabel + " → " + dayLabel(item.toDay) + " " + item.toLabel + "\nTurnaround: " + formatHours(item.gapHours) + " hours"
  ));
  showInfoDialog("Short turnarounds this month", lines.join("\n\n"), "Got it");
}

function updateRecoveryDisplay() {
  const stats = recoveryStats();
  const score = Math.min(100, stats.nightCount * 8 + stats.maxNightRun * 10 + stats.shortTurnarounds * 18 + stats.weekendDays * 4 - stats.recoveryBlocks * 5);
  const safeScore = Math.max(0, score);
  const ring = document.getElementById("recovery-ring");
  if (!ring) return;

  document.getElementById("recovery-score").textContent = String(Math.round(safeScore));
  ring.style.background = "conic-gradient(var(--coral) 0 " + safeScore + "%, var(--ring-track, #e8eef0) " + safeScore + "% 100%)";

  if (stats.workEntries.length === 0) {
    document.getElementById("recovery-risk").textContent = "No roster data";
    document.getElementById("recovery-title").textContent = "Add shifts to see roster strain";
    document.getElementById("recovery-summary").textContent = stats.recoveryBlocks ? stats.recoveryBlocks + " off/recovery day" + (stats.recoveryBlocks === 1 ? "" : "s") + " entered, but no work shifts yet." : "Recovery insights will update from the calendar.";
    document.getElementById("recovery-insights").innerHTML = "<article><strong>No work shifts yet</strong><span>Off/Sleep days are tracked as recovery blocks, but they do not count as rostered work days.</span></article>";
    return;
  }

  if (!recoveryAlertsEnabled) {
    document.getElementById("recovery-risk").textContent = "Alerts off";
    document.getElementById("recovery-title").textContent = "Recovery alerts are paused";
    document.getElementById("recovery-summary").textContent = "Calendar insights are still shown, but warning states are hidden.";
  } else {
    const risk = safeScore >= 65 ? "Higher risk" : safeScore >= 35 ? "Moderate risk" : "Lower risk";
    document.getElementById("recovery-risk").textContent = risk;
    document.getElementById("recovery-title").textContent = stats.maxNightRun >= 3 ? stats.maxNightRun + " nights in a row" : stats.nightCount + " night shifts this month";
    document.getElementById("recovery-summary").textContent = stats.workEntries.length + " rostered work day" + (stats.workEntries.length === 1 ? "" : "s") + " in " + monthName() + ". " + stats.recoveryBlocks + " off/recovery day" + (stats.recoveryBlocks === 1 ? "" : "s") + " excluded.";
  }

  const insights = [
    { title: "Monthly night shifts", text: stats.nightCount + " night shift" + (stats.nightCount === 1 ? "" : "s") + " entered.", warning: recoveryAlertsEnabled && stats.maxNightRun >= 3 },
    { title: "Short turnarounds", text: stats.shortTurnarounds ? stats.shortTurnarounds + " under 10 hours. Shortest is " + formatHours(stats.shortestTurnaround) + " hours. Tap for dates." : "None under 10 hours found.", warning: recoveryAlertsEnabled && stats.shortTurnarounds > 0, action: stats.shortTurnarounds > 0 ? "short-turnaround" : "" },
    { title: "Weekend load", text: stats.weekendDays + " weekend work day" + (stats.weekendDays === 1 ? "" : "s") + " entered.", warning: recoveryAlertsEnabled && stats.weekendDays >= 4 },
    { title: "Recovery blocks", text: stats.recoveryBlocks + " recovery/off block" + (stats.recoveryBlocks === 1 ? "" : "s") + " entered.", warning: recoveryAlertsEnabled && stats.recoveryBlocks === 0 && stats.nightCount > 0 },
  ];

  document.getElementById("recovery-insights").innerHTML = insights.map((item) => (
    "<article" + (item.warning ? " class=\"warning\"" : "") + (item.action ? " data-insight=\"" + item.action + "\" tabindex=\"0\" role=\"button\"" : "") + "><strong>" + escapeHtml(item.title) + "</strong><span>" + escapeHtml(item.text) + "</span></article>"
  )).join("");
  const shortTurnaroundCard = document.querySelector('[data-insight="short-turnaround"]');
  if (shortTurnaroundCard) {
    shortTurnaroundCard.addEventListener("click", () => showShortTurnaroundDetails(stats.shortTurnaroundDetails));
    shortTurnaroundCard.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") showShortTurnaroundDetails(stats.shortTurnaroundDetails);
    });
  }
}

function applyTheme(theme) {
  selectedTheme = normalizeTheme(theme);
  document.body.dataset.theme = selectedTheme;
  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === selectedTheme);
  });
  saveState();
}

function toggleRecoveryAlerts() {
  recoveryAlertsEnabled = !recoveryAlertsEnabled;
  document.getElementById("recovery-alert-status").textContent = recoveryAlertsEnabled ? "On" : "Off";
  saveState();
  updateRecoveryDisplay();
}

function rosterLineForDate(date, options = shareIncludeOptions()) {
  const roster = getRosterForDate(date);
  const template = templates[roster[date.getDate()]];
  const weekday = new Intl.DateTimeFormat("en-AU", { weekday: "short" }).format(date);
  const label = formatShortDate(date);
  const note = dayNotes[dateKeyForDate(date)] || "";
  const extra = additionalHoursForDate(date);
  const onCallOnly = isOnCallDate(date) ? " · ON-CALL" : "";
  const extraText = extra.hours > 0 ? " · Extra " + formatHours(extra.hours) + "h" + (extra.doubleTime ? " DT" : "") : "";
  if (!template) return weekday + " " + label + ": " + (onCallOnly || extraText ? "No shift" + onCallOnly + extraText : "No shift") + (options.notes && note ? " · Note: " + note : "");
  const time = options.times && template.start && template.finish ? " " + template.start + "-" + template.finish : "";
  const casual = (casualRosters[monthKeyForDate(date)] || {})[date.getDate()] ? " · CAS" : "";
  const higherDuties = isHigherDutiesDate(date) ? " · HD" : "";
  const onCall = isOnCallDate(date) ? " · ON-CALL" : "";
  return weekday + " " + label + ": " + template.label + time + casual + higherDuties + onCall + extraText + (options.notes && note ? " · Note: " + note : "");
}

function shareIncludeOptions() {
  const checked = (id, fallback) => {
    const input = document.getElementById(id);
    return input ? input.checked : fallback;
  };
  return {
    times: checked("share-include-times", true),
    notes: checked("share-include-notes", false),
    pay: checked("share-include-pay", false),
    recovery: checked("share-include-recovery", false),
    offDays: checked("share-include-off-days", true),
  };
}

function startOfWeekForDate(date) {
  const start = new Date(date);
  const diff = (start.getDay() - weekStartDay + 7) % 7;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function buildShareRanges() {
  const monthStart = new Date(currentYear, currentMonth, 1);
  const monthEnd = new Date(currentYear, currentMonth + 1, 0);
  const payCycle = selectedPeriodRange();
  const weeks = [];
  for (let weekStart = startOfWeekForDate(monthStart); weekStart <= monthEnd; weekStart = addDays(weekStart, 7)) {
    const weekEnd = addDays(weekStart, 6);
    weeks.push({
      key: dateKeyForDate(weekStart),
      label: formatDateRange(weekStart, weekEnd),
      startDate: new Date(weekStart),
      endDate: weekEnd,
    });
  }
  if (!shareWeekStartDate || !weeks.some((week) => week.key === shareWeekStartDate)) {
    const selectedWeek = startOfWeekForDate(dayDate(selectedEntryDay));
    const selectedKey = dateKeyForDate(selectedWeek);
    shareWeekStartDate = weeks.some((week) => week.key === selectedKey) ? selectedKey : (weeks[0] ? weeks[0].key : dateKeyForDate(monthStart));
  }
  const chosenWeek = weeks.find((week) => week.key === shareWeekStartDate) || weeks[0];
  return {
    month: { title: "Month", label: monthName() + " " + currentYear, startDate: monthStart, endDate: monthEnd },
    "pay-cycle": { title: "Pay cycle", label: formatDateRange(payCycle.startDate, payCycle.endDate), startDate: payCycle.startDate, endDate: payCycle.endDate },
    week: { title: "Week", label: chosenWeek ? chosenWeek.label : formatDateRange(monthStart, addDays(monthStart, 6)), startDate: chosenWeek ? chosenWeek.startDate : monthStart, endDate: chosenWeek ? chosenWeek.endDate : addDays(monthStart, 6) },
    weeks,
  };
}

function updateShareWeekOptions() {
  const select = document.getElementById("share-week-select");
  if (!select) return;
  const ranges = buildShareRanges();
  select.innerHTML = ranges.weeks.map((week) => "<option value=\"" + escapeHtml(week.key) + "\">" + escapeHtml(week.label) + "</option>").join("");
  select.value = shareWeekStartDate;
  const picker = document.querySelector(".share-week-picker");
  // hidden-control, not hidden: `.share-week-picker { display: grid }` is
  // declared later in styles.css at equal specificity, so it beat
  // `.hidden { display: none }` and the week picker stayed on screen in every
  // range mode. hidden-control is the established display:none !important
  // mechanism used for every other conditional control in this app.
  if (picker) picker.classList.toggle("hidden-control", shareRangeMode !== "week");
}

function activeShareRange() {
  const ranges = buildShareRanges();
  return ranges[shareRangeMode] || ranges["pay-cycle"];
}

function isShareableDate(date, options) {
  if (options.offDays) return true;
  const template = templates[getRosterForDate(date)[date.getDate()]];
  return Boolean(template && template.type !== "recovery");
}

function shareRecoverySummary(startDate, endDate) {
  let nightCount = 0;
  let weekendWorkDays = 0;
  let workDays = 0;
  for (let date = new Date(startDate); date <= endDate; date = addDays(date, 1)) {
    const template = templates[getRosterForDate(date)[date.getDate()]];
    if (!template || template.type !== "work") continue;
    workDays += 1;
    if (isNightShift(getRosterForDate(date)[date.getDate()], template)) nightCount += 1;
    if (date.getDay() === 0 || date.getDay() === 6) weekendWorkDays += 1;
  }
  if (!workDays) return "Recovery: no work shifts in this range.";
  return "Recovery: " + workDays + " work day" + (workDays === 1 ? "" : "s") + ", " + nightCount + " night" + (nightCount === 1 ? "" : "s") + ", " + weekendWorkDays + " weekend work day" + (weekendWorkDays === 1 ? "" : "s") + ".";
}

function buildShareTextForRange(range, options = shareIncludeOptions()) {
  const lines = ["RosterBuddy roster: " + range.title + " — " + range.label, ""];
  if (options.pay) {
    const stats = calculateRosterStatsForRange(range.startDate, range.endDate);
    lines.push("Pay estimate: " + formatHours(stats.hours) + " hours · " + money(stats.gross) + " gross");
    lines.push("");
  }
  if (options.recovery) {
    lines.push(shareRecoverySummary(range.startDate, range.endDate));
    lines.push("");
  }
  let includedDays = 0;
  for (let date = new Date(range.startDate); date <= range.endDate; date = addDays(date, 1)) {
    if (!isShareableDate(date, options)) continue;
    lines.push(rosterLineForDate(date, options));
    includedDays += 1;
  }
  if (!includedDays) lines.push("No rostered work shifts in this range.");
  return lines.join("\n");
}

function nextRosterText(days = 14) {
  const start = dayDate(selectedEntryDay);
  const end = addDays(start, days - 1);
  return buildShareTextForRange({ title: "Next " + days + " days", label: formatDateRange(start, end), startDate: start, endDate: end });
}

function setShareRangeMode(mode) {
  if (!["month", "pay-cycle", "week"].includes(mode)) return;
  shareRangeMode = mode;
  document.querySelectorAll("[data-share-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.shareRange === shareRangeMode);
  });
  updateSharePreview();
}

function updateSharePreview() {
  const card = document.getElementById("share-preview-card");
  if (!card) return;
  updateShareWeekOptions();
  const month = document.getElementById("share-preview-month");
  const rangeLabel = document.getElementById("share-preview-range");
  const range = activeShareRange();
  const options = shareIncludeOptions();
  const text = buildShareTextForRange(range, options);
  currentSharePreviewText = text;
  if (month) month.textContent = range.title;
  if (rangeLabel) rangeLabel.textContent = range.label;
  const rows = text.split("\n").filter(Boolean).slice(0, 8).map((line) => "<div class=\"share-row\"><span>" + escapeHtml(line) + "</span></div>");
  const hiddenLines = Math.max(0, text.split("\n").filter(Boolean).length - rows.length);
  card.innerHTML = "<h3>Exact preview</h3><p>" + escapeHtml(range.label) + "</p>" + rows.join("") + (hiddenLines ? "<p>+ " + hiddenLines + " more line" + (hiddenLines === 1 ? "" : "s") + " in copied/shared text</p>" : "");
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast("Roster copied to clipboard.", "success"))
      .catch(() => showInfoDialog("Copy roster text", text, "Done"));
    return;
  }
  showInfoDialog("Copy roster text", text, "Done");
}

function copyTextWithLabel(text, successMessage, dialogTitle) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast(successMessage, "success"))
      .catch(() => showInfoDialog(dialogTitle, text, "Done"));
    return;
  }
  showInfoDialog(dialogTitle, text, "Done");
}

function currentShareText() {
  updateSharePreview();
  return currentSharePreviewText || buildShareTextForRange(activeShareRange());
}

function shareNext14Days() {
  copyText(nextRosterText(14));
}

function copyShareText() {
  copyText(currentShareText());
}

function nativeShareRoster() {
  const text = currentShareText();
  if (navigator.share) {
    navigator.share({ title: "RosterBuddy roster", text }).catch(() => copyText(text));
    return;
  }
  copyText(text);
}

function downloadTextFile(text, filename, type = "application/json") {
  const blob = new Blob([text], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function androidBridge() {
  return window.RosterBuddyAndroid || window.ShiftMateAndroid || window.RosterMateAndroid || window.RosterLyteAndroid || null;
}

function updateBackupStatus() {
  const status = document.getElementById("backup-status");
  if (!status) return;
  if (!backupCreatedAt) {
    status.textContent = "No backup imported/exported yet";
    return;
  }
  const date = new Date(backupCreatedAt);
  status.textContent = "Last backup touch: " + (Number.isNaN(date.getTime()) ? backupCreatedAt : date.toLocaleString("en-AU"));
}

function buildBackupPayload() {
  backupCreatedAt = new Date().toISOString();
  backupSchemaVersion = BACKUP_SCHEMA_VERSION;
  return {
    app: "RosterBuddy",
    appVersion: APP_VERSION,
    backupSchemaVersion,
    backupCreatedAt,
    state: currentStatePayload(),
  };
}

function currentBackupJsonAndFilename() {
  const payload = buildBackupPayload();
  saveState();
  updateBackupStatus();
  const filename = "rosterbuddy-backup-" + payload.backupCreatedAt.slice(0, 10) + ".json";
  return { payload, filename, json: JSON.stringify(payload, null, 2) };
}

function backupSuccessMessage(filename, nativeResult = "") {
  const location = nativeResult || "your file picker/downloads";
  return "Backup created: " + filename + ". " + location + ". Before uninstalling or clearing data, open Files and confirm the JSON exists. If you cannot find it, tap Share/save backup or Copy backup JSON.";
}

function exportBackupJson() {
  const backup = currentBackupJsonAndFilename();
  const bridge = androidBridge();
  let nativeResult = "";
  if (bridge && typeof bridge.saveBackupFile === "function") {
    nativeResult = String(bridge.saveBackupFile(backup.json, backup.filename) || "");
  } else {
    downloadTextFile(backup.json, backup.filename);
    nativeResult = "Browser download requested";
  }
  copyTextWithLabel(backup.json, "Backup JSON copied as a safety fallback.", "Copy RosterBuddy backup JSON");
  showInfoDialog("Backup export started", backupSuccessMessage(backup.filename, nativeResult), "I will check Files");
}

function shareBackupJson() {
  const backup = currentBackupJsonAndFilename();
  const bridge = androidBridge();
  if (bridge && typeof bridge.shareBackupFile === "function") {
    bridge.shareBackupFile(backup.json, backup.filename);
    showInfoDialog("Share/save backup", "Choose Files, Drive, email, or another safe place. Confirm " + backup.filename + " exists before uninstalling or clearing app data.", "Done");
    return;
  }
  if (navigator.share) {
    navigator.share({ title: "RosterBuddy backup", text: backup.json }).catch(() => copyTextWithLabel(backup.json, "Backup JSON copied.", "Copy RosterBuddy backup JSON"));
    return;
  }
  copyTextWithLabel(backup.json, "Backup JSON copied.", "Copy RosterBuddy backup JSON");
}

function copyBackupJson() {
  const backup = currentBackupJsonAndFilename();
  copyTextWithLabel(backup.json, "Backup JSON copied. Paste it into Notes/email and save it before uninstalling.", "Copy RosterBuddy backup JSON");
}

function importBackupJson(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    showToast("That backup file is not valid JSON.", "warning");
    return false;
  }
  // Do not mutate live state while saveState() is intentionally blocked from
  // persisting over newer-format device data. Otherwise the UI can report a
  // successful restore that exists only in memory and disappears on reload.
  if (unsupportedSavedTemplateState) {
    showToast("This device holds RosterBuddy data from a newer version. Update RosterBuddy before restoring a backup; nothing was changed.", "warning");
    return false;
  }
  const state = payload && payload.state && typeof payload.state === "object" ? payload.state : payload;
  if (!state || typeof state !== "object" || !state.templates || !state.rosters) {
    showToast("That does not look like a RosterBuddy backup file.", "warning");
    return false;
  }
  // Refused before the confirm dialog, not inside it: the restore step wipes
  // local state and then reports success, so a payload this build cannot
  // apply must never reach that point.
  if (isUnsupportedTemplateStateVersion(state)) {
    showToast("That backup was made by a newer version of RosterBuddy. Update RosterBuddy, then restore it. Nothing on this device was changed.", "warning");
    return false;
  }
  showConfirmDialog({
    title: "Restore backup?",
    message: "This replaces the current local app data on this device. Export a backup first if you want to keep the current data.",
    confirmText: "Restore backup",
    cancelText: "Cancel",
    tone: "danger",
    onConfirm: () => {
      replaceStateWithPayload(state);
      backupCreatedAt = payload.backupCreatedAt || new Date().toISOString();
      backupSchemaVersion = payload.backupSchemaVersion || BACKUP_SCHEMA_VERSION;
      saveState();
      syncControlState();
      populatePayRuleInputs();
      renderCalendar();
      renderQuickGrid();
      renderShiftPicker();
      renderTemplates();
      updateSelectedCount();
      updatePayDisplay();
      applyTheme(selectedTheme);
      updateBackupStatus();
      showScreen("calendar");
      showToast("RosterBuddy backup restored.", "success");
    },
  });
  return true;
}

function handleBackupFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importBackupJson(String(reader.result || ""));
  reader.onerror = () => showToast("RosterBuddy could not read that backup file.", "warning");
  reader.readAsText(file);
  event.target.value = "";
}

function resetAppData() {
  showConfirmDialog({
    title: "Reset all RosterBuddy data?",
    message: "This deletes rosters, templates, pay rules, notes, reminders, and settings on this device. Export a backup first if you want to keep anything.",
    confirmText: "Reset app data",
    cancelText: "Keep my data",
    requireText: "RESET",
    inputLabel: "Type RESET to confirm",
    tone: "danger",
    onConfirm: () => {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        window.sessionStorage.removeItem(ACTIVE_SCREEN_STORAGE_KEY);
      } catch (error) {
        console.warn("RosterBuddy reset storage cleanup failed.", error);
      }
      sendAndroidWidgetState("{}");
      window.location.reload();
    },
  });
}

function escapeIcsText(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function compactIcsDate(date) {
  return formatDateInput(date).replace(/-/g, "");
}

function compactIcsDateTime(date) {
  return compactIcsDate(date) + "T" + String(date.getHours()).padStart(2, "0") + String(date.getMinutes()).padStart(2, "0") + "00";
}

function shiftDateTimes(date, template) {
  const startMinutes = parseClock(template.start);
  const finishMinutes = parseClock(template.finish);
  if (startMinutes === null || finishMinutes === null) return null;
  const start = new Date(date);
  start.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
  const end = new Date(date);
  end.setHours(Math.floor(finishMinutes / 60), finishMinutes % 60, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

function calendarSummaryForDate(date, template) {
  const extra = additionalHoursForDate(date);
  const suffixes = [];
  if (isCasualDate(date)) suffixes.push("CAS");
  if (isHigherDutiesDate(date)) suffixes.push("HD");
  if (isOnCallDate(date)) suffixes.push("On-call");
  if (extra.hours > 0) suffixes.push("Extra " + formatHours(extra.hours) + "h" + (extra.doubleTime ? " DT" : ""));
  if (template) return template.label + (suffixes.length ? " (" + suffixes.join(", ") + ")" : "");
  if (isOnCallDate(date)) return "On-call — RosterBuddy";
  if (extra.hours > 0) return "Additional hours — RosterBuddy";
  return "RosterBuddy roster note";
}

function dateHasCalendarEntry(date) {
  const roster = getRosterForDate(date);
  const template = templates[roster[date.getDate()]];
  const extra = additionalHoursForDate(date);
  return Boolean(template || isOnCallDate(date) || extra.hours > 0 || dayNotes[dateKeyForDate(date)]);
}

function appendCalendarEvent(lines, date, rangeKey) {
  const roster = getRosterForDate(date);
  const template = templates[roster[date.getDate()]];
  const timed = template && template.start && template.finish ? shiftDateTimes(date, template) : null;
  const dateKey = dateKeyForDate(date);
  lines.push("BEGIN:VEVENT");
  lines.push("UID:rosterbuddy-" + dateKey + "@donkeyworks.rosterbuddy");
  lines.push("DTSTAMP:" + compactIcsDate(new Date()) + "T000000Z");
  if (timed) {
    lines.push("DTSTART:" + compactIcsDateTime(timed.start));
    lines.push("DTEND:" + compactIcsDateTime(timed.end));
  } else {
    lines.push("DTSTART;VALUE=DATE:" + compactIcsDate(date));
    lines.push("DTEND;VALUE=DATE:" + compactIcsDate(addDays(date, 1)));
  }
  lines.push("SUMMARY:" + escapeIcsText(calendarSummaryForDate(date, template)));
  lines.push("DESCRIPTION:" + escapeIcsText(rosterLineForDate(date, { times: true, notes: true, pay: false, recovery: false, offDays: false }) + "\nExported from RosterBuddy for " + rangeKey + "."));
  lines.push("END:VEVENT");
}

function buildCalendarIcsForRange(range = activeShareRange()) {
  const safeRange = range || buildShareRanges()["pay-cycle"];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RosterBuddy//Google Calendar Export V0.2.1//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:RosterBuddy roster",
    "X-WR-CALDESC:" + escapeIcsText("RosterBuddy roster export: " + safeRange.title + " — " + safeRange.label),
  ];
  let eventCount = 0;
  for (let date = new Date(safeRange.startDate); date <= safeRange.endDate; date = addDays(date, 1)) {
    if (!dateHasCalendarEntry(date)) continue;
    appendCalendarEvent(lines, date, safeRange.title + " " + safeRange.label);
    eventCount += 1;
  }
  if (!eventCount) {
    const start = new Date(safeRange.startDate);
    lines.push("BEGIN:VEVENT");
    lines.push("UID:rosterbuddy-empty-" + dateKeyForDate(start) + "@donkeyworks.rosterbuddy");
    lines.push("DTSTAMP:" + compactIcsDate(new Date()) + "T000000Z");
    lines.push("DTSTART;VALUE=DATE:" + compactIcsDate(start));
    lines.push("DTEND;VALUE=DATE:" + compactIcsDate(addDays(start, 1)));
    lines.push("SUMMARY:" + escapeIcsText("No RosterBuddy rostered shifts"));
    lines.push("DESCRIPTION:" + escapeIcsText("No rostered work shifts, on-call days, manual hours, or notes were found for " + safeRange.label + "."));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function buildCalendarIcs() {
  return buildCalendarIcsForRange(buildShareRanges().month);
}

function downloadCalendarIcs(icsText, filename) {
  downloadTextFile(icsText, filename, "text/calendar");
}

function calendarFilenameForRange(range, target = "google") {
  const start = range && range.startDate ? dateKeyForDate(range.startDate) : monthKey();
  const end = range && range.endDate ? dateKeyForDate(range.endDate) : monthKey();
  const prefix = target === "phone" ? "rosterbuddy-phone-calendar" : "rosterbuddy-google-calendar";
  return prefix + "-" + start + "-to-" + end + ".ics";
}

function calendarRangePayload(target) {
  updateSharePreview();
  const range = activeShareRange();
  return {
    range,
    filename: calendarFilenameForRange(range, target),
    icsText: buildCalendarIcsForRange(range),
  };
}

function handoffCalendarFile({ icsText, filename, range }, bridgeMethod, fallbackTitle, fallbackMessage, toastMessage) {
  try {
    const bridge = androidBridge();
    if (bridge && typeof bridge[bridgeMethod] === "function") {
      bridge[bridgeMethod](icsText, filename);
      showToast(toastMessage(range), "success");
      return;
    }
  } catch (error) {
    console.warn("RosterBuddy could not hand calendar file to Android.", error);
  }
  downloadCalendarIcs(icsText, filename);
  showInfoDialog(fallbackTitle, fallbackMessage(filename), "Done");
}

function exportGoogleCalendarRange() {
  handoffCalendarFile(
    calendarRangePayload("google"),
    "addCalendarFile",
    "Google Calendar import",
    (filename) => "Saved " + filename + ". Open it with Google Calendar to import the selected RosterBuddy range.",
    (range) => "Choose Google Calendar to import " + range.title.toLowerCase() + "."
  );
}

function exportPhoneCalendarRange() {
  handoffCalendarFile(
    calendarRangePayload("phone"),
    "addPhoneCalendarFile",
    "Phone calendar import",
    (filename) => "Saved " + filename + ". Open it with your phone calendar app to import the selected RosterBuddy range.",
    (range) => "Choose your phone calendar app to import " + range.title.toLowerCase() + "."
  );
}

function exportCalendar() {
  exportGoogleCalendarRange();
}

function scanRosterDraftLabel(draft) {
  const template = templates[draft.shiftKey];
  const label = template ? template.label : "Needs review";
  const markers = [draft.higherDuties ? "HD" : "", draft.onCall ? "OC" : ""].filter(Boolean).join(" ");
  return label + (markers ? " + " + markers : "");
}

function scanRosterMappingOptionsHtml() {
  return Object.entries(templates)
    .map(([key, template]) => "<option value=\"" + escapeHtml(key) + "\">" + escapeHtml(template.label || key) + "</option>")
    .join("");
}

function scanRosterMappingControlsHtml(draft, index) {
  if (!draft || draft.status === "ready") return "";
  return "<div class=\"scan-map-controls\" aria-label=\"Map unknown workplace code\"><label><span>Register code as</span><select data-scan-map-select=\"" + index + "\">" + scanRosterMappingOptionsHtml() + "</select></label><div class=\"scan-map-actions\"><button class=\"secondary-button compact\" type=\"button\" data-scan-map-code=\"" + index + "\">Save code</button><button class=\"ghost-button compact\" type=\"button\" data-scan-new-template=\"" + index + "\">Create new shift</button></div></div>";
}

function scanRosterStatusLabel(draft) {
  if (!draft || draft.status !== "ready") return "Needs setup";
  return draft.mappingSource === "mapped" ? "Mapped" : "Known";
}

function scanRosterStatusClass(draft) {
  return draft?.status === "ready" ? (draft.mappingSource === "mapped" ? " mapped" : " known") : " needs-setup";
}

function scanRosterAiSourceLabel(draft) {
  if (!draft || !draft.source || draft.source === "ocr") return "";
  if (draft.reviewState === "conflict") return "AI conflict";
  if (draft.source === "both") return "OCR + AI agree";
  return "AI only";
}

function scanRosterAiSourceClass(draft) {
  if (draft?.reviewState === "conflict") return " needs-setup";
  if (draft?.source === "both") return " known";
  if (draft?.source === "ai") return " mapped";
  return "";
}

function scanRosterAiSourceChipHtml(draft) {
  const label = scanRosterAiSourceLabel(draft);
  if (!label) return "";
  const confidence = draft.confidence ? " (" + draft.confidence + " confidence)" : "";
  return "<span class=\"scan-status-chip" + scanRosterAiSourceClass(draft) + "\">" + escapeHtml(label + confidence) + "</span>";
}

function scanRosterAiReasonHtml(draft) {
  return draft && draft.reason ? "<small>" + escapeHtml(draft.reason) + "</small>" : "";
}

function renderScanRosterImportSummary() {
  const summary = document.getElementById("scan-import-summary");
  if (!summary) return;
  if (!lastScanRosterImportSummary) {
    summary.classList.add("hidden-control");
    summary.textContent = "";
    return;
  }
  const result = lastScanRosterImportSummary;
  const codeText = result.codes.length ? " · Codes: " + result.codes.join(", ") : "";
  summary.classList.remove("hidden-control");
  summary.innerHTML = "<strong>Last import</strong><span>Imported " + result.imported + " · Skipped " + result.skipped + " · Ready " + result.ready + " · Needs setup " + result.needsReview + codeText + "</span>";
}

function syncScanRosterInputs() {
  const nameInput = document.getElementById("scan-roster-name");
  const aliasesInput = document.getElementById("scan-roster-aliases");
  if (nameInput) nameInput.value = scanRosterIdentity.name || "";
  if (aliasesInput) aliasesInput.value = scanRosterIdentity.aliases || "";
  const formatTeamInput = document.getElementById("scan-roster-format-team");
  const formatPersonalInput = document.getElementById("scan-roster-format-personal");
  if (formatTeamInput) formatTeamInput.checked = scanRosterFormat !== "personal";
  if (formatPersonalInput) formatPersonalInput.checked = scanRosterFormat === "personal";
  // Personal format never matches by name (see beginScanRosterRequest's
  // Team-only identity gate), so the identity card is hidden rather than
  // shown-but-irrelevant.
  const identitySection = document.getElementById("scan-roster-identity-section");
  if (identitySection && identitySection.classList) identitySection.classList.toggle("hidden-control", scanRosterFormat === "personal");
  renderGuidedScanChoices();
  renderScanRosterReview();
  renderScanRosterAiReview();
}

function saveScanRosterIdentityFromInputs() {
  scanRosterIdentity = {
    name: document.getElementById("scan-roster-name")?.value.trim() || "",
    aliases: document.getElementById("scan-roster-aliases")?.value.trim() || "",
  };
  saveState();
}

function saveScanRosterFormatFromInputs() {
  const personalInput = document.getElementById("scan-roster-format-personal");
  scanRosterFormat = sanitizedScanRosterFormat(personalInput && personalInput.checked ? "personal" : "team");
  saveState();
}

// The inner markup of one Review row, shared by Team's flat rows and
// Personal's grouped rows below so both paths render an identical row --
// only the surrounding container (a plain <article> for Team, one per
// date-group <section> for Personal) differs.
function scanRosterReviewRowInnerHtml(draft, index, awaitingConfirmation) {
  const statusLabel = scanRosterStatusLabel(draft);
  const heldAttribute = awaitingConfirmation ? " disabled" : "";
  const actionLabel = awaitingConfirmation ? "Held" : "Import";
  const readinessLabel = awaitingConfirmation ? "Waiting for Step 3" : (draft.status === "ready" ? "Ready to import" : "Needs manual review");
  return "<label class=\"toggle-row\"><input type=\"checkbox\" " + (draft.selected ? "checked" : "") + heldAttribute + " data-scan-draft=\"" + index + "\" /><span>" + actionLabel + "</span></label><div><strong>" + escapeHtml(scanRosterDraftDateLabel(draft)) + "</strong><small>Found: " + escapeHtml(draft.rawCode) + "</small></div><div><strong>" + escapeHtml(scanRosterDraftLabel(draft)) + "</strong><span class=\"scan-status-chip" + scanRosterStatusClass(draft) + "\">" + statusLabel + "</span>" + scanRosterAiSourceChipHtml(draft) + "<small>" + readinessLabel + "</small>" + scanRosterAiReasonHtml(draft) + scanRosterMappingControlsHtml(draft, index) + "</div>";
}

function scanRosterReviewRowHtml(draft, index, awaitingConfirmation) {
  return "<article class=\"scan-review-row" + (draft.status !== "ready" ? " needs-review" : "") + "\">"
    + scanRosterReviewRowInnerHtml(draft, index, awaitingConfirmation)
    + "</article>";
}

// Personal-only grouping key (see renderScanRosterReview): groups strictly
// by the draft's own resolved calendar date, in the drafts' existing array
// order. An unresolved-date draft (text-only fallback; never produced by
// Personal's own geometry path, but guarded here anyway) never merges with
// any other draft -- each gets its own singleton group instead of silently
// agreeing with an unrelated one just because both are "unresolved".
function scanRosterReviewGroupKey(draft, index) {
  if (draft.dateUnresolved) return "unresolved-" + index;
  return scanRosterDraftYear(draft) + "-" + scanRosterDraftMonth(draft) + "-" + draft.day;
}

function renderScanRosterReview() {
  const title = document.getElementById("scan-review-title");
  const list = document.getElementById("scan-review-list");
  const importButton = document.getElementById("scan-roster-import");
  const awaitingConfirmation = guidedScanAwaitingConfirmation();
  if (!title || !list) return;
  if (importButton) importButton.disabled = !scanRosterDrafts.length || awaitingConfirmation;
  if (!scanRosterDrafts.length) {
    title.textContent = "No scan results yet";
    list.innerHTML = "<p class=\"scan-empty\">Choose a roster screenshot, then confirm the date row, then your row, then any extra ambiguous rows. RosterBuddy will only stage shifts once every required step is confirmed.</p>";
    renderScanRosterImportSummary();
    return;
  }
  const readyCount = scanRosterDrafts.filter((draft) => draft.selected && draft.status === "ready").length;
  const reviewCount = scanRosterDrafts.filter((draft) => draft.status !== "ready").length;
  title.textContent = awaitingConfirmation
    ? "Waiting for Step 3 · " + scanRosterDrafts.length + " confirmed-row shift" + (scanRosterDrafts.length === 1 ? " held" : "s held")
    : ("Found " + scanRosterDrafts.length + " possible shifts · " + readyCount + " ready to import" + (reviewCount ? " · " + reviewCount + " need code setup" : ""));
  list.innerHTML = "";
  // Personal grids routinely carry more than one shift code for the same
  // physical date (separate physical rows under one date column -- see
  // guidedScanPersonalGridRowCandidates); showing each as its own flat,
  // identical-looking date row buries that they share a date. Grouped here
  // by the draft's own resolved date, in the drafts' existing array order --
  // already source-row order within one date, because of the final
  // date-only sort in buildGuidedScanGeometryDrafts, which is stable and so
  // never reorders two entries that already share a date. Team's layout is
  // left exactly as it was: Team's identity row already proves whose codes
  // these are, and grouping is specific to Personal's "whole grid" shape.
  if (guidedScanSession.rosterFormat === "personal") {
    const groups = [];
    let currentGroup = null;
    scanRosterDrafts.forEach((draft, index) => {
      const groupKey = scanRosterReviewGroupKey(draft, index);
      if (!currentGroup || currentGroup.key !== groupKey) {
        currentGroup = { key: groupKey, label: scanRosterDraftDateLabel(draft), rowsHtml: [] };
        groups.push(currentGroup);
      }
      currentGroup.rowsHtml.push(scanRosterReviewRowHtml(draft, index, awaitingConfirmation));
    });
    groups.forEach((group) => {
      const section = document.createElement("section");
      section.className = "scan-review-date-group";
      section.innerHTML = "<h3 class=\"scan-review-date-heading\">" + escapeHtml(group.label) + "</h3>" + group.rowsHtml.join("");
      list.appendChild(section);
    });
  } else {
    scanRosterDrafts.forEach((draft, index) => {
      const row = document.createElement("article");
      row.className = "scan-review-row" + (draft.status !== "ready" ? " needs-review" : "");
      row.innerHTML = scanRosterReviewRowInnerHtml(draft, index, awaitingConfirmation);
      list.appendChild(row);
    });
  }
  renderScanRosterImportSummary();
  list.querySelectorAll("[data-scan-draft]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const draft = scanRosterDrafts[Number(checkbox.dataset.scanDraft)];
      if (draft) draft.selected = checkbox.checked;
      renderScanRosterReview();
    });
  });
  list.querySelectorAll("[data-scan-map-code]").forEach((button) => {
    button.addEventListener("click", () => mapScanRosterDraftCode(Number(button.dataset.scanMapCode)));
  });
  list.querySelectorAll("[data-scan-new-template]").forEach((button) => {
    button.addEventListener("click", () => openScanRosterTemplateForDraft(Number(button.dataset.scanNewTemplate)));
  });
}

function renderScanRosterAiReview() {
  const button = document.getElementById("scan-roster-ai-assist");
  const summaryEl = document.getElementById("scan-ai-summary");
  const warningsEl = document.getElementById("scan-ai-warnings");
  const diagnosticsEl = document.getElementById("scan-ai-diagnostics");
  const awaitingConfirmation = guidedScanAwaitingConfirmation();
  if (button) button.disabled = !scanRosterDrafts.length || awaitingConfirmation;
  if (!scanRosterAiReview) {
    if (summaryEl) summaryEl.textContent = awaitingConfirmation && scanRosterDrafts.length
      ? "Waiting for Step 3. Decide every extra ambiguous row before AI Assist can inspect the confirmed result."
      : "Not run yet. AI Assist is optional and never imports anything on its own.";
    if (warningsEl) { warningsEl.innerHTML = ""; warningsEl.classList.add("hidden-control"); }
    if (diagnosticsEl) diagnosticsEl.textContent = "";
    return;
  }
  const review = scanRosterAiReview;
  if (summaryEl) summaryEl.textContent = (review.providerLabel || "") + (review.summary ? " " + review.summary : "");
  if (warningsEl) {
    if (review.warnings && review.warnings.length) {
      warningsEl.classList.remove("hidden-control");
      warningsEl.innerHTML = review.warnings.map((warning) => "<li>" + escapeHtml(warning) + "</li>").join("");
    } else {
      warningsEl.classList.add("hidden-control");
      warningsEl.innerHTML = "";
    }
  }
  if (diagnosticsEl && review.diagnostics) {
    const d = review.diagnostics;
    diagnosticsEl.textContent = "OCR drafts " + d.ocrDraftCount + " · AI suggested " + d.aiSuggestedCount + " · Agreed " + d.agreedCount + " · AI-only " + d.aiOnlyCount + " · Conflicts " + d.conflictCount + " · Warnings " + d.warningCount;
  }
}

function guidedScanEmptyHtml(message) {
  return "<p class=\"scan-empty\">" + escapeHtml(message) + "</p>";
}

function guidedScanCandidateButtonHtml(candidate, index, type) {
  const isCurrent = type === "row" ? guidedScanSession.selectedRowIndex === index : guidedScanSession.selectedDateIndex === index;
  const confirmed = type === "row"
    ? (guidedScanSession.rosterFormat === "personal" ? guidedScanSession.personalContextConfirmed : guidedScanSession.staffRowConfirmed)
    : guidedScanSession.dateRowConfirmed;
  const meta = type === "row"
    ? (candidate.codes.length + " shift codes")
    : ((candidate.dates || []).map((date) => scanRosterDraftDateLabel(date)).join(" · ") || "possible date row");
  // "selected" is reserved for a row the user has actually confirmed. A row the
  // automatic pass merely suggested is shown as a suggestion, so a preselection
  // can never read as a confirmation the user did not make.
  const stateClass = isCurrent ? (confirmed ? " selected confirmed" : " suggested") : "";
  const stateNote = isCurrent ? (confirmed ? " · Confirmed" : " · Suggested — tap to confirm") : "";
  return "<button class=\"guided-scan-option" + stateClass + "\" type=\"button\" data-guided-scan-" + type + "=\"" + index + "\"><strong>" + escapeHtml(candidate.line) + "</strong><small>" + escapeHtml(meta + stateNote) + "</small></button>";
}

// Step 3 markup for one continuation-band decision. A resolved decision
// (accepted/rejected, including auto-excluded-as-unavailable) renders as a
// plain status line -- there is nothing left for the user to act on. A
// still-pending decision renders the crop (once fetched) plus Accept/Reject
// buttons; the crop itself is the sole deliberate transient image display
// (see CLAUDE.md's scanner privacy rules) and is never written into
// diagnostics or the debug log anywhere in this file.
function guidedScanContinuationEntryHtml(decision) {
  const label = "Extra row " + decision.bandIndex;
  if (decision.status !== "pending") {
    const statusText = decision.status === "accepted"
      ? "Included in Review"
      : (decision.unavailable ? "Excluded — preview unavailable" : "Excluded from Review");
    return "<div class=\"guided-scan-option resolved\"><strong>" + escapeHtml(label) + "</strong><small>" + escapeHtml(statusText) + "</small></div>";
  }
  const activePreview = guidedScanSession.activePreview && guidedScanSession.activePreview.bandIndex === decision.bandIndex
    ? guidedScanSession.activePreview.dataUrl
    : null;
  const previewHtml = activePreview
    ? "<img class=\"guided-scan-band-preview\" alt=\"Cropped preview of this ambiguous row\" src=\"" + activePreview + "\" />"
    : "<p class=\"scan-empty\">Loading preview…</p>";
  return "<div class=\"guided-scan-option guided-scan-continuation-pending\">"
    + "<strong>" + escapeHtml(label) + " — is this really your row?</strong>"
    + previewHtml
    + "<div class=\"two-col\">"
    + "<button class=\"secondary-button\" type=\"button\" data-guided-scan-reject-band=\"" + decision.bandIndex + "\">No, exclude it</button>"
    + "<button class=\"primary-button\" type=\"button\" data-guided-scan-accept-band=\"" + decision.bandIndex + "\">Yes, it's mine</button>"
    + "</div></div>";
}

function guidedScanResolvedEntryHtml(entry) {
  return "<div class=\"guided-scan-option resolved\"><strong>" + escapeHtml(entry.monthText + " " + entry.day) + "</strong><small>" + escapeHtml(entry.rawCodes.join(" ")) + "</small></div>";
}

// Informational summary of what the automatic pass matched on its own. It sits
// ABOVE the real selectors -- it is context, never a replacement for the
// user's confirmation.
const GUIDED_SCAN_PERSONAL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Personal's Step 2 replacement for Team's Staff-row candidate buttons (see
// confirmGuidedScanPersonalDateContext). A plain <select>/<input> pair, never
// prefilled from currentMonth/currentYear or any other "today" value --
// Personal grids have no printed year to read automatically, so a guessed
// default here would look like a real answer the user never actually gave.
// Deliberately not wrapped in a <form>: this card sits inside the larger
// scanner screen, and an Enter keypress inside a <form> would submit/reload
// rather than just confirm this one control.
function guidedScanPersonalDateContextFormHtml() {
  const monthOptions = GUIDED_SCAN_PERSONAL_MONTH_NAMES
    .map((name, index) => "<option value=\"" + index + "\">" + escapeHtml(name) + "</option>").join("");
  return "<div class=\"guided-scan-personal-context\">"
    + "<p class=\"scan-empty\">Enter this roster's own printed starting month and year, then confirm. Never inferred from today's date.</p>"
    + "<label for=\"guided-scan-personal-month\">Start month</label>"
    + "<select id=\"guided-scan-personal-month\" data-guided-scan-personal-month><option value=\"\" selected>Choose month</option>" + monthOptions + "</select>"
    + "<label for=\"guided-scan-personal-year\">Start year</label>"
    + "<input id=\"guided-scan-personal-year\" data-guided-scan-personal-year type=\"number\" inputmode=\"numeric\" placeholder=\"e.g. 2026\">"
    + "<button class=\"primary-button\" type=\"button\" data-guided-scan-confirm-personal-context>Confirm start month/year</button>"
    + "</div>";
}

function guidedScanPersonalDateContextConfirmedHtml() {
  const context = guidedScanSession.personalDateContext;
  const label = context ? GUIDED_SCAN_PERSONAL_MONTH_NAMES[context.month] + " " + context.year : "";
  return "<div class=\"guided-scan-option selected confirmed\"><strong>Roster start month/year</strong><small>" + escapeHtml(label + " · Confirmed") + "</small></div>";
}

function guidedScanAutomaticSummaryHtml() {
  if (!guidedScanSession.resolvedLines.length) return "";
  return "<p class=\"scan-empty\">Automatic match found " + guidedScanSession.resolvedLines.length
    + " shift(s) from this photo's column layout. Confirm the rows below to check or correct it. Nothing is imported until you confirm in Review.</p>"
    + "<div class=\"guided-scan-auto-summary\">" + guidedScanSession.resolvedLines.map(guidedScanResolvedEntryHtml).join("") + "</div>";
}

function renderGuidedScanChoices() {
  const rowList = document.getElementById("guided-scan-row-list");
  const dateList = document.getElementById("guided-scan-date-list");
  if (guidedScanSession.mode === "resolved-summary") {
    // Text-only fallback with no row geometry: the OCR text genuinely holds no
    // separate header row or staff row to choose between. Report what was
    // matched and ask for a rescan rather than inventing selectors.
    if (dateList) {
      dateList.innerHTML = guidedScanAutomaticSummaryHtml()
        + guidedScanEmptyHtml("No separate date row could be read from this image, so there is nothing to confirm here. Rescan with the whole table (date header and your row) visible to choose the rows yourself.");
    }
    if (rowList) {
      rowList.innerHTML = guidedScanEmptyHtml("No selectable rows were found in this image. Review the automatically matched shifts above, or rescan with the date header and your row both visible.");
    }
    return;
  }
  if (dateList) {
    const warningHtml = guidedScanSession.warning ? "<p class=\"scan-empty warning\">" + escapeHtml(guidedScanSession.warning) + "</p>" : "";
    dateList.innerHTML = guidedScanAutomaticSummaryHtml() + (guidedScanSession.dateCandidates.length
      ? guidedScanSession.dateCandidates.map((candidate, index) => guidedScanCandidateButtonHtml(candidate, index, "date")).join("")
      : guidedScanEmptyHtml("Choose a roster image to find the date row.")) + warningHtml;
    dateList.querySelectorAll("[data-guided-scan-date]").forEach((button) => {
      button.addEventListener("click", () => confirmGuidedScanDateRow(Number(button.dataset.guidedScanDate)));
    });
  }
  const isPersonalFormat = guidedScanSession.rosterFormat === "personal";
  const rowHeading = document.getElementById("guided-scan-row-heading");
  if (rowHeading) rowHeading.textContent = isPersonalFormat ? "Confirm the roster's start month/year" : "Confirm your row";
  if (rowList) {
    // Step 2 only ever shows real options once Step 1 is confirmed. Staff
    // candidates for every table are already derived by
    // prepareGuidedScanSession (see guidedScanGeometryStaffCandidatesForDate),
    // but only the confirmed table's own set is ever copied onto
    // guidedScanSession.rowCandidates -- before that, there is nothing
    // genuine to preview here, and no other table's rows are exposed.
    //
    // Personal has no Staff step at all (see confirmGuidedScanPersonalDateContext
    // and guidedScanFlowComplete): confirmGuidedScanStaffRow deliberately
    // refuses a personal-grid candidate, so rendering Team's Staff-row
    // buttons here would be a dead end the user could tap forever without
    // ever reaching Review. Personal's own Step 2 is the start month/year
    // confirmation form below instead.
    if (!guidedScanSession.dateRowConfirmed) {
      rowList.innerHTML = guidedScanEmptyHtml(isPersonalFormat
        ? "Confirm the date row first, then the roster's start month and year."
        : "Confirm the date row first, then choose your row.");
    } else if (isPersonalFormat) {
      const personalCandidate = guidedScanSession.rowCandidates[0];
      if (!personalCandidate || personalCandidate.source !== "personal-grid") {
        rowList.innerHTML = guidedScanEmptyHtml("No personal grid could be confirmed from this date row. Choose another date row, or rescan with the whole grid visible.");
      } else if (guidedScanSession.personalContextConfirmed) {
        rowList.innerHTML = guidedScanPersonalDateContextConfirmedHtml();
      } else {
        rowList.innerHTML = guidedScanPersonalDateContextFormHtml();
        rowList.querySelectorAll("[data-guided-scan-confirm-personal-context]").forEach((button) => {
          button.addEventListener("click", () => {
            const monthInput = rowList.querySelector("[data-guided-scan-personal-month]");
            const yearInput = rowList.querySelector("[data-guided-scan-personal-year]");
            // A blank <select>/<input> must fail closed, never resolve to
            // January via Number("") === 0 -- blank is mapped to NaN here so
            // confirmGuidedScanPersonalDateContext's own Number.isInteger
            // check rejects it the same way a genuinely invalid value would.
            const monthRaw = monthInput ? String(monthInput.value).trim() : "";
            const yearRaw = yearInput ? String(yearInput.value).trim() : "";
            confirmGuidedScanPersonalDateContext(
              monthRaw === "" ? NaN : Number(monthRaw),
              yearRaw === "" ? NaN : Number(yearRaw)
            );
          });
        });
      }
    } else {
      rowList.innerHTML = guidedScanSession.rowCandidates.length
        ? guidedScanSession.rowCandidates.map((candidate, index) => guidedScanCandidateButtonHtml(candidate, index, "row")).join("")
        : guidedScanEmptyHtml("No selectable rows were found in that date row's table. Choose another date row, or rescan with your row fully visible.");
      rowList.querySelectorAll("[data-guided-scan-row]").forEach((button) => {
        button.addEventListener("click", () => confirmGuidedScanStaffRow(Number(button.dataset.guidedScanRow)));
      });
    }
  }
  const continuationList = document.getElementById("guided-scan-continuation-list");
  if (continuationList) {
    const decisions = guidedScanSession.continuationBandDecisions || [];
    continuationList.innerHTML = decisions.length
      ? decisions.map(guidedScanContinuationEntryHtml).join("")
      : guidedScanEmptyHtml("No extra ambiguous rows were found for your row in this photo.");
    continuationList.querySelectorAll("[data-guided-scan-accept-band]").forEach((button) => {
      button.addEventListener("click", () => guidedScanResolveContinuationBand(Number(button.dataset.guidedScanAcceptBand), true));
    });
    continuationList.querySelectorAll("[data-guided-scan-reject-band]").forEach((button) => {
      button.addEventListener("click", () => guidedScanResolveContinuationBand(Number(button.dataset.guidedScanRejectBand), false));
    });
    // Lazily fetch one preview per render pass, for the first pending
    // decision that has not been attempted yet. previewAttempted is set
    // BEFORE the fetch call (which itself re-renders on both success and
    // failure) so this can never loop back onto the same band twice.
    const nextPending = decisions.find((decision) => decision.status === "pending" && !decision.previewAttempted);
    if (nextPending) {
      nextPending.previewAttempted = true;
      guidedScanRequestContinuationBandPreview(nextPending.bandIndex);
    }
  }
}

function clearGuidedScanSession() {
  // Read before the session object below is replaced -- this is the sole
  // teardown point for guidedScanSession, so it is also the one place that
  // reliably observes every lifecycle event requirement 6 lists (new scan
  // via beginScanRosterRequest -> resetScanRosterSessionState(true), Clear
  // results via clearScanRosterDrafts -> resetScanRosterSessionState(false),
  // and leaving/resetting the scanner generally) and releases whatever
  // native preview source the outgoing session held.
  releaseGuidedScanPreviewSourceIfHeld();
  clearGuidedScanCloudArtifact();
  guidedScanPreviewBootstraps.clear();
  guidedScanSession = { rawText: "", lines: [], mode: "header-row", resolvedLines: [], rowCandidates: [], dateCandidates: [], geometryBlocks: [], automaticDrafts: [], trustedRowStripDrafts: [], trustedRowStripCapability: null, trustedRowStripRequestId: null, trustedRowStripGeneration: null, rowStripProvenance: null, requiresConfirmation: false, dateRowConfirmed: false, staffRowConfirmed: false, personalContextConfirmed: false, personalDateContext: null, selectedRowIndex: -1, selectedDateIndex: -1, warning: "", continuationBandDecisions: [], fullDrafts: [], previewRequestId: null, previewGeneration: null, scanSessionId: null, activePreview: null };
  renderGuidedScanChoices();
}

function resetScanRosterSessionState(clearDiagnostics) {
  scanRosterDrafts = [];
  lastScanRosterImportSummary = null;
  scanRosterAiReview = null;
  scanRosterOcrAwaitingResult = true;
  if (clearDiagnostics) {
    lastScanRosterOcrResult = null;
    lastScanRosterAlignmentDiagnostics = null;
    lastScanRosterGeometryDiagnostics = null;
    scanRosterOcrDebugEvents.length = 0;
  }
  clearGuidedScanSession();
  renderScanRosterReview();
  renderScanRosterAiReview();
}

function clearScanRosterDrafts() {
  const requestId = currentScanRosterRequestId;
  if (scanRosterTransactionIsActive(requestId)) {
    transitionScanRosterTransaction(requestId, "cancelled", { error: new Error("Roster scan cancelled.") });
  }
  resetScanRosterSessionState(false);
  currentScanRosterRequestId = null;
}

function mapScanRosterDraftCode(index) {
  const draft = scanRosterDrafts[index];
  const select = document.getElementById("scan-review-list")?.querySelector("[data-scan-map-select=\"" + index + "\"]");
  const shiftKey = select?.value || "";
  if (!draft || !registerScanRosterCodeMapping(draft.rawCode, shiftKey, { onCall: draft.onCall, higherDuties: draft.higherDuties })) {
    showToast("Choose a shift type before saving this code.", "info");
    return;
  }
  scanRosterDrafts = applyScanRosterCodeMappingsToDrafts(scanRosterDrafts);
  renderScanRosterReview();
  showToast("Saved code " + draft.rawCode + " for future roster imports.", "success");
}

function openScanRosterTemplateForDraft(index) {
  const draft = scanRosterDrafts[index];
  const createdKey = createScanRosterTemplateForDraft(draft);
  if (!createdKey) {
    showToast("Choose an unknown code before creating a shift.", "info");
    return;
  }
  pendingScanRosterReviewTemplateKey = createdKey;
  scanRosterDrafts = applyScanRosterCodeMappingsToDrafts(scanRosterDrafts);
  openTemplateEditor(createdKey);
  showToast("New shift created for " + draft.rawCode + ". Set the times, then save.", "info");
}

function importReviewedScanRosterDrafts() {
  // Defence in depth: staging already leaves scanRosterDrafts empty until both
  // guided rows are confirmed, so this should be unreachable -- but Import is
  // the one irreversible action here, so refuse outright rather than rely on
  // the staged list having been cleared correctly.
  if (guidedScanAwaitingConfirmation()) {
    showToast("Confirm the date row, then your row, then any extra ambiguous rows, before importing.", "warning");
    return;
  }
  const summary = importScanRosterDrafts(scanRosterDrafts);
  renderScanRosterReview();
  showToast("Imported " + summary.imported + " scanned shifts" + (summary.skipped ? " · " + summary.skipped + " skipped" : "") + (summary.needsReview ? " · " + summary.needsReview + " still need setup" : ""), summary.imported ? "success" : "info");
  if (summary.imported) showScreen("calendar");
}

function setScanRosterPhotoStatus(message) {
  const status = document.getElementById("scan-roster-photo-status");
  if (status) status.textContent = message;
}

function renderScanRosterPremiumGate() {
  const locked = !premiumFeatureState("scanner").allowed;
  const lockedCard = document.getElementById("scan-roster-locked-card");
  const gatedContent = document.getElementById("scan-roster-gated-content");
  if (lockedCard) lockedCard.classList.toggle("hidden-control", !locked);
  if (gatedContent) gatedContent.classList.toggle("hidden-control", locked);
}

function renderPremiumScreen() {
  const unlocked = isPremiumUnlocked();
  const statusHeading = document.getElementById("premium-status-heading");
  if (statusHeading) statusHeading.textContent = playPremiumUnlocked ? "Premium active" : "Free plan";
  const settingsStatus = document.getElementById("settings-premium-status");
  if (settingsStatus) settingsStatus.textContent = playPremiumUnlocked ? "Premium" : "Free";
  const detail = document.getElementById("premium-status-detail");
  if (detail) detail.textContent = unlocked
    ? "Smart Scanner is unlocked. Manual entry, calendar, pay estimates, recovery, backup/restore, and sharing remain free."
    : "Manual entry, calendar, pay estimates, recovery, backup/restore, and sharing are free and always available. Premium unlocks Smart Scanner.";
}

const scanRosterOcrDebugEvents = [];
let lastScanRosterOcrResult = null;
let lastScanRosterAlignmentDiagnostics = null;
let lastScanRosterGeometryDiagnostics = null;

// Diagnostics are deliberately metadata-only. Native OCR detail can contain
// names, roster lines and a `preview=...` tail even on an entirely successful,
// non-withheld scan, so never retain arbitrary detail text. Keep only the
// numeric counters that support troubleshooting; stage names are recorded by
// appendScanRosterOcrDebug separately.
// Every key here must be a SEMANTIC count -- how many dates/shifts/lines/
// drafts/variants the scan resolved -- never a measurement of the content
// itself. A character count, byte count or pixel dimension is derived from
// the user's own roster photo: it varies with who is on that roster and how
// many days it covers, and this string is copied and sent by the user. The
// previously allowlisted "chars"/"bytes"/"width"/"height" are gone for that
// reason; do not reintroduce them, and do not add a key whose value is not
// provably a count of resolved roster structure.
const SCAN_ROSTER_DIAGNOSTIC_COUNT_KEYS = new Set([
  "lines", "originalLines", "mergedLines", "autoRowStripVariants",
  "dateColumns", "shiftTokens", "aligned", "lowConfidence", "unaligned",
  "finalDrafts", "dates", "months", "shifts", "blocks",
  "count", "drafts", "warnings", "conflicts", "rejected", "secondPassTokens",
]);

// Keys whose value is a closed lowercase status word rather than a count --
// kept as a separate key set and a separate scan below (never folded into
// the digit-only pattern above) so neither sibling can widen the other's
// value shape. Mirrors the native sanitizeOcrDetail allowlist's
// OCR_DETAIL_STATE_KEYS/freshScanStatusToken mapping for
// native-freshscan-second-pass specifically.
const SCAN_ROSTER_DIAGNOSTIC_STATUS_KEYS = new Set(["firstStatus", "finalStatus"]);
const SCAN_ROSTER_DIAGNOSTIC_STATUS_VALUES = new Set(["complete", "partial", "rejected"]);

// Separate key/value set for native-freshscan-header-recovery's own closed
// enum -- kept apart from the status pair above for the same reason: so
// neither sibling's value vocabulary can widen the other's. Mirrors the
// native sanitizeOcrDetail allowlist's headerRecoveryOutcomeToken mapping.
const SCAN_ROSTER_DIAGNOSTIC_HEADER_RECOVERY_KEYS = new Set(["headerRecoveryOutcome"]);
const SCAN_ROSTER_DIAGNOSTIC_HEADER_RECOVERY_VALUES = new Set([
  "accepted", "merge-rejected", "validation-rejected", "other-rejected",
]);

function scanRosterDiagnosticCounts(detail) {
  const text = String(detail || "");
  const seen = new Set();
  const matches = [];

  // The key must start the token outright. A bare \b would let any
  // non-word-character prefix smuggle an allowlisted key back in --
  // "row-chars=137" puts a word boundary immediately before "chars", so the
  // old pattern matched the key "chars" inside it and published a raw OCR
  // character count. The lookbehind requires that nothing identifier-like
  // (including a hyphen or underscore) precedes the key.
  const countPattern = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+)\b/g;
  let match;
  while ((match = countPattern.exec(text))) {
    if (!SCAN_ROSTER_DIAGNOSTIC_COUNT_KEYS.has(match[1]) || seen.has(match[1])) continue;
    seen.add(match[1]);
    matches.push({ index: match.index, text: match[1] + "=" + match[2] });
  }

  // A second, narrower scan for the closed status vocabulary -- a value must
  // be an all-lowercase word AND one of the exact three mapped statuses, so
  // a name, path or unmapped/uppercase word on the same key is still dropped.
  const statusPattern = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*)\s*=\s*([a-z][a-z0-9-]{0,23})(?![A-Za-z0-9_-])/g;
  while ((match = statusPattern.exec(text))) {
    if (!SCAN_ROSTER_DIAGNOSTIC_STATUS_KEYS.has(match[1]) || !SCAN_ROSTER_DIAGNOSTIC_STATUS_VALUES.has(match[2]) || seen.has(match[1])) continue;
    seen.add(match[1]);
    matches.push({ index: match.index, text: match[1] + "=" + match[2] });
  }

  // A third, separate scan for native-freshscan-header-recovery's own
  // closed enum -- same shape as the status scan, deliberately its own
  // key/value set (see the comment above the sets) rather than folded in.
  const headerRecoveryPattern = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]*)\s*=\s*([a-z][a-z0-9-]{0,23})(?![A-Za-z0-9_-])/g;
  while ((match = headerRecoveryPattern.exec(text))) {
    if (!SCAN_ROSTER_DIAGNOSTIC_HEADER_RECOVERY_KEYS.has(match[1]) || !SCAN_ROSTER_DIAGNOSTIC_HEADER_RECOVERY_VALUES.has(match[2]) || seen.has(match[1])) continue;
    seen.add(match[1]);
    matches.push({ index: match.index, text: match[1] + "=" + match[2] });
  }

  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => m.text).join(", ");
}

function appendScanRosterOcrDebug(stage, detail = "") {
  const safeStage = String(stage || "event").trim() || "event";
  const safeDetail = scanRosterDiagnosticCounts(detail);
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  scanRosterOcrDebugEvents.push("[" + stamp + "] " + safeStage + (safeDetail ? " — " + safeDetail : ""));
  while (scanRosterOcrDebugEvents.length > 80) scanRosterOcrDebugEvents.shift();
  const log = document.getElementById("scan-roster-debug-log");
  if (log) log.textContent = scanRosterOcrDebugEvents.slice(-10).join("\n");
  renderScanRosterDiagnosticsScreen();
}

// The one native call site that sends no requestId at all: an unmatched
// picker request code (no launch was ever registered under it, so there is
// no requestId to carry). Carries no transaction-private detail by
// construction. Every other native debug call site now parses/tags its
// requestId before sending (including the fallback path's own first log
// line, "fallback-start" -- see RosterMateBridge.extractRosterTextFromImage),
// so this allowlist stays narrow rather than growing into a second, weaker
// gate.
const SCAN_ROSTER_GLOBAL_DEBUG_STAGES = new Set(["native-picker-unmatched-request-code"]);

// A TAGGED event must be the current transaction -- the same non-null
// request-id equality every other native callback uses (see
// scanRosterOcrResultIsCurrent) -- or it is dropped entirely: a stale
// tagged event belongs to an attempt that has already been superseded or
// answered and must never leak into the current session's debug log.
// An UNTAGGED event is only ever genuinely global: it is accepted solely
// when no transaction is active AND its stage is in the narrow allowlist
// above. While a transaction is active, an untagged event carries no proof
// it belongs to the current attempt (or any attempt at all), so it is
// dropped exactly like a stale tagged one would be -- an untagged event is
// not a free pass just because it cannot be checked by id.
function handleScanRosterOcrDebug(event = {}) {
  const requestId = event.requestId != null ? event.requestId : null;
  if (requestId !== null) {
    if (!scanRosterTransactionIsCurrent(requestId)) return;
  } else if (currentScanRosterRequestId !== null || !SCAN_ROSTER_GLOBAL_DEBUG_STAGES.has(event.stage)) {
    return;
  }
  appendScanRosterOcrDebug(event.stage, event.detail);
}

function scanRosterDraftSummaryLines() {
  return (scanRosterDrafts || []).map((draft) => {
    return scanRosterDraftDateLabel(draft) + " — " + (draft?.status || "unknown");
  });
}

function compactScanRosterOcrSummary() {
  const result = lastScanRosterOcrResult || {};
  const detail = String(result.detail || result.error || "");
  const baseline = detail.match(/(?:originalLines|lines)=(\d+)/)?.[1] || "?";
  const merged = detail.match(/mergedLines=(\d+)/)?.[1] || String((scanRosterDrafts || []).length || "?");
  const variants = detail.match(/autoRowStripVariants=(\d+)/)?.[1] || "?";

  const rejectedHint = detail.includes("broadAdjacentRowSuspected") || scanRosterOcrDebugEvents.some((line) => line.includes("broadAdjacentRowSuspected")) ? "adjacent-row candidates suppressed" : "none reported";
  return [
    "OCR summary",
    "Drafts: " + (scanRosterDrafts || []).length,
    "Baseline lines: " + baseline,
    "Merged lines: " + merged,
    "Row-strip variants: " + variants,
    "Rejected/guarded: " + rejectedHint,
  ].join("\n");
}

// Phase 8: compact, read-only diagnostic summary of native's optional
// structuralCells payload (already normalized/validated at the
// scanRosterPrivacySafeOcrResult choke point -- see
// guidedScanNormalizeStructuralCells). Shows only counts and the normalized
// cells' own month/day/code/band/support -- never names, coordinates,
// filenames, hashes, or raw OCR text. A missing or rejected/invalid payload
// (normalized to null) shows the same "unavailable" copy either way, so a
// hostile/malformed raw payload can never leak its rejected content here.
function scanRosterStructuralCellsDiagnosticsLine(result) {
  const structuralCells = result && result.structuralCells;
  if (!structuralCells || !Array.isArray(structuralCells.cells)) return "Structural comparison: unavailable";
  const cells = structuralCells.cells;
  const cellSummaries = cells.map((cell) => cell.month + " " + cell.day + " " + cell.code + " (band " + cell.band + ", support " + cell.support + ")");
  return "Structural comparison: bands " + structuralCells.bandCount + " · cells " + cells.length
    + (cellSummaries.length ? " · " + cellSummaries.join(", ") : "");
}

// Read-only summary for the private FreshRosterScanner diagnostics panel: reads ONLY result.freshScanner/.freshScannerInvalid (see guidedScanNormalizeFreshScannerDiagnostic), never result.text/.textBlocks or any sibling field, and never selects/imports/writes calendar state.
function freshScannerDiagnosticsCellDate(cell) {
  const month = String(cell.month).padStart(2, "0");
  const day = String(cell.day).padStart(2, "0");
  return cell.year !== null ? cell.year + "-" + month + "-" + day : month + "-" + day;
}

function freshScannerDiagnosticsSummaryLine(result) {
  const freshScanner = result && result.freshScanner;
  if (freshScanner) {
    const cellSummaries = freshScanner.cells.map((cell) => freshScannerDiagnosticsCellDate(cell) + " " + cell.code);
    const reasonNames = Object.keys(freshScanner.rejectionCounts).sort();
    const rejectionSummaries = reasonNames.map((reason) => reason + "=" + freshScanner.rejectionCounts[reason]);
    const diagnostic = freshScanner.allocationDiagnostic;
    const diagnosticSummary = diagnostic
      ? " (shape " + diagnostic.shape + ", row +" + diagnostic.rowOffsetFromIdentity
        + ", later name-shaped token " + (diagnostic.laterNameShapedTokenInRow ? "yes" : "no") + ")"
      : "";
    return "FreshRosterScanner (diagnostic candidate): status " + freshScanner.status
      + " · cells " + freshScanner.cells.length + (cellSummaries.length ? " · " + cellSummaries.join(", ") : "")
      + " · rejections " + (rejectionSummaries.length ? rejectionSummaries.join(", ") : "none") + diagnosticSummary;
  }
  if (result && result.freshScannerInvalid) return "FreshRosterScanner (diagnostic candidate): diagnostic payload failed validation and was discarded.";
  return "FreshRosterScanner (diagnostic candidate): no diagnostic result for this scan.";
}

// Read-only summary for the guided-scan staff-row diagnostic (see
// guidedScanStaffRowDiagnostic): reports why Step 2 ("Confirm your row")
// currently shows no selectable candidate for the confirmed/preselected date
// row, via closed reason/boolean/count fields only. Never influences
// candidate selection, staging, or import.
function guidedScanStaffRowDiagnosticsSummaryLine() {
  if (guidedScanSession.mode !== "geometry" || !guidedScanSession.dateCandidates.length) {
    return "Guided staff-row diagnostic: not available for this scan (no date-row candidates).";
  }
  const index = guidedScanSession.selectedDateIndex;
  const candidate = index >= 0 ? guidedScanSession.dateCandidates[index] : null;
  const diagnostic = candidate && candidate.staffRowDiagnostic;
  if (!diagnostic) return "Guided staff-row diagnostic: no date row selected yet.";
  return "Guided staff-row diagnostic: reason " + diagnostic.reason
    + " · identity match found " + (diagnostic.identityMatchFound ? "yes" : "no")
    + " · within table " + (diagnostic.candidateWithinTable ? "yes" : "no")
    + " · candidate bands " + diagnostic.candidateBandCount
    + " · rejected by row reach " + (diagnostic.rejectedByRowReach ? "yes" : "no")
    + (diagnostic.nearestBandOffsetRatio !== null ? " · nearest band offset ratio " + diagnostic.nearestBandOffsetRatio : "");
}

function scanRosterDiagnosticsText(options = {}) {
  const status = document.getElementById("scan-roster-photo-status")?.textContent || "No status yet.";
  const draftSummary = scanRosterDraftSummaryLines();
  const result = lastScanRosterOcrResult || {};
  const full = Boolean(options.full);
  const eventLines = full ? scanRosterOcrDebugEvents : scanRosterOcrDebugEvents.slice(-12);
  return [
    "RosterBuddy OCR diagnostics",
    "Version: " + APP_VERSION,
    compactScanRosterOcrSummary(),
    "Status: " + status,
    "Last OCR stage: " + (result.stage || "none"),
    "Last OCR ok: " + (Object.prototype.hasOwnProperty.call(result, "ok") ? String(Boolean(result.ok)) : "none"),
    full ? "Last OCR counts: " + (scanRosterDiagnosticCounts(result.detail) || "none") : "Detail: compact view — use Copy diagnostics for the full event log.",
    "",
    scanRosterStructuralCellsDiagnosticsLine(result),
    "",
    freshScannerDiagnosticsSummaryLine(result),
    "",
    guidedScanStaffRowDiagnosticsSummaryLine(),
    "",
    lastScanRosterGeometryDiagnostics
      ? "Geometry: date columns " + lastScanRosterGeometryDiagnostics.dateColumnsDetected +
        " · identity row found " + (lastScanRosterGeometryDiagnostics.identityFound ? "yes" : "no") +
        " · shift tokens " + lastScanRosterGeometryDiagnostics.shiftTokensDetected +
        " · aligned " + lastScanRosterGeometryDiagnostics.alignedTokens +
        " (low-confidence " + lastScanRosterGeometryDiagnostics.lowConfidenceAligned + ")" +
        // C62: count only -- never the unaligned tokens' own text. This
        // string is copied and sent by the user.
        " · unaligned " + lastScanRosterGeometryDiagnostics.unalignedTokens +
        " · final drafts " + lastScanRosterGeometryDiagnostics.finalDraftCount
      : "Geometry: not computed for this scan (no OCR text-block geometry available).",
    "",
    lastScanRosterAlignmentDiagnostics
      ? "Alignment: date headers " + lastScanRosterAlignmentDiagnostics.dateHeadersDetected +
        " · configured row found " + (lastScanRosterAlignmentDiagnostics.configuredRowDetected ? "yes" : "no") +
        " · shift-like tokens " + lastScanRosterAlignmentDiagnostics.shiftLikeTokensDetected +
        " · aligned " + lastScanRosterAlignmentDiagnostics.alignedTokens +
        " · unaligned " + lastScanRosterAlignmentDiagnostics.unalignedTokens +
        " · rejected " + lastScanRosterAlignmentDiagnostics.rejectedTokens +
        " · final drafts " + scanRosterDrafts.length
      : "Alignment: not computed for this scan.",
    "",
    full ? "Full event log:" : "Recent event highlights:",
    eventLines.length ? eventLines.join("\n") : "No OCR events yet.",
    !full && scanRosterOcrDebugEvents.length > eventLines.length ? "… " + (scanRosterOcrDebugEvents.length - eventLines.length) + " older events hidden" : "",
    "",
    "Guided Scan text: retained locally for review; omitted from diagnostics.",
    "",
    "AI Assist: " + (scanRosterAiReview
      ? (scanRosterAiReview.providerLabel + " — OCR drafts " + scanRosterAiReview.diagnostics.ocrDraftCount + " · AI suggested " + scanRosterAiReview.diagnostics.aiSuggestedCount + " · Agreed " + scanRosterAiReview.diagnostics.agreedCount + " · AI-only " + scanRosterAiReview.diagnostics.aiOnlyCount + " · Conflicts " + scanRosterAiReview.diagnostics.conflictCount + " · Warnings " + scanRosterAiReview.diagnostics.warningCount)
      : "not run for this scan."),
    "",
    "Parser drafts: " + draftSummary.length,
  ].filter((line) => line !== "").join("\n");
}

function renderScanRosterDiagnosticsScreen() {
  const output = document.getElementById("scan-diagnostics-full");
  if (output) output.textContent = scanRosterDiagnosticsText();
}

function openScanRosterDiagnostics() {
  renderScanRosterDiagnosticsScreen();
  showScreen("scan-diagnostics");
}

function copyScanRosterDiagnostics() {
  const text = scanRosterDiagnosticsText({ full: true });
  copyTextWithLabel(text, "Full OCR diagnostics copied.", "Copy OCR diagnostics");
}

function selectedScanRosterImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const maxDimension = 1800;
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
        canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable for roster photo compression.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read selected roster image."));
      reader.readAsDataURL(file);
    };
    image.src = url;
  });
}

function scanRosterOcrNativeIdentityConfigured(result = {}) {
  return result.identityConfigured === true || /\bidentity=configured\b/i.test(String(result.detail || ""));
}

function scanRosterOcrFilteredText(result = {}) {
  const text = String(result.text || "").trim();
  if (!text) return "";
  const filteredByWebIdentity = scanRosterOcrTextForReview(text);
  if (filteredByWebIdentity) return filteredByWebIdentity;
  if (scanRosterOcrNativeIdentityConfigured(result)) return text;
  return "";
}

// Phase 3B: the single web choke-point validator/normalizer for native
// rowStripProvenance (Phase 3A), run before it is retained anywhere (see
// scanRosterPrivacySafeOcrResult, the only caller). Purely a structural,
// closed-shape check -- it never looks at trustedRowStripDrafts or the
// confirmed date row; that binding happens later, per-draft, in
// guidedScanRowStripProvenanceBandForCode. Any malformed item, extra key,
// out-of-range value, or duplicate/conflicting date+code assignment rejects
// the ENTIRE object atomically to null -- never a partial salvage.
function guidedScanRowStripProvenanceValidMonth(month) {
  if (month === "") return true;
  return typeof month === "string" && /^[A-Za-z]{3}$/.test(month) && scanRosterMonthIndex(month) >= 0;
}

function guidedScanRowStripProvenanceValidDay(day) {
  return typeof day === "string" && /^([1-9]|[12][0-9]|3[01])$/.test(day);
}

// Blocker 3 (independent audit): the broad isLikelyRosterCodeToken() used
// elsewhere in the scanner is a loose heuristic (any short uppercase
// alnum-ish token) -- not narrow enough to trust as provenance from native.
// This mirrors native Phase 3A's actually-trusted shift-code grammar
// exactly (see RosterMateBridge#isTrustedNativeRosterCode /
// isRosterShiftElement in RosterMateBridge.java), so a code that is
// syntax-plausible but not one of native's real trusted shapes cannot pass
// as provenance evidence.
const ROW_STRIP_PROVENANCE_TRUSTED_CODE_GRAMMAR = /^(9[TSVW=]|NB|OFF|X|RDO|IS|CZ|CM|#[A-Z0-9]+|[A-Z]{1,3}\d?)$/i;

function guidedScanRowStripProvenanceValidCode(code) {
  return typeof code === "string" && Boolean(code) && isLikelyRosterCodeToken(code) && canonicalScanRosterCode(code) === code
    && ROW_STRIP_PROVENANCE_TRUSTED_CODE_GRAMMAR.test(code);
}

function guidedScanOwnDataRecordValues(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length) return null;
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return null;
    const values = {};
    for (const name of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
      values[name] = descriptor.value;
    }
    return values;
  } catch (error) {
    return null;
  }
}

function guidedScanDenseDataArrayValues(value, maxLength) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set
      || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maxLength) return null;
    const length = lengthDescriptor.value;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== length + 1 || !names.includes("length")) return null;
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch (error) {
    return null;
  }
}

function guidedScanNormalizeRowStripProvenance(raw) {
  const rawValues = guidedScanOwnDataRecordValues(raw, ["bandCount", "lines"]);
  if (!rawValues) return null;
  const bandCount = rawValues.bandCount;
  if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 7) return null;
  const rawLines = guidedScanDenseDataArrayValues(rawValues.lines, 40);
  if (!rawLines) return null;
  // A day+code pair claimed more than once -- even under different months or
  // bands -- is an unresolvable duplicate/conflicting assignment: nothing
  // here can decide which claim is correct, so the whole object fails
  // closed rather than guessing a winner.
  const dateCodeKeys = new Set();
  const lines = [];
  for (const rawLine of rawLines) {
    const item = guidedScanOwnDataRecordValues(rawLine, ["month", "day", "code", "band"]);
    if (!item) return null;
    const { month, day, code, band } = item;
    if (!guidedScanRowStripProvenanceValidMonth(month)) return null;
    if (!guidedScanRowStripProvenanceValidDay(day)) return null;
    if (!guidedScanRowStripProvenanceValidCode(code)) return null;
    if (!Number.isInteger(band) || band < 0 || band >= bandCount) return null;
    const dateCodeKey = day + "|" + code;
    if (dateCodeKeys.has(dateCodeKey)) return null;
    dateCodeKeys.add(dateCodeKey);
    lines.push({ month, day, code, band });
  }
  return { bandCount, lines };
}

// Phase 8: web choke-point validator/normalizer for native's optional
// structuralCells diagnostic payload (schemaVersion/bandCount/cells, each
// cell {month,day,code,band,support}). Purely a closed-shape structural
// check, built the same way as guidedScanNormalizeRowStripProvenance just
// above -- same hostile-input-safe extractors
// (guidedScanOwnDataRecordValues/guidedScanDenseDataArrayValues) and the same
// month/day/code grammar. Any malformed item, extra key, out-of-range value,
// or duplicate/conflicting month+day+code assignment rejects the ENTIRE
// object atomically to null -- never a partial salvage.
//
// The dedup/conflict key here is month+day+code, NOT day+code alone: unlike
// rowStripProvenance's lines (one physical row's own recovered codes, where a
// day+code pair is unambiguous within that single row), structuralCells can
// carry the same calendar day from two different months (e.g. Sep 14 and Oct
// 14), and the same date can legitimately carry two distinct cells (e.g. a
// 9T cell and a separate CZ cell for the same day). Only an exact
// month+day+code repeat -- or that same triple claimed under two different
// bands -- is an unresolvable duplicate/conflict.
//
// This normalized result is diagnostic-only: it must never be read by
// prepareGuidedScanSession, buildGuidedScanDrafts, Review, AI, Import, or
// calendar code -- only by the read-only diagnostics summary (see
// scanRosterStructuralCellsDiagnosticsLine).
function guidedScanStructuralCellsValidSupport(support) {
  return Number.isInteger(support) && support >= 2 && support <= 6;
}

function guidedScanNormalizeStructuralCells(raw) {
  const rawValues = guidedScanOwnDataRecordValues(raw, ["schemaVersion", "bandCount", "cells"]);
  if (!rawValues) return null;
  if (rawValues.schemaVersion !== 1) return null;
  const bandCount = rawValues.bandCount;
  if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 7) return null;
  const rawCells = guidedScanDenseDataArrayValues(rawValues.cells, 40);
  if (!rawCells) return null;
  const cellKeys = new Set();
  const cells = [];
  for (const rawCell of rawCells) {
    const item = guidedScanOwnDataRecordValues(rawCell, ["month", "day", "code", "band", "support"]);
    if (!item) return null;
    const { month, day, code, band, support } = item;
    if (!guidedScanRowStripProvenanceValidMonth(month)) return null;
    if (!guidedScanRowStripProvenanceValidDay(day)) return null;
    if (!guidedScanRowStripProvenanceValidCode(code)) return null;
    if (!Number.isInteger(band) || band < 0 || band >= bandCount) return null;
    if (!guidedScanStructuralCellsValidSupport(support)) return null;
    const cellKey = month + "|" + day + "|" + code;
    if (cellKeys.has(cellKey)) return null;
    cellKeys.add(cellKey);
    cells.push({ month, day, code, band, support });
  }
  return { schemaVersion: 1, bandCount, cells };
}

// Web choke-point validator/normalizer for native's optional `freshScanner` diagnostic payload -- see docs/internal/fresh-roster-scanner-design.md.
// FreshRosterScanner is a diagnostic candidate only: this normalized result feeds ONLY freshScannerDiagnosticsSummaryLine, never drafting/import/calendar/AI code (see FreshScannerBoundaryTest-style coverage in tests/web/freshscan-diagnostics-view.test.js).
const FRESH_SCANNER_STATUSES = new Set(['COMPLETE', 'PARTIAL', 'REJECTED']);
const FRESH_SCANNER_REJECTION_REASONS = new Set([
  'NO_DATE_HEADER', 'DATE_HEADER_AMBIGUOUS', 'DATE_HEADER_NO_MONTH_ANCHOR',
  'DATE_HEADER_NOT_CONSECUTIVE', 'CONTRADICTORY_MONTH_ANCHORS', 'IDENTITY_NOT_FOUND',
  'IDENTITY_AMBIGUOUS', 'ALLOCATION_REGION_UNBOUNDED', 'CODE_COLUMN_AMBIGUOUS', 'INSUFFICIENT_EVIDENCE',
]);
const FRESH_SCANNER_TRUSTED_CODE_GRAMMAR = /^(9[TSVW=]|NB|OFF|X|RDO|IS|CZ|CM|#[A-Z0-9]+|[A-Z]{1,3}\d?)$/;
// Closed shape buckets for the single name-column-zone token that triggered
// an ALLOCATION_REGION_UNBOUNDED reject -- count/shape-only, never raw text.
const FRESH_SCANNER_AMBIGUOUS_SHAPES = new Set(['NUMERIC_INT', 'DECIMAL', 'ALPHA_INTERNAL_PUNCT', 'MIXED_ALNUM', 'SYMBOL']);
const FRESH_SCANNER_MAX_ROW_OFFSET = 500;
// Matches the sibling structuralCells/rowStripProvenance bandCount ceiling (1-7, i.e. band indices 0-6) rather than an arbitrary number.
const FRESH_SCANNER_MAX_BAND = 6;
// A full 31-day month in every band up to that ceiling -- large enough for any real photographed roster, still bounded against a hostile payload.
const FRESH_SCANNER_MAX_CELLS = 31 * (FRESH_SCANNER_MAX_BAND + 1);

function guidedScanFreshScannerValidCell(rawCell) {
  const item = guidedScanOwnDataRecordValues(rawCell, ['day', 'month', 'year', 'code', 'band']);
  if (!item) return null;
  const { day, month, year, code, band } = item;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) return null;
  if (typeof code !== 'string' || !FRESH_SCANNER_TRUSTED_CODE_GRAMMAR.test(code)) return null;
  if (!Number.isInteger(band) || band < 0 || band > FRESH_SCANNER_MAX_BAND) return null;
  return { day, month, year, code, band };
}

function guidedScanFreshScannerValidRejectionCounts(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype
      || Object.getOwnPropertySymbols(raw).length) return null;
    const names = Object.getOwnPropertyNames(raw);
    const counts = {};
    for (const name of names) {
      if (!FRESH_SCANNER_REJECTION_REASONS.has(name)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      if (!descriptor || descriptor.get || descriptor.set || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      const value = descriptor.value;
      if (!Number.isInteger(value) || value < 0 || value > 100000) return null;
      counts[name] = value;
    }
    return counts;
  } catch (error) {
    return null;
  }
}

// Only present alongside an atomic ALLOCATION_REGION_UNBOUNDED reject (see
// AllocationDiagnostic.java) -- a closed enum shape, a bounded row offset,
// and a boolean, never the triggering token's own text.
function guidedScanFreshScannerValidAllocationDiagnostic(raw) {
  const item = guidedScanOwnDataRecordValues(raw, ['shape', 'rowOffsetFromIdentity', 'laterNameShapedTokenInRow']);
  if (!item) return null;
  const { shape, rowOffsetFromIdentity, laterNameShapedTokenInRow } = item;
  if (typeof shape !== 'string' || !FRESH_SCANNER_AMBIGUOUS_SHAPES.has(shape)) return null;
  if (!Number.isInteger(rowOffsetFromIdentity) || rowOffsetFromIdentity < 1 || rowOffsetFromIdentity > FRESH_SCANNER_MAX_ROW_OFFSET) return null;
  if (typeof laterNameShapedTokenInRow !== 'boolean') return null;
  return { shape, rowOffsetFromIdentity, laterNameShapedTokenInRow };
}

function guidedScanNormalizeFreshScannerDiagnostic(raw) {
  const baseKeys = ['schemaVersion', 'status', 'cells', 'rejectionCounts'];
  const hasDiagnosticKey = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'allocationDiagnostic');
  const rawValues = guidedScanOwnDataRecordValues(raw, hasDiagnosticKey ? [...baseKeys, 'allocationDiagnostic'] : baseKeys);
  if (!rawValues) return null;
  if (rawValues.schemaVersion !== 1) return null;
  if (typeof rawValues.status !== 'string' || !FRESH_SCANNER_STATUSES.has(rawValues.status)) return null;
  const rawCells = guidedScanDenseDataArrayValues(rawValues.cells, FRESH_SCANNER_MAX_CELLS);
  if (!rawCells) return null;
  const cells = [];
  for (const rawCell of rawCells) {
    const cell = guidedScanFreshScannerValidCell(rawCell);
    if (!cell) return null;
    cells.push(cell);
  }
  const rejectionCounts = guidedScanFreshScannerValidRejectionCounts(rawValues.rejectionCounts);
  if (!rejectionCounts) return null;
  if (!hasDiagnosticKey) return { schemaVersion: 1, status: rawValues.status, cells, rejectionCounts };

  // allocationDiagnostic is only ever valid for the exact atomic shape an
  // ALLOCATION_REGION_UNBOUNDED reject produces: REJECTED, zero cells, and
  // that single reason with count 1 -- anything else (a stray key sitting
  // alongside a different reject, or a PARTIAL/COMPLETE result) fails the
  // whole payload closed rather than silently dropping the extra field.
  const rejectionNames = Object.keys(rejectionCounts);
  const isAtomicAllocationUnbounded = rawValues.status === 'REJECTED' && cells.length === 0
    && rejectionNames.length === 1 && rejectionNames[0] === 'ALLOCATION_REGION_UNBOUNDED'
    && rejectionCounts.ALLOCATION_REGION_UNBOUNDED === 1;
  if (!isAtomicAllocationUnbounded) return null;
  const allocationDiagnostic = guidedScanFreshScannerValidAllocationDiagnostic(rawValues.allocationDiagnostic);
  if (!allocationDiagnostic) return null;
  return { schemaVersion: 1, status: rawValues.status, cells, rejectionCounts, allocationDiagnostic };
}

// Binds one already-trusted row-strip draft (see
// guidedScanSession.trustedRowStripDrafts -- itself already parsed from this
// same result's own row-strip text, so the date+code here can never be
// invented) to whichever physical band native's rowStripProvenance
// unanimously proved it belongs to. Returns -1 (no bind) whenever the
// evidence does not exactly and unambiguously match: no line for this
// day+code, a month-bearing line whose month disagrees with the trusted
// draft's own resolved month, or -- structurally impossible after
// guidedScanNormalizeRowStripProvenance's own dedup, but checked here too
// for safety -- more than one candidate line.
function guidedScanRowStripProvenanceBandForCode(provenance, day, month, code, trustedDrafts = []) {
  if (!provenance || !Array.isArray(provenance.lines)) return -1;
  const candidates = provenance.lines.filter((line) => line.day === String(day) && line.code === code
    && (line.month === "" || scanRosterMonthIndex(line.month) === month));
  if (candidates.length !== 1) return -1;
  const candidate = candidates[0];
  if (candidate.month === "") {
    const eligibleDrafts = (Array.isArray(trustedDrafts) ? trustedDrafts : []).filter((draft) => draft
      && draft.day === day && draft.rawCode === code);
    if (eligibleDrafts.length !== 1) return -1;
  }
  return candidate.band;
}

// The native auto-row-strip pipeline re-OCRs the confirmed row across
// several crop/upscale/enhancement variants and merges the results into
// result.text. Confirmed on a real photographed roster: that merged text
// caught codes and dates that the single full-image OCR pass behind
// result.textBlocks either misread (e.g. "9T" -> "9V") or bound to the
// wrong date column entirely, because the geometry pass only ever sees the
// lower-fidelity, non-upscaled full-page recognition. When the row-strip
// pipeline actually ran and produced usable lines, trust that merged text
// over the raw text-block geometry instead of always preferring geometry.
function preferDirectScanRosterDrafts(result, directDrafts) {
  return result.stage === "native-auto-row-strip-mlkit-success" && directDrafts.length > 0;
}

// Authoritative product rule: no photo-derived OCR result may reach Review as
// importable/selectable/tickable data until a Date row AND a Staff row from
// that same table have both been explicitly confirmed. This is the single
// choke point every successful photo/gallery OCR result passes through --
// the real captured-image bridge callback (via resolvePendingScanRosterImage),
// the direct handleScanRosterOcrResult callback (self-test, extractRosterText
// FromImage fallback), and the web/local text-detector path (via
// scanRosterImage) all funnel here before anything can be staged. It always
// clears scanRosterDrafts and initialises Guided Scan; the automatic match is
// kept on the session as non-authoritative context only, never staged.
// geometryBlocks defaults to result.textBlocks and differs from it only when
// privacy sanitation stripped a withheld block from the retained result: the
// geometry pass must still see that block to count/warn about it. See
// scanRosterPrivacySafeOcrResult. `result` (text, detail) is already sanitized
// by the time it reaches here, so everything derived from text below is safe.
function applyScanRosterOcrResult(result, geometryBlocks) {
  // Currency (does this result belong to the current generation?) is
  // decided once, by request id, at the handleScanRosterOcrResult choke
  // point before this is ever called -- see the acceptance check there.
  scanRosterOcrAwaitingResult = false;
  const filteredText = scanRosterOcrFilteredText(result);
  const mediaPipeTextBlocks = Array.isArray(geometryBlocks)
    ? geometryBlocks
    : (Array.isArray(result.textBlocks) ? result.textBlocks : []);
  lastScanRosterGeometryDiagnostics = null;
  const mediaPipeDrafts = mediaPipeTextBlocks.length ? scanRosterDraftsFromMediaPipeTextBlocks(mediaPipeTextBlocks) : [];
  // Stage plus a semantic line count only. The filtered text's CHARACTER
  // count measured the user's own roster (how many staff, days and codes
  // that photo held) and reached the copyable diagnostics; how many roster
  // lines survived filtering is what this event is actually read for.
  if (filteredText) {
    appendScanRosterOcrDebug(
      "web-ocr-filtered-text",
      "lines=" + filteredText.split(/\r?\n/).filter((line) => line.trim()).length
    );
  }
  if (lastScanRosterGeometryDiagnostics) {
    const geometry = lastScanRosterGeometryDiagnostics;
    appendScanRosterOcrDebug(
      "geometry-diagnostics",
      "dateColumns=" + geometry.dateColumnsDetected +
        " identityRow=" + (geometry.identityFound ? "yes" : "no") +
        " shiftTokens=" + geometry.shiftTokensDetected +
        " aligned=" + geometry.alignedTokens +
        " lowConfidence=" + geometry.lowConfidenceAligned +
        // C62: count only -- the unalignedSample values never reach the log.
        " unaligned=" + geometry.unalignedTokens
    );
  }
  if (mediaPipeDrafts.length) appendScanRosterOcrDebug("web-mediapipe-spatial-drafts", mediaPipeDrafts.length + " shifts found by local OCR text-block geometry (context only, not staged)");
  const filteredLines = filteredText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasDateHeader = Boolean(scanRosterHeaderLine(filteredLines));
  prepareGuidedScanSession(filteredText, mediaPipeTextBlocks, scanRosterTransactionFormat(result.requestId));
  // The requestId this OCR result arrived under is the same id native may
  // be retaining an image source under for Step 3 previews (see
  // RosterMateBridge.requestGuidedScanBandPreview) -- stamped here, once,
  // right after the session it belongs to is (re)built, so
  // guidedScanRequestContinuationBandPreview always asks for the correct
  // request's source and releaseGuidedScanPreviewSourceIfHeld always
  // releases the correct one.
  guidedScanSession.previewRequestId = result.requestId || null;
  guidedScanSession.scanSessionId = result.requestId || null;
  guidedScanSession.previewGeneration = guidedScanSession.previewRequestId
    ? (guidedScanPreviewBootstraps.get(guidedScanSession.previewRequestId) || null) : null;
  if (guidedScanSession.previewRequestId) guidedScanPreviewBootstraps.delete(guidedScanSession.previewRequestId);
  renderGuidedScanChoices();
  const directDrafts = filteredText ? parseSimpleScanRosterLines(filteredLines) : [];
  // Geometry drafts (and the plain text parse used as their fallback) are
  // only trustworthy once prepareGuidedScanSession has itself proved a real
  // two-date table exists (mode === "geometry"). Outside the row-strip
  // stage, a page with no provable date table must keep the automatic match
  // empty rather than fall back to a single-date/malformed geometry guess --
  // see C65. The row-strip stage is exempt: its merged text is already
  // isolated to the confirmed row by the native re-OCR pass itself, so it
  // stays trustworthy even when the full-page geometry behind textBlocks is
  // too sparse to prove a table (see preferDirectScanRosterDrafts).
  const automaticDrafts = preferDirectScanRosterDrafts(result, directDrafts)
    ? directDrafts
    : (guidedScanSession.mode === "geometry" ? (mediaPipeDrafts.length ? mediaPipeDrafts : directDrafts) : []);
  // The automatic match is kept on the session as non-authoritative context
  // only (e.g. for the resolved-line summary). It is NEVER staged into
  // scanRosterDrafts: only a row the user has explicitly confirmed through
  // both guided steps may reach Review/Import.
  guidedScanSession.automaticDrafts = automaticDrafts;
  // Recessive recovery source for buildGuidedScanGeometryDrafts (see there):
  // only ever populated for the native-auto-row-strip-mlkit-success stage,
  // never the generic text fallback -- that fallback has no per-row native
  // re-OCR scoping behind it, so it is never safe to treat as this row's own
  // recovered evidence.
  guidedScanSession.trustedRowStripDrafts = preferDirectScanRosterDrafts(result, directDrafts) ? directDrafts : [];
  // Usable only on a current, successful result whose stage is exactly
  // native-auto-row-strip-mlkit-success -- see preferDirectScanRosterDrafts
  // above. Every other stage treats it as null, even when `result` (already
  // structurally normalized by scanRosterPrivacySafeOcrResult) carried a
  // validly-shaped object -- the row-strip evidence it describes is only
  // trustworthy alongside this exact recovery pipeline.
  guidedScanSession.rowStripProvenance = result.stage === "native-auto-row-strip-mlkit-success"
    ? (result.rowStripProvenance || null)
    : null;
  // Table-ownership capability binding: result.rowStripTableCapability is
  // already choke-point validated (closed UUID shape, ok===true, exact
  // stage) by scanRosterPrivacySafeOcrResult -- here it is stamped onto the
  // session ALONGSIDE the exact request/generation this currency-gated
  // result belongs to (previewRequestId/previewGeneration above, set from
  // this same `result` a few lines up), so buildGuidedScanGeometryDrafts can
  // later prove the trusted merge is still being evaluated for the same
  // request/generation it was captured under -- not merely that some
  // capability string happens to match. Null on every other stage, exactly
  // like rowStripProvenance/trustedRowStripDrafts above.
  guidedScanSession.trustedRowStripCapability = result.stage === "native-auto-row-strip-mlkit-success"
    ? (result.rowStripTableCapability || null)
    : null;
  guidedScanSession.trustedRowStripRequestId = guidedScanSession.trustedRowStripCapability
    ? guidedScanSession.previewRequestId
    : null;
  guidedScanSession.trustedRowStripGeneration = guidedScanSession.trustedRowStripCapability
    ? guidedScanSession.previewGeneration
    : null;
  scanRosterDrafts = [];
  lastScanRosterImportSummary = null;
  renderScanRosterReview();
  renderScanRosterAiReview();
  const alignment = scanRosterAlignmentDiagnostics(filteredLines);
  lastScanRosterAlignmentDiagnostics = alignment;
  appendScanRosterOcrDebug(
    "alignment-diagnostics",
    "dateHeaders=" + alignment.dateHeadersDetected +
      " configuredRow=" + (alignment.configuredRowDetected ? "yes" : "no") +
      " shiftTokens=" + alignment.shiftLikeTokensDetected +
      " aligned=" + alignment.alignedTokens +
      " unaligned=" + alignment.unalignedTokens +
      " rejected=" + alignment.rejectedTokens +
      " finalDrafts=" + scanRosterDrafts.length
  );
  renderScanRosterDiagnosticsScreen();
  saveState();
  const canConfirm = guidedScanSession.dateCandidates.length > 0
    && (guidedScanSession.mode === "geometry" || guidedScanSession.rowCandidates.length > 0);
  if (canConfirm) {
    setScanRosterPhotoStatus("Photo text read on-device. Confirm the date row and then your row to stage shifts safely.");
    showToast("Photo read — confirm the date row, then your row.", "success");
    return;
  }
  if (automaticDrafts.length) {
    setScanRosterPhotoStatus("Photo text read on-device, but there is no separate date row and staff row to confirm here. The automatic match is shown as a summary only -- rescan with the date header and your row both visible to import.");
    showToast("Photo read, but nothing could be confirmed for import. Rescan with the date header and your row visible.", "warning");
    return;
  }
  if (filteredText && !hasDateHeader) {
    setScanRosterPhotoStatus("Photo text read on-device, but the date header was not found. No shifts were staged so the roster dates are not guessed.");
    showToast("Photo read, but no date header was found. Try a crop with the dates visible.", "warning");
    return;
  }
  if (filteredText) {
    setScanRosterPhotoStatus("Photo text read on-device and matched the configured name, but no shift codes were found. The filtered OCR preview is shown below for troubleshooting.");
    showToast("Photo matched your name, but no shift codes were detected.", "warning");
    return;
  }
  setScanRosterPhotoStatus("Photo text read on-device, but the configured name was not found. Nothing was imported.");
  showToast("Photo read, but no matching roster row was found. Check the name/aliases.", "warning");
}

// Single choke point for currency: decides whether `result` belongs to the
// generation currently on screen BEFORE dispatching to either the pending
// bridge-promise resolver or the failure/success handling below, so a stale
// result can mutate neither -- not the drafts, not a still-outstanding
// promise that in fact belongs to a newer attempt, not even the status/toast
// shown to the user. See currentScanRosterRequestId for the id/null model.
// Currency requires both exact non-null id equality and ACTIVE ownership. A
// result with no id, a final transaction, or an id that merely equals an old
// value can never be current.
function scanRosterOcrResultIsCurrent(result) {
  const incomingRequestId = result && result.requestId != null ? result.requestId : null;
  return scanRosterTransactionIsCurrent(incomingRequestId);
}

// Value key for a normalised OCR block. mediaPipeScannerNormalisedBlocks
// builds fresh objects with no back-reference to the caller's input array, so
// a withheld block is matched back onto the raw result.textBlocks by value
// rather than by object identity. Adding a back-reference to the shared
// normaliser instead would put a privacy concern inside a helper the whole
// scanner depends on.
function scanRosterOcrBlockKey(block) {
  const box = block.boundingBox;
  return [block.text, box.x, box.y, box.width, box.height].join("|");
}

// Every block guided geometry would withhold for privacy, under ANY date row
// the user could go on to confirm. The withholding decision is per confirmed
// table (see guidedScanDateTableScope), but this runs BEFORE the user has
// confirmed anything, so it takes the union: a token that any reachable
// confirmation would withhold must not be retained now on the chance the user
// picks a different date row. Fail-closed in the same direction as the rest
// of the scanner.
function scanRosterPrivacyWithheldBlocks(textBlocks) {
  const geometry = guidedScanGeometryCandidates(textBlocks);
  if (!geometry) return [];
  const withheld = new Map();
  geometry.dateCandidates.forEach((dateCandidate) => {
    guidedScanDateTableScope(dateCandidate, geometry.blocks).ambiguousBoundaryBlocks
      .forEach((block) => withheld.set(scanRosterOcrBlockKey(block), block));
  });
  return [...withheld.values()];
}

// Every block the retained OCR result is allowed to keep, full stop -- not
// just the ones an ambiguous-boundary check happens to withhold. The full
// page (`textBlocks`) is only ever read HERE, transiently inside this one
// call, to find (a) every table's own date-header band -- dates are not
// private -- and (b) whichever table has a configured-identity row, that
// row's own band (its name blocks and its own shift codes). Nothing else on
// the page is safe to retain: a neighbouring staff member's row must never
// survive in lastScanRosterOcrResult.textBlocks just because it happened to
// sit on the same page as the configured person's row. A table with no
// identity match contributes nothing but its (non-private) header.
//
// If no table geometry can be proved, retain nothing. A cropped or malformed
// header gives us no safe boundary between the configured row and neighbours;
// treating that uncertainty as "no restriction" would retain the whole page.
function scanRosterPrivacySafeGeometryBlocks(textBlocks) {
  const geometry = guidedScanGeometryCandidates(textBlocks);
  if (!geometry) return [];
  const safe = new Map();
  geometry.dateCandidates.forEach((dateCandidate) => {
    dateCandidate.band.blocks.forEach((block) => safe.set(scanRosterOcrBlockKey(block), block));
    guidedScanGeometryStaffCandidatesForDate(dateCandidate, geometry.blocks).forEach((rowCandidate) => {
      rowCandidate.band.blocks.forEach((block) => safe.set(scanRosterOcrBlockKey(block), block));
    });
  });
  return [...safe.values()];
}

// Removes every standalone occurrence of a withheld token from OCR text.
// Boundaries are alphanumeric-class rather than \b so surrounding punctuation
// is handled, and the replace is repeated to a fixed point because each match
// consumes the character before it (so "OFF OFF" needs a second pass).
function scanRosterRedactOcrToken(text, token) {
  const escaped = String(token || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return text;
  const pattern = new RegExp("(^|[^A-Za-z0-9])" + escaped + "(?![A-Za-z0-9])", "gi");
  let current = String(text || "");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.replace(pattern, "$1");
    if (next === current) break;
    current = next;
  }
  return current;
}

// Rebuild retained OCR text from the accepted block objects. Used as the
// FAIL-CLOSED fallback for scanRosterPrivacySafeRetainedText below: it can
// never retain a withheld token (it only ever sees accepted blocks), but it
// also cannot carry anything result.text knows and the blocks do not, so it
// is only used when the withheld occurrence cannot be located precisely.
function scanRosterTextFromAcceptedBlocks(textBlocks) {
  const blocks = mediaPipeScannerNormalisedBlocks(textBlocks);
  if (!blocks.length) return "";
  return mediaPipeScannerRowBands(blocks)
    .sort((a, b) => a.y - b.y)
    .map((row) => row.blocks.slice().sort((a, b) => a.centerX - b.centerX).map((block) => block.text).join(" "))
    .filter(Boolean)
    .join("\n");
}

// Index of the last whitespace-separated token of the configured identity
// within one already-tokenised line of OCR text, or -1 if this line carries
// no configured alias at all. Joins up to 4 consecutive tokens exactly like
// mediaPipeScannerIdentityBlock does, so a multi-word alias still matches a
// name OCR split across tokens.
//
// Takes the TIGHTEST match (smallest end index), not the widest: a window is
// matched by substring containment, so "Ford Alex OFF 9T" matches the alias
// "Ford Alex" just as "Ford Alex" does, and taking the widest match would
// place the end of the name past real shift codes -- hiding exactly the
// adjacent occurrence this is used to find. A tighter-than-true end only ever
// widens the "after the name" search region, which is safe here.
function scanRosterIdentityLineMatchEnd(tokens) {
  const aliases = scanRosterAliases().map((alias) => normaliseScanNameToken(alias)).filter(Boolean);
  if (!aliases.length) return -1;
  let end = -1;
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let stop = start; stop < Math.min(tokens.length, start + 4); stop += 1) {
      joined = joined ? joined + " " + tokens[stop] : tokens[stop];
      const normalised = normaliseScanNameToken(joined);
      if (!aliases.some((alias) => normalisedTextHasAliasMatch(normalised, alias))) continue;
      if (end < 0 || stop < end) end = stop;
      break;
    }
  }
  return end;
}

// Removes exactly the withheld OCCURRENCES from the retained OCR text, by
// position, rather than deleting a token value globally or throwing the text
// away and rebuilding it from the accepted blocks.
//
// Both of the simpler rules are wrong in a way that matters:
//  - Global token deletion erases a second, genuinely distinct cell that
//    happens to hold the same code (C53's real OFF under a later date).
//  - Rebuilding from accepted blocks only cannot represent anything the
//    blocks never had. result.text from the native auto-row-strip pipeline
//    legitimately carries higher-fidelity codes the full-page pass behind
//    result.textBlocks missed entirely (see preferDirectScanRosterDrafts), so
//    that rule silently destroyed real recovered shifts whenever anything
//    else on the page was withheld -- C55.
//
// Every withheld block sits immediately right of the matched identity by
// construction (guidedScanAmbiguousBoundaryBlocks only ever withholds blocks
// adjacent to the identity's own right edge), so in reading-order text its
// occurrence is the nearest one AFTER the alias on the identity's own line.
// That is the only occurrence removed; later identical codes and every
// row-strip-only token on that line survive untouched.
//
// Fails closed to the accepted-block rebuild -- never to the raw text -- on
// any uncertainty: no text, no identity line, more than one identity line
// (two tables on one page could each have withheld something, and there is
// then no single line to attribute occurrences to), or fewer post-alias
// occurrences of a withheld value than were actually withheld.
function scanRosterPrivacySafeRetainedText(originalText, withheldBlocks, acceptedBlocks, isRowStripMergedText) {
  // Rebuilding every accepted page block would retain unrelated staff rows in
  // lastScanRosterOcrResult even though Guided Scan later filters them out.
  // Run the accepted-only reconstruction through the same configured-row
  // review filter and fail closed to empty text if that row/header cannot be
  // established. The original geometry still remains available internally for
  // the explicit Date-row -> Staff-row confirmation workflow.
  const fallback = () => scanRosterOcrTextForReview(scanRosterTextFromAcceptedBlocks(acceptedBlocks)) || "";
  // No block could be proven to belong to any table at all (e.g. a header
  // with only one day number -- too sparse for guidedScanGeometryCandidates
  // to trust as a real date row). C65: no valid two-date table means no safe
  // geometry scope could be proved, which is a fail-closed privacy case, not
  // permission to retain ANY staff text from a fresh full-page OCR pass --
  // not even the configured person's own row, since the sparse header gives
  // no safe boundary to prove it apart from a neighbour. The native row-strip
  // pipeline's merged text (see preferDirectScanRosterDrafts) is the one
  // exception: it is built purely by re-OCRing the already-confirmed row
  // across crop/upscale variants, never from a fresh full-page pass, so it
  // never names the row owner and never carries a neighbour's row either --
  // there is no page for this sparse-header rule to protect against.
  if (!Array.isArray(acceptedBlocks) || !acceptedBlocks.length) {
    return isRowStripMergedText ? String(originalText || "").trim() : "";
  }
  const text = String(originalText || "");
  if (!text.trim()) return fallback();
  const lines = text.split(/\r?\n/);
  const lineTokens = lines.map((line) => line.trim().split(/\s+/).filter(Boolean));
  const identityLines = [];
  lineTokens.forEach((tokens, index) => {
    if (scanRosterIdentityLineMatchEnd(tokens) >= 0) identityLines.push(index);
  });
  // Row-strip merged text (see above) can EITHER be bare "<Month> <Day>
  // <code...>" lines with no name at all, OR -- when native's own re-OCR
  // happened to also catch the row's leading name tokens -- coexist with a
  // genuine identity line. The general precise by-position redaction below
  // already handles the latter correctly (exactly C55's fixture: one
  // identity line, an ambiguous withheld token on it, a row-strip-only code
  // elsewhere on the SAME line) and must run unmodified whenever exactly one
  // identity line was found, withheld or not.
  //
  // The gap is identityLines.length !== 1 while isRowStripMergedText: that is
  // the ORDINARY shape for this stage (no name line at all), not an
  // ambiguity, yet the fallback below treats it exactly like one, rebuilding
  // retained text purely from the accepted GEOMETRY blocks and silently
  // destroying every row-strip-only recovered date/code the geometry pass
  // never independently found (C55/C66) -- a regression-critical missing-
  // shift bug.
  //
  // Verbatim retention in that gap is safe only when BOTH:
  //  - nothing was withheld for this table (withheldBlocks.length === 0) --
  //    a withheld token is a CODE-shaped value (see C53's ambiguous OFF), and
  //    with no identity line to anchor a by-position redaction against here,
  //    there is no safe way to remove just that one occurrence; fail closed
  //    to the fallback instead, same as the identityLines.length !== 1 case
  //    always has; and
  //  - every line is EXACTLY the closed "<Month> <Day> <code...>" shape
  //    native promises for this stage, validated with the SAME trusted
  //    month/day/code grammar already used for native's own rowStripProvenance
  //    (guidedScanRowStripProvenanceValidMonth/Day/Code above) -- not the
  //    looser guidedScanResolvedLineInfo used for the read-only text-only
  //    summary, which accepts arbitrary trailing content after a valid code
  //    and would wave a stray name or unrelated text straight through.
  // Any line that does not fit that exact shape could be anything at all, so
  // it fails closed to the accepted-block rebuild instead. This exact stage
  // gate plus this exact closed-shape validation is what makes single-row
  // ownership safe here -- not a claim about band/table geometry, which this
  // text-only helper never has access to.
  if (identityLines.length !== 1) {
    const noWithheld = !Array.isArray(withheldBlocks) || !withheldBlocks.length;
    if (isRowStripMergedText && noWithheld) {
      const rowStripLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const shapeIsClosed = rowStripLines.length > 0 && rowStripLines.every((line) => {
        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length < 3) return false;
        const [monthText, dayText, ...codeTokens] = tokens;
        if (!monthText || !guidedScanRowStripProvenanceValidMonth(monthText)) return false;
        if (!guidedScanRowStripProvenanceValidDay(dayText)) return false;
        return codeTokens.every((token) => guidedScanRowStripProvenanceValidCode(token));
      });
      if (shapeIsClosed) return text.trim();
    }
    return fallback();
  }
  const identityIndex = identityLines[0];
  const tokens = lineTokens[identityIndex];
  const aliasEnd = scanRosterIdentityLineMatchEnd(tokens);
  const withheldCounts = new Map();
  let unmatchable = false;
  withheldBlocks.forEach((block) => {
    const key = compactScanCode(block.text);
    // A withheld block whose text normalises to nothing cannot be located in
    // the line by value at all, so there is no safe occurrence to remove.
    if (!key) unmatchable = true;
    else withheldCounts.set(key, (withheldCounts.get(key) || 0) + 1);
  });
  if (unmatchable) return fallback();
  const removed = new Set();
  for (const [value, count] of withheldCounts) {
    const positions = [];
    for (let index = aliasEnd + 1; index < tokens.length; index += 1) {
      if (!removed.has(index) && compactScanCode(tokens[index]) === value) positions.push(index);
    }
    if (positions.length < count) return fallback();
    positions.slice(0, count).forEach((position) => removed.add(position));
  }
  lines[identityIndex] = tokens.filter((_, index) => !removed.has(index)).join(" ");
  return lines.map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n");
}

// Privacy sanitation for a CURRENT, successful OCR result, applied at the
// handleScanRosterOcrResult choke point before anything derived from the
// result is retained anywhere. guidedScanAmbiguousBoundaryBlocks already kept
// withheld tokens out of codes/labels/warnings/drafts, but the result object
// itself flowed through untouched -- so the raw token still reached
// lastScanRosterOcrResult.text/.textBlocks, guidedScanSession.rawText, the
// "web-ocr-filtered-preview" debug event and, through those, the compact/full/
// copied diagnostics. Withholding a token from the UI while writing it to the
// diagnostics the user is asked to copy and send is not withholding it.
//
// Returns { safeResult, geometryBlocks }. safeResult is the ORIGINAL result
// object untouched whenever nothing was actually filtered out, so the common
// single-table, single-row case (nothing else on the page) stays bit-for-bit
// unchanged. The moment a real roster photo has more than one staff row or
// more than one table, safeResult.textBlocks is rebuilt down to date headers
// plus the configured identity row(s) -- see scanRosterPrivacySafeGeometry
// Blocks. This is a SEPARATE cut from the ambiguous-boundary withholding
// below: withholding handles the narrow "adjacent to the matched name, could
// be a torn-off fragment of it" case, while this cut is what stops an
// entirely different, clearly-separated staff row's name and shift codes
// from ever being retained just because the whole page was scanned once to
// find the date headers and the configured person's own row.
//
// geometryBlocks stays the UNREDACTED, unscoped block array and is handed to
// the guided session separately, because building today's candidates (and
// the "N entries withheld for privacy" count, and keeping the configured
// row alive when the withheld token was its only one, C47) needs the real
// page geometry. That is a TRANSIENT argument, consumed synchronously by
// prepareGuidedScanSession and then discarded -- it is never itself assigned
// onto any retained object. See prepareGuidedScanSession's own comment for
// the retention rule that applies once it has been consulted.
function scanRosterPrivacySafeOcrResult(result = {}) {
  const geometryBlocks = Array.isArray(result && result.textBlocks) ? result.textBlocks : [];
  // Phase 3B choke point: rowStripProvenance is structurally validated/
  // normalized here, before the first retention onto anything (safeResult ->
  // lastScanRosterOcrResult). Only touches the key when the raw result
  // actually carries one, so a result with no rowStripProvenance at all stays
  // bit-for-bit unchanged, exactly like every other field here.
  const rowStripProvenanceFields = result && Object.prototype.hasOwnProperty.call(result, "rowStripProvenance")
    ? { rowStripProvenance: result.ok === true && result.stage === "native-auto-row-strip-mlkit-success"
      ? guidedScanNormalizeRowStripProvenance(result.rowStripProvenance)
      : null }
    : {};
  // Phase 8 choke point: structuralCells is validated/normalized here on the
  // exact same rule as rowStripProvenance just above -- same stage/ok gate,
  // same "absent key stays absent" behaviour. This is the ONLY place
  // structuralCells is ever touched before retention; it is read back out
  // only by the read-only diagnostics summary, never by guidedScanSession or
  // any drafting/import/AI/calendar code.
  const structuralCellsFields = result && Object.prototype.hasOwnProperty.call(result, "structuralCells")
    ? { structuralCells: result.ok === true && result.stage === "native-auto-row-strip-mlkit-success"
      ? guidedScanNormalizeStructuralCells(result.structuralCells)
      : null }
    : {};
  // freshScanner choke point: validated/normalized here, before the first retention onto anything, same as rowStripProvenance/structuralCells above -- except native emits freshScanner (or null) on every successful OCR stage, not just one, so there is no single stage to gate on here.
  // freshScannerInvalid distinguishes "native itself sent null" from "native sent something, but the web validator rejected it" purely for the diagnostics summary's wording -- it carries no content, just that one fact.
  const freshScannerRawPresent = result && Object.prototype.hasOwnProperty.call(result, "freshScanner");
  const freshScannerNormalized = freshScannerRawPresent ? guidedScanNormalizeFreshScannerDiagnostic(result.freshScanner) : null;
  const freshScannerFields = freshScannerRawPresent
    ? { freshScanner: freshScannerNormalized, freshScannerInvalid: result.freshScanner !== null && freshScannerNormalized === null }
    : {};
  // Table-capability choke point: validated/normalized here, before the
  // first retention onto anything, on the exact same ok/stage gate as
  // rowStripProvenance/structuralCells above -- a capability is only ever
  // real on the one terminal automatic-row-strip-success call site (see
  // RosterMateBridge's own "only the terminal success call carries it"
  // invariant). Shape-checked against a closed UUID regex -- the exact
  // format java.util.UUID.randomUUID().toString() produces -- rather than
  // merely "a non-empty string", so a malformed/truncated/content-shaped
  // value native (or a compromised/outdated WebView bridge) could never
  // legitimately send is normalized to null here, once, instead of leaking
  // into guidedScanSession and being trusted by the merge gate below.
  const ROW_STRIP_TABLE_CAPABILITY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rowStripTableCapabilityFields = result && Object.prototype.hasOwnProperty.call(result, "rowStripTableCapability")
    ? { rowStripTableCapability: result.ok === true && result.stage === "native-auto-row-strip-mlkit-success"
      && typeof result.rowStripTableCapability === "string" && ROW_STRIP_TABLE_CAPABILITY_SHAPE.test(result.rowStripTableCapability)
      ? result.rowStripTableCapability : null }
    : {};
  const metadataSafeResult = Object.assign({}, result, {
    detail: scanRosterDiagnosticCounts(result && result.detail),
    identityConfigured: scanRosterOcrNativeIdentityConfigured(result),
  }, rowStripProvenanceFields, structuralCellsFields, freshScannerFields, rowStripTableCapabilityFields);
  const unchanged = { safeResult: metadataSafeResult, geometryBlocks };
  if (!result || !result.ok) return unchanged;
  const textBlocks = geometryBlocks.length ? geometryBlocks : null;
  if (!textBlocks) return unchanged;
  const withheld = scanRosterPrivacyWithheldBlocks(textBlocks);
  const withheldKeys = new Set(withheld.map(scanRosterOcrBlockKey));
  const safeGeometryBlocks = scanRosterPrivacySafeGeometryBlocks(textBlocks);
  const safeKeys = new Set(safeGeometryBlocks.map(scanRosterOcrBlockKey));
  // Original block objects are kept (not the normalised copies) so any extra
  // fields the native bridge attaches survive for the retained blocks. A
  // block that cannot be normalised at all cannot be proven safe either, so
  // it fails closed (excluded) rather than the old fail-open default.
  const safeTextBlocks = textBlocks.filter((block) => {
    const normalised = mediaPipeScannerNormalisedBlocks([block])[0];
    if (!normalised) return false;
    const key = scanRosterOcrBlockKey(normalised);
    if (!safeKeys.has(key)) return false;
    return !withheldKeys.has(key);
  });
  if (!withheld.length && safeTextBlocks.length === textBlocks.length) return unchanged;
  const redact = (value) => withheld
    .reduce((text, block) => scanRosterRedactOcrToken(text, block.text), String(value || ""))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  return {
    safeResult: Object.assign({}, metadataSafeResult, {
      text: scanRosterPrivacySafeRetainedText(result.text, withheld, safeTextBlocks, result.stage === "native-auto-row-strip-mlkit-success"),
      textBlocks: safeTextBlocks,
      detail: scanRosterDiagnosticCounts(result.detail),
      error: result.error ? redact(result.error) : result.error,
    }),
    // Unredacted/unscoped, same as the `unchanged` case above -- see the
    // function-level comment. prepareGuidedScanSession and
    // scanRosterDraftsFromMediaPipeTextBlocks each already do their own
    // per-table/per-row privacy scoping against the real page geometry
    // (guidedScanGeometryStaffCandidatesForDate and
    // mediaPipeScannerTargetRowBlocks respectively) and never retain more
    // than that scoped result; narrowing this to safeGeometryBlocks here
    // only starved both of the page geometry they need to do that scoping
    // at all whenever the whole-page table couldn't be proven (e.g. a
    // sparse single-day header), with no privacy benefit since neither
    // consumer is a retained value.
    geometryBlocks: textBlocks,
  };
}

function handleScanRosterOcrResult(result = {}) {
  const isCurrent = scanRosterOcrResultIsCurrent(result);
  if (!isCurrent) {
    // Currency is checked FIRST, before touching lastScanRosterOcrResult or
    // appending anything to the debug log -- a stale/untagged result must
    // leave every piece of session state (status, diagnostics, log, drafts)
    // completely untouched, not just the drafts. It must still settle a
    // pending native-bridge promise for its OWN exact requestId though, or
    // an overlapping/superseded native request hangs its caller forever --
    // see resolvePendingScanRosterImage's isCurrent=false branch, which
    // rejects with no other side effects.
    // A successful stale native result may have retained an in-memory bitmap
    // under its own request id immediately before calling into JS. It is not
    // part of the current guided session, so clearGuidedScanSession cannot see
    // it; release that exact stale capability here. Exact-id native ownership
    // means this cannot release the current request's source.
    const stalePreviewRequestId = result && result.requestId;
    const stalePreviewGeneration = stalePreviewRequestId
      ? (guidedScanPreviewBootstraps.get(stalePreviewRequestId) || null) : null;
    if (stalePreviewRequestId) guidedScanPreviewBootstraps.delete(stalePreviewRequestId);
    releaseGuidedScanPreviewSourceRequest(stalePreviewRequestId, stalePreviewGeneration);
    resolvePendingScanRosterImage(result, false);
    return;
  }
  // Privacy sanitation runs AFTER the currency gate (a stale result must
  // still touch nothing at all -- not even pay for a geometry pass) but
  // BEFORE the first retention of anything derived from the result: the
  // assignment below and the debug append after it are the first two places
  // raw OCR text is kept. Everything downstream uses safeResult, which is the
  // same object when nothing was withheld.
  const { safeResult, geometryBlocks } = scanRosterPrivacySafeOcrResult(result);
  lastScanRosterOcrResult = safeResult;
  appendScanRosterOcrDebug(safeResult.stage || (safeResult.ok ? "ocr-result-ok" : "ocr-result-failed"), safeResult.detail || safeResult.error || (safeResult.text ? "text length " + String(safeResult.text).length : ""));
  if (!safeResult.ok) {
    const error = new Error(safeResult.error || "Offline roster image scan failed.");
    resetScanRosterSessionState(false);
    setScanRosterProcessing(false);
    setScanRosterPhotoStatus("OCR stopped at: " + (safeResult.stage || "unknown") + ". Local roster scan failed: " + (safeResult.error || "Could not read text from that image."));
    showToast(safeResult.error || "Photo text extraction failed.", "warning");
    transitionScanRosterTransaction(safeResult.requestId, /cancel/i.test(safeResult.stage || "") ? "cancelled" : "failed", { error });
    return;
  }
  if (resolvePendingScanRosterImage(safeResult, true, geometryBlocks)) return;
  applyScanRosterOcrResult(safeResult, geometryBlocks);
  setScanRosterProcessing(false);
  transitionScanRosterTransaction(safeResult.requestId, "succeeded", { value: { staged: scanRosterDrafts.length } });
}

function scanRosterOcrIdentityText() {
  saveScanRosterIdentityFromInputs();
  const parts = [];
  if (scanRosterIdentity.name) parts.push(scanRosterIdentity.name);
  const aliases = Array.isArray(scanRosterIdentity.aliases)
    ? scanRosterIdentity.aliases
    : String(scanRosterIdentity.aliases || "").split(/[\n,;]+/);
  aliases.map((alias) => String(alias || "").trim()).filter(Boolean).forEach((alias) => parts.push(alias));
  return parts.join("\n");
}


function refuseScanRosterAccess() {
  setScanRosterPhotoStatus(PREMIUM_LOCKED_SCANNER_MESSAGE);
  renderScanRosterPremiumGate();
}

// Shared feedback for every scan entry point refused by
// beginScanRosterRequest()'s Team-identity gate (null requestId).
function refuseScanRosterTeamIdentityMissing() {
  setScanRosterPhotoStatus("Add your name or an alias in Settings → Roster scan before scanning a Team roster.");
  showToast("Team roster scanning needs your name set in Settings first.", "warning");
}

function runScanRosterSelfTestFromAdb() {
  if (!premiumFeatureState("scanner").allowed) {
    refuseScanRosterAccess();
    return;
  }
  const bridge = androidBridge();
  const requestId = beginScanRosterRequest();
  if (requestId === null) {
    refuseScanRosterTeamIdentityMissing();
    return;
  }
  appendScanRosterOcrDebug("web-self-test-start", "ADB/app self-test requested; using app-specific rosterbuddy-ocr-selftest.jpeg");
  showScreen("scan-roster");
  // Minted before the bridge-missing check too: even this immediate,
  // same-call failure is its own transaction and must carry a real id, or
  // handleScanRosterOcrResult's currency gate would discard it.
  if (!bridge || typeof bridge.runRosterSelfTestImage !== "function") {
    handleScanRosterOcrResult({ ok: false, error: "RosterBuddy self-test bridge is not available in this build.", stage: "web-self-test-bridge-missing", detail: "runRosterSelfTestImage missing", requestId });
    return;
  }
  setScanRosterPhotoStatus("Running OCR self-test from app test image…");
  bridge.runRosterSelfTestImage(scanRosterOcrIdentityText(), requestId);
}

function handleScanRosterSelfTestClick(event) {
  if (event) event.preventDefault();
  runScanRosterSelfTestFromAdb();
}

window.runScanRosterSelfTestFromAdb = runScanRosterSelfTestFromAdb;

function scanRosterConsoleWarning(stage) {
  const messages = Object.freeze({
    nativePicker: "RosterBuddy native photo picker failed before launch",
    fileRead: "RosterBuddy photo read failed",
  });
  const message = messages[stage];
  if (message) console.warn(message);
}

async function handleNativeScanRosterPhotoClick(event) {
  if (event) event.preventDefault();
  if (!premiumFeatureState("scanner").allowed) {
    refuseScanRosterAccess();
    return;
  }
  const bridge = androidBridge();
  const fallback = document.getElementById("scan-roster-image");
  if (!bridge || typeof bridge.pickRosterImageForOcr !== "function") {
    // Tapping Scan is a new attempt in BOTH branches, so it must invalidate
    // the previous confirmed session here too. Without this the bridge branch
    // below invalidated (via beginScanRosterRequest -> resetScanRosterSession
    // State) while this one silently left the previous scan's confirmed,
    // importable drafts on screen under a "opening the picker" status -- the
    // user could still Import the OLD photo's shifts after asking for a new
    // one. Cancel rather than mint: this branch only hands off to the browser
    // file input, which mints its own generation in handleScanRosterImage
    // Selected once a file actually arrives, so minting one here would leave
    // an active generation with no timeout and nothing to answer it if the
    // user cancels the file dialog. resetScanRosterSessionState(false) inside
    // clearScanRosterDrafts deliberately keeps the OCR debug log across the
    // hand-off so the fallback's own events append to it.
    clearScanRosterDrafts();
    setScanRosterPhotoStatus("Opening browser image picker. Android OCR works best in the installed app build.");
    if (fallback) fallback.click();
    return;
  }
  const requestId = beginScanRosterRequest();
  if (requestId === null) {
    refuseScanRosterTeamIdentityMissing();
    return;
  }
  try {
    appendScanRosterOcrDebug("web-click", "Android bridge found");
    setScanRosterPhotoStatus("Opening Android photo picker for on-device OCR…");
    const identityText = scanRosterOcrIdentityText();
    // Reads the format THIS transaction was snapshotted under at
    // beginScanRosterRequest, not the live scanRosterFormat setting -- a
    // mid-flight Settings change must never retroactively change which
    // native identity rule this exact requestId's picker launch is held to.
    const rosterFormat = scanRosterTransactionFormat(requestId);
    const isPersonalFormat = rosterFormat === "personal";
    appendScanRosterOcrDebug("web-native-picker-call", identityText
      ? "Configured name/aliases available; sending identity privately to Android"
      : (isPersonalFormat ? "Personal format; no name/alias match required" : "No configured name/aliases available; Android will not filter safely"));
    bridge.pickRosterImageForOcr(identityText, requestId, rosterFormat);
  } catch (caughtException) {
    // C64: the stage only. The caught exception used to ride along as a second
    // console argument, and on Android the WebView mirrors console output into
    // Logcat -- reopening, from the JS side, exactly the raw-detail window the
    // native bridge had to close unconditionally. A bridge/provider exception
    // routinely quotes the offending path back, and that path ends in the
    // user's own roster filename. Nothing in the message is actionable here
    // anyway: this branch is already unconditional (any throw at all means the
    // native attempt is dead), so the stage is the whole diagnosis.
    scanRosterConsoleWarning("nativePicker");
    // A synchronous bridge exception means this native attempt can never
    // produce its tagged result. Retire its exact ownership before opening the
    // independent browser fallback, which will mint a fresh id only if a file
    // is actually selected. Error details are deliberately not copied into
    // diagnostics because exception messages can contain filenames or names.
    if (scanRosterTransactionIsCurrent(requestId)) {
      transitionScanRosterTransaction(requestId, "failed", { error: new Error("Android photo picker failed before launch.") });
    }
    appendScanRosterOcrDebug("web-native-picker-error", "Android picker failed before launch; browser fallback offered");
    setScanRosterProcessing(false);
    setScanRosterPhotoStatus("Android photo picker was not available. Trying the backup image picker…");
    if (fallback) fallback.click();
  }
}

async function handleScanRosterImageSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!premiumFeatureState("scanner").allowed) {
    refuseScanRosterAccess();
    event.target.value = "";
    return;
  }
  const bridge = androidBridge();
  // Minted up front, before the (possibly slow) data-URL conversion below
  // can yield to another attempt -- re-checked immediately after that yield
  // so a superseded attempt cannot mutate status/toast/native calls that
  // belong to whatever started after it.
  const requestId = beginScanRosterRequest();
  if (requestId === null) {
    refuseScanRosterTeamIdentityMissing();
    event.target.value = "";
    return;
  }
  try {
    // C60: generic, and deliberately so. The filename used to be shown here
    // and scanRosterDiagnosticsText copies whatever status is live into the
    // text the user is invited to copy and send -- and gallery filenames are
    // routinely identifying ("Alex-Ford-roster-March.jpg"), while screenshot
    // names carry a timestamp. The exact byte size that used to ride along in
    // web-fallback-file is the same class of problem: a stable fingerprint of
    // one specific image file. The stage stays in the log; the fingerprint
    // does not.
    setScanRosterPhotoStatus("Preparing the selected image for local roster scan…");
    appendScanRosterOcrDebug("web-fallback-file", "selected=true");
    const dataUrl = await selectedScanRosterImageToDataUrl(file);
    if (!scanRosterTransactionIsCurrent(requestId)) return;
    if ((window.MediaPipeScannerService && typeof window.MediaPipeScannerService.scanRosterImage === "function") || window.RosterBuddyMediaPipeTextDetector || window.MediaPipeTextDetector || window.google_mediapipe) {
      await processCapturedRosterImageUri(dataUrl, requestId);
      return;
    }
    if (!bridge || typeof bridge.extractRosterTextFromImage !== "function") {
      setScanRosterPhotoStatus("Photo OCR needs the Android app build. For browser testing, use a local MediaPipe text detector provider.");
      showInfoDialog("Open in Android app", "Photo text extraction runs on-device in the Android app so roster screenshots are not uploaded.", "OK");
      // This attempt minted a real transaction above, before the bridge could
      // be inspected, and nothing on this branch will ever produce a result
      // for it -- the user is being sent to the Android app instead. Retire it
      // here rather than routing through handleScanRosterOcrResult, which
      // would replace the hand-off status/dialog above with a generic "OCR
      // stopped at ..." failure and a warning toast. Left active, the id stays
      // current and a late echo for it would still be accepted.
      setScanRosterProcessing(false);
      transitionScanRosterTransaction(requestId, "failed", {
        error: new Error("Photo OCR needs the Android app build."),
      });
      return;
    }
    setScanRosterPhotoStatus("Photo prepared for on-device OCR. Reading text now…");
    // Stage only: the data URL's length is a file-size fingerprint of the
    // user's own photo, and one refactor away from being emitted as a
    // "chars=" key the diagnostics allowlist would have to catch again.
    appendScanRosterOcrDebug("web-fallback-data-url", "prepared");
    bridge.extractRosterTextFromImage(JSON.stringify({ dataUrl, identityText: scanRosterOcrIdentityText(), requestId }));
  } catch (caughtException) {
    // C64: stage only, for the same reason as the native picker branch above.
    // This catch covers the file read/compression step, whose exceptions come
    // from the platform decoder and name the file being decoded.
    scanRosterConsoleWarning("fileRead");
    // Routed entirely through handleScanRosterOcrResult's own currency gate
    // (via requestId) rather than a separate check here, so a stale
    // rejection cannot append to the debug log or touch status/toast either.
    handleScanRosterOcrResult({ ok: false, error: "Browser image picker could not read the selected file.", stage: "web-fallback-read-error", detail: "readFailed=true", requestId });
  } finally {
    event.target.value = "";
  }
}

const GUIDED_SETUP_TEMPLATE_KEYS = ["early", "mid", "afternoon", "late", "overnight", "night"];

function applyGuidedSetupDraft(draft = {}) {
  const payPeriod = String(draft.payPeriod || "");
  const cycleStart = parseDateInput(String(draft.payCycleStartDate || ""));
  const parsedWeekStart = Number(draft.weekStart);
  const shifts = draft.shifts && typeof draft.shifts === "object" ? draft.shifts : {};

  if (!payPeriods[payPeriod]) return { ok: false, message: "Choose weekly, fortnightly or monthly pay." };
  if (!cycleStart) return { ok: false, message: "Choose the first day of one known pay cycle." };
  if (![0, 1, 6].includes(parsedWeekStart)) return { ok: false, message: "Choose which day your week starts." };

  const pendingTemplates = {};
  for (const key of GUIDED_SETUP_TEMPLATE_KEYS) {
    const current = templates[key];
    const supplied = shifts[key];
    if (!current || !supplied || typeof supplied !== "object") continue;
    const label = String(supplied.label || "").trim() || current.label;
    const icon = (String(supplied.icon || "").trim() || current.icon || label.slice(0, 2).toUpperCase()).slice(0, 8);
    const rawStart = String(supplied.start || "").trim();
    const rawFinish = String(supplied.finish || "").trim();
    if (Boolean(rawStart) !== Boolean(rawFinish)) {
      return { ok: false, message: label + " needs both a start and finish time, or neither." };
    }
    const start = rawStart ? normaliseTimeText(rawStart) : "";
    const finish = rawFinish ? normaliseTimeText(rawFinish) : "";
    if ((rawStart && !start) || (rawFinish && !finish)) {
      return { ok: false, message: "Check the start and finish time for " + label + "." };
    }
    pendingTemplates[key] = {
      ...current,
      label,
      icon,
      start,
      finish,
      hours: start && finish ? shiftHours(start, finish, current.breakMinutes || 0) : 0,
    };
  }

  selectedPayPeriod = payPeriod;
  payCycleViewOffset = 0;
  payCycleStartDate = dateKeyForDate(cycleStart);
  weekStartDay = parsedWeekStart;
  Object.entries(pendingTemplates).forEach(([key, template]) => {
    templates[key] = template;
  });
  return { ok: true };
}

function guidedSetupDraftFromInputs() {
  const shifts = {};
  GUIDED_SETUP_TEMPLATE_KEYS.forEach((key) => {
    shifts[key] = {
      icon: document.getElementById("guided-shift-" + key + "-code")?.value || "",
      label: document.getElementById("guided-shift-" + key + "-label")?.value || "",
      start: document.getElementById("guided-shift-" + key + "-start")?.value || "",
      finish: document.getElementById("guided-shift-" + key + "-finish")?.value || "",
    };
  });
  return {
    payPeriod: document.getElementById("guided-pay-frequency")?.value || selectedPayPeriod,
    payCycleStartDate: document.getElementById("guided-pay-cycle-start")?.value || payCycleStartDate,
    weekStart: Number(document.getElementById("guided-week-start")?.value ?? weekStartDay),
    shifts,
  };
}

function renderGuidedSetup() {
  const frequency = document.getElementById("guided-pay-frequency");
  const cycleStart = document.getElementById("guided-pay-cycle-start");
  const weekStart = document.getElementById("guided-week-start");
  const list = document.getElementById("guided-shift-setup");
  if (!frequency || !cycleStart || !weekStart || !list) return;

  frequency.value = selectedPayPeriod;
  cycleStart.value = payCycleStartDate;
  weekStart.value = String(weekStartDay);
  list.innerHTML = "";

  GUIDED_SETUP_TEMPLATE_KEYS.forEach((key, index) => {
    const template = templates[key];
    if (!template) return;
    const row = document.createElement("article");
    row.className = "guided-shift-row";
    row.innerHTML =
      "<div class=\"guided-shift-number\">Shift " + (index + 1) + "</div>" +
      "<div class=\"guided-shift-fields\">" +
        "<label><span>Roster code</span><input id=\"guided-shift-" + key + "-code\" maxlength=\"8\" autocomplete=\"off\" /></label>" +
        "<label><span>Meaning</span><input id=\"guided-shift-" + key + "-label\" autocomplete=\"off\" /></label>" +
        "<label><span>Starts</span><input id=\"guided-shift-" + key + "-start\" type=\"time\" /></label>" +
        "<label><span>Finishes</span><input id=\"guided-shift-" + key + "-finish\" type=\"time\" /></label>" +
      "</div>";
    list.appendChild(row);
    document.getElementById("guided-shift-" + key + "-code").value = template.icon || "";
    document.getElementById("guided-shift-" + key + "-label").value = template.label || "";
    document.getElementById("guided-shift-" + key + "-start").value = template.start || "";
    document.getElementById("guided-shift-" + key + "-finish").value = template.finish || "";
  });
}

function saveGuidedSetup({ quiet = false } = {}) {
  const result = applyGuidedSetupDraft(guidedSetupDraftFromInputs());
  if (!result.ok) {
    showToast(result.message, "warning");
    return false;
  }
  saveState();
  syncControlState();
  populatePayRuleInputs();
  renderTemplates();
  renderShiftPicker();
  renderCalendar();
  renderQuickGrid();
  updateSelectedCount();
  updatePayDisplay();
  renderGuidedSetup();
  if (!quiet) showToast("Setup saved. You can change it any time in Settings.", "success");
  return true;
}

function completeOnboarding() {
  if (!saveGuidedSetup({ quiet: true })) return;
  onboardingCompleted = true;
  saveState();
  showToast("Setup saved. You can replay the guide from Settings.", "success");
  showScreen("calendar");
}

const cloudSyncConsentApi = window.RosterBuddyCloudSyncConsent;
const cloudSyncPreference = cloudSyncConsentApi
  ? cloudSyncConsentApi.createSyncPreference(window.localStorage)
  : null;
let cloudSyncChoiceOpen = false;
function cloudSyncPreferenceState() {
  return cloudSyncPreference ? cloudSyncPreference.get() : "unset";
}
function renderCloudSyncSetting() {
  const state = cloudSyncPreferenceState();
  const status = document.getElementById("settings-cloud-sync-status");
  const description = document.getElementById("settings-cloud-sync-description");
  if (!status || !description) return;
  status.textContent = state === "cloud-enabled" ? "On" : state === "local-only" ? "This device" : "Choose";
  description.textContent = state === "cloud-enabled" ? "Allow approved roster sharing to sync across devices." : state === "local-only" ? "New cloud uploads and live updates are off." : "Choose before any cloud sync can start.";
}
function closeCloudSyncChoice() {
  const modal = document.getElementById("cloud-sync-consent-modal");
  if (modal) modal.classList.add("hidden");
  cloudSyncChoiceOpen = false;
}
function openCloudSyncChoice({ firstUse = false } = {}) {
  const modal = document.getElementById("cloud-sync-consent-modal");
  if (!modal || !cloudSyncPreference) return;
  const title = document.getElementById("cloud-sync-consent-title");
  const copy = document.getElementById("cloud-sync-consent-copy");
  if (title) title.textContent = firstUse ? "Choose how RosterBuddy stores your data" : "Change cloud sync";
  if (copy) copy.textContent = firstUse
    ? "Cloud sync is optional. Existing local data stays on this device until you choose."
    : "Turn cloud sync on to use approved sharing across devices, or keep new uploads on this device. Cloud data is not deleted when you switch off.";
  modal.classList.remove("hidden");
  cloudSyncChoiceOpen = true;
}
function commitCloudSyncPreference(value) {
  if (!cloudSyncPreference) return;
  cloudSyncPreference.set(value);
  closeCloudSyncChoice();
  renderCloudSyncSetting();
  window.dispatchEvent(new CustomEvent("rosterbuddy:sync-preference-changed", { detail: { preference: value } }));
  showToast(value === "cloud-enabled" ? "Cloud sync is on. Sharing permissions remain separate." : "This device only. New cloud uploads and live updates are off.", "success");
}
function maybeShowCloudSyncChoice() {
  if (!cloudSyncPreference || !appAuthSession || typeof appAuthSession.status !== "function") return;
  if (cloudSyncPreference.needsFirstUseChoice(appAuthSession.status().authenticated) && !cloudSyncChoiceOpen) openCloudSyncChoice({ firstUse: true });
}
function bindNavigation() {
  function renderAccountStatus() {
    const target = document.getElementById("account-settings-status");
    if (target) target.textContent = "Local device";
  }
  renderAccountStatus();
  renderCloudSyncSetting();
  document.getElementById("settings-cloud-sync-control").addEventListener("click", () => openCloudSyncChoice());
  document.getElementById("cloud-sync-enable").addEventListener("click", () => commitCloudSyncPreference("cloud-enabled"));
  document.getElementById("cloud-sync-local-only").addEventListener("click", () => commitCloudSyncPreference("local-only"));
  window.addEventListener("rosterbuddy:auth-changed", maybeShowCloudSyncChoice);
  document.querySelectorAll("[data-open]").forEach((element) => {
    element.addEventListener("click", () => showScreen(element.dataset.open));
  });

  document.querySelectorAll("[data-back]").forEach((element) => {
    element.addEventListener("click", goBack);
  });

  document.getElementById("clear-selection").addEventListener("click", clearCurrentDay);
  document.getElementById("day-note-open").addEventListener("click", () => setDayNoteEditing(true));
  document.getElementById("day-note-cancel").addEventListener("click", () => setDayNoteEditing(false));
  document.getElementById("toggle-additional-hours").addEventListener("click", () => toggleAdditionalHoursPanel());
  document.getElementById("save-shifts").addEventListener("click", saveQuickEntryAndReturn);
  document.getElementById("additional-hours-day").addEventListener("blur", saveSelectedDayAdditionalHours);
  document.getElementById("additional-hours-day").addEventListener("change", saveSelectedDayAdditionalHours);
  document.getElementById("additional-hours-double-time").addEventListener("change", saveSelectedDayAdditionalHours);
  document.getElementById("undo-entry").addEventListener("click", undoStep);
  document.getElementById("recovery-alert-toggle").addEventListener("click", toggleRecoveryAlerts);
  document.getElementById("save-reminder").addEventListener("click", saveReminder);
  document.getElementById("clear-reminder").addEventListener("click", clearReminder);
  document.getElementById("save-day-note").addEventListener("click", saveDayNote);
  document.getElementById("clear-day-note").addEventListener("click", clearDayNote);
  document.getElementById("clear-month").addEventListener("click", clearMonth);
  document.getElementById("prev-month").addEventListener("click", () => changeMonth(-1));
  document.getElementById("next-month").addEventListener("click", () => changeMonth(1));
  document.getElementById("toggle-calendar-details").addEventListener("click", toggleCalendarDetails);
  bindMonthSwipe();

  document.querySelectorAll(".swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      document.querySelectorAll(".swatch").forEach((item) => item.classList.remove("selected"));
      swatch.classList.add("selected");
    });
  });

  ["template-start", "template-finish", "template-break"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateCalculatedHoursPreview);
    document.getElementById(id).addEventListener("change", updateCalculatedHoursPreview);
  });

  document.getElementById("template-hours").addEventListener("input", () => {
    templateHoursManuallyEdited = true;
    document.getElementById("template-hours-hint").textContent = "Manual paid hours override";
  });

  document.querySelectorAll("[data-emoji]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("template-icon").value = button.dataset.emoji;
    });
  });

  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedPayPeriod = button.dataset.period;
      if (selectedPayPeriod !== "fortnightly") payCycleViewOffset = 0;
      document.querySelectorAll("[data-period]").forEach((item) => {
        item.classList.toggle("active", item.dataset.period === selectedPayPeriod);
      });
      saveState();
      updatePayDisplay();
    });
  });

  document.querySelectorAll("[data-pay-cycle-offset]").forEach((button) => {
    button.addEventListener("click", () => setPayCycleViewOffset(Number(button.dataset.payCycleOffset)));
  });

  document.querySelectorAll("[data-theme]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  });

  document.querySelectorAll("[data-week-start]").forEach((button) => {
    button.addEventListener("click", () => {
      weekStartDay = Number(button.dataset.weekStart);
      document.querySelectorAll("[data-week-start]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      saveState();
      renderCalendar();
      renderQuickGrid();
    });
  });

  document.getElementById("save-template").addEventListener("click", saveTemplate);
  document.getElementById("delete-template").addEventListener("click", deleteTemplate);
  document.getElementById("new-template").addEventListener("click", openNewTemplate);
  document.getElementById("save-pay-rules").addEventListener("click", savePayRules);
  document.querySelectorAll("[data-share-range]").forEach((button) => {
    button.addEventListener("click", () => setShareRangeMode(button.dataset.shareRange));
  });
  const shareWeekSelect = document.getElementById("share-week-select");
  if (shareWeekSelect) {
    shareWeekSelect.addEventListener("change", (event) => {
      shareWeekStartDate = event.target.value;
      updateSharePreview();
    });
  }
  ["share-include-times", "share-include-notes", "share-include-pay", "share-include-recovery", "share-include-off-days"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener("change", updateSharePreview);
  });
  document.getElementById("copy-share-text").addEventListener("click", copyShareText);
  document.getElementById("native-share-roster").addEventListener("click", nativeShareRoster);
  document.getElementById("export-google-calendar").addEventListener("click", exportGoogleCalendarRange);
  document.getElementById("export-phone-calendar").addEventListener("click", exportPhoneCalendarRange);
  document.getElementById("scan-roster-name").addEventListener("change", saveScanRosterIdentityFromInputs);
  document.getElementById("scan-roster-aliases").addEventListener("change", saveScanRosterIdentityFromInputs);
  document.getElementById("scan-roster-format-team").addEventListener("change", saveScanRosterFormatFromInputs);
  document.getElementById("scan-roster-format-personal").addEventListener("change", saveScanRosterFormatFromInputs);
  document.getElementById("scan-roster-open-diagnostics").addEventListener("click", openScanRosterDiagnostics);
  document.getElementById("copy-scan-diagnostics").addEventListener("click", copyScanRosterDiagnostics);
  document.getElementById("scan-roster-clear").addEventListener("click", clearScanRosterDrafts);
  document.getElementById("scan-roster-import").addEventListener("click", importReviewedScanRosterDrafts);
  document.getElementById("scan-roster-ai-assist").addEventListener("click", runScanRosterAiAssist);
  document.getElementById("scan-roster-photo-picker").addEventListener("click", handleNativeScanRosterPhotoClick);
  document.getElementById("scan-roster-self-test").addEventListener("click", handleScanRosterSelfTestClick);
  document.getElementById("scan-roster-image").addEventListener("change", handleScanRosterImageSelected);
  document.getElementById("calendar-export-setting").addEventListener("click", exportGoogleCalendarRange);
  document.getElementById("export-backup").addEventListener("click", exportBackupJson);
  document.getElementById("share-backup").addEventListener("click", shareBackupJson);
  document.getElementById("copy-backup-json").addEventListener("click", copyBackupJson);
  document.getElementById("import-backup-file").addEventListener("change", handleBackupFileSelected);
  document.getElementById("onboarding-choose-backup").addEventListener("click", () => document.getElementById("onboarding-import-backup-file").click());
  document.getElementById("onboarding-import-backup-file").addEventListener("change", handleBackupFileSelected);
  document.getElementById("casual-day").addEventListener("change", applyEntryModifierCheckboxChange);
  document.getElementById("higher-duties-day").addEventListener("change", applyEntryModifierCheckboxChange);
  document.getElementById("on-call-day").addEventListener("change", applyEntryModifierCheckboxChange);
  document.getElementById("reset-app-data").addEventListener("click", resetAppData);
  document.getElementById("save-guided-setup").addEventListener("click", () => saveGuidedSetup());
  document.getElementById("complete-onboarding").addEventListener("click", completeOnboarding);
  document.getElementById("app-modal-cancel").addEventListener("click", closeConfirmDialog);
  document.getElementById("app-modal-confirm").addEventListener("click", () => {
    if (typeof modalConfirmAction === "function") modalConfirmAction();
  });
  document.getElementById("refresh-widgets").addEventListener("click", refreshWidgetsWithFeedback);
  document.getElementById("premium-purchase").addEventListener("click", startPremiumPurchase);
  document.getElementById("premium-restore").addEventListener("click", () => syncPremiumEntitlementFromPlay("restore"));
  bindPayRuleFormatting();
}

function syncControlState() {
  syncCalendarDetailsControl();
  document.querySelectorAll("[data-period]").forEach((item) => {
    item.classList.toggle("active", item.dataset.period === selectedPayPeriod);
  });
  document.querySelectorAll("[data-week-start]").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.weekStart) === weekStartDay);
  });
  const recoveryStatus = document.getElementById("recovery-alert-status");
  if (recoveryStatus) recoveryStatus.textContent = recoveryAlertsEnabled ? "On" : "Off";
  const jurisdictionSelect = document.getElementById("public-holiday-jurisdiction");
  if (jurisdictionSelect) jurisdictionSelect.value = publicHolidayJurisdiction;
  renderPremiumScreen();
  renderScanRosterPremiumGate();
}

loadPremiumUnlockState();
loadSavedState();
syncControlState();
syncScanRosterInputs();
populatePayRuleInputs();
renderCalendar();
renderQuickGrid();
renderShiftPicker();
renderTemplates();
updateSelectedCount();
updatePayDisplay();
updateBackupStatus();
applyTheme(selectedTheme);
bindNavigation();
restorePersistedActiveScreen();
bindActiveScreenRestoreEvents();
if (!onboardingCompleted) {
  activeScreen = "onboarding";
  history.length = 0;
  history.push("onboarding");
}
function cleanupOldAppCaches() {
  if (!("caches" in window)) return;
  caches.keys().then((keys) => Promise.all(
    keys
      .filter((key) => (key.startsWith("shiftmate-") || key.startsWith("rosterbuddy-")) && key !== "rosterbuddy-v0-2-1")
      .map((key) => caches.delete(key))
  )).catch((error) => {
    console.warn("RosterBuddy cache cleanup failed.", error);
  });
}

window.currentStatePayload = currentStatePayload;
window.RosterBuddyGetLocalRoster = () => ({ roster: JSON.parse(JSON.stringify(rosters)), templates: JSON.parse(JSON.stringify(templates)) });
// Read-only member-labelled view. Rows are copied through the allowlisting model
// into calendarViewProjection; nothing is written to templates, rosters or saved
// state, so personal roster, pay and recovery calculations are unaffected.
window.RosterBuddySetCalendarView = (rows, label = "Shared roster") => {
  const model = window.RosterBuddySharedCalendarModel;
  if (!model) return false;
  calendarViewProjection = model.buildProjection(rows, label);
  calendarViewFilter = null;
  calendarViewSelectedDay = null;
  calendarViewReadOnly = true;
  setSharedCalendarChrome(true);
  renderCalendar();
  return true;
};
window.RosterBuddySetCombinedCalendarView = window.RosterBuddySetCalendarView;
window.RosterBuddyClearCalendarView = () => {
  calendarViewProjection = null;
  calendarViewFilter = null;
  calendarViewSelectedDay = null;
  calendarViewReadOnly = false;
  setSharedCalendarChrome(false);
  renderCalendar();
  return true;
};
// ids: array of source user ids to show, or null for everyone.
window.RosterBuddySetCalendarMemberFilter = (ids) => {
  if (!calendarViewProjection) return false;
  calendarViewFilter = ids == null ? null : new Set(Array.from(ids).map(String));
  renderCalendar();
  return true;
};
window.RosterBuddyCalendarViewState = () => ({
  readOnly: calendarViewReadOnly,
  label: calendarViewProjection && calendarViewProjection.label || "My calendar",
  members: calendarViewProjection ? calendarViewProjection.members.map((member) => ({ id: member.id, name: member.name })) : [],
  filter: calendarViewFilter == null ? null : Array.from(calendarViewFilter),
});
if (typeof document !== "undefined" && document.getElementById) {
  const sharedFilterHost = document.getElementById("calendar-shared-filters");
  if (sharedFilterHost && sharedFilterHost.addEventListener) {
    sharedFilterHost.addEventListener("click", (event) => {
      const button = event.target && event.target.closest ? event.target.closest("[data-shared-member]") : null;
      if (!button || !calendarViewProjection) return;
      const all = calendarViewProjection.members.map((member) => member.id);
      const next = new Set(calendarViewFilter == null ? all : calendarViewFilter);
      const id = button.getAttribute("data-shared-member");
      if (next.has(id)) next.delete(id); else next.add(id);
      // Hiding everyone is never useful; an empty or full selection means "all".
      window.RosterBuddySetCalendarMemberFilter(next.size === 0 || next.size === all.length ? null : Array.from(next));
    });
  }
}
window.syncAndroidWidgetState = syncAndroidWidgetStateFromNative;
window.scanRosterImage = scanRosterImage;
window.processCapturedRosterImageUri = processCapturedRosterImageUri;
window.handleScanRosterOcrResult = handleScanRosterOcrResult;
window.handleScanRosterOcrDebug = handleScanRosterOcrDebug;
window.handlePlayBillingResult = handlePlayBillingResult;
syncPremiumEntitlementFromPlay("startup");
cleanupOldAppCaches();
scheduleWidgetSync();
window.addEventListener("load", scheduleWidgetSync);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleWidgetSync();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("RosterBuddy service worker registration failed.", error);
    });
  });
}
