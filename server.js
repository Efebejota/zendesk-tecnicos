/**
 * MP Ascensores — Proxy Zendesk unificado v5
 * Novedades v5:
 *  - Lista de técnicos en tecnicos.json (fuente única de verdad)
 *  - Módulo canon.js: filtros y cálculos compartidos para que los tres
 *    dashboards usen las mismas reglas y devuelvan los mismos números
 *  - Nuevo endpoint /api/kpi con KPIs cocinados al canon (el kpi.html podrá
 *    consumirlo en lugar de descargar 14k tickets en bruto)
 *  - /api/stats y /api/llamadas/stats migrados al canon (mismo universo,
 *    misma validación, mismo concepto de "técnico del equipo")
 *  - "manager" (Fernando) excluido de agregados; visible solo en su tarjeta
 *    del dashboard de Técnicos como referencia personal
 *  - Mailboxes (Multimarca, Technical Team) suman en agregados y aparecen
 *    en ranking marcados con role='mailbox' (el cliente puede pintarlos aparte)
 * Heredado de v4:
 *  - ETags off + Cache-Control: no-store en datos, no-cache en HTML
 *  - Auto-refresh del caché (6h) y auto-scan de llamadas (6h)
 *  - DATA_DIR opcional para checkpoint.json/llamadas.json/tecnicos.json
 *
 * Puerto: 3001 (local) | process.env.PORT (Railway)
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const canon   = require('./canon');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.set('etag', false);

const DATA_PATHS = new Set(['/tickets', '/metrics', '/all', '/refresh', '/health']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || DATA_PATHS.has(req.path)) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// ── Credenciales ─────────────────────────────────────────────────────────────
const SUBDOMAIN = process.env.ZD_SUBDOMAIN || process.env.ZDOMAIN || 'mpascensoresatc';
const EMAIL     = process.env.ZD_EMAIL     || process.env.ZEMAIL  || 'fbj@mpascensores.com';
const TOKEN     = process.env.ZD_TOKEN     || process.env.ZTOKEN  || '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';
const AUTH      = Buffer.from(EMAIL + '/token:' + TOKEN).toString('base64');
const BASE      = `https://${SUBDOMAIN}.zendesk.com/api/v2`;
const HEADERS   = { Authorization: 'Basic ' + AUTH, 'Content-Type': 'application/json' };

// ── Persistencia ─────────────────────────────────────────────────────────────
const DATA_DIR        = process.env.DATA_DIR || __dirname;
const LLAMADAS_FILE   = path.join(DATA_DIR, 'llamadas.json');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'checkpoint.json');

function seedFromRepo(targetFile, name) {
  if (DATA_DIR === __dirname) return;
  const seed = path.join(__dirname, name);
  if (!fs.existsSync(targetFile) && fs.existsSync(seed)) {
    try { fs.copyFileSync(seed, targetFile); console.log(`${name} sembrado en DATA_DIR desde el repo.`); }
    catch (e) { console.warn(`No se pudo sembrar ${name}:`, e.message); }
  }
}
seedFromRepo(LLAMADAS_FILE, 'llamadas.json');
seedFromRepo(CHECKPOINT_FILE, 'checkpoint.json');

// ── Equipo TAT (tecnicos.json) ───────────────────────────────────────────────
let TECNICOS = canon.loadTecnicos(DATA_DIR);
let TEAM     = canon.buildTeamSets(TECNICOS);
function reloadTecnicos() {
  try {
    TECNICOS = canon.loadTecnicos(DATA_DIR);
    TEAM = canon.buildTeamSets(TECNICOS);
    console.log(`Equipo recargado: ${TECNICOS.length} entradas (${TEAM.rankingIds.size} tech, ${TEAM.mailboxIds.size} mailbox).`);
    return true;
  } catch (e) { console.warn('No se pudo recargar tecnicos.json:', e.message); return false; }
}

// ── Checkpoint y llamadas ────────────────────────────────────────────────────
// CHECKPOINT v2: solo guarda cursor (afterUrl) + savedAt. NO guarda los tickets,
// que en el formato anterior podían crecer a 150+ MB y provocar OOM al arrancar.
// Si encontramos un checkpoint v1 (con tickets dentro), lo ignoramos y arrancamos
// de cero. La carga incremental posterior reconstruye el caché en memoria.
const CHECKPOINT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB de margen para v2

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    const stats = fs.statSync(CHECKPOINT_FILE);
    if (stats.size > CHECKPOINT_MAX_BYTES) {
      console.warn(`checkpoint.json pesa ${(stats.size/1024/1024).toFixed(1)} MB (>5 MB). Formato antiguo, se ignora para evitar OOM. Se reconstruirá al guardar.`);
      return null;
    }
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    // Compatibilidad: si trae 'tickets' lo descartamos también (formato viejo)
    if (Array.isArray(cp.tickets) && cp.tickets.length > 0) {
      console.warn(`Checkpoint v1 detectado (con ${cp.tickets.length} tickets dentro). Se ignora, solo se aprovecha afterUrl.`);
      return cp.afterUrl ? { afterUrl: cp.afterUrl, savedAt: cp.savedAt } : null;
    }
    console.log(`Checkpoint cargado: afterUrl=${!!cp.afterUrl}, savedAt: ${cp.savedAt || '?'}`);
    return cp;
  } catch (e) { console.warn('checkpoint.json no legible:', e.message); return null; }
}

function saveCheckpoint(tickets, afterUrl) {
  // tickets se pasa por compatibilidad de firma; ya NO se persiste (ver arriba).
  try {
    const cp = { afterUrl, savedAt: new Date().toISOString(), ticketsSeen: tickets?.length || 0 };
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
    console.log(`Checkpoint guardado (ligero): afterUrl=${!!afterUrl}, ticketsSeen=${cp.ticketsSeen}`);
  } catch (e) { console.warn('No se pudo guardar checkpoint:', e.message); }
}

function loadLlamadas() {
  if (!fs.existsSync(LLAMADAS_FILE)) return { tickets: {}, meta: {} };
  try { return JSON.parse(fs.readFileSync(LLAMADAS_FILE, 'utf8')); }
  catch (e) { console.warn('llamadas.json no legible:', e.message); return { tickets: {}, meta: {} }; }
}

let llamadasCache = loadLlamadas();
console.log(`llamadas.json cargado: ${Object.keys(llamadasCache.tickets).length} entradas`);

function saveLlamadas() {
  try { fs.writeFileSync(LLAMADAS_FILE, JSON.stringify(llamadasCache, null, 2)); }
  catch (e) { console.warn('No se pudo guardar llamadas.json:', e.message); }
}

function tieneLlamada(ticketId) { return llamadasCache.tickets[String(ticketId)] === true; }

// ── Caché ────────────────────────────────────────────────────────────────────
const CACHE_TTL = 6 * 60 * 60 * 1000;
let cache = {
  tickets: [], metrics: [], organizations: [],
  loadedAt: null, loading: false, loadingStage: 'idle',
  ticketsPartial: 0, lastError: null, stats: null,
};

// ── Fetch ────────────────────────────────────────────────────────────────────
async function fetchAll(startUrl) {
  let items = [];
  let url = startUrl;
  while (url) {
    const r = await fetch(url, { headers: HEADERS });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '60');
      console.log(`  Rate limit, esperando ${wait}s...`);
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error('Zendesk ' + r.status);
    const data = await r.json();
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'facets');
    if (key) items = items.concat(data[key]);
    url = data.next_page || null;
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  return items;
}

async function fetchIncremental() {
  const cp = loadCheckpoint();
  // Estado actual del caché en memoria. Si está vacío (arranque en frío), NO
  // sirve usar el cursor del checkpoint: solo traería los nuevos desde ese punto
  // y perderíamos todo el histórico. El cursor solo es útil si ya tenemos un
  // caché poblado al que añadir tickets nuevos (refresh en caliente).
  const haveCacheInMemory = cache.tickets && cache.tickets.length > 100;
  let items = haveCacheInMemory ? [...cache.tickets] : [];
  // metric_sets sideloaded en la misma petición (cobertura 100% incluso para
  // tickets archivados, que /ticket_metrics.json excluía). Se acumulan en
  // un array paralelo y los devolvemos junto con los tickets.
  const haveMetricsInMemory = cache.metrics && cache.metrics.length > 100;
  let metrics = haveMetricsInMemory ? [...cache.metrics] : [];
  let startUrl;
  if (cp && cp.afterUrl && haveCacheInMemory) {
    console.log(`Refresh incremental: ${items.length} tickets en memoria + cursor del checkpoint (savedAt=${cp.savedAt})`);
    startUrl = cp.afterUrl;
  } else {
    if (cp && cp.afterUrl) {
      console.log(`Caché en memoria vacío (${cache.tickets?.length || 0} tickets). Aunque hay cursor en checkpoint, se ignora y se hace carga completa para rehidratar histórico.`);
    } else {
      console.log('Primera carga completa desde el inicio...');
    }
    // include=metric_sets devuelve los metric_set sideloaded (Zendesk lo pasa
    // junto al ticket en data.metric_sets) — cobertura 100% incluso para
    // tickets archivados de hace meses.
    startUrl = BASE + '/incremental/tickets/cursor.json?start_time=0&per_page=100&include=metric_sets';
    items = []; metrics = []; // arrancar de cero
  }
  let url = startUrl, page = 0, lastAfterUrl = cp?.afterUrl || null;
  while (url) {
    page++;
    if (page % 10 === 0) {
      console.log(`  Tickets: página ${page} (${items.length} tickets, ${metrics.length} métricas)...`);
      // Checkpoint intermedio cada 10 páginas (~1000 tickets) — ahora es muy
      // barato porque solo guardamos afterUrl. Así si Railway nos mata, al
      // volver retomamos donde íbamos.
      if (lastAfterUrl) saveCheckpoint(items, lastAfterUrl);
    }
    const r = await fetch(url, { headers: HEADERS });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '60');
      console.log(`  Rate limit en tickets, esperando ${wait}s...`);
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error('Zendesk tickets ' + r.status);
    const data = await r.json();
    if (data.tickets) {
      items = items.concat(data.tickets);
      cache.ticketsPartial = items.filter(canon.isValidTicket).length;
    }
    // Zendesk sideloads metric_sets en data.metric_sets cuando se usa include=metric_sets.
    // Solo viene si la API soporta sideload en este endpoint (lo soporta).
    if (Array.isArray(data.metric_sets)) {
      metrics = metrics.concat(data.metric_sets);
    }
    lastAfterUrl = data.after_url || null;
    // Asegurarnos de que el after_url conserva el include=metric_sets. Si Zendesk no
    // lo añadiera automáticamente, lo forzamos.
    if (lastAfterUrl && !lastAfterUrl.includes('include=metric_sets')) {
      lastAfterUrl += (lastAfterUrl.includes('?') ? '&' : '?') + 'include=metric_sets';
    }
    if (data.end_of_stream === true) { saveCheckpoint(items, lastAfterUrl); url = null; }
    else { url = lastAfterUrl; }
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  return { tickets: items, metrics };
}

// ── /api/stats (dashboard de Técnicos) — usa canon ──────────────────────────
function computeStats() {
  const metricsById = {};
  cache.metrics.forEach(m => { metricsById[m.ticket_id] = m; });
  const result = {};
  for (const period of ['last_week', 'current_week', 'current_month', 'last_month', 'year']) {
    const { start, end } = canon.getDateRange(period);
    const allValid    = cache.tickets.filter(canon.isValidTicket);
    const periodAll   = allValid.filter(t => canon.inPeriod(t, start, end));
    const periodTeam  = canon.teamTickets(periodAll, TEAM);
    const periodKpi   = canon.kpiTickets(periodTeam);
    const byAgent = {}, byAgentTickets = {};
    TECNICOS.forEach(tec => {
      // El manager (Fernando) ve sus propios tickets pero no entra en agregados
      const baseForThis = tec.role === 'manager' ? periodAll : periodKpi;
      const mine = baseForThis.filter(t => String(t.assignee_id) === tec.id
        && (tec.role !== 'manager' || ['tipo_cliente_1','tipo_cliente_2'].includes(canon.getTipoCliente(t))));
      byAgent[tec.name] = { ...canon.computeAgentMetrics(mine, metricsById), role: tec.role };
      byAgentTickets[tec.id] = mine.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50).map(t => ({
        id: t.id, subject: t.subject, status: t.status, created_at: t.created_at,
        _puntos: canon.getPuntos(t) || null,
        _tipo: canon.getTipoCliente(t),
        _frMin: canon.getBusinessFR(t, metricsById),
        _resMin: canon.getBusinessRes(t, metricsById),
      }));
    });
    result[period] = {
      totalRaw: periodAll.length,
      general: canon.computePeriodSummary(periodKpi, metricsById),
      byAgent, techTickets: byAgentTickets,
    };
  }
  return result;
}

// ── /api/kpi (NUEVO) ─────────────────────────────────────────────────────────
// Helper interno: calcula KPIs canónicos para un rango arbitrario [start, end]
function computeRange(start, end, metricsById) {
  const allValid   = cache.tickets.filter(canon.isValidTicket);
  const periodAll  = allValid.filter(t => canon.inPeriod(t, start, end));
  const periodTeam = canon.teamTickets(periodAll, TEAM);
  const periodKpi  = canon.kpiTickets(periodTeam);
  const general    = canon.computePeriodSummary(periodKpi, metricsById);
  return {
    desde: start.toISOString().slice(0,10),
    hasta: end.toISOString().slice(0,10),
    universo: {
      totalRaw: periodAll.length,
      totalTeam: periodTeam.length,
      totalKpi: periodKpi.length,
    },
    general,
    byTipo: {
      tipo1:   periodTeam.filter(t => canon.getTipoCliente(t) === 'tipo_cliente_1').length,
      tipo2:   periodTeam.filter(t => canon.getTipoCliente(t) === 'tipo_cliente_2').length,
      tipo3:   periodTeam.filter(t => canon.getTipoCliente(t) === 'tipo_cliente_3').length,
      sinTipo: periodTeam.filter(t => canon.getTipoCliente(t) === null).length,
    },
    informativos: {
      invalidByTipif: periodAll.filter(t => canon.getTipificacion(t) === 'invalid_ticket').length,
    },
  };
}

function computeKpiPanel(period) {
  const metricsById = {};
  cache.metrics.forEach(m => { metricsById[m.ticket_id] = m; });
  const { start, end } = canon.getDateRange(period);
  const current = computeRange(start, end, metricsById);

  // Comparativas
  const prevRange = canon.getPreviousRange(period);
  const yoyRange  = canon.getSamePeriodLastYear(period);
  const previous  = prevRange ? { ...computeRange(prevRange.start, prevRange.end, metricsById), label: prevRange.label } : null;
  const yoy       = yoyRange  ? { ...computeRange(yoyRange.start,  yoyRange.end,  metricsById), label: yoyRange.label  } : null;

  // Evolución mensual del año actual (para gráfico). Solo si period ∈ {current_month, last_month, year}.
  let monthlyEvo = null;
  if (['current_month', 'last_month', 'year'].includes(period)) {
    const now = new Date();
    const year = now.getFullYear();
    const upToMonth = now.getMonth(); // 0-indexed, hasta el mes actual incluido
    monthlyEvo = [];
    for (let m = 0; m <= upToMonth; m++) {
      const mStart = new Date(year, m, 1, 0, 0, 0, 0);
      const mEnd   = m === upToMonth
        ? now
        : new Date(year, m + 1, 0, 23, 59, 59, 999);
      const r = computeRange(mStart, mEnd, metricsById);
      monthlyEvo.push({
        month: m + 1,
        monthLabel: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m],
        desde: r.desde, hasta: r.hasta,
        totalKpi: r.universo.totalKpi,
        totalTeam: r.universo.totalTeam,
        resolved: r.general.resolved,
        sla1: r.general.sla1, sla2: r.general.sla2,
        avgFR1: r.general.avgFR1, avgFR2: r.general.avgFR2,
      });
    }
  }

  return {
    period,
    current: { ...current, label: period },
    previous,
    yoy,
    monthlyEvo,
  };
}

// ── Carga ─────────────────────────────────────────────────────────────────────
async function loadInBackground(force = false) {
  if (cache.loading) { console.log('Ya hay una carga en curso.'); return; }
  const now = Date.now();
  if (!force && cache.loadedAt && (now - cache.loadedAt < CACHE_TTL) && cache.tickets.length > 0) return;
  if (force && fs.existsSync(CHECKPOINT_FILE)) {
    try { fs.unlinkSync(CHECKPOINT_FILE); console.log('Checkpoint eliminado (recarga forzada).'); }
    catch(e) { console.warn('No se pudo eliminar checkpoint:', e.message); }
  }
  cache.loading = true; cache.loadingStage = 'tickets'; cache.lastError = null;
  console.log('\n=== Iniciando carga ===');
  try {
    console.log('Cargando tickets + métricas (sideload include=metric_sets)...');
    const { tickets: allTickets, metrics: allMetrics } = await fetchIncremental();
    cache.tickets = allTickets.filter(canon.isValidTicket);
    cache.metrics = allMetrics;
    console.log(`Tickets válidos: ${cache.tickets.length} · Métricas sideload: ${cache.metrics.length}`);
    cache.loadingStage = 'orgs';
    console.log('Cargando organizaciones...');
    try {
      const orgs = await fetchAll(BASE + '/organizations.json?per_page=100');
      const orgById = {};
      orgs.forEach(o => { orgById[o.id] = o.name; });
      cache.tickets = cache.tickets.map(t => ({ ...t, organization_name: t.organization_id ? (orgById[t.organization_id] || null) : null }));
      cache.organizations = orgs;
      console.log(`Organizaciones: ${orgs.length}`);
    } catch(e) { console.log('Organizaciones: error no crítico -', e.message); }
    cache.loadingStage = 'stats';
    console.log('Calculando estadísticas...');
    cache.stats = computeStats();
    cache.loadedAt = Date.now(); cache.loadingStage = 'done';
    console.log('=== Carga completa ===\n');
  } catch(e) {
    cache.loadingStage = 'error'; cache.lastError = e.message;
    console.error('Error en carga:', e.message);
  } finally { cache.loading = false; }
}

// ── Scan llamadas ────────────────────────────────────────────────────────────
let scanState = { running: false, lastRun: null, lastResult: null };

async function runScanLlamadas(desde, hasta, origen = 'manual') {
  if (scanState.running) { console.log('Scan de llamadas ya en curso, se omite.'); return; }
  scanState.running = true;
  console.log(`Scan llamadas (${origen}): ${desde} → ${hasta}`);
  try {
    const desdeTs = Math.floor(new Date(desde + 'T00:00:00Z').getTime() / 1000);
    const hastaTs = Math.floor(new Date(hasta + 'T23:59:59Z').getTime() / 1000);
    const allIds = TEAM.allIds;
    let ticketsRango = cache.tickets.filter(t => {
      const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
      return ts >= desdeTs && ts <= hastaTs && allIds.has(String(t.assignee_id));
    });
    if (ticketsRango.length === 0) {
      console.log('Caché vacía, consultando Zendesk directamente para el scan...');
      let url = `${BASE}/incremental/tickets/cursor.json?start_time=${desdeTs}&per_page=100`;
      while (url) {
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) break;
        const data = await r.json();
        const batch = (data.tickets || []).filter(t => {
          const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
          return ts <= hastaTs && allIds.has(String(t.assignee_id)) && canon.isValidTicket(t);
        });
        ticketsRango = ticketsRango.concat(batch);
        const last = data.tickets?.[data.tickets.length - 1];
        if (last && new Date(last.created_at).getTime() / 1000 > hastaTs) break;
        if (data.end_of_stream) break;
        url = data.after_url || null;
        if (url) await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`Scan llamadas: ${ticketsRango.length} tickets en rango ${desde}→${hasta}`);
    let conLlamada = 0, consultados = 0;
    for (const t of ticketsRango) {
      const id = String(t.id);
      if (id in llamadasCache.tickets) { if (llamadasCache.tickets[id]) conLlamada++; continue; }
      try {
        const r = await fetch(`${BASE}/tickets/${t.id}/comments.json`, { headers: HEADERS });
        if (r.ok) {
          const json = await r.json();
          const tiene = (json.comments || []).some(c => c.type === 'VoiceComment' && c.via?.channel === 'voice' && c.via?.source?.rel === 'outbound');
          llamadasCache.tickets[id] = tiene;
          if (tiene) conLlamada++;
          consultados++;
          if (consultados % 50 === 0) saveLlamadas();
        }
      } catch(e) { /* skip */ }
      await new Promise(r => setTimeout(r, 350));
    }
    llamadasCache.meta = {
      ...llamadasCache.meta, lastScan: new Date().toISOString(),
      lastScanRango: { desde, hasta },
      totalTickets: Object.keys(llamadasCache.tickets).length,
      conLlamada: Object.values(llamadasCache.tickets).filter(Boolean).length,
    };
    saveLlamadas();
    scanState.lastRun = new Date().toISOString();
    scanState.lastResult = `${consultados} consultados, ${conLlamada} con llamada en rango`;
    console.log(`Scan completado (${origen}): ${consultados} nuevos consultados, ${conLlamada} con llamada en el rango.`);
  } catch(e) {
    console.error('Error en scan llamadas:', e.message);
    scanState.lastResult = 'error: ' + e.message;
  } finally { scanState.running = false; }
}

