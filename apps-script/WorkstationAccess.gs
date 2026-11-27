// Script properties: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
// WORKSTATION_BOOK_ID, WORKSTATION_ROLES (JSON object mapping Google email to role).
// Configure privately in Apps Script. Never put these values in the Pages frontend.
const BRIEF_ACTIONS = ['brief.read','brief.write'];
const EQUIPMENT_ACTIONS = ['equipment.read','equipment.register','equipment.borrow','equipment.return','equipment.editAsset','equipment.editLoan','equipment.removeAsset'];
const WORKSTATION_ACCESS = Object.freeze({
  member: ['brief.read'],
  coach: ['attendance.read', 'attendance.write', 'report.publish', ...BRIEF_ACTIONS, ...EQUIPMENT_ACTIONS],
  assistant: ['attendance.read', 'attendance.write', 'report.publish', ...BRIEF_ACTIONS, ...EQUIPMENT_ACTIONS],
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
    if (request.action === 'report.publish') return workstationJson_(requestWorkstationReport_(request.month, props));
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
  if (!Object.prototype.hasOwnProperty.call(roles, address)) {
    const book = SpreadsheetApp.openById(props.getProperty('WORKSTATION_BOOK_ID'));
    const contacts = workstationSheet_(book, '車隊通訊錄',
      ['姓名','年級','學生電話','家長／聯絡人','家長電話','備註','學生 Email']);
    const last = contacts.getLastRow();
    if (last < 2) return null;
    const rows = contacts.getRange(2, 1, last - 1, 7).getDisplayValues();
    const matches = rows.filter(row => row[6].trim().toLowerCase() === address);
    if (matches.length !== 1 || !matches[0][0].trim()) return null;
    const name = matches[0][0].trim();
    if (rows.filter(row => row[0].trim() === name).length !== 1) return null;
    return {role:'member', name, level:1, actions:WORKSTATION_ACCESS.member};
  }
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
      return {rows:profile.role === 'member' ? rows.filter(row =>
        row[1] === '教練' && row[2] === '其他交接' && row[3] === '全體' &&
        row[5].startsWith('[今日值勤]')) : rows};
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
  const readStock = () => stock.getDataRange().getDisplayValues().map(row=>row.slice(0,7));
  const readLoans = () => loans.getDataRange().getDisplayValues().map(row=>row.slice(0,10));
  if (request.action === 'equipment.read') return {assets:readStock().filter((row,index)=>index===0||!row[6]), loans:readLoans()};
  return workstationLocked_(() => {
    const assets = readStock().slice(1);
    const qty = request.quantity;
    if (request.action !== 'equipment.removeAsset' && (!Number.isSafeInteger(qty) || qty < 1)) throw new Error('Invalid quantity');
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
    if (request.action === 'equipment.removeAsset') {
      const matches = assets.flatMap((row,index)=>row[0] && row[0]===request.code ? [index] : []);
      if (matches.length!==1) return {error:'equipment_conflict'};
      const index=matches[0], asset=assets[index];
      if (asset[6]) return {saved:1};
      if (asset[1]!==request.name) return {error:'equipment_conflict'};
      if (records.some(row=>row[0] && row[5]===request.code && !(outstanding(row)===0)))
        return {error:'equipment_on_loan'};
      const header=stock.getRange(1,7);
      if (header.getValue() && header.getValue()!=='移除時間') return {error:'equipment_conflict'};
      if (!header.getValue()) header.setValue('移除時間');
      stock.getRange(index+2,7).setValue(new Date().toISOString());
      return {saved:1};
    }
    if (request.action === 'equipment.editAsset') {
      const matches = assets.flatMap((row,index)=>row[0] && row[0]===request.code ? [index] : []);
      if (matches.length!==1) return {error:'equipment_conflict'};
      const index = matches[0], asset = assets[index];
      if (asset[6]) return {error:'equipment_conflict'};
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
        if (!asset || (qty>current[2] && (asset[6] || !(otherLoans+qty-returned<=Number(asset[3])))))
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
      const asset = assets.find(row=>row[0] && !row[6] && row[0]===request.code);
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

const WORKSTATION_REPORT_ENDPOINT = 'https://api.github.com/repos/ahi0128/xisong-cycling-parent/contents/ledger-summary.json';
const WORKSTATION_REPORT_TOKEN = 'PARENT_REPORT_GITHUB_TOKEN';
const WORKSTATION_REPORT_QUEUE = 'PARENT_REPORT_PENDING_MONTHS';
const WORKSTATION_REPORT_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function requestWorkstationReport_(month, props) {
  if (typeof month !== 'string' || !WORKSTATION_REPORT_MONTH.test(month)) return {error:'report_month'};
  return workstationLocked_(() => {
    const pending = JSON.parse(props.getProperty(WORKSTATION_REPORT_QUEUE)||'[]');
    if (!pending.includes(month)) props.setProperty(WORKSTATION_REPORT_QUEUE,JSON.stringify([...pending,month].sort()));
    if (!props.getProperty(WORKSTATION_REPORT_TOKEN)) return {error:'report_not_configured'};
    try {
      return {published:publishWorkstationReports_(props)};
    } catch (_) {
      return {error:'report_pending'};
    }
  });
}

// Optional clock trigger runs under the owner's account and only retries previously queued reports.
function retryParentReports() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(WORKSTATION_REPORT_TOKEN)||!props.getProperty(WORKSTATION_REPORT_QUEUE)) return;
  workstationLocked_(()=>publishWorkstationReports_(props));
}

function publishWorkstationReports_(props) {
  const pending = JSON.parse(props.getProperty(WORKSTATION_REPORT_QUEUE)||'[]');
  if (!pending.length) return [];
  const token=props.getProperty(WORKSTATION_REPORT_TOKEN);
  if (!token) throw new Error('Publication is not configured');
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  for(let attempt=0;attempt<3;attempt++){
    const remote=UrlFetchApp.fetch(WORKSTATION_REPORT_ENDPOINT+'?ref=main',
      {headers,muteHttpExceptions:true,followRedirects:false});
    if(remote.getResponseCode()!==200)throw new Error('Unable to read monthly report');
    const file=JSON.parse(remote.getContentText());
    if(file.encoding!=='base64'||typeof file.sha!=='string')throw new Error('Invalid report metadata');
    const current=JSON.parse(Utilities.newBlob(Utilities.base64Decode(file.content.replace(/\s/g,''))).getDataAsString('UTF-8'));
    const book=SpreadsheetApp.openById(props.getProperty('WORKSTATION_BOOK_ID'));
    const next=buildWorkstationReports_(current,pending,book);
    const body=JSON.stringify(next,null,2)+'\n';
    if(JSON.stringify(current)!==JSON.stringify(next)){
      const result=UrlFetchApp.fetch(WORKSTATION_REPORT_ENDPOINT,{method:'put',headers,
        contentType:'application/json',muteHttpExceptions:true,followRedirects:false,
        payload:JSON.stringify({branch:'main',sha:file.sha,message:'Publish approved ledger for '+pending.join(', '),
          content:Utilities.base64Encode(body,Utilities.Charset.UTF_8)})});
      if(result.getResponseCode()===409)continue;
      if(result.getResponseCode()!==200)throw new Error('Unable to publish monthly report');
    }
    props.deleteProperty(WORKSTATION_REPORT_QUEUE);
    return pending;
  }
  throw new Error('Monthly report changed during publication');
}

function buildWorkstationReports_(current,pending,book) {
  const existing=current.reports;
  if(!Array.isArray(existing)||existing.some(row=>!row||!WORKSTATION_REPORT_MONTH.test(row.month)))
    throw new Error('Unexpected published report schema');
  const monthStart=pending[0];
  const months=[...new Set([...existing.map(row=>row.month),...pending])].sort();
  const sheet=workstationSheet_(book,'收支明細',['日期','用途','收入（元）','支出（元）','備註','憑證連結']);
  const [header,...rows]=sheet.getDataRange().getDisplayValues();
  const opening=book.getSheetByName('月結').getRange('B2').getDisplayValue();
  let balance=workstationMoney_(opening,true);
  const transactions=rows.filter(row=>row.slice(0,6).some(Boolean)).map(row=>{
    const match=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(row[0].trim());
    const date=match?match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0'):'';
    const category=row[1].trim();
    const credit=workstationMoney_(row[2]),debit=workstationMoney_(row[3]);
    if(!workstationValidDate_(date)||!category||Boolean(credit)===Boolean(debit))
      throw new Error('Invalid ledger transaction');
    return {date,category,credit,debit,note:header[7]==='公開備註'?(row[7]||'').slice(0,400):''};
  }).sort((a,b)=>a.date.localeCompare(b.date));
  let index=0;
  const reports=months.map(month=>{
    if(month<monthStart)return existing.find(row=>row.month===month);
    while(index<transactions.length&&transactions[index].date.slice(0,7)<month){
      const row=transactions[index++];
      balance+=row.credit-row.debit;
    }
    const opening=balance;
    let income=0,expense=0;
    const details=[];
    while(index<transactions.length&&transactions[index].date.slice(0,7)===month){
      const row=transactions[index++];
      income+=row.credit;expense+=row.debit;
      details.push({date:row.date,kind:row.credit?'income':'expense',category:row.category,
        amount:(row.credit||row.debit)/100,note:row.note});
    }
    balance+=income-expense;
    return {month,opening:opening/100,income:income/100,expense:expense/100,closing:balance/100,
      ...(details.length?{details}:{})};
  });
  return {year:Number(months[months.length-1].slice(0,4)),reports};
}

function workstationMoney_(value,signed=false) {
  const raw=String(value||'').trim().replace(/,/g,'');
  if(!raw)return 0;
  const cents=Math.round(Number(raw)*100);
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(raw)||!Number.isSafeInteger(cents)||(!signed&&cents<0))
    throw new Error('Invalid ledger amount');
  return cents;
}
