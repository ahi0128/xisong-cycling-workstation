// Set window.workstationRoleConfig to {clientId, endpoint} before loading this script.
(() => {
 const config = window.workstationRoleConfig;
 if (!config?.clientId || !config?.endpoint) return;
 const endpoint = new URL(config.endpoint);
 if (endpoint.origin !== 'https://script.google.com' || !endpoint.pathname.endsWith('/exec')) return;
 const redirect = location.origin + location.pathname;
 const storageKey = 'xisong-role-signin';
 let session;
 const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
 async function request(action, fields = {}) {
  const response = await fetch(endpoint.href, {
   method:'POST', credentials:'omit', redirect:'follow',
   headers:{'Content-Type':'text/plain;charset=UTF-8'},
   body:JSON.stringify({action,session,...fields})
  });
  if (!response.ok) throw new Error('無法連線至工作站權限服務。');
  const result = await response.json();
  if (result.error) {
   if (result.error==='sign_in_required') {
    session=undefined;
    $('attendance').hidden=true;
    $('roleLogin').hidden=false;
   }
   throw new Error({
    forbidden:'此 Google 帳號沒有這項工作站權限。',
    sign_in_required:'登入已失效，請重新登入。',
    busy:'差勤正在儲存，請稍後重試。'
   }[result.error]||'無法完成這項操作，請重新核對資料。');
  }
  return result;
 }
 async function start() {
  const verifier = random();
  const state = random();
  sessionStorage.setItem(storageKey,JSON.stringify({state,verifier,created:Date.now()}));
  const challenge = encode(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
   client_id:config.clientId,redirect_uri:redirect,response_type:'code',scope:'openid email',
   state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'
  });
  location.assign(url.href);
 }
 const control = $('roleLogin');
 control.hidden=false;
 control.onclick=()=>start().catch(error=>feedback(error.message,'ledgerSource','error'));
 async function restore() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const saved = sessionStorage.getItem(storageKey);
  sessionStorage.removeItem(storageKey);
  for (const key of ['code','state','error','error_description','scope','authuser','prompt']) params.delete(key);
  const search = params.toString();
  history.replaceState(null,'',redirect+(search?'?'+search:'')+location.hash);
  const previous = JSON.parse(saved || 'null');
  const callback = new URLSearchParams(restoreQuery);
  if (!previous || callback.get('state')!==previous.state || Date.now()-previous.created>600000)
   throw new Error('登入驗證已失效，請重新登入。');
  if (!callback.get('code')) throw new Error('Google 登入未完成。');
  const result = await request('login',{code:callback.get('code'),verifier:previous.verifier});
  if (!result.profile?.actions.includes('attendance.read')) throw new Error('此帳號目前沒有差勤權限。');
  session=result.session;
  control.hidden=true;
  feedback('已登入差勤。','ledgerSource','success');
  await switchView('attendance');
 }
 const restoreQuery = location.search;
 window.workstationAttendance = {
  active:()=>Boolean(session),
  read:(date,period)=>request('attendance.read',{date,period}),
  write:(date,period,entries)=>request('attendance.write',{date,period,entries})
 };
 restore().catch(error=>feedback(error.message,'ledgerSource','error'));
})();