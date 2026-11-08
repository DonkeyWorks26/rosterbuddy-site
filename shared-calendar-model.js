/* Pure model for the read-only, member-labelled group calendar.
 *
 * Input rows come from the group-schedule projection (date, shift code, label,
 * start, finish, version, plus a source user id and a safe display name).
 * This module copies ONLY those fields. It never reads, writes or derives
 * anything from the personal roster, templates, pay or recovery state, so the
 * shared view cannot influence them. It has no DOM and no storage access.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RosterBuddySharedCalendarModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function createApi() {
  const FALLBACK_NAME = 'Connected person';
  const MAX_ENTRIES = 4000;

  function validDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const ok = date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
    return ok ? match[0] : '';
  }
  function validTime(value) {
    const text = String(value || '').slice(0, 5);
    return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(text) ? text : '';
  }
  // A display name is a label, never contact data: anything email-like is replaced.
  function safeName(value) {
    const text = String(value == null ? '' : value).trim();
    return !text || text.includes('@') ? FALLBACK_NAME : text.slice(0, 60);
  }
  function memberInitial(name) {
    const first = Array.from(safeName(name))[0] || '?';
    return first.toUpperCase();
  }

  // people (optional): everyone in the group as [{ id, name }], so a member with no shifts yet still gets a row.
  function buildProjection(rows, label, people) {
    const entries = [];
    const members = new Map();
    (Array.isArray(people) ? people : []).slice(0, 200).forEach((person) => {
      const id = String(person && person.id || '').slice(0, 64);
      if (id && !members.has(id)) members.set(id, { id, name: safeName(person.name), sharing: person.sharing !== false });
    });
    (Array.isArray(rows) ? rows : []).slice(0, MAX_ENTRIES).forEach((row) => {
      const date = validDate(row && row.date);
      if (!date) return;
      const sourceUserId = String(row.sourceUserId || '').slice(0, 64);
      const displayName = safeName(row.displayName);
      entries.push({
        date, sourceUserId, displayName,
        shiftCode: String(row.shiftCode || '').slice(0, 8),
        label: String(row.label || 'Shift').slice(0, 80),
        start: validTime(row.start), finish: validTime(row.finish),
        version: Number.isFinite(Number(row.version)) ? Number(row.version) : 0,
      });
      if (!members.has(sourceUserId)) members.set(sourceUserId, { id: sourceUserId, name: displayName, sharing: true });
    });
    return {
      label: String(label || 'Shared roster').slice(0, 80),
      entries,
      members: Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    };
  }

  // visibleIds: null = everyone; otherwise an array/Set of source user ids.
  function isVisible(entry, visibleIds) {
    if (visibleIds == null) return true;
    const set = visibleIds instanceof Set ? visibleIds : new Set(visibleIds);
    return set.has(entry.sourceUserId);
  }

  function entriesByDay(projection, monthPrefix, visibleIds) {
    const byDay = {};
    ((projection && projection.entries) || []).forEach((entry) => {
      if (!entry.date.startsWith(`${monthPrefix}-`) || !isVisible(entry, visibleIds)) return;
      const day = Number(entry.date.slice(8, 10));
      (byDay[day] ||= []).push(entry);
    });
    Object.values(byDay).forEach((list) => list.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.shiftCode.localeCompare(b.shiftCode)));
    return byDay;
  }

  function describeEntry(entry) {
    const times = entry.start && entry.finish ? ` · ${entry.start}–${entry.finish}` : '';
    const code = entry.shiftCode ? `${entry.shiftCode} ` : '';
    return `${entry.displayName} — ${code}${entry.label}${times}`;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // Week-by-week roster: one block per week, a header of seven dates, then one row per person with the shift code
  // under each day. year/month are the viewed month (month is 0-11); weekStartDay is 0 (Sunday), 1 (Monday) or 6 (Saturday).
  // Days outside the viewed month are present (so the header is a full week) but carry no shifts: only this month was read.
  function buildWeeks(projection, year, month, weekStartDay, visibleIds) {
    const start = [0, 1, 6].includes(Number(weekStartDay)) ? Number(weekStartDay) : 0;
    const monthPrefix = `${year}-${pad2(month + 1)}`;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() - start + 7) % 7;
    const total = Math.ceil((offset + daysInMonth) / 7) * 7;
    const people = ((projection && projection.members) || []).filter((member) => isVisible({ sourceUserId: member.id }, visibleIds));
    const codes = new Map();
    ((projection && projection.entries) || []).forEach((entry) => {
      if (!entry.date.startsWith(`${monthPrefix}-`) || !isVisible(entry, visibleIds)) return;
      const key = `${entry.sourceUserId}|${Number(entry.date.slice(8, 10))}`;
      codes.set(key, codes.has(key) ? `${codes.get(key)} ${entry.shiftCode}` : entry.shiftCode);
    });
    const weeks = [];
    for (let weekStart = 0; weekStart < total; weekStart += 7) {
      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const dayNumber = weekStart + i - offset + 1;
        const date = new Date(Date.UTC(year, month, dayNumber));
        days.push({
          day: dayNumber, inMonth: dayNumber >= 1 && dayNumber <= daysInMonth,
          dateOfMonth: date.getUTCDate(), weekday: date.getUTCDay(),
          iso: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
        });
      }
      weeks.push({
        days,
        rows: people.map((member) => ({ id: member.id, name: member.name, sharing: member.sharing !== false, cells: days.map((d) => (d.inMonth ? (codes.get(`${member.id}|${d.day}`) || '') : '')) })),
      });
    }
    return weeks;
  }

  return { buildProjection, buildWeeks, entriesByDay, describeEntry, memberInitial, safeName, validDate, isVisible, FALLBACK_NAME };
});
