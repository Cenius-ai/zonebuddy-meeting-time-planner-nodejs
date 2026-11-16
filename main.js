'use strict';

/*
 * Zonebuddy Meeting Time Planner
 * ------------------------------
 * A dependency-free Node 20 server: routing, auth, JSON persistence and the SPA
 * shell are all served from this single entry file (`node main.js`).
 *
 * Data lives in data/db.json and is rewritten atomically (tmp file + rename) so a
 * crash mid-write leaves the previous store intact.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* Minimal .env loader (no dependency): KEY=VALUE lines; real env wins. */
function loadDotEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    console.error('[zonebuddy] could not read .env:', error.message);
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnvFile();

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = path.resolve(process.env.ZONEBUDDY_DB || path.join(__dirname, 'data', 'db.json'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 168) * 60 * 60 * 1000;
const COOKIE_NAME = 'zb_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_BODY_BYTES = 64 * 1024;

const MEMBER_COLORS = ['#528a54', '#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00'];
const ALLOWED_DURATIONS = [30, 60, 90];
const SLOT_STEP_MINUTES = 30;

const DEMO_ACCOUNT = { email: 'cenius@cenius.ai', username: 'cenius', password: 'cenius' };
const LEGACY_DEMO_ACCOUNT = { email: 'demo@zonebuddy.dev', username: 'demo', password: 'zonebuddy123' };

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const pad2 = (value) => String(value).padStart(2, '0');
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(18).toString('base64url');

function sortedTimeZones() {
  let zones = [];
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
  }
  if (!zones.length) {
    zones = [
      'Africa/Cairo', 'Africa/Johannesburg', 'America/Chicago', 'America/Los_Angeles',
      'America/Mexico_City', 'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai',
      'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/Berlin',
      'Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'Europe/Warsaw', 'UTC',
    ];
  }
  if (!zones.includes('UTC')) zones = zones.concat('UTC');
  return [...zones].sort((a, b) => a.localeCompare(b));
}

const TIME_ZONES = sortedTimeZones();
const TIME_ZONE_SET = new Set(TIME_ZONES);

/* -------------------------------------------------------------------------- */
/* Time-zone math (all wall-clock conversion goes through Intl)               */
/* -------------------------------------------------------------------------- */