// Schedulers
const SCAN_INTERVAL = 6 * 60 * 60 * 1000;
setInterval(() => {
  if (!cache.stats || cache.loading || scanState.running) return;
  const last = llamadasCache.meta?.lastScan ? new Date(llamadasCache.meta.lastScan).getTime() : 0;
  if (Date.now() - last < SCAN_INTERVAL) return;
  const desdeMs = Math.max(last - 3 * 864e5, Date.now() - 30 * 864e5);
  const desde = new Date(desdeMs).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);
  runScanLlamadas(desde, hasta, 'auto');
}, 60 * 1000);

setInterval(() => { loadInBackground(false); }, 30 * 60 * 1000);

// ── Estáticos ────────────────────────────────────────────────────────────────
const staticOpts = {
  etag: false,
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache, must-revalidate'); },
};
app.use(express.static(path.join(__dirname, 'dashboards'), staticOpts));
app.use(express.static(path.join(__dirname), staticOpts));

// ── Endpoints ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  let cp = null;
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const stats = fs.statSync(CHECKPOINT_FILE);
      if (stats.size > CHECKPOINT_MAX_BYTES) {
        cp = { sizeBytes: stats.size, note: 'checkpoint v1 antiguo, ignorado por tamaño' };
      } else {
        const raw = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
        cp = { savedAt: raw.savedAt, hasAfterUrl: !!raw.afterUrl, ticketsSeen: raw.ticketsSeen || 0, sizeBytes: stats.size };
      }
    } catch(e) { cp = { error: e.message }; }
  }
  res.json({
    ok: true, version: 'v5', time: new Date().toISOString(),
    equipo: { total: TECNICOS.length, tech: TEAM.rankingIds.size, mailbox: TEAM.mailboxIds.size, manager: TECNICOS.filter(t=>t.role==='manager').length },
    cachedTickets: cache.tickets.length, cachedMetrics: cache.metrics.length,
    cacheAge: cache.loadedAt ? Math.round((Date.now()-cache.loadedAt)/1000)+'s' : 'none',
    loading: cache.loading, loadingStage: cache.loadingStage,
    ticketsPartial: cache.ticketsPartial, lastError: cache.lastError,
    statsReady: cache.stats !== null, checkpoint: cp,
    scanLlamadas: { running: scanState.running, lastRun: scanState.lastRun, lastResult: scanState.lastResult, lastScanMeta: llamadasCache.meta?.lastScan || null },
  });
});

