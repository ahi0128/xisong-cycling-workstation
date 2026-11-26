// Script properties: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
// WORKSTATION_BOOK_ID, WORKSTATION_ROLES (JSON object mapping Google email to role).
// Configure privately in Apps Script. Never put these values in the Pages frontend.
const BRIEF_ACTIONS = ['brief.read','brief.write'];
const EQUIPMENT_ACTIONS = ['equipment.read','equipment.register','equipment.borrow','equipment.return','equipment.editAsset','equipment.editLoan'];
const WORKSTATION_ACCESS = Object.freeze({
  coach: ['attendance.read', 'attendance.write', ...BRIEF_ACTIONS, ...EQUIPMENT_ACTIONS],
  assistant: ['attendance.read', 'attendance.write', ...BRIEF_ACTIONS, ...EQUIPMENT_ACTIONS],
  secretary: ['attendance.read', 'attendance.write', 'brief.read'],
  captain: BRIEF_ACTIONS,
  deputy: BRIEF_ACTIONS,
  treasurer: ['brief.read'],
  manager: [...EQUIPMENT_ACTIONS, 'brief.read']
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
    if (!request.action.startsWith('attendance.')) return workstationJson_(workstationFeature_(request, profile, props));
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
  const account = roles[address];
  const role = typeof account === 'string' ? account : account?.role;
  if (!Object.prototype.hasOwnProperty.call(WORKSTATION_ACCESS, role)) return null;
  return {role, name:typeof account?.name==='string'?account.name:'', level: role === 'coach' || role === 'assistant' ? 3 : 2, actions: WORKSTATION_ACCESS[role]};
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

const BRIEF_ROLES = {coach:'教練',assistant:'教練',captain:'隊長',deputy:'副隊長',secretary:'文書',treasurer:'總務',manager:'經理'};
const EQUIPMENT_PREFIXES = Object.freeze({
  '輪組':'WHL','車架':'FRM','休息把套件':'AER','手把':'BAR','坐墊／座管':'SAD',
  '電子功率':'ELC','齒盤傳動':'DRV','踏板':'PDL','安全裝備':'SAF','工具維修':'TLS',
  '訓練設備':'TRN','運輸收納':'STO','其他':'OTH'
});
const BRIEF_KINDS = ['待辦事項','請假登記','訓練提醒','其他交接'];

function workstationFeature_(request, profile, props) {
  const book = SpreadsheetApp.openById(props.getProperty('WORKSTATION_BOOK_ID'));
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  if (request.action.startsWith('brief.')) {
    const role = BRIEF_ROLES[profile.role];
    const manager = profile.level === 3;
    const sheet = workstationSheet_(book,'今日交接',['日期','職務欄','類型','通知對象','留言人','事項','登錄時間']);
    if (request.action === 'brief.read') {
      const rows = sheet.getDataRange().getDisplayValues().slice(1).filter(row =>
        row[0] === today && (manager || row[1] === role || row[3] === '全體' || row[3] === role));
      return {rows};
    }
    const author = profile.name || role;
    const body = workstationText_(request.body,500);
    const audience = request.audience;
    if (!BRIEF_KINDS.includes(request.kind) ||
        !['全體','教練','隊長','副隊長','文書','總務','經理'].includes(audience)) throw new Error('Invalid brief');
    return workstationLocked_(() => {
      workstationAppend_(sheet,[today,role,request.kind,audience,author,body,new Date().toISOString()]);
      return {saved:1};
    });
  }
  const stock = workstationSheet_(book,'器材清單',['物品編號','品名','類別','總數量','存放位置','備註']);
  const loans = workstationSheet_(book,'器材借用',['登記識別碼']);
  const readStock = () => stock.getDataRange().getDisplayValues().map(row=>row.slice(0,6));
  const readLoans = () => loans.getDataRange().getDisplayValues().map(row=>row.slice(0,10));
  if (request.action === 'equipment.read') return {assets:readStock(), loans:readLoans()};
  return workstationLocked_(() => {
    const assets = readStock().slice(1);
    const qty = request.quantity;
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('Invalid quantity');
    if (request.action === 'equipment.register') {
      const category = request.category;
      if (!Object.prototype.hasOwnProperty.call(EQUIPMENT_PREFIXES,category)) throw new Error('Invalid category');
      const prefix = EQUIPMENT_PREFIXES[category];
      let last = 0;
      for (const [id,,group] of assets) {
        const code = String(id).normalize('NFKC').trim().toUpperCase();
        if (group !== category && !code.startsWith(prefix+'-')) continue;
        const suffix = Number(code.match(/-(\d+)$/)?.[1]);
        if (Number.isSafeInteger(suffix)) last = Math.max(last,suffix);
      }
      if (!Number.isSafeInteger(last+1)) throw new Error('Equipment limit');
      const code = prefix+'-'+String(last+1).padStart(3,'0');
      workstationAppend_(stock,[code,workstationText_(request.name,180),category,qty,
        workstationText_(request.location,180,true),'']);
      return {saved:1,code};
    }
    const records = readLoans().slice(1);
    const received = row => row[8] !== '' && row[8] !== undefined ? Number(row[8]) : row[4] ? Number(row[7]||1) : 0;
    const outstanding = row => Math.max(0,Number(row[7]||1)-received(row));
    if (request.action === 'equipment.editAsset') {
      const matches = assets.flatMap((row,index)=>row[0] && row[0]===request.code ? [index] : []);
      if (matches.length!==1) return {error:'equipment_conflict'};
      const index = matches[0], asset = assets[index];
      const current = [asset[1],asset[2],Number(asset[3]),asset[4]||'',asset[5]||''];
      if (JSON.stringify(current)!==JSON.stringify(request.original)) return {error:'equipment_conflict'};
      if (!Object.prototype.hasOwnProperty.call(EQUIPMENT_PREFIXES,request.category)) throw new Error('Invalid category');
      const open = records.filter(row=>row[0] && row[5]===request.code).reduce((sum,row)=>sum+outstanding(row),0);
      if (!(qty>=open)) return {error:'equipment_quantity'};
      const fields = [workstationText_(request.name,180),request.category,qty,
        workstationText_(request.location,180,true),workstationText_(request.note,400,true)];
      stock.getRange(index+2,2,1,5).setValues([fields.map(workstationLiteral_)]);
      return {saved:1};
    }
    if (request.action === 'equipment.editLoan') {
      const matches = records.flatMap((row,index)=>row[0] && row[0]===request.id ? [index] : []);
      if (matches.length!==1) return {error:'equipment_conflict'};
      const index = matches[0], record = records[index], returned = received(record);
      const current = [record[2],record[6]||'',Number(record[7]||1),returned,record[9]||''];
      if (JSON.stringify(current)!==JSON.stringify(request.original)) return {error:'equipment_conflict'};
      const out = String(record[3]||'').slice(0,10);
      if (request.due && (!workstationValidDate_(request.due) || (workstationValidDate_(out)&&request.due<out)))
        return {error:'equipment_due'};
      if (!Number.isSafeInteger(returned)||returned<0||qty<returned) return {error:'equipment_quantity'};
      if (qty!==current[2]) {
        const asset = assets.find(row=>row[0] && row[0]===record[5]);
        const otherLoans = records.reduce((sum,row,i)=>i!==index && row[0] && row[5]===record[5] ? sum+outstanding(row) : sum,0);
        if (!asset || (qty>current[2] && !(otherLoans+qty-returned<=Number(asset[3]))))
          return {error:'equipment_quantity'};
      }
      const range = loans.getRange(index+2,3,1,8);
      const values = range.getValues()[0];
      values[0] = workstationText_(request.borrower,120);
      values[4] = request.due;
      values[5] = qty;
      values[6] = returned;
      values[7] = workstationText_(request.note,400,true);
      range.setValues([values.map(workstationLiteral_)]);
      return {saved:1};
    }
    if (request.action === 'equipment.borrow') {
      const asset = assets.find(row=>row[0] && row[0]===request.code);
      if (!asset || !workstationValidDate_(request.due) || request.due<today) throw new Error('Invalid loan');
      const open = records.filter(row=>row[0] && row[5]===request.code)
        .reduce((total,row)=>total+outstanding(row),0);
      if (!(qty<=Number(asset[3])-open)) throw new Error('Insufficient inventory');
      workstationAppend_(loans,[Utilities.getUuid(),asset[1],workstationText_(request.borrower,120),
        new Date().toISOString(),'',asset[0],request.due,qty,0,'']);
      return {saved:1};
    }
    const index = records.findIndex(row=>row[0] && row[0]===request.id);
    if (index<0 || !(qty<=outstanding(records[index]))) throw new Error('Invalid return');
    const row = index+2;
    // Both updated values are in one row write, preserving the other existing fields.
    const range = loans.getRange(row,5,1,5);
    const values = range.getValues()[0];
    values[0] = new Date().toISOString();
    values[4] = received(records[index])+qty;
    range.setValues([values.map(workstationLiteral_)]);
    return {saved:1};
  });
}

function workstationText_(value,max,optional=false) {
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim()))
    throw new Error('Invalid text');
  return value.trim();
}

function workstationLiteral_(value) {
  return typeof value === 'string' && /^[=']/.test(value) ? "'"+value : value;
}

function workstationAppend_(sheet,row) {
  const next=sheet.getLastRow()+1;
  if (next>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),1);
  sheet.getRange(next,1,1,row.length).setNumberFormat('@').setValues([row.map(workstationLiteral_)]);
}

function workstationLocked_(callback) {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(5000)) return {error:'busy'};
  try {
    const result=callback();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}