const FORMATTERS = new Map();

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(timeZone, instantMs) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function timeZoneOffsetMs(timeZone, instantMs) {
  const parts = zonedParts(timeZone, instantMs);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

function minutesOfDay(timeZone, instantMs) {
  const parts = zonedParts(timeZone, instantMs);
  return parts.hour * 60 + parts.minute;
}

function dateKeyInZone(timeZone, instantMs) {
  const parts = zonedParts(timeZone, instantMs);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** UTC instant for `minutes` past local midnight of `dateStr` in `timeZone`. */
function zonedTimeToUtc(dateStr, minutes, timeZone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * 60000;
  const firstOffset = timeZoneOffsetMs(timeZone, naive);
  let utc = naive - firstOffset;
  const secondOffset = timeZoneOffsetMs(timeZone, utc);
  if (secondOffset !== firstOffset) utc = naive - secondOffset;
  return utc;
}

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86400000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function weekdayOf(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function mondayOf(dateStr) {
  return addDays(dateStr, -((weekdayOf(dateStr) + 6) % 7));
}

function isValidDateStr(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function hhmmToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToHHMM(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** Next instant at or after `instant` whose local wall-clock minutes are a multiple of `step`. */
function alignToStep(instant, timeZone, stepMinutes) {
  const stepMs = stepMinutes * 60000;
  const offset = timeZoneOffsetMs(timeZone, instant);
  const localMs = instant + offset;
  return Math.ceil(localMs / stepMs) * stepMs - offset;
}

function formatDayLabel(instant, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone,
  }).format(new Date(instant));
}

/* -------------------------------------------------------------------------- */
/* Interval math for shared working hours                                     */
/* -------------------------------------------------------------------------- */

function intersectIntervals(a, b) {
  const out = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (end > start) out.push([start, end]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

/** UTC intervals during which `member` is inside their working hours near the window. */
function memberWorkingIntervals(member, windowStart, windowEnd) {
  const workStart = hhmmToMinutes(member.workStart);
  const workEnd = hhmmToMinutes(member.workEnd);
  if (workEnd <= workStart) return [];
  const startDate = dateKeyInZone(member.timeZone, windowStart);
  const endDate = dateKeyInZone(member.timeZone, windowEnd);
  const localDates = new Set([addDays(startDate, -1), startDate, endDate, addDays(endDate, 1)]);
  const intervals = [];
  for (const localDate of localDates) {
    const start = zonedTimeToUtc(localDate, workStart, member.timeZone);
    const end = zonedTimeToUtc(localDate, workEnd, member.timeZone);
    if (end > start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  return intervals;
}

function sharedIntervals(members, windowStart, windowEnd) {
  let shared = [[windowStart, windowEnd]];
  for (const member of members) {
    shared = intersectIntervals(shared, memberWorkingIntervals(member, windowStart, windowEnd));
    if (!shared.length) return [];
  }
  return shared;
}

function dayWindow(dateStr, referenceZone) {
  return {
    start: zonedTimeToUtc(dateStr, 0, referenceZone),
    end: zonedTimeToUtc(addDays(dateStr, 1), 0, referenceZone),
  };
}

function sharedHoursForDay(members, dateStr, referenceZone) {
  if (!members.length) return 0;
  const window = dayWindow(dateStr, referenceZone);
  const intervals = sharedIntervals(members, window.start, window.end);
  const totalMs = intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
  return Math.round((totalMs / 3600000) * 10) / 10;
}

/** A default planning date: today, or the next weekday when today is a weekend. */
function defaultPlanningDate(referenceZone) {
  let date = dateKeyInZone(referenceZone, Date.now());
  for (let guard = 0; guard < 4; guard += 1) {
    const weekday = weekdayOf(date);
    if (weekday !== 0 && weekday !== 6) break;
    date = addDays(date, 1);
  }
  return date;
}

/* -------------------------------------------------------------------------- */
/* Meeting slot suggestions                                                   */
/* -------------------------------------------------------------------------- */

function comfortScore(members, slot) {
  let total = 0;
  for (const member of members) {
    const workMidpoint = (hhmmToMinutes(member.workStart) + hhmmToMinutes(member.workEnd)) / 2;
    const slotMidpoint = (minutesOfDay(member.timeZone, slot.start) + minutesOfDay(member.timeZone, slot.end)) / 2;
    total += Math.abs(slotMidpoint - workMidpoint);
  }
  return Math.round(total / members.length);
}

/** Slots inside a shared window, aligned to the reference zone's half hours. */
function slotsInsideWindow(windowIntervals, referenceZone, durationMinutes) {
  const durationMs = durationMinutes * 60000;
  const stepMs = SLOT_STEP_MINUTES * 60000;
  const slots = [];
  for (const [start, end] of windowIntervals) {
    let cursor = alignToStep(start, referenceZone, SLOT_STEP_MINUTES);
    if (cursor < start) cursor += stepMs;
    for (; cursor + durationMs <= end && slots.length < 400; cursor += stepMs) {
      slots.push({ start: cursor, end: cursor + durationMs });
    }
  }
  return slots;
}

function findNextDayWithSlots(members, fromDate, referenceZone, durationMinutes) {
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = addDays(fromDate, offset);
    const window = dayWindow(date, referenceZone);
    const shared = sharedIntervals(members, window.start, window.end);
    if (shared.length && slotsInsideWindow(shared, referenceZone, durationMinutes).length) {
      return { date, label: formatDayLabel(window.start, referenceZone) };
    }
  }
  return null;
}

function describeNoSlot(members, date, referenceZone, durationMinutes) {
  const window = dayWindow(date, referenceZone);
  const dayLabel = formatDayLabel(window.start, referenceZone);
  const outside = members.filter((member) => !memberWorkingIntervals(member, window.start, window.end).length);
  const next = findNextDayWithSlots(members, date, referenceZone, durationMinutes);
  const parts = [];
  if (!members.length) {
    return { reason: 'Add at least one member before Zonebuddy can find a shared slot.', nextDate: null, nextLabel: null };
  }
  if (outside.length === members.length) {
    parts.push(`Nobody on this team is inside working hours on ${dayLabel}.`);
  } else if (outside.length) {
    const names = outside.map((member) => `${member.name} (${member.timeZone})`).join(', ');
    parts.push(`No window fits every member's working hours on ${dayLabel}.`);
    parts.push(`${names} ${outside.length === 1 ? 'is' : 'are'} outside working hours for the whole day.`);
  } else {
    const longest = sharedIntervals(members, window.start, window.end);
    const longestMinutes = longest.reduce((best, [start, end]) => Math.max(best, Math.round((end - start) / 60000)), 0);
    if (longestMinutes === 0) {
      parts.push(`No window fits every member's working hours on ${dayLabel}.`);
    } else {
      parts.push(
        `The longest shared window on ${dayLabel} is ${longestMinutes} minutes — shorter than the ` +
          `${durationMinutes}-minute slot you asked for.`,
      );
    }
  }
  parts.push(next ? `The next day with a shared window is ${next.label}.` : 'Try another date or adjust working hours.');
  return { reason: parts.join(' '), nextDate: next ? next.date : null, nextLabel: next ? next.label : null };
}

function computeSuggestions(members, { date, durationMinutes, referenceZone, limit }) {
  const result = {
    date,
    durationMinutes,
    referenceZone,
    slots: [],
    reason: null,
    nextDate: null,
    nextLabel: null,
  };
  if (!members.length) {
    result.reason = 'Add at least one member before Zonebuddy can find a shared slot.';
    return result;
  }
  const window = dayWindow(date, referenceZone);
  const shared = sharedIntervals(members, window.start, window.end);
  const candidates = slotsInsideWindow(shared, referenceZone, durationMinutes);
  if (!candidates.length) {
    const detail = describeNoSlot(members, date, referenceZone, durationMinutes);
    result.reason = detail.reason;
    result.nextDate = detail.nextDate;
    result.nextLabel = detail.nextLabel;
    return result;
  }

  const scored = candidates
    .map((slot) => ({ ...slot, score: comfortScore(members, slot) }))
    .sort((a, b) => a.score - b.score || a.start - b.start);

  // Keep alternatives that start at least an hour (or the meeting length) apart,
  // so the list shows genuinely different times rather than 30-minute near-duplicates.
  const minSeparationMs = Math.min(durationMinutes, 60) * 60000;
  const picked = [];
  for (const candidate of scored) {
    if (picked.length >= limit) break;
    const tooClose = picked.some((slot) => Math.abs(candidate.start - slot.start) < minSeparationMs);
    if (!tooClose) picked.push(candidate);
  }

  result.slots = picked.map((slot, index) => ({
    rank: index + 1,
    startUtc: new Date(slot.start).toISOString(),
    endUtc: new Date(slot.end).toISOString(),
    label: `${formatDayLabel(slot.start, referenceZone)} ${minutesToHHMM(minutesOfDay(referenceZone, slot.start))}–${minutesToHHMM(
      minutesOfDay(referenceZone, slot.end),
    )}`,
    startLocal: minutesToHHMM(minutesOfDay(referenceZone, slot.start)),
    endLocal: minutesToHHMM(minutesOfDay(referenceZone, slot.end)),
    comfortMinutes: slot.score,
    members: members.map((member) => ({
      memberId: member.id,
      name: member.name,
      timeZone: member.timeZone,
      color: member.color,
      localStart: minutesToHHMM(minutesOfDay(member.timeZone, slot.start)),
      localEnd: minutesToHHMM(minutesOfDay(member.timeZone, slot.end)),
    })),
  }));
  return result;
}

/* -------------------------------------------------------------------------- */
/* JSON store (atomic write-through)                                          */
/* -------------------------------------------------------------------------- */

/** @type {{users: any[], sessions: any[], teams: any[], members: any[], shareLinks: any[]}} */
let db = { users: [], sessions: [], teams: [], members: [], shareLinks: [] };

function emptyDb() {
  return { version: 1, users: [], sessions: [], teams: [], members: [], shareLinks: [] };
}

function normalizeDb(value) {
  const base = emptyDb();
  if (!value || typeof value !== 'object') return base;
  for (const key of ['users', 'sessions', 'teams', 'members', 'shareLinks']) {
    if (Array.isArray(value[key])) base[key] = value[key];
  }
  return base;
}

function pruneExpiredSessions() {
  const now = Date.now();
  db.sessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now);
}

function saveDb() {
  pruneExpiredSessions();
  const directory = path.dirname(DB_PATH);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.db.json.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(db, null, 2);
  const handle = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(handle, payload);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, DB_PATH);
}

function loadDb() {
  const directory = path.dirname(DB_PATH);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    db = emptyDb();
    console.log(`[zonebuddy] creating store at ${DB_PATH}`);
    return;
  }
  try {
    db = normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  } catch (error) {
    const backup = `${DB_PATH}.corrupt-${Date.now()}`;
    console.error(`[zonebuddy] could not read ${DB_PATH} (${error.message}); starting fresh, previous file kept at ${backup}`);
    try {
      fs.copyFileSync(DB_PATH, backup);
    } catch (copyError) {
      console.error('[zonebuddy] could not back up the unreadable store:', copyError.message);
    }
    db = emptyDb();
  }
}

/* -------------------------------------------------------------------------- */
/* Passwords (scrypt) and sessions                                            */
/* -------------------------------------------------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  if (!expected.length) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(password).normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
  } catch (error) {
    console.error('[zonebuddy] scrypt verification failed:', error.message);
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const chunk of String(header).split(';')) {
    const index = chunk.indexOf('=');
    if (index === -1) continue;
    const name = chunk.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(chunk.slice(index + 1).trim());
  }
  return out;
}

function cookieAttributes(maxAgeSeconds) {
  const flags = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (COOKIE_SECURE) flags.push('Secure');
  return flags.join('; ');
}

function createSession(userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.sessions.push({ token, userId, expiresAt, createdAt: nowIso() });
  saveDb();
  return { token, expiresAt };
}

function sessionCookie(token, expiresAt) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes((Date.parse(expiresAt) - Date.now()) / 1000)}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

// Session states are deliberately explicit strings; there is no token parsing
// here at all — the cookie is an opaque random id looked up in the server store,
// and its expiry plus the owning user are verified on every request.
function resolveSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return { status: 'anonymous' };
  const session = db.sessions.find((entry) => entry.token === token);
  if (!session) return { status: 'anonymous' };
  if (Date.parse(session.expiresAt) <= Date.now()) return { status: 'expired', session };
  const user = db.users.find((entry) => entry.id === session.userId);
  if (!user) return { status: 'anonymous' };
  return { status: 'active', session, user };
}

function publicUser(user) {
  return { id: user.id, email: user.email, username: user.username, createdAt: user.createdAt };
}

/* -------------------------------------------------------------------------- */
/* Seed data (idempotent; also runs on the normal boot path)                   */
/* -------------------------------------------------------------------------- */

const SEED_TEAMS = [
  {
    ownerEmail: DEMO_ACCOUNT.email,
    name: 'Platform Sync',
    createdDaysAgo: 96,
    updatedHoursAgo: 2,
    members: [
      { name: 'Amara Osei', timeZone: 'America/New_York', workStart: '09:00', workEnd: '17:00', color: '#528a54' },
      { name: 'Lena Brandt', timeZone: 'Europe/Berlin', workStart: '09:00', workEnd: '17:00', color: '#0072B2' },
      { name: 'Sofia Marques', timeZone: 'Europe/Lisbon', workStart: '08:30', workEnd: '16:30', color: '#CC79A7' },
      { name: 'Mateo Rossi', timeZone: 'America/Sao_Paulo', workStart: '09:00', workEnd: '18:00', color: '#E69F00' },
    ],
  },
  {
    ownerEmail: DEMO_ACCOUNT.email,
    name: 'Design Critique',
    createdDaysAgo: 47,
    updatedHoursAgo: 30,
    members: [
      { name: 'Priya Raman', timeZone: 'Asia/Kolkata', workStart: '09:30', workEnd: '18:30', color: '#D55E00' },
      { name: 'Kenji Watanabe', timeZone: 'Asia/Tokyo', workStart: '09:00', workEnd: '18:00', color: '#009E73' },
      { name: 'Wei Chen', timeZone: 'Asia/Singapore', workStart: '09:00', workEnd: '18:00', color: '#528a54' },
    ],
  },
  {
    ownerEmail: DEMO_ACCOUNT.email,
    name: 'Customer Escalations',
    createdDaysAgo: 21,
    updatedHoursAgo: 7,
    members: [
      { name: 'Grace Kim', timeZone: 'America/Los_Angeles', workStart: '07:00', workEnd: '15:00', color: '#0072B2' },
      { name: 'Oliver Rees', timeZone: 'Europe/London', workStart: '08:00', workEnd: '16:00', color: '#D55E00' },
    ],
  },
  {
    ownerEmail: LEGACY_DEMO_ACCOUNT.email,
    name: 'Q3 Launch Squad',
    createdDaysAgo: 34,
    updatedHoursAgo: 12,
    members: [
      { name: 'Hana Sato', timeZone: 'Asia/Tokyo', workStart: '09:00', workEnd: '18:00', color: '#CC79A7' },
      { name: 'Wei Chen', timeZone: 'Asia/Singapore', workStart: '09:00', workEnd: '18:00', color: '#528a54' },
      { name: 'Daniel Weiss', timeZone: 'Europe/Berlin', workStart: '08:00', workEnd: '17:00', color: '#0072B2' },
    ],
  },
];

const DEMO_USERS = [DEMO_ACCOUNT, LEGACY_DEMO_ACCOUNT];

function ensureUser(account) {
  const email = account.email.toLowerCase();
  let user = db.users.find((entry) => entry.email === email);
  if (user) return user;
  user = {
    id: newId(),
    email,
    username: account.username,
    passwordHash: hashPassword(account.password),
    createdAt: nowIso(),
  };
  db.users.push(user);
  console.log(`[zonebuddy] seeded demo account ${email}`);
  return user;
}

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

function seedShareLink(teamId) {
  const existing = db.shareLinks.find((link) => link.teamId === teamId);
  if (existing) return existing;
  const link = { id: newId(), teamId, token: newToken(), createdAt: nowIso() };
  db.shareLinks.push(link);
  return link;
}

function seedTeam(user, spec) {
  const existing = db.teams.find((team) => team.ownerId === user.id && team.name === spec.name);
  if (existing) {
    seedShareLink(existing.id);
    return existing;
  }
  const team = {
    id: newId(),
    ownerId: user.id,
    name: spec.name,
    createdAt: hoursAgoIso(spec.createdDaysAgo * 24),
    updatedAt: hoursAgoIso(spec.updatedHoursAgo),
  };
  db.teams.push(team);
  for (const member of spec.members) {
    db.members.push({
      id: newId(),
      teamId: team.id,
      name: member.name,
      timeZone: member.timeZone,
      workStart: member.workStart,
      workEnd: member.workEnd,
      color: member.color,
      createdAt: team.createdAt,
    });
  }
  seedShareLink(team.id);
  console.log(`[zonebuddy] seeded team "${spec.name}" for ${user.email} (${spec.members.length} members)`);
  return team;
}

/** Creates demo accounts + demo teams only when they are missing. Never duplicates. */
function seedDemoData() {
  const before = db.teams.length + db.users.length + db.members.length + db.shareLinks.length;
  for (const account of DEMO_USERS) ensureUser(account);
  for (const spec of SEED_TEAMS) {
    const user = db.users.find((entry) => entry.email === spec.ownerEmail.toLowerCase());
    if (!user) continue;
    seedTeam(user, spec);
  }
  const changed = before !== db.teams.length + db.users.length + db.members.length + db.shareLinks.length;
  if (changed) saveDb();
  return changed;
}

function teamMembers(teamId) {
  return db.members.filter((member) => member.teamId === teamId);
}

function teamShareLinks(teamId) {
  return db.shareLinks.filter((link) => link.teamId === teamId);
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                              */
/* -------------------------------------------------------------------------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function fail(res, status, message, extra) {
  sendJson(res, status, { error: message, ...(extra || {}) });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('Body must be a JSON object'), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* Simple in-process throttle for credential attempts (single instance). */
const attemptBuckets = new Map();

function allowAttempt(key, limit, windowMs) {
  const now = Date.now();
  const entry = attemptBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    if (attemptBuckets.size > 2000) {
      for (const [bucketKey, bucket] of attemptBuckets) {
        if (bucket.resetAt <= now) attemptBuckets.delete(bucketKey);
      }
    }
    attemptBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) return { error: 'Enter your email address.' };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: 'Enter a valid email address, like name@team.com.' };
  return { value: email };
}

function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (!password) return { error: 'Enter your password.' };
  if (password.length < 8) return { error: 'Use at least 8 characters.' };
  if (password.length > 200) return { error: 'Use 200 characters or fewer.' };
  return { value: password };
}

function validateTeamName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { error: 'Give the team a name.' };
  if (name.length > 80) return { error: 'Keep the team name to 80 characters or fewer.' };
  return { value: name };
}

