import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";
import { suitabilityConfigured, type SuitabilityEnv } from "./policy";
import { currentMonthKey, previousMonthKey } from "./time";

export async function getDashboardData(
  db: D1Database,
  env: SuitabilityEnv & {
    STUDENTCONSULTING_EMAIL?: string;
    STUDENTCONSULTING_PASSWORD?: string;
    STUDENTCONSULTING_AUTOSUBMIT?: string;
    NOTIFY_EMAIL_TO?: string;
    NOTIFY_WEBHOOK_URL?: string;
  },
) {
  const applicationMonth = currentMonthKey();
  const reportMonth = previousMonthKey();

  const progress = await db
    .prepare(
      `SELECT COUNT(*) AS verified
       FROM applications
       WHERE report_month = ? AND status = 'verified'`,
    )
    .bind(applicationMonth)
    .first<{ verified: number }>();

  const report = await db
    .prepare(
      `SELECT report_month, target_count, status, submitted_at, last_error, updated_at
       FROM reports WHERE report_month = ?`,
    )
    .bind(reportMonth)
    .first();

  const runs = await db
    .prepare(
      `SELECT id, mode, application_month, report_month, status, target_count,
              verified_count, auth_live_view_url, auth_expires_at, last_error,
              started_at, completed_at, updated_at
       FROM automation_runs
       ORDER BY started_at DESC
       LIMIT 20`,
    )
    .all();

  const applications = await db
    .prepare(
      `SELECT a.id, a.status, a.applied_at, a.verified_at, a.report_month,
              j.external_id, j.title, j.location, j.country_code,
              j.is_international, j.source_url,
              aa.error_code, aa.error_message
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN application_attempts aa ON aa.id = (
         SELECT aa2.id FROM application_attempts aa2
         WHERE aa2.application_id = a.id
         ORDER BY aa2.attempt_no DESC LIMIT 1
       )
       ORDER BY COALESCE(a.verified_at, a.applied_at, a.created_at) DESC
       LIMIT 50`,
    )
    .all();

  return {
    applicationMonth,
    reportMonth,
    target: MONTHLY_APPLICATION_TARGET,
    verified: Number(progress?.verified ?? 0),
    report: report ?? null,
    runs: runs.results,
    applications: applications.results,
    configuration: {
      studentConsultingCredentials: Boolean(
        env.STUDENTCONSULTING_EMAIL && env.STUDENTCONSULTING_PASSWORD,
      ),
      studentConsultingAutoSubmit:
        env.STUDENTCONSULTING_AUTOSUBMIT === "true",
      suitabilityPolicy: suitabilityConfigured(env),
      bankIdNotification: Boolean(
        env.NOTIFY_EMAIL_TO || env.NOTIFY_WEBHOOK_URL,
      ),
    },
    automaticMode: {
      enabled: true,
      schedule: "14:e varje månad, 10:00–20:00 Europe/Stockholm",
      behavior:
        "Säkrar innevarande månads 10 ansökningar och förbereder föregående månads aktivitetsrapport.",
    },
  };
}

