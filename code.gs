// ============================================================
// SALON NAME — Google Apps Script Booking Backend
// ============================================================
// SETUP:
// 1. Create a Google Sheet — paste its ID below as SHEET_ID
// 2. Deploy: Extensions → Apps Script → Deploy → New deployment
//    - Type: Web App | Execute as: Me | Who has access: Anyone
// 3. Paste the deployment URL into index.html as SCRIPT_URL
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
const CARRIER_GATEWAY = '<>number@txt.att.net'; // Change per carrier: 
// AT&T:      @txt.att.net
// T-Mobile:  @tmomail.net
// Verizon:   @vtext.com
// Sprint:    @messaging.sprintpcs.com
// US Cellular: @email.uscc.net
// Comcast : @comcast.pcs.textmsg.com

// ── REWARDS CONFIG ──────────────────────────────────────────
// Points awarded per service
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
const DEFAULT_POINTS       = 10;   // fallback for unlisted services
const FREE_PEDICURE_POINTS = 125;  // points needed for a free pedicure
// ============================================================

// Sheet tabs
const APPT_TAB     = 'Appointments';
const CUSTOMER_TAB = 'Customers';
// Appointments columns: Phone|First|Last|Date|Technician|Time|Services|Email|Points|Submitted At
// Customers columns:    Phone|First|Last|Email|TotalPoints|TotalVisits|LastVisit

// ── Entry points ──────────────────────────────────────────────────────────────

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'lookup')       return lookupPhone(e.parameter.phone);
  if (action === 'availability') return checkAvailability(e.parameter.technician, e.parameter.date, e.parameter.services, e.parameter.multiTech);
  if (action === 'book')         return bookAppointment(e.parameter);
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
      const points      = parseInt(rows[i][4], 10) || 0;
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
//
// Returns { unavailableSlots: [...] }
function checkAvailability(technician, date, services, multiTech) {
  if (!technician || !date) return json({ unavailableSlots: [] });

  const rows      = getApptRows();
  const techs     = technician.split(',').map(function(t) { return t.trim(); });
  const isMulti   = multiTech === 'true';

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
      success: false, partialConflict: true,
      bookedTechs: bookedTechs, freeTechs: freeTechs, nextAvailable: next,
      error: bookedTechs.join(' and ') + ' is not available at ' + time + '. ' + freeTechs.join(' and ') + ' can see you at that time.',
    });
  }

  if (bookedTechs.length === techs.length) {
    const next = findNextAvailable(technician, date, time, rows, services, isMulti);
    return json({
      success: false, conflict: true, nextAvailable: next,
      error: technician + ' is not available at ' + time + '.',
    });
  }

  // Calculate points earned
  const pointsEarned = calcPoints(services);

  // Write appointment
  const apptSheet = getSheet(APPT_TAB);
  ensureApptHeader(apptSheet);
  apptSheet.appendRow([phone, firstName, lastName, date, technician, time, services, email, pointsEarned, new Date().toISOString()]);

  // Update customer record and get new total
  const newTotal = upsertCustomer(phone, firstName, lastName, email, pointsEarned, date);
  const pointsToFree = Math.max(0, FREE_PEDICURE_POINTS - newTotal);

  // Send confirmation + reminder
  sendConfirmation(email, phone, firstName, date, time, technician, services, newTotal, pointsToFree);
  scheduleReminder(email, phone, firstName, date, time, technician);

  return json({
    success:       true,
    pointsEarned:  pointsEarned,
    totalPoints:   newTotal,
    pointsToFree:  pointsToFree,
    freeReward:    newTotal >= FREE_PEDICURE_POINTS,
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

// ── Unavailable slots for a technician ───────────────────────────────────────

function getUnavailableSlots(technician, date, rows) {
  const isAny       = technician === 'Any Tech';
  const unavailable = new Set();

  for (const row of rows) {
    if (row[3] !== date) continue;
    const rowTechs = row[4].split(',').map(function(t) { return t.trim(); });
    if (!isAny && !rowTechs.includes('Any Tech') && !rowTechs.includes(technician)) continue;
    // Use sum blocking for existing bookings (most conservative)
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

  // New customer
  sheet.appendRow([clean, firstName, lastName, email, pointsEarned, 1, visitDate]);
  return pointsEarned;
}

// ── Notifications ─────────────────────────────────────────────────────────────

function sendConfirmation(email, phone, firstName, date, time, technician, services, totalPoints, pointsToFree) {
  const subject = 'Your appointment at ' + SALON_NAME + ' is confirmed!';
  let body = 'Hi ' + firstName + ',\n\n'
    + 'Your appointment is confirmed:\n'
    + '  Date: ' + formatDate(date) + '\n'
    + '  Time: ' + time + '\n'
    + '  Technician: ' + technician + '\n'
    + '  Services: ' + services + '\n\n'
    + 'Rewards: You now have ' + totalPoints + ' points.\n';

  if (pointsToFree <= 0) {
    body += 'You have earned a FREE pedicure! Mention this at your next visit.\n';
  } else {
    body += 'You need ' + pointsToFree + ' more points for a free pedicure.\n';
  }

  body += '\nQuestions? Call us at ' + SALON_PHONE + '.\n\nSee you soon!\n' + SALON_NAME;

  // Email confirmation
  if (email) {
    try { GmailApp.sendEmail(email, subject, body); } catch(e) {}
  }

  // SMS via email-to-carrier gateway
  if (phone) {
    const smsAddress = String(phone).replace(/\D/g, '') + CARRIER_GATEWAY;
    const smsBody    = SALON_NAME + ': Appt confirmed ' + formatDate(date) + ' at ' + time
      + ' with ' + technician + '. Points: ' + totalPoints
      + (pointsToFree <= 0 ? ' - FREE pedicure earned!' : ' (' + pointsToFree + ' to free pedicure).')
      + ' Questions? ' + SALON_PHONE;
    try { GmailApp.sendEmail(smsAddress, '', smsBody); } catch(e) {}
  }
}

function scheduleReminder(email, phone, firstName, date, time, technician) {
  // Store reminder details in a Reminders tab — a time-based trigger fires daily
  // and sends reminders for appointments the next day.
  const sheet = getSheet('Reminders');
  ensureReminderHeader(sheet);
  sheet.appendRow([date, time, firstName, email, phone, technician, 'pending']);
}

// ── Daily reminder trigger ────────────────────────────────────────────────────
// Set up: Apps Script → Triggers → Add trigger → sendDailyReminders
// Trigger type: Time-driven → Day timer → any hour

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
    const body    = 'Hi ' + firstName + ',\n\nJust a reminder that you have an appointment tomorrow:\n'
      + '  Date: ' + formatDate(tomorrow) + '\n'
      + '  Time: ' + time + '\n'
      + '  Technician: ' + technician + '\n\n'
      + 'Need to reschedule? Call us at ' + SALON_PHONE + '.\n\nSee you soon!\n' + SALON_NAME;

    if (email) {
      try { GmailApp.sendEmail(email, subject, body); } catch(e) {}
    }
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
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
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
  const ss    = SpreadsheetApp.openById(SHEET_ID);
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
    sheet.appendRow(['Phone','First Name','Last Name','Date','Technician','Time','Services','Email','Points','Submitted At']);
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
    return { phone: String(r[0]), date: String(r[3]), tech: String(r[4]), time: String(r[5]), services: String(r[6]) };
  });
  let unavailable = [];
  if (technician && date) {
    unavailable = [...getUnavailableSlots(technician, date, rows)];
  }
  return json({ tz: Session.getScriptTimeZone(), rows: rowsData, unavailable: unavailable });
}