function validateMemberInput(body, options) {
  const partial = options && options.partial;
  const errors = {};
  const value = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) errors.name = 'Enter the member’s name.';
    else if (name.length > 60) errors.name = 'Keep the name to 60 characters or fewer.';
    value.name = name;
  }

  if (!partial || body.timeZone !== undefined) {
    const timeZone = typeof body.timeZone === 'string' ? body.timeZone.trim() : '';
    if (!timeZone) errors.timeZone = 'Choose a time zone.';
    else if (!TIME_ZONE_SET.has(timeZone)) errors.timeZone = 'Pick a time zone from the list, for example Europe/Berlin.';
    value.timeZone = timeZone;
  }

  for (const field of ['workStart', 'workEnd']) {
    if (partial && body[field] === undefined) continue;
    const raw = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!TIME_RE.test(raw)) {
      errors[field] = field === 'workStart' ? 'Enter a start time like 09:00.' : 'Enter an end time like 17:00.';
    } else {
      value[field] = raw;
    }
  }

  const startKnown = value.workStart || (partial ? undefined : null);
  const endKnown = value.workEnd || (partial ? undefined : null);
  if (!errors.workStart && !errors.workEnd && startKnown !== undefined && endKnown !== undefined) {
    if (startKnown && endKnown && hhmmToMinutes(endKnown) <= hhmmToMinutes(startKnown)) {
      errors.workEnd = 'The end time must be after the start time.';
    }
  }

  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) {
      errors.color = 'Pick one of the offered colors.';
    } else {
      value.color = body.color;
    }
  }

  return { errors, value, valid: Object.keys(errors).length === 0 };
}

