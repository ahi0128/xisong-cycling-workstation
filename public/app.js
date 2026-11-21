const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key='xisong-workstation-v1';
let saved;try{saved=JSON.parse(localStorage.getItem(key))}catch{}
let {rows,history}=saved?.rows? saved:{rows:seed,history:[]};
let page='home',query='',filter='',owner='',comparison=new Set(),timer;
const statuses=['待確認','進行中','已完成','已撤銷'];
const owners=['校方','家長會','核心家長','教練','待確認'];
const descriptions={flow:'第1–4週是可調整的籌備順序。週次、分工與啟動日期均待確認。',review:'追蹤各方責任分工、審議阻礙、核定依據與下一個里程碑。',staff:'目前約20名學生，分為場地短距離、場地中長距離、公路。各組人數、場地、時段及人力配置待確認。',budget:'所有金額均為可編輯試算或待確認。金額以新臺幣計，啟動資金另列。',ledger:'記錄期初餘額、收入與支出，並填列收據、憑證及審核依據。結算只納入已完成且有金額的有效紀錄。',docs:'登錄會議內容、決議摘要、文件版本及後續工作。'};
const active=r=>!['已完成','已撤銷'].includes(r.status);
const badge=s=>'<span class="pill '+(s==='待確認'?'pending':s==='已完成'?'done':s.includes('風險')?'flag':'')+'">'+esc(s)+'</span>';
const num=n=>Number(n).toLocaleString('zh-TW',{maximumFractionDigits:2});
const money=n=>n===null||n===undefined||n===''?'待確認':'NT$ '+num(n);
function totals(r){
 const complete=keys=>keys.every(k=>r[k]!==undefined&&r[k]!=='');
 const income=complete(['households','monthly'])?r.households*r.monthly*12:null;
 const costs=complete(['coach','car','saturday','visits','admin'])?+r.coach + +r.car+r.saturday*r.visits + +r.admin:null;
 return {income,costs,net:income===null||costs===null?null:income-costs,share:costs!==null&&r.households>0?costs/(r.households*12):null};
}
function ledger(){
 const calc=kind=>rows.filter(r=>r.tab==='ledger'&&r.status==='已完成'&&r.kind===kind&&r.amount!==''&&r.amount!==undefined).reduce((s,r)=>s+Number(r.amount),0);
 const opening=calc('期初餘額'),income=calc('收入'),expense=calc('支出');
 return [opening,income,expense,opening+income-expense];
}
function persist(next,previous){
 try{localStorage.setItem(key,JSON.stringify({rows:next,history:previous}));rows=next;history=previous;return true}
 catch{toast('無法儲存，請先匯出備份並檢查瀏覽器儲存空間');return false}
}
function commit(next){return persist(next,[...history.slice(-24),rows])}
function toast(message){$('toast').textContent=message;$('toast').style.display='block';clearTimeout(timer);timer=setTimeout(()=>$('toast').style.display='none',3200)}
$('undo').onclick=()=>{if(history.length&&persist(history.at(-1),history.slice(0,-1))){render();toast('已復原上一筆操作')}};
function go(name){if(name==='coachPlan'){location.href='/coach-plan';return}if(name==='ledger'){location.href='/team-dues';return}if(!tabs[name])return;location.hash=name}
window.onhashchange=()=>{page=config[location.hash.slice(1)]||location.hash.slice(1)==='export'?location.hash.slice(1):'home';query=filter=owner='';render();scrollTo(0,0)};
function metric(label,value,sub){return '<div class="metric"><small>'+label+'</small><strong>'+esc(value)+'</strong><small>'+esc(sub)+'</small></div>'}
function home(){
 const open=rows.filter(r=>r.tab==='review'&&active(r));
 const risks=open.filter(r=>r.risk?.includes('風險'));
 const priorities=open.filter(r=>r.risk&&r.risk!=='一般');
 const milestone=open.filter(r=>r.kind==='里程碑').sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'))[0];
 const budgets=rows.filter(r=>r.tab==='budget'&&r.status!=='已撤銷');
 const week=rows.filter(r=>r.tab==='flow'&&active(r)).sort((a,b)=>(a.week||'待確認').localeCompare(b.week||'待確認'))[0];
 return '<section class="hero">'+badge('籌備草稿 · 待確認')+'<h1>家長後援會籌備工作站</h1><p>西松高中自由車隊的審議、人力與經費工作紀錄。先確認分地訓練的帶隊人力，再依校方程序與資金到位情況安排啟動。</p><button class="primary" onclick="go(\'review\')">查看待審議事項</button></section><div class="metrics">'+metric('待處理事項',open.length,'審議、待辦及里程碑')+metric('未完成程序',open.filter(r=>r.kind==='程序').length,'校方與家長會對接')+metric('人力與經費風險',risks.length,'待協調事項')+metric('籌備階段',week?.week||'—',week?.title||'目前無待辦流程')+'</div><div class="grid"><section class="card"><div class="sectionhead"><h2>優先決策與協調</h2><button onclick="go(\'review\')">全部事項</button></div>'+(priorities.map(r=>'<div class="row"><div><h3>'+esc(r.title)+'</h3><p>'+esc(r.owner)+' · '+esc(r.status)+'</p></div><button class="linklike" onclick="edit(\''+r.id+'\')">'+esc(r.risk)+'</button></div>').join('')||'<p>目前沒有待協調事項。</p>')+'</section><div><section class="card"><h2>下一個里程碑</h2><p>'+esc(milestone?.title||'待新增里程碑')+'</p><span class="pill pending">'+esc(milestone?.due||'日期待確認')+'</span></section><section class="card" style="margin-top:14px"><div class="sectionhead"><h2>經費試算</h2>'+badge('待確認')+'</div>'+budgets.map(r=>'<div class="row"><div><h3>'+esc(r.title)+'</h3><p>全年試算收支差額</p></div><strong>'+money(totals(r).net)+'</strong></div>').join('')+'<button onclick="go(\'budget\')">查看比較</button></section></div></div>';
}
function filtered(){return rows.filter(r=>r.tab===page&&(!filter||r.status===filter)&&(!owner||r.owner===owner)&&Object.values(r).some(v=>String(v).toLowerCase().includes(query.toLowerCase())))}
function options(values,selected,empty){return (empty?'<option value="">'+empty+'</option>':'')+values.map(v=>'<option '+(v===selected?'selected':'')+'>'+esc(v)+'</option>').join('')}
function detail(r){
 if(r.tab==='budget'){const t=totals(r);return '全年收入 '+money(t.income)+' ／ 全年支出 '+money(t.costs)+' ／ 差額 '+money(t.net)}
 return config[r.tab].filter(([k])=>r[k]!==''&&r[k]!==undefined).map(([k,label])=>label+' '+r[k]).join(' · ');
}
function list(){
 const visible=filtered();
 $('list').innerHTML='<div class="tablewrap"><table><thead><tr><th>項目與內容</th><th>負責角色</th><th>狀態</th><th>操作</th></tr></thead><tbody>'+(visible.map(r=>'<tr><td>'+(page==='budget'&&r.status!=='已撤銷'?'<label><input style="width:auto" type="checkbox" '+(comparison.has(r.id)?'checked':'')+' onchange="pick(this,\''+r.id+'\')"> 納入比較</label>':'')+'<strong>'+esc(r.title)+'</strong><p>'+esc(detail(r))+'</p><p>'+esc(r.note)+'</p></td><td>'+esc(r.owner)+'</td><td>'+badge(r.status)+'</td><td><div class="actions"><button onclick="edit(\''+r.id+'\')">編輯</button>'+(r.status==='已撤銷'?'<button onclick="setStatus(\''+r.id+'\',\'待確認\')">恢復</button>':(r.status!=='已完成'?'<button onclick="setStatus(\''+r.id+'\',\'已完成\')">標記完成</button>':'')+'<button onclick="setStatus(\''+r.id+'\',\'已撤銷\')">撤銷</button>')+'</div></td></tr>').join('')||'<tr><td colspan="4">目前沒有符合條件的紀錄。</td></tr>')+'</tbody></table></div>';
}
function pick(el,id){if(el.checked)comparison.add(id);else comparison.delete(id);showCompare()}
function showCompare(){
 const available=rows.filter(r=>r.tab==='budget'&&r.status!=='已撤銷');
 const selected=comparison.size?available.filter(r=>comparison.has(r.id)):available;
 $('compare').innerHTML=selected.length?'<div class="sectionhead"><h2>方案比較</h2><span class="pill pending">試算 · 待確認</span></div><div class="tablewrap"><table><thead><tr><th>比較項目</th>'+selected.map(r=>'<th>'+esc(r.title)+'</th>').join('')+'</tr></thead><tbody>'+[['家庭數',r=>r.households||'待確認'],['每戶每月',r=>money(r.monthly)],['每戶每月攤平',r=>money(totals(r).share)],['每戶每學期（6個月）',r=>r.monthly!==undefined&&r.monthly!==''?money(r.monthly*6):'待確認'],['全年收入',r=>money(totals(r).income)],['全年支出',r=>money(totals(r).costs)],['結餘／缺口',r=>money(totals(r).net)],['啟動資金',r=>money(r.startup)]].map(([label,value])=>'<tr><th>'+label+'</th>'+selected.map(r=>'<td>'+esc(value(r))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'';
}
function render(){
 $('nav').innerHTML=Object.entries(tabs).map(([id,[icon,label]])=>'<button class="'+(id===page?'active':'')+'" onclick="go(\''+id+'\')"><span aria-hidden="true">'+icon+'</span>'+label+'</button>').join('');
 $('crumb').textContent=tabs[page][1];$('undo').disabled=!history.length;
 if(page==='home'){$('content').innerHTML=home();return}
 if(page==='export'){$('content').innerHTML=exportsPage();return}
 let extras='';
 if(page==='flow')extras='<div class="weeks">'+['第1週','第2週','第3週','第4週'].map(week=>{const group=rows.filter(r=>r.tab==='flow'&&r.week===week&&r.status!=='已撤銷');return metric(week,group.length?group.filter(r=>r.status==='已完成').length+' / '+group.length:'—',group[0]?.title||'待新增')}).join('')+'</div>';
 if(page==='ledger')extras='<div class="metrics">'+ledger().map((v,i)=>metric(['期初餘額','收入','支出','期末餘額'][i],money(v),'已完成且有金額的紀錄')).join('')+'</div>';
 if(page==='budget')extras='<section id="compare" style="margin:18px 0"></section>';
 $('content').innerHTML='<div class="sectionhead"><h1>'+tabs[page][1]+'</h1><button class="primary" onclick="edit()">＋ 新增紀錄</button></div><div class="hint">'+descriptions[page]+'</div>'+extras+'<div class="toolbar"><input id="search" aria-label="搜尋" placeholder="搜尋項目、內容、日期或版本" value="'+esc(query)+'"><select id="filter" aria-label="狀態篩選">'+options(statuses,filter,'全部狀態')+'</select><select id="owner" aria-label="角色篩選">'+options(owners,owner,'全部角色')+'</select><button onclick="exportCsv(filtered(),tabs[page][1])">匯出篩選資料</button></div><div id="list"></div>';
 $('search').oninput=e=>{query=e.target.value;list()};$('filter').onchange=e=>{filter=e.target.value;list()};$('owner').onchange=e=>{owner=e.target.value;list()};list();if(page==='budget')showCompare();
}
function setStatus(id,status){
 const row=rows.find(r=>r.id===id);if(!row)return;
 if(row.tab==='ledger'&&status==='已完成'&&(!row.kind||!row.date||row.amount===''||row.amount===undefined)){toast('請先補上收支類型、日期和金額');return}
 if(commit(rows.map(r=>r.id===id?{...r,status}:r))){render();toast('已更新狀態')}
}
function edit(id){
 const record=rows.find(r=>r.id===id),tab=record?.tab||page;
 if(!config[tab])return;
 const r=record||{owner:'待確認',status:'待確認'};
 const fields=[['title','項目名稱'],['owner','負責角色',owners],['status','狀態',statuses],...config[tab],['note','內容與待確認事項','textarea']];
 $('form').innerHTML='<h2>'+ (record?'編輯':'新增')+' · '+tabs[tab][1]+'</h2><div class="fields">'+fields.map(([k,label,type])=>'<label class="'+(k==='title'||type==='textarea'?'wide':'')+'">'+label+(Array.isArray(type)?'<select name="'+k+'">'+options(type,r[k],k==='status'||k==='owner'?null:'待確認')+'</select>':type==='textarea'?'<textarea name="'+k+'">'+esc(r[k])+'</textarea>':'<input name="'+k+'" type="'+(type||'text')+'" '+(type==='number'?'min="0" step="'+(['households','count','visits'].includes(k)?'1':'0.01')+'"':'')+' '+(k==='title'?'required maxlength="180"':'')+' value="'+esc(r[k])+'">')+'</label>').join('')+'</div><div class="actions"><button type="button" onclick="document.getElementById(\'dialog\').close()">取消</button><button class="primary">儲存紀錄</button></div>';
 $('form').onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));data.title=data.title.trim();if(!data.title){toast('請輸入項目名稱');return}if(tab==='ledger'&&data.status==='已完成'&&(!data.kind||!data.date||data.amount==='')){toast('請先補上收支類型、日期和金額');return}const updated={...data,id:id||crypto.randomUUID(),tab};if(commit(record?rows.map(x=>x.id===id?updated:x):[...rows,updated])){$('dialog').close();render();toast('已儲存紀錄')}};
 $('dialog').showModal();
}
function download(name,body,mime){
 const url=URL.createObjectURL(new Blob([body],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已準備下載');
}
const csvCell=v=>{const s=String(v??'');return '"'+(/^[\t\r\n]|^\s*[=+@-]/.test(s)&&typeof v!=='number'?"'":"")+s.replaceAll('"','""')+'"'};
function csv(data){return '\uFEFF'+data.map(row=>row.map(csvCell).join(',')).join('\r\n')}
function exportCsv(records,name){
 const fields=[...new Map(Object.values(config).flat().map(([k,l])=>[k,l])).entries()];
 download(name+'.csv',csv([['工作區','項目','負責角色','狀態','內容',...fields.map(f=>f[1])],...records.map(r=>[tabs[r.tab][1],r.title,r.owner,r.status,r.note,...fields.map(([k])=>r[k])])]),'text/csv;charset=utf-8');
}
function exportsPage(){
 const items=[['家長說明','成立目的、三專項支援與認捐試算。','report(\'parent\')','下載文字檔'],['校方審議摘要','校方程序、提案預算及目前分工。','report(\'school\')','下載文字檔'],['收支結算資料','期初餘額、收入、支出、期末餘額及憑證明細。','report(\'ledger\')','下載 CSV'],['工作站備份','完整紀錄與最近復原歷程，可在同一網站還原。','backup()','下載 JSON']];
 return '<h1>匯出中心</h1><p>匯出目前工作站的資料。編輯紀錄保存在此瀏覽器，可下載備份並在其他裝置還原。</p><div class="exports">'+items.map(([title,desc,action,label])=>'<section class="card"><h2>'+title+'</h2><p>'+desc+'</p><button class="primary" onclick="'+action+'">'+label+'</button></section>').join('')+'</div><div class="toolbar"><button onclick="exportCsv(rows,\'工作站完整紀錄\')">匯出完整 CSV</button><button onclick="document.getElementById(\'restore\').click()">匯入 JSON 備份</button><input hidden id="restore" type="file" accept=".json,application/json" onchange="restore(this)"></div>';
}
function backup(){download('西松自由車隊工作站備份.json',JSON.stringify({rows,history},null,2),'application/json')}
async function restore(input){
 if(!input.files.length)return;
 try{const data=JSON.parse(await input.files[0].text());const valid=list=>Array.isArray(list)&&new Set(list.map(r=>r?.id)).size===list.length&&list.every(r=>r&&config[r.tab]&&/^[a-z0-9-]+$/i.test(r.id)&&typeof r.title==='string'&&statuses.includes(r.status)&&owners.includes(r.owner)&&[...config[r.tab],['note']].every(([k,,type])=>r[k]===undefined||(type==='number'?(r[k]===''||((typeof r[k]==='number'||typeof r[k]==='string')&&Number.isFinite(Number(r[k]))&&Number(r[k])>=0)):typeof r[k]==='string')));
 if(!valid(data.rows)||!Array.isArray(data.history)||!data.history.every(valid))throw Error();
 if(confirm('載入備份會取代目前紀錄。可用「復原操作」回到匯入前。')&&persist(data.rows,[...data.history.slice(-24),rows])){render();toast('已載入備份')}
 }catch{toast('無法讀取備份格式')}finally{input.value=''}
}
function report(type){
 const live=rows.filter(r=>r.status!=='已撤銷');
 if(type==='ledger'){
 const items=live.filter(r=>r.tab==='ledger'&&r.status==='已完成'&&r.kind&&r.amount!==''&&r.amount!==undefined);
 download('西松自由車隊收支結算.csv',csv([['西松高中自由車隊收支結算','工作紀錄'],['期初餘額','收入','支出','期末餘額'],ledger(),[],['日期','類型','項目','金額','憑證','審核依據','負責','備註'],...items.map(r=>[r.date,r.kind,r.title,Number(r.amount),r.voucher,r.approval,r.owner,r.note])]),'text/csv;charset=utf-8');return
 }
 const parent=type==='parent',title=parent?'家長說明':'校方審議摘要';
 const section=(label,tab,predicate=()=>true)=>'【'+label+'】\n'+(live.filter(r=>r.tab===tab&&predicate(r)).map(r=>r.title+'｜'+r.status+'｜'+r.owner+'\n'+detail(r)+'\n'+(r.note||'')).join('\n\n')||'待補')+'\n\n';
 const intro=parent?'隊上約20名學生分三專項訓練。後援會提案以穩定帶隊與後勤支援為目的。成立意願、認捐及幹部意願分別徵詢，認捐與否不影響學生訓練與出賽。':'請審議後援會組織形式、聘約及收款主體、核定與核銷程序、投保及附帶成本，以及分地帶隊與事故通報安排。';
 download('西松自由車隊'+title+'.txt','西松高中自由車隊｜'+title+'\n籌備草稿，依正式審議及核定結果執行。\n\n'+intro+'\n\n'+section('籌備流程','flow')+section('人力與支援','staff')+section('經費試算','budget')+section('程序與里程碑','review',r=>!parent||r.kind!=='決議')+(parent?'':section('會議與文件','docs')),'text/plain;charset=utf-8');
}
window.onhashchange();
