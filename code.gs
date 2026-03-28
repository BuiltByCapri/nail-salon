// ============================================================
// SALON NAME — Google Apps Script Booking Backend
// ============================================================
// SETUP:
// 1. Create a Google Sheet — paste its ID below as SHEET_ID
// 2. Deploy: Extensions → Apps Script → Deploy → New deployment
//    - Type: Web App | Execute as: Me | Who has access: Anyone
// 3. Paste the deployment URL into index.html and checkin.html as SCRIPT_URL
// 4. To update after code changes: Deploy → Manage deployments →
//    pencil → Version: New version → Deploy (URL stays the same)
// ============================================================

// ============================================================
// CUSTOMIZE THESE VALUES PER CLIENT
// ============================================================
const SHEET_ID        = '1WnatJY-KwF-e0bW1i1wK61KNWfqN4hqGb3eObT8ONjQ';
const SHEET_NAME      = 'Sheet1';
const SALON_NAME      = 'Salon Name';
const SALON_PHONE     = '(XXX) XXX-XXXX';
const CARRIER_GATEWAY = '@txt.att.net'; // Change per carrier:
// AT&T:        @txt.att.net
// T-Mobile:    @tmomail.net
// Verizon:     @vtext.com
// Sprint:      @messaging.sprintpcs.com
// US Cellular: @email.uscc.net
// Comcast:     @comcastpcs.textmsg.com

// ── REWARDS CONFIG ───────────────────────────────────────────
const SERVICE_POINTS = {
  'Pedicure':      10,
  'Manicure':      10,
  'Gel Manicure':  15,
  'Full Set':      10,
  'Fill-In':       10,
  'Color Dipping': 15,
  'Wax':           10,
  'Polish Change': 10,
  'Repair':        5,
  'Other':         10,
};
const DEFAULT_POINTS       = 10;
const FREE_PEDICURE_POINTS = 125;
// ============================================================

// Sheet tabs
const APPT_TAB     = 'Appointments';
const CUSTOMER_TAB = 'Customers';

// Appointments columns:
//   A(0) Phone | B(1) First | C(2) Last | D(3) Date | E(4) Technician
//   F(5) Time | G(6) Services | H(7) Email | I(8) Points Preview
//   J(9) Submitted At | K(10) Status

// Customers columns:
//   A(0) Phone | B(1) First | C(2) Last | D(3) Email
//   E(4) Total Points | F(5) Total Visits | G(6) Last Visit

// ── Entry points ──────────────────────────────────────────────────────────────

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'lookup')       return lookupPhone(e.parameter.phone);
  if (action === 'availability') return checkAvailability(e.parameter.technician, e.parameter.date, e.parameter.services, e.parameter.multiTech);
  if (action === 'book')         return bookAppointment(e.parameter);
  if (action === 'checkin')      return checkInCustomer(e.parameter.phone);
  if (action === 'walkin')       return recordWalkIn(e.parameter);
  if (action === 'waittime')     return getWaitTime(e.parameter.services);
  if (action === 'debug')        return debugInfo(e.parameter.technician, e.parameter.date);
  return json({ error: 'Unknown action' });
}

// ── Lookup ────────────────────────────────────────────────────────────────────

// GET ?action=lookup&phone=7135551234
// Returns { found, firstName, lastName, email, points, pointsToFree, freeReward }
function lookupPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return json({ found: false });

  const sheet = getSheet(CUSTOMER_TAB);
  const rows  = sheet.getDataRange().getDisplayValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).replace(/\D/g, '') === clean) {
      const points       = parseInt(rows[i][4], 10) || 0;
      const pointsToFree = Math.max(0, FREE_PEDICURE_POINTS - points);
      return json({
        found:        true,
        firstName:    rows[i][1],
        lastName:     rows[i][2],
        email:        rows[i][3],
        points:       points,
        pointsToFree: pointsToFree,
        freeReward:   points >= FREE_PEDICURE_POINTS,
      });
    }
  }

  return json({ found: false });
}