/* -------------------------------------------------------------------------- */
/* Auth routes                                                                */
/* -------------------------------------------------------------------------- */

function authenticate(req, res) {
  const result = resolveSession(req);
  if (result.status === 'active') return result.user;
  if (result.status === 'expired') {
    res.setHeader('Set-Cookie', clearedCookie());
    db.sessions = db.sessions.filter((session) => session.token !== result.session.token);
    saveDb();
  }
  return null;
}

function findUserByIdentifier(identifier) {
  const needle = String(identifier || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    db.users.find((user) => user.email === needle) ||
    db.users.find((user) => String(user.username || '').toLowerCase() === needle) ||
    null
  );
}

async function handleSignup(req, res) {
  const body = await readJsonBody(req);
  const errors = {};
  const email = validateEmail(body.email);
  if (email.error) errors.email = email.error;
  else if (db.users.some((user) => user.email === email.value)) errors.email = 'An account with that email already exists.';

  const password = validatePassword(body.password);
  if (password.error) errors.password = password.error;

  const confirm =
    typeof body.confirmPassword === 'string' ? body.confirmPassword : typeof body.confirm === 'string' ? body.confirm : '';
  if (!confirm) errors.confirmPassword = 'Repeat your password.';
  else if (password.value !== undefined && confirm !== password.value) errors.confirmPassword = 'The passwords do not match.';

  if (Object.keys(errors).length) {
    fail(res, 400, 'Please fix the highlighted fields.', { errors });
    return;
  }

  let username = email.value.split('@')[0].replace(/[^a-z0-9._-]/g, '') || 'member';
  let suffix = 1;
  const base = username;
  while (db.users.some((user) => String(user.username || '').toLowerCase() === username.toLowerCase())) {
    suffix += 1;
    username = `${base}${suffix}`;
  }

  const user = {
    id: newId(),
    email: email.value,
    username,
    passwordHash: hashPassword(password.value),
    createdAt: nowIso(),
  };
  db.users.push(user);
  const session = createSession(user.id);
  console.log(`[zonebuddy] signup ${user.email}`);
  sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(session.token, session.expiresAt) });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const identifier = typeof body.email === 'string' ? body.email : typeof body.identifier === 'string' ? body.identifier : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!identifier.trim() || !password) {
    fail(res, 400, 'Enter your email and password.', {
      errors: {
        ...(identifier.trim() ? {} : { email: 'Enter your email address.' }),
        ...(password ? {} : { password: 'Enter your password.' }),
      },
    });
    return;
  }

  const ip = clientIp(req);
  const identityKey = `login:${identifier.trim().toLowerCase()}`;
  const ipKey = `login-ip:${ip}`;
  if (!allowAttempt(identityKey, 8, 10 * 60 * 1000) || !allowAttempt(ipKey, 40, 10 * 60 * 1000)) {
    res.setHeader('Retry-After', '600');
    fail(res, 429, 'Too many sign-in attempts. Wait a few minutes and try again.');
    return;
  }

  const user = findUserByIdentifier(identifier);
  const passwordOk = user ? verifyPassword(password, user.passwordHash) : false;
  if (!user || !passwordOk) {
    fail(res, 401, 'Email or password is incorrect.');
    return;
  }

  attemptBuckets.delete(identityKey);
  const session = createSession(user.id);
  console.log(`[zonebuddy] login ${user.email}`);
  sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(session.token, session.expiresAt) });
}