export function renderDashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jobbautomation</title>
  <style>
    :root{font-family:Inter,system-ui,sans-serif;color-scheme:dark;background:#0b0d10;color:#f2f4f7}body{margin:0;padding:24px;max-width:1180px;margin-inline:auto}h1{margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:24px 0}.card{background:#15191f;border:1px solid #272d36;border-radius:14px;padding:18px}.big{font-size:34px;font-weight:700}.ok{color:#78dba9}.warn{color:#ffd166}.bad{color:#ff7b7b}button,a.button{border:0;border-radius:9px;padding:11px 15px;font-weight:700;cursor:pointer;background:#f2f4f7;color:#111;text-decoration:none;display:inline-block}button:disabled{opacity:.5;cursor:not-allowed}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #272d36;vertical-align:top}code{font-size:12px}.status{font-weight:700}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.error{white-space:pre-wrap;color:#ff9a9a}.bankid{border-color:#ffd166}progress{width:100%;height:14px} @media(max-width:700px){body{padding:14px}table{display:block;overflow:auto}}
  </style>
</head>
<body>
  <h1>Jobbautomation</h1>
  <div class="muted">10 verifierade lämpliga jobb per månad · StudentConsulting → Arbetsförmedlingen</div>

  <div class="grid">
    <section class="card">
      <h2>Manuellt läge</h2>
      <p>Startar samma pipeline direkt: hitta lämpliga jobb, ansök, verifiera och förbered rapportering.</p>
      <button id="manual">Kör nu</button>
      <span id="manualResult" class="muted"></span>
    </section>
    <section class="card">
      <h2>Automatiskt säkerhetsläge</h2>
      <div class="status ok">Aktivt</div>
      <p>Den 14:e varje månad mellan 10:00 och 20:00, svensk tid.</p>
      <p class="muted">Körningen är idempotent: den söker bara det som återstår upp till 10 och skapar inte dubbletter.</p>
    </section>
  </div>

  <div id="content"><div class="card">Laddar…</div></div>

<script>
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
async function api(path,options){const r=await fetch(path,options);if(!r.ok)throw new Error(await r.text());return r.json()}
function badge(s){const c=s==='verified'||s==='completed'||s==='submitted'?'ok':s==='failed'?'bad':'warn';return '<span class="status '+c+'">'+esc(s)+'</span>'}
async function load(){
 try{
  const d=await api('/api/dashboard');
  const remaining=Math.max(0,d.target-d.verified);
  const cfg=d.configuration;
  const activeBank=d.runs.find(r=>r.status==='needs_user_auth'&&r.auth_live_view_url);
  document.getElementById('content').innerHTML=`
   <div class="grid">
    <section class="card"><h2>${esc(d.applicationMonth)}</h2><div class="big">${d.verified}/${d.target}</div><progress max="${d.target}" value="${d.verified}"></progress><p class="muted">${remaining} återstår</p></section>
    <section class="card"><h2>Rapport ${esc(d.reportMonth)}</h2>${d.report?badge(d.report.status):'<span class="muted">Inte skapad än</span>'}<p class="error">${esc(d.report?.last_error||'')}</p></section>
    <section class="card"><h2>Konfiguration</h2><div>${cfg.studentConsultingCredentials?'✅':'❌'} StudentConsulting-konto</div><div>${cfg.studentConsultingAutoSubmit?'✅':'❌'} Autosubmit</div><div>${cfg.suitabilityPolicy?'✅':'❌'} Lämplighetsregler</div><div>${cfg.bankIdNotification?'✅':'❌'} BankID-notifiering</div></section>
   </div>
   ${activeBank?`<section class="card bankid"><h2>BankID krävs</h2><p>Körning <code>${esc(activeBank.id)}</code> väntar på legitimering.</p><div class="toolbar"><a class="button" target="_blank" rel="noopener noreferrer" href="${esc(activeBank.auth_live_view_url)}">Öppna BankID-flödet</a><button onclick="checkBankId('${esc(activeBank.id)}')">Jag har signerat – kontrollera</button></div><p class="muted">Sessionen löper ut ${esc(activeBank.auth_expires_at)}</p></section>`:''}
   <section class="card"><h2>Senaste ansökningar</h2><table><thead><tr><th>Status</th><th>Jobb</th><th>Ort</th><th>Datum</th><th>Fel</th></tr></thead><tbody>${d.applications.map(a=>`<tr><td>${badge(a.status)}</td><td><a href="${esc(a.source_url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a><br><code>Jobb-ID ${esc(a.external_id)}</code></td><td>${a.is_international?'🌍 ':''}${esc(a.location||a.country_code||'')}</td><td>${esc(a.verified_at||a.applied_at||'')}</td><td class="error">${esc(a.error_code||'')} ${esc(a.error_message||'')}</td></tr>`).join('')}</tbody></table></section>
   <section class="card"><h2>Senaste körningar</h2><table><thead><tr><th>Läge</th><th>Status</th><th>Månad</th><th>Verifierade</th><th>Fel</th></tr></thead><tbody>${d.runs.map(r=>`<tr><td>${esc(r.mode)}</td><td>${badge(r.status)}</td><td>${esc(r.application_month)}</td><td>${esc(r.verified_count)}/${esc(r.target_count)}</td><td class="error">${esc(r.last_error||'')}</td></tr>`).join('')}</tbody></table></section>`;
 }catch(e){document.getElementById('content').innerHTML='<div class="card bad">'+esc(e.message)+'</div>'}
}
document.getElementById('manual').onclick=async()=>{const b=document.getElementById('manual');const out=document.getElementById('manualResult');b.disabled=true;out.textContent=' Startar…';try{const r=await api('/api/runs/manual',{method:'POST'});out.textContent=' Startad: '+r.runId;setTimeout(load,1500)}catch(e){out.textContent=' '+e.message}finally{b.disabled=false}};
async function checkBankId(id){try{const r=await api('/api/runs/'+encodeURIComponent(id)+'/bankid/check',{method:'POST'});alert(r.message||JSON.stringify(r));await load()}catch(e){alert(e.message)}}
load();setInterval(load,10000);
</script>
</body>
</html>`;