app.get('/api/tecnicos', (req, res) => {
  res.json({ tecnicos: TECNICOS, totals: { total: TECNICOS.length, tech: TEAM.rankingIds.size, mailbox: TEAM.mailboxIds.size } });
});

app.get('/api/tecnicos/reload', (req, res) => {
  const ok = reloadTecnicos();
  if (ok && cache.tickets.length > 0) { cache.stats = computeStats(); console.log('Stats recalculadas con el nuevo equipo.'); }
  res.json({ ok, tecnicos: TECNICOS.length, message: ok ? 'tecnicos.json recargado y stats recalculadas.' : 'No se pudo recargar.' });
});

app.get('/api/kpi', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
  const period = req.query.period || 'current_month';
  if (!['current_week','last_week','current_month','last_month','year'].includes(period)) {
    return res.status(400).json({ error: 'period inválido' });
  }
  res.json(computeKpiPanel(period));
});

// NUEVO: los 5 períodos en una sola petición (para evitar refetch en cada cambio de pestaña).
// Reutiliza computeKpiPanel, que ya excluye/incluye comparativas según el período.
app.get('/api/kpi/all', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
  const periods = ['current_week', 'last_week', 'current_month', 'last_month', 'year'];
  const result = {};
  periods.forEach(p => { result[p] = computeKpiPanel(p); });
  res.json({ periods: result, generadoAt: new Date().toISOString() });
});

