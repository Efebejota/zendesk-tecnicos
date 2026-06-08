/**
 * scan-llamadas.js — MP Ascensores
 * Uso: node scan-llamadas.js [desde] [hasta]
 * Ejemplo: node scan-llamadas.js 2026-01-01 2026-06-01
 * Si no se pasan fechas, usa 2026-01-01 hasta hoy.
 *
 * Lee tickets de Zendesk en el rango, consulta sus comentarios,
 * marca los que tienen VoiceComment outbound y guarda llamadas.json.
 * El fichero existente se respeta: solo se añaden/actualizan entradas.
 */

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

// ── Credenciales ──────────────────────────────────────────────────────────────
const SUBDOMAIN = 'mpascensoresatc';
const EMAIL     = 'fbj@mpascensores.com';
const TOKEN     = '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';
const AUTH      = Buffer.from(EMAIL + '/token:' + TOKEN).toString('base64');
const BASE      = `https://${SUBDOMAIN}.zendesk.com/api/v2`;
const HEADERS   = { Authorization: 'Basic ' + AUTH, 'Content-Type': 'application/json' };

// ── Técnicos válidos ──────────────────────────────────────────────────────────
const TECH_IDS = new Set([
  '18823504352925','22511063320093','19330437521693','19330468060189',
  '22510403813533','27405062363805','35441820724509','22829521407261',
  '27939255391261','24252949539869','25081523536157','26600613366301',
  '25238078751389','26600564602525','34726482176285','24254682817949',
]);

// ── Fichero de salida ─────────────────────────────────────────────────────────
const OUTPUT = path.join(__dirname, 'llamadas.json');

// ── Fechas ────────────────────────────────────────────────────────────────────
const desde = process.argv[2] || '2026-01-01';
const hasta = process.argv[3] || new Date().toISOString().slice(0, 10);
const desdeTs = Math.floor(new Date(desde + 'T00:00:00Z').getTime() / 1000);
const hastaTs = Math.floor(new Date(hasta + 'T23:59:59Z').getTime() / 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url) {
  while (true) {
    const r = await fetch(url, { headers: HEADERS });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '60');
      console.log(`  Rate limit, esperando ${wait}s...`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
    return r.json();
  }
}

function isValidTicket(t) {
  if ((t.tags || []).includes('closed_by_merge')) return false;
  if (t.status === 'deleted') return false;
  if ((t.subject || '').toUpperCase().includes('INVALID TICKET')) return false;
  return true;
}

async function hasOutboundCall(ticketId) {
  try {
    const data = await fetchWithRetry(`${BASE}/tickets/${ticketId}/comments.json`);
    return (data.comments || []).some(c =>
      c.type === 'VoiceComment' &&
      c.via?.channel === 'voice' &&
      c.via?.source?.rel === 'outbound'
    );
  } catch (e) {
    console.warn(`  Comentarios de #${ticketId}: ${e.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== scan-llamadas.js ===`);
  console.log(`Rango: ${desde} → ${hasta}`);

  // Cargar datos existentes
  let existing = { meta: {}, tickets: {} };
  if (fs.existsSync(OUTPUT)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    console.log(`Fichero existente: ${Object.keys(existing.tickets).length} entradas`);
  }

  // Obtener tickets del rango via incremental cursor
  console.log(`\nObteniendo tickets del rango...`);
  let allTickets = [];
  let url = `${BASE}/incremental/tickets/cursor.json?start_time=${desdeTs}&per_page=100`;
  let page = 0;

  while (url) {
    page++;
    const data = await fetchWithRetry(url);
    const batch = (data.tickets || []).filter(t => {
      const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
      return ts <= hastaTs;
    });
    allTickets = allTickets.concat(batch);
    process.stdout.write(`\r  Página ${page} — ${allTickets.length} tickets acumulados...`);

    // Si todos los tickets de la página son posteriores al rango, parar
    const last = data.tickets?.[data.tickets.length - 1];
    if (last && new Date(last.created_at).getTime() / 1000 > hastaTs) break;
    if (data.end_of_stream) break;
    url = data.after_url || null;
    if (url) await sleep(300);
  }

  console.log(`\nTotal descargados: ${allTickets.length}`);

  // Filtrar: válidos + asignados a técnicos
  const filtered = allTickets.filter(t =>
    isValidTicket(t) && TECH_IDS.has(String(t.assignee_id))
  );
  console.log(`Válidos y asignados a técnicos: ${filtered.length}`);

  // Excluir los que ya tenemos en el fichero
  const pendientes = filtered.filter(t => !(String(t.id) in existing.tickets));
  console.log(`Pendientes de consultar: ${pendientes.length}`);

  if (pendientes.length === 0) {
    console.log('Nada nuevo que escanear.');
  } else {
    const eta = Math.round(pendientes.length * 0.35 / 60);
    console.log(`ETA aproximado: ${eta} minutos\n`);

    let ok = 0, conLlamada = 0;
    for (const t of pendientes) {
      const tiene = await hasOutboundCall(t.id);
      existing.tickets[String(t.id)] = tiene;
      if (tiene) conLlamada++;
      ok++;
      if (ok % 50 === 0) {
        const pct = Math.round(ok / pendientes.length * 100);
        console.log(`  ${ok}/${pendientes.length} (${pct}%) — con llamada: ${conLlamada}`);
        // Guardar progreso parcial cada 50 tickets
        fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));
      }
      await sleep(350);
    }
  }

  // Resumen final
  const total = Object.keys(existing.tickets).length;
  const conLlamada = Object.values(existing.tickets).filter(Boolean).length;

  existing.meta = {
    lastScan: new Date().toISOString(),
    rangoHistorico: { desde, hasta },
    totalTickets: total,
    conLlamada,
    pctLlamada: total ? Math.round(conLlamada / total * 100) : 0,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));

  console.log(`\n=== Completado ===`);
  console.log(`Total tickets en fichero: ${total}`);
  console.log(`Con llamada outbound:     ${conLlamada} (${existing.meta.pctLlamada}%)`);
  console.log(`Fichero guardado en:      ${OUTPUT}\n`);
})();