// ── Availability ──────────────────────────────────────────────────────────────

// GET ?action=availability&technician=Tech1,Tech2&date=2026-04-01
//     &services=Pedicure 45min,Manicure 30min&multiTech=true
//
// multiTech=true  → group booking: block by MAX service duration (simultaneous)
// multiTech=false → solo booking:  block by SUM of service durations (sequential)
function checkAvailability(technician, date, services, multiTech) {
  if (!technician || !date) return json({ unavailableSlots: [] });

  const rows    = getApptRows();
  const techs   = technician.split(',').map(function(t) { return t.trim(); });
  const isMulti = multiTech === 'true';

  function unavailableStarts(tech) {
    const existing = getUnavailableSlots(tech, date, rows);
    return new Set(allTimeSlots().filter(function(slot) {
      const blocked = isMulti
        ? getBlockedSlotsMax(slot, services || '')
        : getBlockedSlotsSum(slot, services || '');
      return blocked.some(function(s) { return existing.has(s); });
    }));
  }

  if (techs.length === 1) {
    return json({ unavailableSlots: [...unavailableStarts(techs[0])] });
  }

  // Multi-tech: slot only blocked when ALL selected techs are unavailable
  const setsPerTech = techs.map(unavailableStarts);
  const unavailable = allTimeSlots().filter(function(slot) {
    return setsPerTech.every(function(s) { return s.has(slot); });
  });
  return json({ unavailableSlots: unavailable });
}

// ── Book ──────────────────────────────────────────────────────────────────────

// GET ?action=book&phone=&firstName=&lastName=&email=&date=
//     &technician=&time=&services=&multiTech=true
//
// Points are NOT awarded here — they are awarded at check-in.
// Returns pointsPreview so the frontend can show "X points will be added at check-in."
function bookAppointment(params) {
  const phone      = params.phone      || '';
  const firstName  = params.firstName  || '';
  const lastName   = params.lastName   || '';
  const email      = params.email      || '';
  const date       = params.date       || '';
  const technician = params.technician || 'Any Tech';
  const time       = params.time       || '';
  const services   = params.services   || '';
  const isMulti    = params.multiTech  === 'true';

  const rows  = getApptRows();
  const techs = technician.split(',').map(function(t) { return t.trim(); });

  const newBookingSlots = isMulti
    ? getBlockedSlotsMax(time, services)
    : getBlockedSlotsSum(time, services);

  const bookedTechs = techs.filter(function(t) {
    const unavail = getUnavailableSlots(t, date, rows);
    return newBookingSlots.some(function(slot) { return unavail.has(slot); });
  });
  const freeTechs = techs.filter(function(t) { return bookedTechs.indexOf(t) === -1; });

  if (bookedTechs.length > 0 && freeTechs.length > 0) {
    const next = findNextAvailable(bookedTechs[0], date, time, rows, services, isMulti);
    return json({
      success:         false,
      partialConflict: true,
      bookedTechs:     bookedTechs,
      freeTechs:       freeTechs,
      nextAvailable:   next,
      error:           bookedTechs.join(' and ') + ' is not available at ' + time + '. ' + freeTechs.join(' and ') + ' can see you at that time.',
    });
  }

  if (bookedTechs.length === techs.length) {
    const next = findNextAvailable(technician, date, time, rows, services, isMulti);
    return json({
      success:       false,
      conflict:      true,
      nextAvailable: next,
      error:         technician + ' is not available at ' + time + '.',
    });
  }

  // Preview points (awarded at check-in, not now)
  const pointsPreview = calcPoints(services);

  // Write appointment with status 'pending'
  const apptSheet = getSheet(APPT_TAB);
  ensureApptHeader(apptSheet);
  apptSheet.appendRow([
    phone, firstName, lastName, date, technician,
    time, services, email, pointsPreview, new Date().toISOString(), 'pending'
  ]);

  // Upsert customer record (no points yet — just make sure they exist)
  upsertCustomerNoPoints(phone, firstName, lastName, email);

  // Send confirmation email + SMS
  sendConfirmation(email, phone, firstName, date, time, technician, services, pointsPreview);

  // Schedule reminder
  scheduleReminder(email, phone, firstName, date, time, technician);

  return json({ success: true, pointsPreview: pointsPreview });
}

