// ── Cha Nails & Spa — Google Apps Script Backend ──
//
// Sheet column layout (row 1 = header):
//   A (0) Phone | B (1) First | C (2) Last | D (3) Date | E (4) Technician
//   F (5) Time | G (6) Services | H (7) Submitted At
//
// Deploy: Extensions → Apps Script → Deploy → Manage deployments → new version
//   Execute as: Me | Who has access: Anyone

const SHEET_ID   = '1WnatJY-KwF-e0bW1i1wK61KNWfqN4hqGb3eObT8ONjQ';
const SHEET_NAME = 'Sheet1';

// ── Entry points ─────────────────────────────────────────────────────────────

function doGet(e) {
  // Apps Script web apps automatically include Access-Control-Allow-Origin: *
  // for GET requests when deployed as "Execute as: Me / Anyone can access".
  const action = e.parameter.action;
  if (action === 'lookup')       return lookupPhone(e.parameter.phone);
  if (action === 'availability') return checkAvailability(e.parameter.technician, e.parameter.date, e.parameter.services);
  if (action === 'book')         return bookAppointment(e.parameter);
  if (action === 'debug')        return debugInfo(e.parameter.technician, e.parameter.date);
  return json({ error: 'Unknown action' });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// GET ?action=lookup&phone=7135551234
// Returns { found, firstName, lastName } — most recent row for that phone
function lookupPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return json({ found: false });

  const rows  = getRows();
  let match   = null;
  for (const row of rows) {
    if (String(row[0]).replace(/\D/g, '') === clean) match = row;
  }

  if (match) return json({ found: true, firstName: match[1], lastName: match[2] });
  return json({ found: false });
}

// GET ?action=availability&technician=Tech%2C%20Tech&date=2026-04-01&services=Pedicure+45min
// Returns { unavailableSlots: [...] } — start times where the new booking
// (given its duration) would overlap any existing booking.
// When multiple techs selected, a slot is only blocked if ALL are unavailable.
function checkAvailability(technician, date, services) {
  if (!technician || !date) return json({ unavailableSlots: [] });

  const rows  = getRows();
  const techs = technician.split(',').map(function(t) { return t.trim(); });

  function unavailableStarts(tech) {
    const existing = getUnavailableSlots(tech, date, rows);
    // A start time is unavailable if any slot the new booking would occupy is taken.
    return new Set(allTimeSlots().filter(function(slot) {
      return getBlockedSlots(slot, services || '').some(function(s) { return existing.has(s); });
    }));
  }

  if (techs.length === 1) {
    return json({ unavailableSlots: [...unavailableStarts(techs[0])] });
  }

  // Multi-tech: only block a slot when ALL selected techs are unavailable.
  const setsPerTech = techs.map(unavailableStarts);
  const unavailable = allTimeSlots().filter(function(slot) {
    return setsPerTech.every(function(s) { return s.has(slot); });
  });
  return json({ unavailableSlots: unavailable });
}

// GET ?action=book&phone=&firstName=&lastName=&date=&technician=&time=&services=
// Checks for conflicts (using duration-aware blocking), then writes one row.
function bookAppointment(params) {
  const phone      = params.phone      || '';
  const firstName  = params.firstName  || '';
  const lastName   = params.lastName   || '';
  const date       = params.date       || '';
  const technician = params.technician || 'Any Tech';
  const time       = params.time       || '';
  const services   = params.services   || '';

  const rows  = getRows();
  const techs = technician.split(',').map(function(t) { return t.trim(); });

  // A tech is "booked" if any slot the new booking would occupy is already taken.
  const newBookingSlots = getBlockedSlots(time, services);
  const bookedTechs = techs.filter(function(t) {
    const unavail = getUnavailableSlots(t, date, rows);
    return newBookingSlots.some(function(slot) { return unavail.has(slot); });
  });
  const freeTechs = techs.filter(function(t) { return bookedTechs.indexOf(t) === -1; });

  if (bookedTechs.length > 0 && freeTechs.length > 0) {
    // Some techs booked, some free → partial conflict.
    const next = findNextAvailable(bookedTechs[0], date, time, rows, services);
    const bookedStr = bookedTechs.join(' and ');
    const freeStr   = freeTechs.join(' and ');
    return json({
      success:         false,
      partialConflict: true,
      bookedTechs:     bookedTechs,
      freeTechs:       freeTechs,
      nextAvailable:   next,
      error:           bookedStr + ' is not available at ' + time + '. ' + freeStr + ' can see you at that time.',
    });
  }

  if (bookedTechs.length === techs.length) {
    // All selected techs are booked → full conflict.
    const next = findNextAvailable(technician, date, time, rows, services);
    return json({
      success:       false,
      conflict:      true,
      nextAvailable: next,
      error:         technician + ' is not available at ' + time + '.',
    });
  }

  const sheet = getSheet();
  ensureHeader(sheet);
  sheet.appendRow([phone, firstName, lastName, date, technician, time, services, new Date().toISOString()]);
  return json({ success: true });
}