function handleLogout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) {
    db.sessions = db.sessions.filter((session) => session.token !== token);
    saveDb();
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
}

function handleMe(req, res) {
  const user = authenticate(req, res);
  if (!user) {
    fail(res, 401, 'Not signed in.');
    return;
  }
  sendJson(res, 200, { user: publicUser(user) });
}

/* -------------------------------------------------------------------------- */
/* Team payloads                                                              */
/* -------------------------------------------------------------------------- */

function publicMember(member) {
  return {
    id: member.id,
    teamId: member.teamId,
    name: member.name,
    timeZone: member.timeZone,
    workStart: member.workStart,
    workEnd: member.workEnd,
    color: member.color,
    createdAt: member.createdAt,
  };
}

function getOwnedTeam(userId, teamId) {
  return db.teams.find((team) => team.id === teamId && team.ownerId === userId) || null;
}

function weekSparkline(members, referenceZone) {
  const monday = mondayOf(dateKeyInZone(referenceZone, Date.now()));
  const days = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(monday, index);
    days.push({ date, hours: sharedHoursForDay(members, date, referenceZone) });
  }
  return { weekStart: monday, days };
}

function teamSummary(team) {
  const members = teamMembers(team.id);
  const referenceZone = members.length ? members[0].timeZone : 'UTC';
  const spark = weekSparkline(members, referenceZone);
  return {
    id: team.id,
    name: team.name,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    referenceZone,
    memberCount: members.length,
    shareLinkCount: teamShareLinks(team.id).length,
    weekStart: spark.weekStart,
    weekHours: spark.days.map((day) => day.hours),
  };
}