// ── Check In ──────────────────────────────────────────────────────────────────

// GET ?action=checkin&phone=7135551234
// Finds today's appointment, marks it checked in, awards points.
// Returns confirmation data including updated points balance.
function checkInCustomer(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return json({ found: false });

  const today     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const apptSheet = getSheet(APPT_TAB);
  const rows      = apptSheet.getDataRange().getDisplayValues();

  for (let i = 1; i < rows.length; i++) {
    const rowPhone = String(rows[i][0]).replace(/\D/g, '');
    const rowDate  = String(rows[i][3]).trim();
    const status   = String(rows[i][10] || '').trim().toLowerCase();

    if (rowPhone !== clean) continue;
    if (rowDate  !== today) continue;

    // Already checked in
    if (status === 'checked in') {
      return json({
        found:            true,
        alreadyCheckedIn: true,
        firstName:        rows[i][1],
      });
    }

    // Mark checked in
    ensureStatusColumn(apptSheet);
    apptSheet.getRange(i + 1, 11).setValue('checked in');

    // Award points now
    const services     = String(rows[i][6]);
    const pointsEarned = calcPoints(services);
    const firstName    = rows[i][1];
    const lastName     = rows[i][2];
    const email        = rows[i][7];
    const technician   = rows[i][4];
    const time         = rows[i][5];

    const newTotal     = upsertCustomer(clean, firstName, lastName, email, pointsEarned, today);
    const pointsToFree = Math.max(0, FREE_PEDICURE_POINTS - newTotal);

    return json({
      found:            true,
      alreadyCheckedIn: false,
      firstName:        firstName,
      lastName:         lastName,
      services:         services,
      technician:       technician,
      time:             time,
      pointsEarned:     pointsEarned,
      totalPoints:      newTotal,
      pointsToFree:     pointsToFree,
      freeReward:       newTotal >= FREE_PEDICURE_POINTS,
    });
  }

  return json({ found: false });
}

// ── Walk-In ───────────────────────────────────────────────────────────────────

// GET ?action=walkin&phone=&services=&technician=
// Records the walk-in row, awards half points, and returns wait time.
function recordWalkIn(params) {
  const phone      = String(params.phone      || '').replace(/\D/g, '');
  const services   = params.services   || '';
  const technician = params.technician || 'Any Tech';

  const tz    = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const now   = Utilities.formatDate(new Date(), tz, 'h:mm a');

  const pointsEarned = calcWalkInPoints(services);

  // Write appointment row with status 'walk-in'
  const apptSheet = getSheet(APPT_TAB);
  ensureApptHeader(apptSheet);
  apptSheet.appendRow([
    phone, '', '', today, technician,
    now, services, '', pointsEarned, new Date().toISOString(), 'walk-in'
  ]);

  // Award points — upsert customer record by phone
  const newTotal = upsertCustomer(phone, '', '', '', pointsEarned, today);

  // Count currently checked-in appointments for wait estimate
  const rows = apptSheet.getDataRange().getDisplayValues();
  let checkedInCount = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][3]).trim() === today &&
        String(rows[i][10] || '').trim().toLowerCase() === 'checked in') {
      checkedInCount++;
    }
  }

  return json({
    success:              true,
    pointsEarned:         pointsEarned,
    totalPoints:          newTotal,
    checkedInCount:       checkedInCount,
    estimatedWaitMinutes: checkedInCount * 30,
  });
}

