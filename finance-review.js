(() => {
 const queue = 'https://sheets.googleapis.com/v4/spreadsheets/1ayeXEhczWtMd2ZAB1Ouw1K_d794W72afdPS9sHqp7gA';
 const auditId = 26112503;
 const panel = $('financeReview');
 const status = (message, kind) => feedback(message, 'financeReviewStatus', kind);
 const range = name => '/values/' + encodeURIComponent(name);
 const labels = {use:'用款申請',income:'收入',expense:'支出'};
 const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
 let mirroredIds = new Set();
 const publishedMonths = new Set();
 let reviewer = false, data = [], decisions = new Map(), pending;
 const cell = value => ({userEnteredValue: typeof value === 'number' ? {numberValue:value} : {stringValue:value}});
 const append = (sheetId, values) => ({appendCells:{sheetId,rows:[{values:values.map(cell)}],fields:'userEnteredValue'}});
 async function request(path, method='GET', body) {
  const response = await fetch(queue + path, {
   method, headers:{Authorization:'Bearer '+sheetsToken,'Content-Type':'application/json'},
   body:body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status===401) { sheetsExpiry=0; sheetsToken=undefined; sheetsHasDrive=false; }
  if (!response.ok) throw new Error('送審清單存取失敗（'+response.status+'）。請確認使用有權限的 Google 帳號。');
  return response.json();
 }
 function parse(row) {
  const [id,time,kind,date,rawTitle,amount,note='',permit=''] = row;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const cents = Math.round(Number(amount)*100);
  if (!uuid.test(id) || !Object.hasOwn(labels,kind) || !validDate(date) || !title || title.length>180 ||
      !Number.isSafeInteger(cents) || cents<=0 || cents>100000000 || Math.abs(cents/100-Number(amount))>1e-8 ||
      typeof note!=='string' || note.length>300 || (kind==='expense' && !uuid.test(permit))) return null;
  return {id,time,kind,date,title,cents,note,permit};
 }
 async function refresh() {
  const [submissions, mirror] = await Promise.all([
   request(range("'送審'!A2:H")+'?valueRenderOption=UNFORMATTED_VALUE'), request(range("'審核結果'!A2:H")+'?valueRenderOption=UNFORMATTED_VALUE')
  ]);
  let results = mirror.values || [];
  mirroredIds = new Set(results.map(row=>row[0]));
  reviewer = false;
  try {
   const audit = await sheetsRequest(range("'總務審核紀錄'!A1:H")+'?valueRenderOption=UNFORMATTED_VALUE');
   if (audit.values?.[0]?.[0] !== '識別碼') throw new Error('審核紀錄欄位有誤。');
   results = audit.values.slice(1);
   reviewer = true;
  } catch (error) {
   if (cloudLedger) throw error;
  }
  decisions = new Map(results.map(row=>[row[0],row]));
  const counts = new Map();
  for (const row of submissions.values || []) counts.set(row[0],(counts.get(row[0])||0)+1);
  data = (submissions.values || []).filter(row=>counts.get(row[0])===1).map(parse).filter(Boolean);
  renderQueue();
 }
 function renderQueue() {
  $('financeSync').hidden = !reviewer;
  $('financeRole').textContent = reviewer ? '教練審核' : '總務送審';
  const select = $('financePermit');
  const previous = select.value;
  select.replaceChildren(new Option('選擇已核准的用款申請',''));
  const used = new Set([...decisions.values()].filter(row=>row[1]==='已入帳').map(row=>row[7]));
  for (const row of decisions.values()) {
   if (row[1]==='已核准用款' && !used.has(row[0])) select.add(new Option(row[5]+' ｜ '+money(Number(row[6])*100),row[0]));
  }
  if ([...select.options].some(option=>option.value===previous)) select.value=previous;
  const list = $('financeItems');
  list.replaceChildren();
  const entries = new Map(data.map(row=>[row.id,row]));
  for (const [id, decision] of decisions) {
   entries.set(id,{id,kind:decision[3],date:decision[4],title:decision[5],cents:Number(decision[6])*100});
  }
  for (const row of [...entries.values()].reverse()) {
   const item = document.createElement('div');
   item.className = 'row';
   const decision = decisions.get(row.id);
   item.textContent = [row.date,labels[row.kind],row.title,money(row.cents),decision?.[1]||'待審核'].join(' ｜ ');
   if (decision && reviewer) {
    item.append(document.createTextNode(mirroredIds.has(row.id)?' ｜ 總務頁已同步':' ｜ 總務頁待同步'));
    if (!mirroredIds.has(row.id)) item.append(button('重試同步',()=>run(async()=>{
     await refresh();
     if (!reviewer || !decisions.has(row.id)) throw new Error('無法核對正式審核紀錄。');
     await copyResults([decisions.get(row.id)]);
     renderQueue();
     status('總務頁已同步。','success');
    })));
    if (decision[1]==='已入帳') {
     const month=row.date.slice(0,7);
     item.append(document.createTextNode(publishedMonths.has(month)?' ｜ 家長月報已提交':' ｜ 家長月報發布狀態未確認'));
     item.append(button('重新發布 '+month+' 月報',()=>run(async()=>{
      await refresh();
      if (!reviewer || decisions.get(row.id)?.[1]!=='已入帳') throw new Error('無法核對正式入帳紀錄。');
      await publishReviewMonth(month);
      renderQueue();
      status('家長月報已提交，部署後更新。','success');
     })));
    }
   }
   if (!decision) {
    if (row.note) item.append(document.createTextNode(' ｜ '+row.note));
    if (row.kind==='expense') {
     const permit = decisions.get(row.permit);
     item.append(document.createTextNode(' ｜ 用款許可：'+(permit?.[5]||'未找到')));
    }
    if (reviewer) item.append(button(row.kind==='use'?'核准用款':'確認入帳',()=>review(row,false)),button('退回',()=>review(row,true)));
   }
   list.append(item);
  }
  if (!entries.size) list.textContent='目前沒有送審紀錄。';
 }
 async function run(action) {
  if (panel.inert) return;
  panel.inert = true;
  try {
   await authorizeSheets();
   await action();
  } catch (error) {
   status(error.message,'error');
  } finally {
   panel.inert = false;
  }
 }
 async function review(row, reject) {
  const action = reject?'退回':row.kind==='use'?'核准用款':'確認入帳';
  if (!confirm(action+'？\n'+row.date+' ｜ '+row.title+' ｜ '+money(row.cents))) return;
  await run(async()=>{
   await refresh();
   if (!reviewer || decisions.has(row.id)) throw new Error('此單已審核，或目前帳號沒有審核權限。');
   const current = data.find(item=>item.id===row.id);
   if (JSON.stringify(current)!==JSON.stringify(row)) throw new Error('送審資料已變更，請核對後再操作。');
   const posting = !reject && row.kind!=='use';
   const marker = value => {
    const name = 'finance_' + value.replaceAll('-','_');
    return {addNamedRange:{namedRange:{name,namedRangeId:name,range:{sheetId:auditId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:1}}}};
   };
   const result = [row.id,reject?'已退回':posting?'已入帳':'已核准用款',new Date().toISOString(),row.kind,row.date,row.title,row.cents/100,row.permit];
   const requests = [marker(row.id),append(auditId,result)];
   if (posting) {
    if (row.kind==='expense') {
     const permit = decisions.get(row.permit);
     if (permit?.[1]!=='已核准用款'||Number(permit[6])*100+0.001<row.cents ||
         [...decisions.values()].some(item=>item[1]==='已入帳' && item[7]===row.permit))
      throw new Error('請使用尚未入帳且金額足夠的用款許可。');
     requests.push(marker('spent_'+row.permit));
    }
    const ledger = await sheetsRequest(range("'收支明細'!A1:H1"));
    const header = ledger.values?.[0]||[];
    if (['日期','用途','收入（元）','支出（元）','備註','憑證連結'].some((value,index)=>header[index]!==value) ||
        (header[6] && header[6]!=='登記識別碼') || (header[7] && header[7]!=='公開備註')) throw new Error('正式帳簿欄位有誤。');
    if (!header[6]) requests.push({updateCells:{start:{sheetId:1013939567,rowIndex:0,columnIndex:6},rows:[{values:[cell('登記識別碼')]}],fields:'userEnteredValue'}});
    if (!header[7]) requests.push({updateCells:{start:{sheetId:1013939567,rowIndex:0,columnIndex:7},rows:[{values:[cell('公開備註')]}],fields:'userEnteredValue'}});
    const entry = append(1013939567,[Date.parse(row.date)/86400000+25569,row.title,row.kind==='income'?row.cents/100:'',row.kind==='expense'?row.cents/100:'','','',row.id,row.note]);
    entry.appendCells.rows[0].values[0].userEnteredFormat = {numberFormat:{type:'DATE',pattern:'yyyy/mm/dd'}};
    entry.appendCells.fields += ',userEnteredFormat.numberFormat';
    requests.push(entry);
   }
   try {
    await sheetsRequest(':batchUpdate',{method:'POST',body:JSON.stringify({requests})});
   } catch (error) {
    await refresh();
    if (decisions.has(row.id)) throw new Error('此單已由教練處理，請核對更新後的狀態。');
    throw error;
   }
   decisions.set(row.id,result);
   renderQueue();
   const notices = [];
   try { await copyResults([result]); } catch (_) { notices.push('總務頁待同步，可按「同步審核結果」'); }
   if (posting) {
    try { await publishReviewMonth(row.date.slice(0,7)); }
    catch (_) { notices.push('家長月報待發布，可直接按該筆的重新發布按鈕'); }
   }
   renderQueue();
   status(result[1]+'。'+notices.join('。'),notices.length?'error':'success');
  });
 }
 async function publishReviewMonth(month) {
  const token = $('publishToken').value.trim() || rememberedToken;
  if (!token) throw new Error('請先設定家長月報發布權杖。');
  await publishMonth(token,month,undefined,undefined,{fromCloud:true});
  rememberToken(token);
  $('publishToken').value='';
  publishedMonths.add(month);
 }
 async function copyResults(results) {
  const mirror = await request(range("'審核結果'!A2:A"));
  const existing = new Set((mirror.values||[]).map(row=>row[0]));
  const values = results.filter(row=>!existing.has(row[0]));
  if (values.length) await request(range("'審核結果'!A1:H")+':append?valueInputOption=RAW','POST',{values});
  for (const row of results) mirroredIds.add(row[0]);
 }
 $('financeSync').onclick = ()=>run(async()=>{
  await refresh();
  if (!reviewer) throw new Error('請使用教練帳號同步審核結果。');
  await copyResults([...decisions.values()]);
  renderQueue();
  status('已同步審核結果。','success');
 });
 $('openFinanceReview').onclick = ()=>{
  panel.hidden=false;
  panel.scrollIntoView({block:'start'});
  if (!$('financeDate').value) $('financeDate').value=today;
  void run(async()=>{await refresh();status('已載入送審清單。','success')});
 };
 $('financeClose').onclick = ()=>{panel.hidden=true};
 $('financeKind').onchange = ()=>{
  const expense = $('financeKind').value==='expense';
  $('financePermitLabel').hidden=!expense;
  $('financePermit').required=expense;
 };
 $('financeForm').onsubmit = event=>{
  event.preventDefault();
  void run(async()=>{
   const fields = [$('financeKind').value,$('financeDate').value,$('financeTitle').value.trim(),Number($('financeAmount').value),$('financeNote').value.trim(),$('financeKind').value==='expense'?$('financePermit').value:''];
   const key = JSON.stringify(fields);
   if (pending?.key!==key) pending={key,values:[crypto.randomUUID(),new Date().toISOString(),...fields]};
   if (!parse(pending.values)) throw new Error('請檢查日期、用途、金額及用款許可。');
   const saved = await request(range("'送審'!A2:A"));
   if (!(saved.values||[]).some(row=>row[0]===pending.values[0]))
    await request(range("'送審'!A1:H")+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS','POST',{values:[pending.values]});
   pending=undefined;
   $('financeTitle').value='';
   $('financeAmount').value='';
   $('financeNote').value='';
   status('已送審，等待教練處理。','success');
   try { await refresh(); } catch (_) { status('已送審。清單待重新載入。','error'); }
  });
 };
})();