// ── /api/kpi/direccion — panel de Dirección ───────────────────────────────────
// Devuelve en una sola petición:
//  · sla.{semanaAnterior, mesActual, anioActual} (T1, T2, media + tiempos)
//  · slaEvoMensual y tiemposEvoMensual del año actual
//  · llamadasSemanas (hasta 16 semanas cerradas hacia atrás)
//  · llamadasAcum {semanaUltCerrada, mesActual, ultimoMesCerrado, anioActual}
// El cliente no calcula nada: pinta lo que llega.
function computeDireccionPanel() {
  const metricsById = {};
  cache.metrics.forEach(m => { metricsById[m.ticket_id] = m; });
  const now = new Date();
  const year = now.getFullYear();
  const upToMonth = now.getMonth();

  // Helper: para un rango, devuelve {kpi (solo T1+T2 equipo), team (todo equipo válido)}
  const slice = (start, end) => {
    const allValid = cache.tickets.filter(canon.isValidTicket);
    const inP = allValid.filter(t => canon.inPeriod(t, start, end));
    const team = canon.teamTickets(inP, TEAM);
    const kpi = canon.kpiTickets(team);
    return { kpi, team, summary: canon.computePeriodSummary(kpi, metricsById) };
  };

  // SLA — semana anterior cerrada, mes actual (acumulado), año actual (acumulado)
  const wkPrev = canon.getWeekRangeBack(1);
  const semAnterior = slice(wkPrev.start, wkPrev.end);
  const mesActStart = new Date(year, upToMonth, 1, 0, 0, 0, 0);
  const mesActual = slice(mesActStart, now);
  const anioStart = new Date(year, 0, 1, 0, 0, 0, 0);
  const anioActual = slice(anioStart, now);

  const sla = {
    semanaAnterior: {
      desde: wkPrev.start.toISOString().slice(0,10), hasta: wkPrev.end.toISOString().slice(0,10),
      isoWeek: wkPrev.isoWeek,
      sla1: semAnterior.summary.sla1, sla2: semAnterior.summary.sla2,
      slaMedia: combineSLA(semAnterior.summary),
      avgFR1: semAnterior.summary.avgFR1, avgFR2: semAnterior.summary.avgFR2,
      total: semAnterior.kpi.length,
    },
    mesActual: {
      desde: mesActStart.toISOString().slice(0,10), hasta: now.toISOString().slice(0,10),
      sla1: mesActual.summary.sla1, sla2: mesActual.summary.sla2,
      slaMedia: combineSLA(mesActual.summary),
      avgFR1: mesActual.summary.avgFR1, avgFR2: mesActual.summary.avgFR2,
      total: mesActual.kpi.length,
    },
    anioActual: {
      desde: anioStart.toISOString().slice(0,10), hasta: now.toISOString().slice(0,10),
      sla1: anioActual.summary.sla1, sla2: anioActual.summary.sla2,
      slaMedia: combineSLA(anioActual.summary),
      avgFR1: anioActual.summary.avgFR1, avgFR2: anioActual.summary.avgFR2,
      total: anioActual.kpi.length,
    },
  };

  // Evolución mensual del año (SLA y tiempos)
  const slaEvoMensual = [];
  for (let m = 0; m <= upToMonth; m++) {
    const mStart = new Date(year, m, 1, 0, 0, 0, 0);
    const mEnd   = m === upToMonth ? now : new Date(year, m + 1, 0, 23, 59, 59, 999);
    const sl = slice(mStart, mEnd);
    slaEvoMensual.push({
      month: m + 1,
      monthLabel: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m],
      sla1: sl.summary.sla1, sla2: sl.summary.sla2,
      slaMedia: combineSLA(sl.summary),
      avgFR1: sl.summary.avgFR1, avgFR2: sl.summary.avgFR2,
    });
  }

  // Llamadas semanales (hasta 16 semanas cerradas hacia atrás).
  // Universo: equipo TAT (tech+mailbox) válidos. Métrica: % con llamada outbound.
  const isoWeekCur = canon.getISOWeekNumber(now);
  const numSemanas = Math.min(isoWeekCur - 1, 16); // no incluye la semana actual parcial
  const llamadasSemanas = [];
  for (let w = numSemanas; w >= 1; w--) {
    const r = canon.getWeekRangeBack(w);
    const allValid = cache.tickets.filter(canon.isValidTicket);
    const inP = allValid.filter(t => canon.inPeriod(t, r.start, r.end));
    const team = canon.teamTickets(inP, TEAM);
    const conLlamada = team.filter(t => tieneLlamada(t.id)).length;
    llamadasSemanas.push({
      label: 'S' + r.isoWeek,
      isoWeek: r.isoWeek,
      desde: r.start.toISOString().slice(0,10),
      hasta: r.end.toISOString().slice(0,10),
      total: team.length,
      conLlamada,
      pct: team.length > 0 ? conLlamada / team.length * 100 : 0,
    });
  }

  // Acumulados de llamadas
  const allValid = cache.tickets.filter(canon.isValidTicket);
  const sliceLlamadas = (start, end) => {
    const inP = allValid.filter(t => canon.inPeriod(t, start, end));
    const team = canon.teamTickets(inP, TEAM);
    const cL = team.filter(t => tieneLlamada(t.id)).length;
    return { total: team.length, conLlamada: cL, pct: team.length > 0 ? cL / team.length * 100 : 0 };
  };

  const ultMesStart = new Date(year, upToMonth - 1, 1, 0, 0, 0, 0);
  const ultMesEnd   = new Date(year, upToMonth, 0, 23, 59, 59, 999);
  const llamadasAcum = {
    semanaUltCerrada: llamadasSemanas.length > 0 ? llamadasSemanas[llamadasSemanas.length - 1] : null,
    mesActual:        sliceLlamadas(mesActStart, now),
    ultimoMesCerrado: { ...sliceLlamadas(ultMesStart, ultMesEnd), desde: ultMesStart.toISOString().slice(0,10), hasta: ultMesEnd.toISOString().slice(0,10), monthLabel: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][upToMonth - 1] + ' ' + year },
    anioActual:       sliceLlamadas(anioStart, now),
  };

  return {
    year,
    generadoAt: new Date().toISOString(),
    sla,
    slaEvoMensual,
    llamadasSemanas,
    llamadasAcum,
    scanLlamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running },
  };
}