// ── Wait Time ─────────────────────────────────────────────────────────────────

// GET ?action=waittime&services=Pedicure,Manicure
// Counts appointments with status 'checked in' today; estimates wait.
// Also returns walk-in points preview for the selected services.
function getWaitTime(services) {
  const today     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const apptSheet = getSheet(APPT_TAB);
  const rows      = apptSheet.getDataRange().getDisplayValues();
  let count = 0;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][3]).trim() === today &&
        String(rows[i][10] || '').trim().toLowerCase() === 'checked in') {
      count++;
    }
  }

  return json({
    checkedInCount:        count,
    estimatedWaitMinutes:  count * 30,
    pointsPreview:         calcWalkInPoints(services || ''),
  });
}

// ── Time blocking ─────────────────────────────────────────────────────────────

// SOLO booking: block sum of all service durations + 15 grace
function getBlockedSlotsSum(startTime, servicesStr) {
  const totalMin = parseTotalDurationSum(servicesStr) + 15;
  return slotsFromStart(startTime, totalMin);
}

// GROUP booking (multiTech): block max single service duration + 15 grace
function getBlockedSlotsMax(startTime, servicesStr) {
  const totalMin = parseTotalDurationMax(servicesStr) + 15;
  return slotsFromStart(startTime, totalMin);
}

function slotsFromStart(startTime, totalMin) {
  const startMin = timeToMinutes(startTime);
  const blocked  = [];
  for (const slot of allTimeSlots()) {
    const slotMin = timeToMinutes(slot);
    if (slotMin >= startMin && slotMin < startMin + totalMin) blocked.push(slot);
  }
  return blocked;
}

// Sum of all durations: "Pedicure 45min, Manicure 30min" → 75
function parseTotalDurationSum(servicesStr) {
  const matches = String(servicesStr).match(/(\d+)min/g) || [];
  const total   = matches.reduce(function(s, m) { return s + parseInt(m, 10); }, 0);
  return total > 0 ? total : 15;
}

// Max single duration: "Pedicure 45min, Manicure 30min" → 45
function parseTotalDurationMax(servicesStr) {
  const matches = String(servicesStr).match(/(\d+)min/g) || [];
  if (!matches.length) return 15;
  return Math.max.apply(null, matches.map(function(m) { return parseInt(m, 10); }));
}

// ── Unavailable slots ─────────────────────────────────────────────────────────

function getUnavailableSlots(technician, date, rows) {
  const isAny       = technician === 'Any Tech';
  const unavailable = new Set();

  for (const row of rows) {
    if (row[3] !== date) continue;
    const rowTechs = row[4].split(',').map(function(t) { return t.trim(); });
    if (!isAny && !rowTechs.includes('Any Tech') && !rowTechs.includes(technician)) continue;
    getBlockedSlotsSum(row[5], row[6]).forEach(function(s) { unavailable.add(s); });
  }

  return unavailable;
}

// ── Next available ────────────────────────────────────────────────────────────

function findNextAvailable(technician, date, requestedTime, rows, services, isMulti) {
  const unavailable = getUnavailableSlots(technician, date, rows);
  const reqMin      = timeToMinutes(requestedTime);

  for (const slot of allTimeSlots()) {
    if (timeToMinutes(slot) <= reqMin) continue;
    const newSlots = isMulti
      ? getBlockedSlotsMax(slot, services || '')
      : getBlockedSlotsSum(slot, services || '');
    if (newSlots.every(function(s) { return !unavailable.has(s); })) return slot;
  }

  return null;
}

// ── Rewards ───────────────────────────────────────────────────────────────────

function calcPoints(servicesStr) {
  let total = 0;
  for (const name of Object.keys(SERVICE_POINTS)) {
    if (servicesStr.indexOf(name) !== -1) total += SERVICE_POINTS[name];
  }
  return total > 0 ? total : DEFAULT_POINTS;
}

