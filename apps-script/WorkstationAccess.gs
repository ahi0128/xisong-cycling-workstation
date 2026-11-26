// Script properties: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
// WORKSTATION_BOOK_ID, WORKSTATION_ROLES (JSON object mapping Google email to role).
// Configure privately in Apps Script. Never put these values in the Pages frontend.
const WORKSTATION_ACCESS = Object.freeze({
  coach: ['attendance.read', 'attendance.write'],
  assistant: ['attendance.read', 'attendance.write'],
  secretary: ['attendance.read', 'attendance.write'],
  captain: [],
  deputy: [],
  treasurer: [],
  manager: []
});
const WORKSTATION_SESSIONS = ['晨操', '下午訓練', '週六團練', '其他'];
const WORKSTATION_ATTENDANCE = ['', '到課', '缺課', '遲到', '早退', '遲到及早退', '請假'];

function doPost(event) {
  try {
    const body = event && event.postData && event.postData.contents;
    if (!body || body.length > 32000) return workstationJson_({error:'invalid_request'});
    const request = JSON.parse(body);
    const props = PropertiesService.getScriptProperties();
    const cache = CacheService.getScriptCache();
    if (request.action === 'login') {
      const email = workstationExchange_(request, props);
      const profile = workstationProfile_(email, props);
      if (!profile) return workstationJson_({error:'forbidden'});
      const session = Utilities.getUuid() + Utilities.getUuid();
      cache.put('workstation:' + session, email, 1800);
      return workstationJson_({session, expiresIn:1800, profile});
    }
    const email = typeof request.session === 'string' && /^[a-f0-9-]{72}$/.test(request.session)
      ? cache.get('workstation:' + request.session) : null;
    if (!email) return workstationJson_({error:'sign_in_required'});
    const profile = workstationProfile_(email, props);
    if (!profile) return workstationJson_({error:'forbidden'});
    if (request.action === 'profile') return workstationJson_({profile});
    if (!profile.actions.includes(request.action)) return workstationJson_({error:'forbidden'});
    if (!workstationValidDate_(request.date) || !WORKSTATION_SESSIONS.includes(request.period))
      return workstationJson_({error:'invalid_period'});
    const book = SpreadsheetApp.openById(props.getProperty('WORKSTATION_BOOK_ID'));
    const roster = workstationSheet_(book, '隊費固定名單', ['姓名', '年級'])
      .getDataRange().getDisplayValues().slice(1)
      .filter(row => row[0].trim())
      .map(row => ({name:row[0].trim(), grade:row[1].trim()}));
    const log = workstationSheet_(book, '學生差勤', ['日期','時段','姓名','差勤','登錄時間']);
    if (request.action === 'attendance.read') {
      const statuses = Object.create(null);
      const names = new Set(roster.map(person => person.name));
      for (const [date, period, name, status] of log.getDataRange().getDisplayValues().slice(1)) {
        if (date === request.date && period === request.period && names.has(name) && WORKSTATION_ATTENDANCE.includes(status))
          statuses[name] = status;
      }
      return workstationJson_({roster, statuses});
    }
    const entries = request.entries;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 120)
      return workstationJson_({error:'invalid_entries'});
    const names = new Set(roster.map(person => person.name));
    const seen = new Set();
    const timestamp = new Date().toISOString();
    const rows = [];
    for (const entry of entries) {
      if (!entry || !names.has(entry.name) || seen.has(entry.name) || /^[=+\-@]/.test(entry.name) ||
          !WORKSTATION_ATTENDANCE.includes(entry.status)) return workstationJson_({error:'invalid_entries'});
      seen.add(entry.name);
      rows.push([request.date, request.period, entry.name, entry.status, timestamp]);
    }
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return workstationJson_({error:'busy'});
    try {
      const start = log.getLastRow() + 1;
      const missing = start + rows.length - 1 - log.getMaxRows();
      if (missing > 0) log.insertRowsAfter(log.getMaxRows(), missing);
      log.getRange(start, 1, rows.length, 5).setNumberFormat('@').setValues(rows);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return workstationJson_({saved: rows.length});
  } catch (_) {
    return workstationJson_({error:'request_failed'});
  }
}

function workstationProfile_(email, props) {
  const roles = JSON.parse(props.getProperty('WORKSTATION_ROLES') || '{}');
  const address = String(email || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(roles, address)) return null;
  const role = roles[address];
  if (!Object.prototype.hasOwnProperty.call(WORKSTATION_ACCESS, role)) return null;
  return {role, level: role === 'coach' || role === 'assistant' ? 3 : 2, actions: WORKSTATION_ACCESS[role]};
}

function workstationExchange_(request, props) {
  if (typeof request.code !== 'string' || !request.code || request.code.length > 2048 ||
      typeof request.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(request.verifier))
    throw new Error('Invalid authorization code');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method:'post', muteHttpExceptions:true, followRedirects:false,
    payload:{
      grant_type:'authorization_code',
      client_id:props.getProperty('GOOGLE_CLIENT_ID'),
      client_secret:props.getProperty('GOOGLE_CLIENT_SECRET'),
      redirect_uri:props.getProperty('GOOGLE_REDIRECT_URI'),
      code:request.code,
      code_verifier:request.verifier
    }
  });
  if (response.getResponseCode() !== 200) throw new Error('Code exchange failed');
  const {access_token} = JSON.parse(response.getContentText());
  if (typeof access_token !== 'string' || !access_token) throw new Error('Missing token');
  const identity = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers:{Authorization:'Bearer ' + access_token}, muteHttpExceptions:true, followRedirects:false
  });
  if (identity.getResponseCode() !== 200) throw new Error('Identity lookup failed');
  const profile = JSON.parse(identity.getContentText());
  if (profile.email_verified !== true || typeof profile.email !== 'string')
    throw new Error('Unverified account');
  return profile.email.toLowerCase();
}

function workstationSheet_(book, name, headers) {
  const sheet = book.getSheetByName(name);
  if (!sheet || !sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0]
      .every((value, index) => value.trim() === headers[index])) throw new Error('Unexpected sheet structure');
  return sheet;
}

function workstationValidDate_(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === date;
}

function workstationJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