// Combina SLA T1 + T2 ponderado por número de tickets (no promedio simple).
function combineSLA(summary) {
  const d1 = summary.sla1Den || 0, d2 = summary.sla2Den || 0;
  if (d1 + d2 === 0) return null;
  const cumple1 = summary.sla1 != null ? Math.round(summary.sla1 * d1 / 100) : 0;
  const cumple2 = summary.sla2 != null ? Math.round(summary.sla2 * d2 / 100) : 0;
  return Math.round((cumple1 + cumple2) / (d1 + d2) * 100);
}

app.get('/api/kpi/direccion', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
  res.json(computeDireccionPanel());
});

app.get('/api/stats', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    const pct = cache.ticketsPartial > 0 ? ` (${cache.ticketsPartial} tickets cargados hasta ahora)` : '';
    return res.status(202).json({ error: `Cargando datos${pct}. Etapa: ${cache.loadingStage}`, loading: true, stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
  res.json(cache.stats);
});

app.get('/api/reload', (req, res) => {
  cache.tickets = []; cache.metrics = []; cache.stats = null; cache.loadedAt = null;
  loadInBackground(true);
  res.json({ ok: true, message: 'Recarga completa iniciada (checkpoint eliminado).' });
});

app.get('/api/refresh', (req, res) => {
  cache.tickets = []; cache.metrics = []; cache.stats = null; cache.loadedAt = null;
  loadInBackground(false);
  res.json({ ok: true, message: 'Recarga incremental iniciada.' });
});

app.get('/api/ticket/:id', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/tickets/${req.params.id}.json`, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `Zendesk ${r.status}` });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ticket/:id/comments', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/tickets/${req.params.id}/comments.json`, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `Zendesk ${r.status}` });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ticket-fields', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/ticket_fields.json`, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `Zendesk ${r.status}` });
    const data = await r.json();
    res.json({ total: data.ticket_fields.length, fields: data.ticket_fields.map(f => ({ id: f.id, title: f.title, type: f.type, key: f.key, tag: f.tag||null, custom_field_options: f.custom_field_options||null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Llamadas ──────────────────────────────────────────────────────────────────
app.get('/api/llamadas/meta', (req, res) => {
  res.json({ ...(llamadasCache.meta || {}), scanning: scanState.running, statsReady: cache.stats !== null, loadingStage: cache.loadingStage, ticketsPartial: cache.ticketsPartial });
});

app.get('/api/llamadas/scan', (req, res) => {
  const desde = req.query.desde || new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
  const hasta = req.query.hasta || new Date().toISOString().slice(0,10);
  if (scanState.running) return res.json({ ok: false, message: 'Ya hay un scan en curso.' });
  res.json({ ok: true, message: `Escaneando ${desde} → ${hasta} en background.` });
  runScanLlamadas(desde, hasta, 'manual');
});

// Helper compartido: KPIs de llamadas para un período concreto (canon).
function computeLlamadasPeriod(period) {
  const { start, end } = canon.getDateRange(period);
  const allValid = cache.tickets.filter(canon.isValidTicket);
  const periodAll = allValid.filter(t => canon.inPeriod(t, start, end));
  const ticketsPeriod = canon.teamTickets(periodAll, TEAM);
  const total = ticketsPeriod.length;
  const conLlamada = ticketsPeriod.filter(t => tieneLlamada(t.id)).length;
  const byAgent = {};
  TECNICOS.forEach(tec => {
    if (tec.role === 'manager') return;
    const mine = ticketsPeriod.filter(t => String(t.assignee_id) === tec.id);
    const mineConLlamada = mine.filter(t => tieneLlamada(t.id)).length;
    if (mine.length > 0) byAgent[tec.name] = {
      total: mine.length, conLlamada: mineConLlamada,
      pct: Math.round(mineConLlamada / mine.length * 100),
      role: tec.role,
    };
  });
  return {
    period, desde: start.toISOString().slice(0,10), hasta: end.toISOString().slice(0,10),
    total, conLlamada, pct: total ? Math.round(conLlamada/total*100) : null,
    byAgent,
  };
}

app.get('/api/llamadas/stats', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché principal aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial, llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running } });
  }
  const period = req.query.period || 'current_month';
  const data = computeLlamadasPeriod(period);
  res.json({ ...data, llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running } });
});

