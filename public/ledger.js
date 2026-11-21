const $ = id=>document.getElementById(id);
const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
const month = date.slice(0,7);
const cash = n=>'NT$ '+Number(n).toLocaleString('zh-TW');
const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = {draft:'草稿',posted:'已入帳',void:'已作廢'};
let entries=[],editing=null,uploading=null,reviewing=null;
async function api(path,body){
 const raw=body instanceof FormData;
 const response=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:raw?{}:{'Content-Type':'application/json'},body:raw?body:JSON.stringify(body)});
 let data;
 try{data=await response.json()}catch{throw Error('網站登入或連線已失效，請重新整理')}
 if(!response.ok)throw Error(data.error||'操作失敗');
 return data;
}
function show(text){$('feedback').textContent=text}
function metrics(row){
 return [['opening','期初餘額'],['income','收入'],['expense','支出'],['closing','期末餘額']]
 .map(([key,title])=>`<div class="metric"><small>${title}</small><strong>${cash(row[key])}</strong></div>`).join('');
}
async function reports(){
 const data=await api('reports');
 $('reports').innerHTML=data.map(r=>`<article class="card" style="margin-bottom:12px"><h3>${esc(r.month)} 月報</h3><p style="white-space:pre-wrap">${esc(r.announcement)}</p><div class="metrics">${metrics(r)}</div></article>`).join('')||'<p>目前尚無已發布月報。</p>';
}
async function load(){
 const params=new URLSearchParams({start:$('start').value,end:$('end').value});
 const state=await api('entries?'+params);
 entries=state.entries;
 $('totals').innerHTML=metrics(state.totals);
 $('records').innerHTML='<table><thead><tr><th>交易日期</th><th>類型與摘要</th><th>金額</th><th>狀態</th><th>憑證</th><th>操作</th></tr></thead><tbody>'+
 (entries.map(r=>`<tr><td>${esc(r.day)}</td><td><strong>${esc(r.title)}</strong><p>${esc(r.kind)} · ${esc(r.category)}</p><p>${esc(r.note)}</p></td><td>${cash(r.amount)}</td><td>${r.review_day&&r.status==='posted'?'已核銷入帳':label[r.status]}${r.review_day?`<p>${esc(r.review_day)} · ${esc(r.review_ref)}</p>`:''}<p>${esc(r.reason)}</p></td><td>${esc(r.voucher)}${state.files.filter(f=>f.entry_id===r.id).map(f=>`<p><a target="_blank" rel="noopener" href="/api/files/${esc(f.id)}">${esc(f.filename)}</a></p>`).join('')}</td><td><div class="actions">${r.status==='draft'?['edit','files',r.kind==='支出'?'review':'post'].map((a,i)=>button(a,r,['編輯','上傳憑證',r.kind==='支出'?'核銷入帳':'核對入帳'][i])).join(''):''}${r.status!=='void'?button('void',r,'作廢'):''}</div></td></tr>`).join('')||'<tr><td colspan="6">此期間尚無紀錄。</td></tr>')+'</tbody></table>';
}
function button(action,row,title){return `<button data-action="${action}" data-id="${esc(row.id)}">${title}</button>`}
function edit(row){
 editing=row;
 const form=$('entryForm');
 form.reset();
 for(const name of ['day','kind','category','amount','title','voucher','note']){
  if(row)form.elements[name].value=row[name];
 }
 if(!row)form.elements.day.value=date;
 $('entryError').textContent='';
 $('entryDialog').showModal();
}
function bind(id,callback,errorId){
 $(id).addEventListener(id.endsWith('Form')||id==='publish'?'submit':'click',async e=>{
  e.preventDefault();
  const button=e.submitter||e.currentTarget;
  button.disabled=true;
  try{await callback(e)}catch(err){if(errorId)$(errorId).textContent=err.message;else show(err.message)}finally{button.disabled=false}
 });
}
$('start').value=month+'-01';
$('end').value=new Date(Date.UTC(+month.slice(0,4),+month.slice(5),0)).toISOString().slice(0,10);
$('publish').elements.month.value=month;
bind('refresh',async()=>{await load();show('已更新查詢結果')});
bind('add',()=>edit(null));
$('cancel').onclick=()=>$('entryDialog').close();
$('cancelUpload').onclick=()=>$('uploadDialog').close();
bind('entryForm',async e=>{
 const data=Object.fromEntries(new FormData(e.currentTarget));
 data.amount=Number(data.amount);
 if(editing)data.revision=editing.revision;
 await api('entries'+(editing?'/'+editing.id:''),data);
 $('entryDialog').close();
 if(data.day<$('start').value||data.day>$('end').value){$('start').value=data.day;$('end').value=data.day}
 await load();show('已儲存草稿。可在該筆明細上傳憑證。');
},'entryError');
bind('uploadForm',async e=>{
 await api('entries/'+uploading.id+'/files',new FormData(e.currentTarget));
 $('uploadDialog').close();await load();show('已上傳憑證');
},'uploadError');
$('cancelReview').onclick=()=>$('reviewDialog').close();
bind('reviewForm',async e=>{
 const data=Object.fromEntries(new FormData(e.currentTarget));
 await api('entries/'+reviewing.id+'/review',{...data,revision:reviewing.revision});
 $('reviewDialog').close();await load();show('支出已核銷並納入結算');
},'reviewError');
$('records').onclick=async e=>{
 const b=e.target.closest('button[data-action]');
 if(!b)return;
 const r=entries.find(r=>r.id===b.dataset.id);
 if(!r)return;
 const a=b.dataset.action;
 if(a==='edit'){edit(r);return}
 if(a==='review'){
  reviewing=r;$('reviewForm').reset();$('reviewForm').elements.day.value=date;
  $('reviewError').textContent='';$('reviewDialog').showModal();return;
 }
 if(a==='files'){uploading=r;$('uploadForm').reset();$('uploadError').textContent='';$('uploadDialog').showModal();return}
 const reason=a==='void'?prompt('請輸入作廢或更正原因'):'';
 if(a==='void'&&!reason?.trim())return;
 if(a==='post'&&!confirm('確認入帳並納入結算？'))return;
 b.disabled=true;
 try{await api('entries/'+r.id+'/'+a,{revision:r.revision,reason});await load();show(a==='post'?'已入帳':'已保留原紀錄並標記作廢')}
 catch(error){show(error.message)}finally{b.disabled=false}
};
bind('publish',async e=>{
 if(!confirm('確認將此月份的收支摘要及公告發布給受邀家長？'))return;
 await api('reports',Object.fromEntries(new FormData(e.currentTarget)));
 await reports();show('月報已發布');
});
bind('csv',()=>{
 const csv=v=>'"'+String(v??'').replace(/^(?=\s*[=+\-@]|[\t\r\n])/,"'").replaceAll('"','""')+'"';
 const lines=[['日期','類型','分類','摘要','金額','憑證編號','狀態','備註','作廢理由','核銷日期','核銷依據'],...entries.map(r=>[r.day,r.kind,r.category,r.title,r.amount,r.voucher,label[r.status],r.note,r.reason,r.review_day,r.review_ref])];
 const url=URL.createObjectURL(new Blob(['\uFEFF'+lines.map(r=>r.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download='西松自由車隊收支明細.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
(async()=>{
 try{
  const {admin}=await api('session');
  $('admin').hidden=!admin;$('home').hidden=!admin;
  if(admin){$('intro').textContent='登錄交易、上傳憑證與核對入帳。只有已入帳紀錄計入結算。';await load()}
  else {$('title').textContent='家長公告與收支月報';$('intro').textContent='查閱已發布公告與每月經費摘要。'}
  await reports();
 }catch(error){show(error.message)}
})();
