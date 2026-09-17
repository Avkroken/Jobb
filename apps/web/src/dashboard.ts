import { MONTHLY_APPLICATION_TARGET } from "../../../packages/core/src/types";
import { suitabilityConfigured, type SuitabilityEnv } from "./policy";
import {
  currentMonthKey,
  isApplicationAutomationWindow,
  previousMonthKey,
} from "./time";

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

  const quota = await db
    .prepare(
      `SELECT COUNT(*) AS occupied
       FROM monthly_application_slots
       WHERE report_month = ? AND state <> 'free'`,
    )
    .bind(applicationMonth)
    .first<{ occupied: number }>();

  const report = await db
    .prepare(
      `SELECT report_month, target_count, status, submitted_at, last_error, updated_at
       FROM reports WHERE report_month = ?`,
    )
    .bind(reportMonth)
    .first();

  const runs = await db
    .prepare(
      `SELECT r.id, r.mode, r.application_month, r.report_month, r.status,
              r.target_count, r.verified_count, r.auth_live_view_url,
              r.auth_expires_at, r.last_error, r.started_at, r.completed_at,
              r.updated_at,
              (SELECT p.status FROM integration_probes p
               WHERE p.automation_run_id = r.id
               LIMIT 1) AS probe_status,
              (SELECT p.error_message FROM integration_probes p
               WHERE p.automation_run_id = r.id
               LIMIT 1) AS probe_error
       FROM automation_runs r
       ORDER BY r.started_at DESC
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
    quotaUsed: Number(quota?.occupied ?? 0),
    applicationWindowOpen: isApplicationAutomationWindow(),
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
      schedule:
        "10–13:e varje månad, en gång per dag mellan 10:00–20:00 Europe/Stockholm",
      applicationWindow: "1–14:e varje månad",
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
:root{font-family:Inter,system-ui,sans-serif;color-scheme:dark;background:#0b0d10;color:#f2f4f7}body{margin:0;padding:24px;max-width:1180px;margin-inline:auto}h1{margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:24px 0}.card{background:#15191f;border:1px solid #272d36;border-radius:14px;padding:18px}.big{font-size:34px;font-weight:700}.ok{color:#78dba9}.warn{color:#ffd166}.bad{color:#ff7b7b}button,a.button{border:0;border-radius:9px;padding:11px 15px;font-weight:700;cursor:pointer;background:#f2f4f7;color:#111;text-decoration:none;display:inline-block}button:disabled{opacity:.5;cursor:not-allowed}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #272d36;vertical-align:top}code{font-size:12px}.status{font-weight:700}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.error{white-space:pre-wrap;color:#ff9a9a}.bankid{border-color:#ffd166}progress{width:100%;height:14px}@media(max-width:700px){body{padding:14px}table{display:block;overflow:auto}}
</style>
</head>
<body>
<h1>Jobbautomation</h1>
<div class="muted">Exakt 10 slots per månad · StudentConsulting → Arbetsförmedlingen</div>
<div class="grid">
<section class="card"><h2>Manuellt läge</h2><p>Startar samma pipeline direkt. Jobbansökningar är endast tillåtna den 1:a–14:e varje månad.</p><button id="manual">Kör nu</button> <span id="manualResult" class="muted"></span></section>
<section class="card"><h2>Automatiskt säkerhetsläge</h2><div class="status ok">Aktivt</div><p>En körning per dag den 10:e–13:e, inom 10:00–20:00 svensk tid.</p><p class="muted">Dag 10 gör huvudförsöket. Dag 11–13 används bara om den gemensamma månadskörningen fortfarande är failed. Ingen jobbsökning den 15:e–31:e.</p></section>
</div>
<div id="content"><div class="card">Laddar…</div></div>
<script>
var bankCheckInFlight=false;
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
async function api(path,options){var response=await fetch(path,options);if(!response.ok)throw new Error(await response.text());return response.json();}
function badge(status){var cls=status==='verified'||status==='completed'||status==='submitted'||status==='captured'?'ok':status==='failed'?'bad':'warn';return '<span class="status '+cls+'">'+esc(status)+'</span>';}
function errorStage(code){var map={APPLICATION_FAILED:'Ansökan',APPLICATION_UNKNOWN:'Ansökan – okänt resultat',VERIFICATION_FAILED:'Verifiering hos StudentConsulting',UNEXPECTED_APPLICATION_ERROR:'Automation'};return map[code]||'Fel';}
function applicationRow(a){var detail=a.error_code?'<strong>'+esc(errorStage(a.error_code))+'</strong><br><code>'+esc(a.error_code)+'</code><br>'+esc(a.error_message||''):(a.error_message?esc(a.error_message):'');return '<tr><td>'+badge(a.status)+'</td><td><a href="'+esc(a.source_url)+'" target="_blank" rel="noopener noreferrer">'+esc(a.title)+'</a><br><code>Jobb-ID '+esc(a.external_id)+'</code></td><td>'+(a.is_international?'🌍 ':'')+esc(a.location||a.country_code||'')+'</td><td>'+esc(a.verified_at||a.applied_at||'')+'</td><td class="error">'+detail+'</td></tr>';}
function runRow(r){return '<tr><td>'+esc(r.mode)+'</td><td>'+badge(r.status)+'</td><td>'+esc(r.application_month)+'</td><td>'+esc(r.verified_count)+'/'+esc(r.target_count)+'</td><td>'+(r.probe_status?badge(r.probe_status):'')+'</td><td class="error">'+esc(r.last_error||r.probe_error||'')+'</td></tr>';}
async function autoCheckBankId(runId){if(bankCheckInFlight)return;bankCheckInFlight=true;try{var result=await api('/api/runs/'+encodeURIComponent(runId)+'/bankid/check',{method:'POST'});if(result.authenticated){await load();}}catch(error){}finally{bankCheckInFlight=false;}}
async function load(){
 try{
  var d=await api('/api/dashboard');
  var remaining=Math.max(0,d.target-d.verified);
  var cfg=d.configuration;
  var active=d.runs.find(function(r){return r.status==='needs_user_auth'&&r.auth_live_view_url&&r.probe_status!=='captured';});
  var mapped=d.runs.find(function(r){return r.probe_status==='captured';});
  var html='<div class="grid">';
  html+='<section class="card"><h2>'+esc(d.applicationMonth)+'</h2><div class="big">'+d.verified+'/'+d.target+'</div><progress max="'+d.target+'" value="'+d.verified+'"></progress><p class="muted">'+remaining+' verifierade återstår · '+esc(d.quotaUsed)+'/'+d.target+' slots upptagna</p></section>';
  html+='<section class="card"><h2>Rapport '+esc(d.reportMonth)+'</h2>'+(d.report?badge(d.report.status):'<span class="muted">Inte skapad än</span>')+'<p class="error">'+esc(d.report&&d.report.last_error||'')+'</p></section>';
  html+='<section class="card"><h2>Konfiguration</h2><div>'+(cfg.studentConsultingCredentials?'✅':'❌')+' StudentConsulting-konto</div><div>'+(cfg.studentConsultingAutoSubmit?'✅':'❌')+' Autosubmit</div><div>'+(cfg.suitabilityPolicy?'✅':'❌')+' Lämplighetsregler</div><div>'+(cfg.bankIdNotification?'✅':'❌')+' BankID-notifiering</div></section></div>';
  var manual=document.getElementById('manual');if(manual){manual.disabled=!d.applicationWindowOpen;manual.title=d.applicationWindowOpen?'':'Jobbautomation är stängd den 15:e–månadens slut.';}
  if(!d.applicationWindowOpen){document.getElementById('manualResult').textContent=' Stängt 15:e–månadens slut.';}
  if(active){html+='<section class="card bankid"><h2>BankID krävs</h2><p>Körning <code>'+esc(active.id)+'</code> väntar på legitimering eller formulärkartläggning. Dashboarden försöker automatiskt igen efter tillfälliga probe-fel.</p><div class="toolbar"><a class="button" target="_blank" rel="noopener noreferrer" href="'+esc(active.auth_live_view_url)+'">Öppna BankID-flödet</a></div><p class="muted">Sessionen löper ut '+esc(active.auth_expires_at)+'</p><p class="error">'+esc(active.probe_error||'')+'</p></section>';setTimeout(function(){autoCheckBankId(active.id);},1000);}
  if(mapped){html+='<section class="card"><h2>Arbetsförmedlingen</h2><div class="status ok">BankID verifierat · formulärschema kartlagt</div><p class="muted">Proben sparar bara struktur och inga ifyllda fältvärden.</p></section>';}
  html+='<section class="card"><h2>Senaste ansökningar</h2><table><thead><tr><th>Status</th><th>Jobb</th><th>Ort</th><th>Datum</th><th>Fel – var och varför</th></tr></thead><tbody>'+d.applications.map(applicationRow).join('')+'</tbody></table></section>';
  html+='<section class="card"><h2>Senaste körningar</h2><table><thead><tr><th>Läge</th><th>Status</th><th>Månad</th><th>Verifierade</th><th>AF-probe</th><th>Fel</th></tr></thead><tbody>'+d.runs.map(runRow).join('')+'</tbody></table></section>';
  document.getElementById('content').innerHTML=html;
 }catch(error){document.getElementById('content').innerHTML='<div class="card bad">'+esc(error.message)+'</div>';}
}
document.getElementById('manual').onclick=async function(){var button=document.getElementById('manual');var out=document.getElementById('manualResult');button.disabled=true;out.textContent=' Startar…';try{var result=await api('/api/runs/manual',{method:'POST'});out.textContent=' Startad: '+result.runId;setTimeout(load,1500);}catch(error){out.textContent=' '+error.message;}finally{setTimeout(load,100);}};
load();setInterval(load,10000);
</script>
</body>
</html>`;