// ── Duration-aware slot blocking ──────────────────────────────────────────────

// Returns a Set of all time strings that are unavailable for technician+date,
// accounting for service duration + 15-min grace period on each booking.
function getUnavailableSlots(technician, date, rows) {
  const isAny      = technician === 'Any Tech';
  const unavailable = new Set();

  for (const row of rows) {
    // getRows() uses getDisplayValues() — these are always plain strings.
    if (row[3] !== date) continue;
    const rowTechs = row[4].split(',').map(function(t) { return t.trim(); });
    if (!isAny && !rowTechs.includes('Any Tech') && !rowTechs.includes(technician)) continue;

    const blocked = getBlockedSlots(row[5], row[6]);
    blocked.forEach(function(s) { unavailable.add(s); });
  }

  return unavailable;
}

// Returns all 15-min slots occupied by a booking:
// from start time up to (but not including) start + duration + 15-min grace.
function getBlockedSlots(startTime, servicesStr) {
  const totalMin  = parseTotalDuration(servicesStr) + 15;
  const startMin  = timeToMinutes(startTime);
  const blocked   = [];

  for (const slot of allTimeSlots()) {
    const slotMin = timeToMinutes(slot);
    if (slotMin >= startMin && slotMin < startMin + totalMin) {
      blocked.push(slot);
    }
  }

  return blocked;
}

// Parses "Full Set 45min, Pedicure 45min" → 90
function parseTotalDuration(servicesStr) {
  const matches = String(servicesStr).match(/(\d+)min/g) || [];
  const total   = matches.reduce((sum, m) => sum + parseInt(m, 10), 0);
  return total > 0 ? total : 15;
}

// ── Next-available helper ─────────────────────────────────────────────────────

function findNextAvailable(technician, date, requestedTime, rows, services) {
  const unavailable = getUnavailableSlots(technician, date, rows);
  const reqMin      = timeToMinutes(requestedTime);

  for (const slot of allTimeSlots()) {
    if (timeToMinutes(slot) <= reqMin) continue;
    // Check that the entire new booking duration fits without overlap.
    const newSlots = getBlockedSlots(slot, services || '');
    if (newSlots.every(function(s) { return !unavailable.has(s); })) return slot;
  }

  return null;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function allTimeSlots() {
  const slots = [];
  for (let h = 9; h <= 21; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === 21 && m > 0) break;
      const ampm = h < 12 ? 'AM' : 'PM';
      const hour = h % 12 === 0 ? 12 : h % 12;
      const min  = m === 0 ? '00' : String(m);
      slots.push(hour + ':' + min + ' ' + ampm);
    }
  }
  return slots;
}

function timeToMinutes(timeVal) {
  // getRows() uses getDisplayValues(), so timeVal is always a string like "9:00 AM".
  try {
    const parts = String(timeVal).split(' ');
    const ampm  = parts[1];
    const hm    = parts[0].split(':');
    let   h     = parseInt(hm[0], 10);
    const m     = parseInt(hm[1], 10);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  } catch (_) { return -1; }
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME)
      || SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
}

function getRows() {
  const sheet = getSheet();
  const range = sheet.getDataRange();
  if (range.getLastRow() < 2) return [];
  // Use getDisplayValues() so date/time cells come back as the strings
  // shown in the sheet ("2026-03-30", "9:00 AM") rather than Date objects,
  // eliminating timezone-shift bugs entirely.
  const rows = range.getDisplayValues();
  return rows.slice(1).filter(function(r) {
    return r[0] !== '' && r[0].toLowerCase() !== 'phone';
  });
}

function ensureHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Phone','First Name','Last Name','Date','Technician','Time','Services','Submitted At']);
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Debug endpoint ────────────────────────────────────────────────────────────
// GET ?action=debug&technician=Tech&date=2026-03-30
function debugInfo(technician, date) {
  const rows = getRows();
  const rowsData = rows.map(function(r) {
    const rawDate = r[3];
    const rawTime = r[5];
    const fmtDate = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(rawDate);
    return {
      phone:    String(r[0]),
      rawDate:  String(rawDate),
      dateType: rawDate instanceof Date ? 'Date' : typeof rawDate,
      fmtDate:  fmtDate,
      tech:     String(r[4]),
      rawTime:  String(rawTime),
      timeType: rawTime instanceof Date ? 'Date' : typeof rawTime,
      services: String(r[6]),
    };
  });

  let unavailable = [];
  if (technician && date) {
    const slots = getUnavailableSlots(technician, date, rows);
    unavailable = [...slots];
  }

  return json({ tz: Session.getScriptTimeZone(), rows: rowsData, unavailable: unavailable });
}