function teamDetail(team) {
  const members = teamMembers(team.id).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const referenceZone = members.length ? members[0].timeZone : 'UTC';
  return {
    id: team.id,
    name: team.name,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    referenceZone,
    members: members.map(publicMember),
    shareLinks: teamShareLinks(team.id).map((link) => ({
      id: link.id,
      token: link.token,
      url: `/share/${link.token}`,
      createdAt: link.createdAt,
    })),
    defaultDate: defaultPlanningDate(referenceZone),
  };
}

/* -------------------------------------------------------------------------- */
/* Query parsing                                                              */
/* -------------------------------------------------------------------------- */

function parseSuggestionsQuery(url, members) {
  const params = url.searchParams;
  const requestedZone = params.get('referenceZone');
  if (requestedZone && !TIME_ZONE_SET.has(requestedZone)) {
    return { error: 'That reference time zone is not recognised.' };
  }
  const referenceZone = requestedZone || (members.length ? members[0].timeZone : 'UTC');

  const requestedDate = params.get('date');
  if (requestedDate !== null && !isValidDateStr(requestedDate)) {
    return { error: 'Use a date in YYYY-MM-DD form.' };
  }
  const date = requestedDate || defaultPlanningDate(referenceZone);

  const requestedDuration = params.get('duration');
  let durationMinutes = 60;
  if (requestedDuration !== null) {
    durationMinutes = Number(requestedDuration);
    if (!ALLOWED_DURATIONS.includes(durationMinutes)) {
      return { error: 'Pick a meeting length of 30, 60 or 90 minutes.' };
    }
  }

  return { referenceZone, date, durationMinutes };
}

function suggestionsPayload(members, query) {
  const suggestions = computeSuggestions(members, { ...query, limit: 6 });
  const spark = weekSparkline(members, query.referenceZone);
  return {
    ...suggestions,
    weekStart: spark.weekStart,
    weekHours: spark.days.map((day) => day.hours),
  };
}

/* -------------------------------------------------------------------------- */
/* Team routes                                                                */
/* -------------------------------------------------------------------------- */

async function handleTeams(req, res, url, parts) {
  const user = authenticate(req, res);
  if (!user) {
    fail(res, 401, 'Please sign in to continue.');
    return;
  }
  const method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) {
    fail(res, 403, 'Cross-site request blocked.');
    return;
  }

  if (parts.length === 1) {
    if (method === 'GET') {
      const teams = db.teams
        .filter((team) => team.ownerId === user.id)
        .map(teamSummary)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      sendJson(res, 200, { teams });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const name = validateTeamName(body.name);
      if (name.error) {
        fail(res, 400, 'Give the team a name.', { errors: { name: name.error } });
        return;
      }
      const team = {
        id: newId(),
        ownerId: user.id,
        name: name.value,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.teams.push(team);
      saveDb();
      sendJson(res, 201, { team: teamDetail(team) });
      return;
    }
    res.setHeader('Allow', 'GET, POST');
    fail(res, 405, 'Method not allowed.');
    return;
  }

  const team = getOwnedTeam(user.id, parts[1]);
  if (!team) {
    fail(res, 404, 'Team not found.');
    return;
  }

  if (parts.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, { team: teamDetail(team) });
      return;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJsonBody(req);
      const name = validateTeamName(body.name);
      if (name.error) {
        fail(res, 400, 'Give the team a name.', { errors: { name: name.error } });
        return;
      }
      team.name = name.value;
      team.updatedAt = nowIso();
      saveDb();
      sendJson(res, 200, { team: teamDetail(team) });
      return;
    }
    if (method === 'DELETE') {
      // Cascade in a single atomic write: team + members + share links.
      db.teams = db.teams.filter((entry) => entry.id !== team.id);
      db.members = db.members.filter((entry) => entry.teamId !== team.id);
      db.shareLinks = db.shareLinks.filter((entry) => entry.teamId !== team.id);
      saveDb();
      sendJson(res, 200, { ok: true, deletedTeamId: team.id });
      return;
    }
    res.setHeader('Allow', 'GET, PATCH, DELETE');
    fail(res, 405, 'Method not allowed.');
    return;
  }

  const sub = parts[2];

  if (sub === 'members') {
    await handleMemberRoutes(req, res, team, parts);
    return;
  }

  if (sub === 'suggestions' && parts.length === 3) {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      fail(res, 405, 'Method not allowed.');
      return;
    }
    const members = teamMembers(team.id);
    const query = parseSuggestionsQuery(url, members);
    if (query.error) {
      fail(res, 400, query.error);
      return;
    }
    sendJson(res, 200, suggestionsPayload(members, query));
    return;
  }

  if (sub === 'share-links') {
    await handleShareLinkRoutes(req, res, team, parts);
    return;
  }

  fail(res, 404, 'Not found.');
}