// Walk-in points — half of standard values
const WALKIN_POINTS = {
  'Pedicure':      5,
  'Manicure':      5,
  'Gel Manicure':  8,
  'Full Set':      5,
  'Fill-In':       5,
  'Color Dipping': 8,
  'Wax':           5,
  'Polish Change': 5,
  'Repair':        3,
  'Other':         5,
};
const DEFAULT_WALKIN_POINTS = 5;

function calcWalkInPoints(servicesStr) {
  let total = 0;
  for (const name of Object.keys(WALKIN_POINTS)) {
    if (servicesStr.indexOf(name) !== -1) total += WALKIN_POINTS[name];
  }
  return total > 0 ? total : DEFAULT_WALKIN_POINTS;
}

// Full upsert — awards points (used at check-in)
function upsertCustomer(phone, firstName, lastName, email, pointsEarned, visitDate) {
  const sheet = getSheet(CUSTOMER_TAB);
  ensureCustomerHeader(sheet);
  const rows  = sheet.getDataRange().getDisplayValues();
  const clean = String(phone).replace(/\D/g, '');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).replace(/\D/g, '') === clean) {
      const newPoints = (parseInt(rows[i][4], 10) || 0) + pointsEarned;
      const newVisits = (parseInt(rows[i][5], 10) || 0) + 1;
      sheet.getRange(i + 1, 2).setValue(firstName);
      sheet.getRange(i + 1, 3).setValue(lastName);
      if (email) sheet.getRange(i + 1, 4).setValue(email);
      sheet.getRange(i + 1, 5).setValue(newPoints);
      sheet.getRange(i + 1, 6).setValue(newVisits);
      sheet.getRange(i + 1, 7).setValue(visitDate);
      return newPoints;
    }
  }

  sheet.appendRow([clean, firstName, lastName, email, pointsEarned, 1, visitDate]);
  return pointsEarned;
}

// Lightweight upsert — no points, just ensures customer record exists (used at booking)
function upsertCustomerNoPoints(phone, firstName, lastName, email) {
  const sheet = getSheet(CUSTOMER_TAB);
  ensureCustomerHeader(sheet);
  const rows  = sheet.getDataRange().getDisplayValues();
  const clean = String(phone).replace(/\D/g, '');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).replace(/\D/g, '') === clean) {
      sheet.getRange(i + 1, 2).setValue(firstName);
      sheet.getRange(i + 1, 3).setValue(lastName);
      if (email) sheet.getRange(i + 1, 4).setValue(email);
      return;
    }
  }

  // New customer — 0 points until first check-in
  sheet.appendRow([clean, firstName, lastName, email, 0, 0, '']);
}

// ── Notifications ─────────────────────────────────────────────────────────────

function sendConfirmation(email, phone, firstName, date, time, technician, services, pointsPreview) {
  const subject = 'Your appointment at ' + SALON_NAME + ' is confirmed!';
  const body    = 'Hi ' + firstName + ',\n\n'
    + 'Your appointment is confirmed:\n'
    + '  Date: '       + formatDate(date) + '\n'
    + '  Time: '       + time + '\n'
    + '  Technician: ' + technician + '\n'
    + '  Services: '   + services + '\n\n'
    + pointsPreview + ' reward points will be added to your account when you check in.\n'
    + '\nQuestions? Call us at ' + SALON_PHONE + '.\n\nSee you soon!\n' + SALON_NAME;

  if (email) {
    try { GmailApp.sendEmail(email, subject, body); } catch(e) {}
  }

  if (phone) {
    const smsAddress = String(phone).replace(/\D/g, '') + CARRIER_GATEWAY;
    const smsBody    = SALON_NAME + ': Confirmed ' + formatDate(date) + ' at ' + time
      + ' with ' + technician + '. Check in when you arrive to earn '
      + pointsPreview + ' points! ' + SALON_PHONE;
    try { GmailApp.sendEmail(smsAddress, '', smsBody); } catch(e) {}
  }
}