// NUEVO: los 5 períodos en una sola petición (cambio de pestaña instantáneo en el cliente).
app.get('/api/llamadas/stats/all', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché principal aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial, llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running } });
  }
  const periods = ['current_week', 'last_week', 'current_month', 'last_month', 'year'];
  const result = {};
  periods.forEach(p => { result[p] = computeLlamadasPeriod(p); });
  res.json({
    periods: result,
    llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running },
    generadoAt: new Date().toISOString(),
  });
});

// ── Legacy (mientras el kpi.html siga sin migrar) ────────────────────────────
app.get('/tickets', (req, res) => {
  if (cache.tickets.length === 0 && !cache.loading) loadInBackground(false);
  if (cache.tickets.length === 0 && cache.loading) return res.status(202).json({ tickets: [], total: 0, loading: true, stage: cache.loadingStage, partial: cache.ticketsPartial });
  let tickets = cache.tickets;
  if (req.query.month) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets, total: tickets.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/metrics', (req, res) => {
  if (cache.metrics.length === 0 && !cache.loading) loadInBackground(false);
  if (cache.metrics.length === 0 && cache.loading) return res.status(202).json({ metrics: [], total: 0, loading: true, stage: cache.loadingStage, partial: cache.ticketsPartial });
  res.json({ metrics: cache.metrics, total: cache.metrics.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/all', (req, res) => {
  if (cache.tickets.length === 0 && !cache.loading) loadInBackground(false);
  const metricsById = {};
  (cache.metrics||[]).forEach(m => { metricsById[m.ticket_id] = m; });
  let combined = cache.tickets.map(t => ({ ...t, _metrics: metricsById[t.id]||null }));
  if (req.query.month) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets: combined, total: combined.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/refresh', (req, res) => {
  cache.tickets = []; cache.metrics = []; cache.stats = null; cache.loadedAt = null;
  loadInBackground(false);
  res.json({ ok: true, message: 'Recarga incremental iniciada en background.' });
});

app.get('/api/tickets', (req, res) => {
  if (cache.tickets.length === 0 && !cache.loading) loadInBackground(false);
  let tickets = cache.tickets;
  if (req.query.month) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets, total: tickets.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

// ── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nServidor MP Ascensores v5 activo en puerto ${PORT}`);
  console.log(`Equipo TAT: ${TECNICOS.length} entradas (${TEAM.rankingIds.size} tech, ${TEAM.mailboxIds.size} mailbox, ${TECNICOS.filter(t=>t.role==='manager').length} manager)`);
  console.log('Endpoints nuevos: /api/kpi  /api/tecnicos  /api/tecnicos/reload');
  console.log('Heredados:        /api/stats  /api/llamadas/stats  /api/reload  /api/refresh');
  console.log('v5: canon.js como fuente única de cálculo para los 3 dashboards\n');
  loadInBackground(false);
});