async function handleMemberRoutes(req, res, team, parts) {
  const method = req.method;

  if (parts.length === 3) {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      fail(res, 405, 'Method not allowed.');
      return;
    }
    const body = await readJsonBody(req);
    const validation = validateMemberInput(body, { partial: false });
    if (!validation.valid) {
      fail(res, 400, 'Please fix the highlighted fields.', { errors: validation.errors });
      return;
    }
    const members = teamMembers(team.id);
    const member = {
      id: newId(),
      teamId: team.id,
      name: validation.value.name,
      timeZone: validation.value.timeZone,
      workStart: validation.value.workStart,
      workEnd: validation.value.workEnd,
      color: validation.value.color || MEMBER_COLORS[members.length % MEMBER_COLORS.length],
      createdAt: nowIso(),
    };
    db.members.push(member);
    team.updatedAt = nowIso();
    saveDb();
    sendJson(res, 201, { member: publicMember(member) });
    return;
  }

  const member = db.members.find((entry) => entry.id === parts[3] && entry.teamId === team.id);
  if (!member) {
    fail(res, 404, 'Member not found.');
    return;
  }

  if (method === 'PATCH' || method === 'PUT') {
    const body = await readJsonBody(req);
    const validation = validateMemberInput(body, { partial: true });
    if (!validation.valid) {
      fail(res, 400, 'Please fix the highlighted fields.', { errors: validation.errors });
      return;
    }
    const nextStart = validation.value.workStart !== undefined ? validation.value.workStart : member.workStart;
    const nextEnd = validation.value.workEnd !== undefined ? validation.value.workEnd : member.workEnd;
    if (hhmmToMinutes(nextEnd) <= hhmmToMinutes(nextStart)) {
      fail(res, 400, 'Please fix the highlighted fields.', {
        errors: { workEnd: 'The end time must be after the start time.' },
      });
      return;
    }
    for (const field of ['name', 'timeZone', 'workStart', 'workEnd', 'color']) {
      if (validation.value[field] !== undefined) member[field] = validation.value[field];
    }
    team.updatedAt = nowIso();
    saveDb();
    sendJson(res, 200, { member: publicMember(member) });
    return;
  }

  if (method === 'DELETE') {
    db.members = db.members.filter((entry) => entry.id !== member.id);
    team.updatedAt = nowIso();
    saveDb();
    sendJson(res, 200, { ok: true, deletedMemberId: member.id });
    return;
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  fail(res, 405, 'Method not allowed.');
}

async function handleShareLinkRoutes(req, res, team, parts) {
  const method = req.method;

  if (parts.length === 3) {
    if (method === 'GET') {
      const links = teamShareLinks(team.id).map((link) => ({
        id: link.id,
        token: link.token,
        url: `/share/${link.token}`,
        createdAt: link.createdAt,
      }));
      sendJson(res, 200, { shareLinks: links });
      return;
    }
    if (method === 'POST') {
      const link = { id: newId(), teamId: team.id, token: newToken(), createdAt: nowIso() };
      db.shareLinks.push(link);
      saveDb();
      sendJson(res, 201, { shareLink: { id: link.id, token: link.token, url: `/share/${link.token}`, createdAt: link.createdAt } });
      return;
    }
    res.setHeader('Allow', 'GET, POST');
    fail(res, 405, 'Method not allowed.');
    return;
  }

  const link = db.shareLinks.find((entry) => entry.id === parts[3] && entry.teamId === team.id);
  if (!link) {
    fail(res, 404, 'Share link not found.');
    return;
  }
  if (method === 'DELETE') {
    db.shareLinks = db.shareLinks.filter((entry) => entry.id !== link.id);
    saveDb();
    sendJson(res, 200, { ok: true, revokedLinkId: link.id });
    return;
  }
  res.setHeader('Allow', 'DELETE');
  fail(res, 405, 'Method not allowed.');
}

/* -------------------------------------------------------------------------- */
/* Public share plan                                                          */
/* -------------------------------------------------------------------------- */

function handlePublicShare(req, res, url, parts) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    fail(res, 405, 'Method not allowed.');
    return;
  }
  const token = parts[1];
  const link = token ? db.shareLinks.find((entry) => entry.token === token) : null;
  if (!link) {
    fail(res, 404, 'This plan link is no longer available. Ask the team owner for a new one.');
    return;
  }
  const team = db.teams.find((entry) => entry.id === link.teamId);
  if (!team) {
    db.shareLinks = db.shareLinks.filter((entry) => entry.id !== link.id);
    saveDb();
    fail(res, 404, 'This plan link is no longer available. Ask the team owner for a new one.');
    return;
  }

  const members = teamMembers(team.id).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const query = parseSuggestionsQuery(url, members);
  if (query.error) {
    fail(res, 400, query.error);
    return;
  }

  const suggestions = computeSuggestions(members, { ...query, limit: 6 });
  const spark = weekSparkline(members, query.referenceZone);
  sendJson(res, 200, {
    team: { name: team.name, updatedAt: team.updatedAt },
    members: members.map(publicMember),
    suggestions,
    referenceZone: query.referenceZone,
    defaultDate: defaultPlanningDate(query.referenceZone),
    weekStart: spark.weekStart,
    weekHours: spark.days.map((day) => day.hours),
    timeZones: TIME_ZONES,
    sharedAt: nowIso(),
  });
}

