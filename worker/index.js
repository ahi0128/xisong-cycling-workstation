const ownerEmail = 'touch605@gmail.com';
const MIME = {html:'text/html',js:'text/javascript',css:'text/css'};
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail = (message,status=400)=>json({error:message},status);
const date = s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const idPattern = /^[a-f0-9-]{36}$/;
const kinds = ['期初餘額','收入','支出'];
const string = (v,limit)=>typeof v==='string'&&v.length<=limit;
const supported = {'application/pdf':[37,80,68,70,45],'image/png':[137,80,78,71,13,10,26,10],'image/jpeg':[255,216,255]};
const round = row=>({...row,closing:row.opening+row.income-row.expense});
function summary(db,start,end){
 return db.prepare(`SELECT
 COALESCE(SUM(CASE WHEN day < ?1 THEN CASE WHEN kind='支出' THEN -amount ELSE amount END
 WHEN kind='期初餘額' AND day <= ?2 THEN amount ELSE 0 END),0) AS opening,
 COALESCE(SUM(CASE WHEN kind='收入' AND day BETWEEN ?1 AND ?2 THEN amount ELSE 0 END),0) AS income,
 COALESCE(SUM(CASE WHEN kind='支出' AND day BETWEEN ?1 AND ?2 THEN amount ELSE 0 END),0) AS expense
 FROM entries WHERE status='posted' AND day <= ?2`).bind(start,end);
}
async function mutate(request,db,id,action,reviewer){
 const data=await request.json();
 if(action==='review'){
  if(!date(data.day)||!string(data.reference,300)||!data.reference.trim())return fail('請填寫核銷日期及審核依據');
  const result=await db.prepare(`UPDATE entries SET status='posted',review_day=?,review_ref=?,reviewed_by=?,
   revision=revision+1,updated_at=CURRENT_TIMESTAMP
   WHERE id=? AND revision=? AND kind='支出' AND status='draft'
   AND (voucher<>'' OR EXISTS (SELECT 1 FROM attachments WHERE entry_id=entries.id))`)
   .bind(data.day,data.reference.trim(),reviewer,id,data.revision).run();
  return result.meta.changes?json({ok:true}):fail('請先填寫憑證編號或上傳檔案，並確認草稿未被更新',409);
 }
 if(action==='post'||action==='void'){
  if(action==='void'&&(!string(data.reason,300)||!data.reason.trim()))return fail('請填寫作廢或更正原因');
  const current=action==='post'?'draft':null;
  const result=await db.prepare(`UPDATE entries SET status=?,reason=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE id=? AND revision=? AND status!='void' AND (? IS NULL OR (status=? AND kind<>'支出'))`)
  .bind(action==='post'?'posted':'void',action==='post'?'':data.reason.trim(),id,data.revision,current,current).run();
  return result.meta.changes?json({ok:true}):fail('紀錄已變更，請重新載入',409);
 }
 if(!date(data.day)||!kinds.includes(data.kind)||!Number.isSafeInteger(data.amount)||data.amount<1||data.amount>100000000||
  !string(data.category,50)||!data.category.trim()||!string(data.title,180)||!data.title.trim()||!string(data.voucher,120)||!string(data.note,1000))return fail('請檢查日期、分類、摘要與金額');
 const fields=[data.day,data.kind,data.category.trim(),data.title.trim(),data.amount,data.voucher.trim(),data.note.trim()];
 if(id){
  const result=await db.prepare(`UPDATE entries SET day=?,kind=?,category=?,title=?,amount=?,voucher=?,note=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE id=? AND revision=? AND status='draft'`).bind(...fields,id,data.revision).run();
  return result.meta.changes?json({id}):fail('只能更新尚未入帳且未被改動的草稿',409);
 }
 const newId=crypto.randomUUID();
 await db.prepare('INSERT INTO entries(id,day,kind,category,title,amount,voucher,note) VALUES(?,?,?,?,?,?,?,?)').bind(newId,...fields).run();
 return json({id:newId},201);
}
async function upload(request,env,id){
 const size=Number(request.headers.get('content-length'));
 if(!size||size>8*1024*1024+16384)return fail('憑證上限為 8 MB',413);
 const row=await env.DB.prepare('SELECT status FROM entries WHERE id=?').bind(id).first();
 if(row?.status!=='draft')return fail('僅草稿可上傳憑證',409);
 const file=(await request.formData()).get('file');
 if(!file||typeof file==='string'||!supported[file.type]||file.size>8*1024*1024)return fail('請選擇 8 MB 內的 PDF、JPG 或 PNG');
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(!supported[file.type].every((b,i)=>bytes[i]===b))return fail('檔案內容與格式不符');
 const fileId=crypto.randomUUID();
 await env.BUCKET.put(fileId,bytes);
 try{
  const info=await env.DB.prepare(`INSERT INTO attachments(id,entry_id,filename,mime,size)
  SELECT ?,id,?,?,? FROM entries WHERE id=? AND status='draft'`).bind(fileId,file.name.slice(0,160).replace(/[\r\n]/g,''),file.type,file.size,id).run();
  if(!info.meta.changes){await env.BUCKET.delete(fileId);return fail('紀錄已變更，請重新載入',409)}
 }catch(error){await env.BUCKET.delete(fileId);throw error}
 return json({id:fileId},201);
}
async function api(request,env,url,admin,reviewer){
 const method=request.method,path=url.pathname;
 if(path==='/api/session'&&method==='GET')return json({admin});
 if(path==='/api/reports'&&method==='GET'){
  const {results}=await env.DB.prepare('SELECT * FROM reports ORDER BY month DESC').all();
  return json(results.map(round));
 }
 if(!admin)return fail('此功能僅限管理員',403);
 if(method!=='GET'&&request.headers.get('origin')!==url.origin)return fail('來源驗證失敗',403);
 if(path==='/api/entries'&&method==='GET'){
  const start=url.searchParams.get('start'),end=url.searchParams.get('end');
  if(!date(start)||!date(end)||start>end)return fail('日期區間無效');
  const [entries,amounts,files]=await env.DB.batch([
   env.DB.prepare('SELECT * FROM entries WHERE day BETWEEN ? AND ? ORDER BY day DESC,updated_at DESC,id').bind(start,end),
   summary(env.DB,start,end),env.DB.prepare('SELECT a.* FROM attachments a JOIN entries e ON e.id=a.entry_id WHERE e.day BETWEEN ? AND ?').bind(start,end)
  ]);
  return json({entries:entries.results,totals:round(amounts.results[0]),files:files.results});
 }
 if(path==='/api/entries'&&method==='POST')return mutate(request,env.DB);
 const entry=path.match(/^\/api\/entries\/([^/]+)(?:\/(post|void|files|review))?$/);
 if(entry&&idPattern.test(entry[1])&&method==='POST')return entry[2]==='files'?upload(request,env,entry[1]):mutate(request,env.DB,entry[1],entry[2],reviewer);
 const filePath=path.match(/^\/api\/files\/([^/]+)$/);
 if(filePath&&idPattern.test(filePath[1])&&method==='GET'){
  const record=await env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(filePath[1]).first();
  const file=record&&await env.BUCKET.get(record.id);
  if(!file)return fail('找不到憑證',404);
  return new Response(file.body,{headers:{'Content-Type':record.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(record.filename.replace(/[!'()*]/g,'_')),'Content-Security-Policy':"default-src 'none'; sandbox"}});
 }
 if(path==='/api/reports'&&method==='POST'){
  const {month,announcement}=await request.json();
  if(typeof month!=='string'||!date(month+'-01')||!string(announcement,2000))return fail('請填寫有效月份與公告');
  const start=month+'-01';
  const d=new Date(start);d.setUTCMonth(d.getUTCMonth()+1,0);
  const end=d.toISOString().slice(0,10);
  const result=await summary(env.DB,start,end).first();
  await env.DB.prepare(`INSERT INTO reports (month,announcement,opening,income,expense) VALUES (?,?,?,?,?)
  ON CONFLICT(month) DO UPDATE SET announcement=excluded.announcement,opening=excluded.opening,income=excluded.income,
  expense=excluded.expense,published_at=CURRENT_TIMESTAMP`).bind(month,announcement,result.opening,result.income,result.expense).run();
  return json({ok:true});
 }
 return fail('找不到功能',404);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 const user=request.headers.get('oai-authenticated-user-id');
 const email=request.headers.get('oai-authenticated-user-email')?.toLowerCase();
 if(!user)return fail('請登入後再使用',401);
 const admin=email===ownerEmail;
 if(url.pathname.startsWith('/api/')){
  try{return await api(request,env,url,admin,user)}
  catch(error){console.error(error?.message);return fail('目前無法完成操作，請稍後再試',500)}
 }
 const path=url.pathname==='/'?(admin?'/index.html':'/ledger.html'):['/ledger','/team-dues'].includes(url.pathname)?'/ledger.html':url.pathname==='/coach-plan'?'/coach-plan.html':url.pathname==='/parent-dues'?'/parent-dues.html':url.pathname;
 if(!admin&&!['/ledger.html','/ledger.js','/style.css','/parent-dues.html'].includes(path))return new Response(null,{status:302,headers:{Location:'/ledger'}});
 if(!Object.hasOwn(assets,path))return fail('頁面不存在',404);
 return new Response(assets[path],{headers:{'Content-Type':MIME[path.split('.').at(-1)]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}});
}};
