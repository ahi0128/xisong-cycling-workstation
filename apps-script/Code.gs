const LEDGER_ID = '1oKpiOXH6U_5lv7bbhmL0_SWyb2ifmWZGt4aAZkL1eA8';
const HEADERS = ['日期','用途','收入（元）','支出（元）','備註','憑證連結'];

function requireEditor_() {
  const allowed = (PropertiesService.getScriptProperties().getProperty('LEDGER_EDITORS') || '')
    .split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  const active = Session.getActiveUser().getEmail().toLowerCase();
  const effective = Session.getEffectiveUser().getEmail().toLowerCase();
  if (!active || active !== effective || !allowed.includes(active)) throw new Error('此 Google 帳號無登記權限。');
}

function doGet() {
  requireEditor_();
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  return HtmlService.createHtmlOutput(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
  <style>body{font:16px system-ui;background:#edf3f3;color:#153438;margin:1rem}main{max-width:34rem;margin:auto;background:white;padding:1rem;border-radius:12px}label{display:grid;margin:.75rem 0;gap:.25rem}input,select,textarea,button{font:inherit;padding:.55rem}button{background:#146b60;color:white;border:0;border-radius:6px}</style>
  <main><h1>西松自由車隊｜新增收支</h1><form id="entry">
  <label>日期<input type="date" name="date" value="${today}" required></label>
  <label>類型<select name="kind"><option value="income">收入</option><option value="expense">支出</option></select></label>
  <label>用途<input name="title" maxlength="120" required></label>
  <label>金額（元）<input name="amount" type="number" min="0.01" max="99999999.99" step="0.01" required></label>
  <label>備註<textarea name="note" maxlength="500"></textarea></label>
  <label>憑證連結（選填）<input name="receipt" type="url" maxlength="500"></label>
  <button>儲存到正式帳簿</button><p id="status" role="status"></p></form></main>
  <script>
  const form = document.querySelector('form'), button = form.querySelector('button');
  const status = document.querySelector('#status');
  let pending;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const key = JSON.stringify(data);
    if (pending?.key !== key) pending = {key, id: crypto.randomUUID()};
    button.disabled = true;
    status.textContent = '正在寫入帳簿…';
    google.script.run.withSuccessHandler(() => {
      pending = undefined;
      form.reset();
      status.textContent = '已存入正式帳簿。';
      button.disabled = false;
    }).withFailureHandler(error => {
      status.textContent = error.message + ' 可保留原填寫內容重試。';
      button.disabled = false;
    }).recordEntry({...data, id: pending.id});
  });
  </script></html>`).setTitle('西松自由車隊｜新增收支').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function recordEntry(data) {
  requireEditor_();
  const {id, date, kind, amount} = data;
  const title = String(data.title || '').trim(), note = String(data.note || '').trim();
  const receipt = String(data.receipt || '').trim();
  const dateValue = new Date(date + 'T00:00:00Z');
  const money = Number(amount);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date ||
      !['income','expense'].includes(kind) || !/^\d{1,8}(\.\d{1,2})?$/.test(amount) || money <= 0 ||
      !title || title.length > 120 || note.length > 500 || receipt.length > 500 ||
      (receipt && !/^https:\/\/[^\s]+$/i.test(receipt))) throw new Error('請檢查日期、用途、金額或 HTTPS 憑證連結。');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.openById(LEDGER_ID).getSheetByName('收支明細');
    const header = sheet.getRange(1, 1, 1, 7).getDisplayValues()[0];
    if (HEADERS.some((item, i) => header[i] !== item) || (header[6] && header[6] !== '登記識別碼')) {
      throw new Error('帳簿欄位已變更，請聯絡管理者。');
    }
    const last = sheet.getLastRow();
    if (!header[6] && last > 1 && !sheet.getRange(2, 7, last - 1).isBlank()) throw new Error('登記識別碼欄已有資料。');
    if (last > 1 && sheet.getRange(2, 7, last - 1).createTextFinder(id).matchEntireCell(true).findNext()) return true;
    if (!header[6]) sheet.getRange(1, 7).setValue('登記識別碼');
    if (last === sheet.getMaxRows()) sheet.insertRowsAfter(last, 1);
    sheet.getRange(last + 1, 1).setNumberFormat('yyyy/mm/dd');
    const serial = dateValue.getTime() / 86400000 + 25569;
    const plain = value => value ? "'" + value : '';
    sheet.getRange(last + 1, 1, 1, 7).setValues([[
      serial, plain(title), kind === 'income' ? money : '', kind === 'expense' ? money : '',
      plain(note), plain(receipt), id
    ]]);
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}