/* -------------------------------------------------------------------------- */
/* API dispatch                                                               */
/* -------------------------------------------------------------------------- */

async function routeApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  parts.shift(); // drop the leading "api" segment
  const method = req.method;
  const resource = parts[0];

  if (resource === 'auth') {
    if (parts[1] === 'signup' && method === 'POST') return handleSignup(req, res);
    if (parts[1] === 'login' && method === 'POST') return handleLogin(req, res);
    if (parts[1] === 'logout' && method === 'POST') return handleLogout(req, res);
    if (parts[1] === 'me' && method === 'GET') return handleMe(req, res);
    fail(res, 404, 'Not found.');
    return;
  }

  if (resource === 'timezones') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      fail(res, 405, 'Method not allowed.');
      return;
    }
    const user = authenticate(req, res);
    if (!user) {
      fail(res, 401, 'Please sign in to continue.');
      return;
    }
    sendJson(res, 200, { timeZones: TIME_ZONES });
    return;
  }

  if (resource === 'teams') {
    await handleTeams(req, res, url, parts);
    return;
  }

  if (resource === 'share' && parts.length === 2) {
    handlePublicShare(req, res, url, parts);
    return;
  }

  fail(res, 404, 'Not found.');
}

/* -------------------------------------------------------------------------- */
/* Static assets and the SPA shell                                            */
/* -------------------------------------------------------------------------- */

const STATIC_ASSETS = new Map([
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/fonts/manrope-latin.woff2', { file: 'fonts/manrope-latin.woff2', type: 'font/woff2' }],
  ['/fonts/manrope-latin-ext.woff2', { file: 'fonts/manrope-latin-ext.woff2', type: 'font/woff2' }],
]);

function serveAsset(res, pathname) {
  const asset = STATIC_ASSETS.get(pathname);
  const absolutePath = path.join(PUBLIC_DIR, asset.file);
  let body;
  try {
    body = fs.readFileSync(absolutePath);
  } catch (error) {
    console.error(`[zonebuddy] missing asset ${pathname}:`, error.message);
    sendText(res, 404, 'Asset not found.');
    return;
  }
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': body.length,
    'Cache-Control': pathname.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  });
  res.end(body);
}

function serveShell(res, status) {
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
  } catch (error) {
    console.error('[zonebuddy] could not read the SPA shell:', error.message);
    sendText(res, 500, 'The app shell could not be loaded.');
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function isShellPath(pathname) {
  if (pathname === '/login' || pathname === '/signup' || pathname === '/app') return true;
  if (pathname.startsWith('/app/')) return true;
  if (pathname.startsWith('/share/')) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Request pipeline                                                           */
/* -------------------------------------------------------------------------- */

async function handleRequest(req, res) {
  applySecurityHeaders(res);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad request.');
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/health') {
    sendText(res, 200, 'ok');
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      fail(res, 403, 'Cross-site request blocked.');
      return;
    }
    await routeApi(req, res, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    fail(res, 405, 'Method not allowed.');
    return;
  }

  if (STATIC_ASSETS.has(pathname)) {
    serveAsset(res, pathname);
    return;
  }

  if (pathname === '/') {
    const session = resolveSession(req);
    redirect(res, session.status === 'active' ? '/app' : '/login');
    return;
  }

  // Authenticated shell routes: send signed-out visitors to the login page with
  // the originally requested path, so they land back where they were heading.
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    const session = resolveSession(req);
    if (session.status === 'expired') {
      db.sessions = db.sessions.filter((entry) => entry.token !== session.session.token);
      saveDb();
      res.setHeader('Set-Cookie', clearedCookie());
    }
    if (session.status !== 'active') {
      redirect(res, `/login?next=${encodeURIComponent(pathname + url.search)}`);
      return;
    }
  }

  if (isShellPath(pathname)) {
    serveShell(res, 200);
    return;
  }

  // Unknown route: the SPA renders its own not-found view inside the app shell.
  serveShell(res, 404);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(`[zonebuddy] request failed ${req.method} ${req.url}:`, error);
    if (!res.writableEnded && !res.headersSent) {
      fail(res, 500, 'Something went wrong on our side. Please try again.');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function start() {
  loadDb();
  seedDemoData();
  saveDb();

  // `node main.js --seed` creates the store and demo data, then exits without
  // binding a port (used by install/seed phases and by `npm run seed`).
  if (process.argv.includes('--seed')) {
    console.log(
      `[zonebuddy] seed complete: ${db.users.length} users, ${db.teams.length} teams, ` +
        `${db.members.length} members, ${db.shareLinks.length} share links -> ${DB_PATH}`,
    );
    return;
  }

  server.listen(PORT, HOST, () => {
    console.log(`[zonebuddy] store: ${DB_PATH}`);
    console.log(`[zonebuddy] listening on http://${HOST}:${PORT}`);
  });
  server.on('error', (error) => {
    console.error('[zonebuddy] server error:', error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[zonebuddy] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

start();