function scheduleReminder(email, phone, firstName, date, time, technician) {
  const sheet = getSheet('Reminders');
  ensureReminderHeader(sheet);
  sheet.appendRow([date, time, firstName, email, phone, technician, 'pending']);
}

// ── Daily reminder trigger ────────────────────────────────────────────────────
// Set up: Apps Script → Triggers → Add trigger
//   Function: sendDailyReminders | Time-driven → Day timer

function sendDailyReminders() {
  const sheet    = getSheet('Reminders');
  const rows     = sheet.getDataRange().getDisplayValues();
  const tomorrow = getTomorrowDate();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== tomorrow) continue;
    if (rows[i][6] === 'sent')   continue;

    const firstName  = rows[i][2];
    const email      = rows[i][3];
    const phone      = rows[i][4];
    const time       = rows[i][1];
    const technician = rows[i][5];

    const subject = 'Reminder: Your appointment tomorrow at ' + SALON_NAME;
    const body    = 'Hi ' + firstName + ',\n\nReminder — you have an appointment tomorrow:\n'
      + '  Date: '       + formatDate(tomorrow) + '\n'
      + '  Time: '       + time + '\n'
      + '  Technician: ' + technician + '\n\n'
      + 'Need to reschedule? Call us at ' + SALON_PHONE + '.\n\nSee you soon!\n' + SALON_NAME;

    if (email) { try { GmailApp.sendEmail(email, subject, body); } catch(e) {} }
    if (phone) {
      const smsAddress = String(phone).replace(/\D/g, '') + CARRIER_GATEWAY;
      const smsBody    = SALON_NAME + ' reminder: Tomorrow ' + time + ' with ' + technician + '. Questions? ' + SALON_PHONE;
      try { GmailApp.sendEmail(smsAddress, '', smsBody); } catch(e) {}
    }

    sheet.getRange(i + 1, 7).setValue('sent');
  }
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

function formatDate(dateStr) {
  try {
    const [y, m, d] = dateStr.split('-');
    const months = ['January','February','March','April','May','June','July',
                    'August','September','October','November','December'];
    return months[parseInt(m, 10) - 1] + ' ' + parseInt(d, 10) + ', ' + y;
  } catch (_) { return dateStr; }
}

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function getSheet(tabName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(tabName) || ss.insertSheet(tabName);
}

function getApptRows() {
  const sheet = getSheet(APPT_TAB);
  const range = sheet.getDataRange();
  if (range.getLastRow() < 2) return [];
  const rows = range.getDisplayValues();
  return rows.slice(1).filter(function(r) {
    return r[0] !== '' && r[0].toLowerCase() !== 'phone';
  });
}

function ensureApptHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Phone','First Name','Last Name','Date','Technician',
      'Time','Services','Email','Points Preview','Submitted At','Status'
    ]);
  }
}

function ensureCustomerHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Phone','First Name','Last Name','Email','Total Points','Total Visits','Last Visit']);
  }
}

function ensureReminderHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date','Time','First Name','Email','Phone','Technician','Status']);
  }
}

function ensureStatusColumn(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('Status')) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue('Status');
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Debug ─────────────────────────────────────────────────────────────────────
// GET ?action=debug&technician=Tech1&date=2026-04-01
function debugInfo(technician, date) {
  const rows     = getApptRows();
  const rowsData = rows.map(function(r) {
    return {
      phone:    String(r[0]),
      date:     String(r[3]),
      tech:     String(r[4]),
      time:     String(r[5]),
      services: String(r[6]),
      status:   String(r[10] || ''),
    };
  });
  let unavailable = [];
  if (technician && date) {
    unavailable = [...getUnavailableSlots(technician, date, rows)];
  }
  return json({ tz: Session.getScriptTimeZone(), rows: rowsData, unavailable: unavailable });
}
