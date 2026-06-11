/**
 * MP Ascensores — Proxy Zendesk unificado v4
 * Novedades v4:
 *  - ETags desactivados + Cache-Control: no-store en todos los endpoints de datos
 *    (mata los 304 con datos obsoletos de raíz, sin depender del cache-buster del cliente)
 *  - Cache-Control: no-cache en los HTML estáticos (el navegador revalida siempre
 *    y recibe la versión nueva tras cada deploy)
 *  - Auto-refresh del caché principal (incremental, cada 30 min comprueba TTL de 6h)
 *  - Auto-scan de llamadas: al arrancar (cuando el caché está listo) y cada 6h,
 *    escanea la ventana desde el último scan (margen 3 días) hasta hoy
 *  - DATA_DIR opcional para persistir llamadas.json/checkpoint.json en un volumen
 * Puerto: 3001 (local) | process.env.PORT (Railway)
 * Uso: node server.js
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// v4: sin ETags — evita respuestas 304 condicionales en endpoints JSON
app.set('etag', false);

// v4: no-store en todos los endpoints de datos
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
// Acepta ambos juegos de nombres de variables (ZD_* y Z*) por compatibilidad
// con la configuración actual de Railway (ZDOMAIN/ZEMAIL/ZTOKEN).
const SUBDOMAIN = process.env.ZD_SUBDOMAIN || process.env.ZDOMAIN || 'mpascensoresatc';
const EMAIL     = process.env.ZD_EMAIL     || process.env.ZEMAIL  || 'fbj@mpascensores.com';
const TOKEN     = process.env.ZD_TOKEN     || process.env.ZTOKEN  || '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';
const AUTH      = Buffer.from(EMAIL + '/token:' + TOKEN).toString('base64');
const BASE      = `https://${SUBDOMAIN}.zendesk.com/api/v2`;
const HEADERS   = { Authorization: 'Basic ' + AUTH, 'Content-Type': 'application/json' };

// ── Ficheros de persistencia ──────────────────────────────────────────────────
// DATA_DIR: si en Railway se monta un volumen (p.ej. /data) y se define la
// variable DATA_DIR=/data, llamadas.json y checkpoint.json sobreviven a los
// redeploys. Sin la variable, todo funciona como hasta ahora (__dirname).
const DATA_DIR        = process.env.DATA_DIR || __dirname;
const LLAMADAS_FILE   = path.join(DATA_DIR, 'llamadas.json');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'checkpoint.json');

// Si DATA_DIR es un volumen vacío pero el repo trae ficheros semilla, copiarlos.
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

// ── Checkpoint ────────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    console.log(`Checkpoint cargado: ${cp.tickets?.length || 0} tickets, savedAt: ${cp.savedAt || '?'}`);
    return cp;
  } catch (e) { console.warn('checkpoint.json no legible:', e.message); return null; }
}

function saveCheckpoint(tickets, afterUrl) {
  try {
    const cp = { tickets, afterUrl, savedAt: new Date().toISOString() };
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
    console.log(`Checkpoint guardado: ${tickets.length} tickets`);
  } catch (e) { console.warn('No se pudo guardar checkpoint:', e.message); }
}

// ── Llamadas ──────────────────────────────────────────────────────────────────
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

function tieneLlamada(ticketId) {
  return llamadasCache.tickets[String(ticketId)] === true;
}

// ── Campos personalizados ────────────────────────────────────────────────────
const CF_TIPO_CLIENTE = 23076303407645;
const CF_PUNTOS       = 19324034176285;

// ── Técnicos ─────────────────────────────────────────────────────────────────
const TECNICOS = [
  { id: '18823504352925', name: 'Amine Laaguidi',        email: 'AL@mpascensores.com' },
  { id: '22511063320093', name: 'Javier Sosa Jimenez',   email: 'jsj@mpascensores.com' },
  { id: '19330437521693', name: 'Eduardo Robles Gamito', email: 'erg@mpascensores.com' },
  { id: '19330468060189', name: 'Pedro Calvo Estallo',   email: 'pjce@mplifts.com' },
  { id: '22510403813533', name: 'Carlos Perez Osuna',    email: 'cpo@mpascensores.com' },
  { id: '27405062363805', name: 'Raidel Alba',           email: 'rah@mpascensores.com' },
  { id: '35441820724509', name: 'Michael Prieto',        email: 'mpri@mpascensores.com' },
  { id: '22829521407261', name: 'Ruud Barten',           email: 'mphollandrb@mplifts.com' },
  { id: '27939255391261', name: 'Kamal Arrad',           email: 'ka@mplifts.com' },
  { id: '24252949539869', name: 'Mar Durán',             email: 'md@mpascensores.com' },
  { id: '25081523536157', name: 'Andreas Scheidl',       email: 'as@mpascensores.com' },
  { id: '26600613366301', name: 'Alexis Didelot',        email: 'ad@mpascenseurs.com' },
  { id: '25238078751389', name: 'Nicklas Jonsson',       email: 'nj@mpsweden.se' },
  { id: '26600564602525', name: 'Antonio Gómez',         email: 'mpcentroag@mpascensores.com' },
  { id: '34726482176285', name: 'Multimarca',            email: 'multibrand@mplifts.com' },
  { id: '24254682817949', name: 'Fernando Becerra',      email: 'fbj@mpascensores.com' },
];
const TECH_BY_ID   = {};
const TECH_BY_NAME = {};
TECNICOS.forEach(t => { TECH_BY_ID[t.id] = t; TECH_BY_NAME[t.name] = t; });

// ── Caché ────────────────────────────────────────────────────────────────────
const CACHE_TTL = 6 * 60 * 60 * 1000;

let cache = {
  tickets:      [],
  metrics:      [],
  organizations:[],
  loadedAt:     null,
  loading:      false,
  loadingStage: 'idle',
  ticketsPartial: 0,
  lastError:    null,
  stats:        null,
};

// ── Helpers de fetch ─────────────────────────────────────────────────────────
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

// ── Carga incremental con checkpoint ─────────────────────────────────────────
async function fetchIncremental() {
  const cp = loadCheckpoint();
  let items = cp ? [...cp.tickets] : [];
  let startUrl;

  if (cp && cp.afterUrl) {
    console.log(`Reanudando desde checkpoint: ${items.length} tickets ya cargados`);
    startUrl = cp.afterUrl;
  } else {
    console.log('Primera carga completa desde el inicio...');
    startUrl = BASE + '/incremental/tickets/cursor.json?start_time=0&per_page=100';
  }

  let url = startUrl;
  let page = 0;
  let lastAfterUrl = cp?.afterUrl || null;

  while (url) {
    page++;
    if (page % 10 === 0) console.log(`  Tickets: página ${page} (${items.length} total)...`);
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
      cache.ticketsPartial = items.filter(isValidTicket).length;
    }
    lastAfterUrl = data.after_url || null;
    if (data.end_of_stream === true) {
      saveCheckpoint(items, lastAfterUrl);
      url = null;
    } else {
      url = lastAfterUrl;
    }
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  return items;
}

// ── Filtrado de tickets válidos ───────────────────────────────────────────────
function isValidTicket(t) {
  if ((t.tags || []).includes('closed_by_merge')) return false;
  if (t.status === 'deleted') return false;
  if ((t.subject || '').toUpperCase().includes('INVALID TICKET')) return false;
  return true;
}

function getField(t, fieldId) {
  return (t.custom_fields || []).find(f => f.id === fieldId)?.value ?? null;
}

function getTipoCliente(t) { return getField(t, CF_TIPO_CLIENTE); }
function getPuntos(t)       { return getField(t, CF_PUNTOS); }

// ── Filtro de período ────────────────────────────────────────────────────────
function getDateRange(period) {
  const now = new Date();
  let start, end;
  if (period === 'current_week') {
    const day = now.getDay() || 7;
    const mon = new Date(now); mon.setDate(now.getDate() - day + 1); mon.setHours(0,0,0,0);
    start = mon; end = now;
  } else if (period === 'last_week') {
    const day = now.getDay() || 7;
    const mon = new Date(now); mon.setDate(now.getDate() - day - 6); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
    start = mon; end = sun;
  } else if (period === 'current_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = now;
  } else if (period === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end   = now;
  }
  return { start, end };
}

function inPeriod(ticket, start, end) {
  const d = new Date(ticket.created_at);
  return d >= start && d <= end;
}

// ── Métricas por técnico ─────────────────────────────────────────────────────
// Tiempos y SLA SOLO con minutos laborables (business). Sin fallback a calendar:
// si un ticket no tiene métrica business, queda fuera del cálculo.
function agentMetrics(tickets, metricsById) {
  const tipo1 = tickets.filter(t => getTipoCliente(t) === 'tipo_cliente_1');
  const tipo2 = tickets.filter(t => getTipoCliente(t) === 'tipo_cliente_2');
  const resolved = tickets.filter(t => t.status === 'solved' || t.status === 'closed').length;
  const puntos   = tickets.reduce((s, t) => s + (parseInt(getPuntos(t)) || 0), 0);
  const fr1  = tipo1.map(t => metricsById[t.id]?.reply_time_in_minutes?.business ?? null).filter(v => v !== null);
  const fr2  = tipo2.map(t => metricsById[t.id]?.reply_time_in_minutes?.business ?? null).filter(v => v !== null);
  const res1 = tipo1.map(t => metricsById[t.id]?.full_resolution_time_in_minutes?.business ?? null).filter(v => v !== null);
  const res2 = tipo2.map(t => metricsById[t.id]?.full_resolution_time_in_minutes?.business ?? null).filter(v => v !== null);
  const avg  = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
  const sla1pct = tipo1.length ? Math.round(tipo1.filter(t => { const v = metricsById[t.id]?.reply_time_in_minutes?.business; return v != null && v <= 15; }).length / tipo1.length * 100) : null;
  const sla2pct = tipo2.length ? Math.round(tipo2.filter(t => { const v = metricsById[t.id]?.reply_time_in_minutes?.business; return v != null && v <= 25; }).length / tipo2.length * 100) : null;
  return { total: tickets.length, resolved, puntos, avgFR: avg([...fr1,...fr2]), avgFR1: avg(fr1), avgFR2: avg(fr2), avgRes: avg([...res1,...res2]), avgRes1: avg(res1), avgRes2: avg(res2), sla1: sla1pct, sla2: sla2pct, tipo1cnt: tipo1.length, tipo2cnt: tipo2.length };
}

// ── Cálculo de estadísticas globales ─────────────────────────────────────────
function computeStats() {
  const metricsById = {};
  cache.metrics.forEach(m => { metricsById[m.ticket_id] = m; });
  const validTickets = cache.tickets.filter(isValidTicket);
  const techIds = new Set(TECNICOS.map(t => String(t.id)));
  const techTickets = validTickets.filter(t => techIds.has(String(t.assignee_id)));
  const result = {};
  for (const period of ['last_week', 'current_week', 'current_month', 'last_month', 'year']) {
    const { start, end } = getDateRange(period);
    const periodAll  = validTickets.filter(t => inPeriod(t, start, end));
    const periodTech = techTickets.filter(t => inPeriod(t, start, end));
    const TIPOS_VALIDOS = ['tipo_cliente_1', 'tipo_cliente_2'];
    const filtered = periodTech.filter(t => TIPOS_VALIDOS.includes(getTipoCliente(t)));
    const byAgent = {}, byAgentTickets = {};
    TECNICOS.forEach(tec => {
      const mine = filtered.filter(t => String(t.assignee_id) === tec.id);
      byAgent[tec.name] = agentMetrics(mine, metricsById);
      byAgentTickets[tec.id] = mine.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0,50).map(t => ({
        id: t.id, subject: t.subject, status: t.status, created_at: t.created_at,
        _puntos: parseInt(getPuntos(t)) || null, _tipo: getTipoCliente(t),
        _frMin: metricsById[t.id]?.reply_time_in_minutes?.business ?? null,
        _resMin: metricsById[t.id]?.full_resolution_time_in_minutes?.business ?? null,
      }));
    });
    result[period] = { totalRaw: periodAll.length, general: agentMetrics(filtered, metricsById), byAgent, techTickets: byAgentTickets };
  }
  return result;
}

// ── Carga en background ──────────────────────────────────────────────────────
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
    console.log('Cargando tickets...');
    const allTickets = await fetchIncremental();
    cache.tickets = allTickets.filter(isValidTicket);
    console.log(`Tickets válidos: ${cache.tickets.length}`);
    cache.loadingStage = 'metrics';
    console.log('Cargando métricas...');
    cache.metrics = await fetchAll(BASE + '/ticket_metrics.json?per_page=100');
    console.log(`Métricas: ${cache.metrics.length}`);
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

// ── Scan de llamadas (función interna, usada por endpoint y scheduler) ───────
let scanState = { running: false, lastRun: null, lastResult: null };

async function runScanLlamadas(desde, hasta, origen = 'manual') {
  if (scanState.running) { console.log('Scan de llamadas ya en curso, se omite.'); return; }
  scanState.running = true;
  console.log(`Scan llamadas (${origen}): ${desde} → ${hasta}`);
  try {
    const desdeTs = Math.floor(new Date(desde + 'T00:00:00Z').getTime() / 1000);
    const hastaTs = Math.floor(new Date(hasta + 'T23:59:59Z').getTime() / 1000);
    const techIds = new Set(TECNICOS.map(t => String(t.id)));
    let ticketsRango = cache.tickets.filter(t => {
      const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
      return ts >= desdeTs && ts <= hastaTs && techIds.has(String(t.assignee_id));
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
          return ts <= hastaTs && techIds.has(String(t.assignee_id)) && isValidTicket(t);
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
          if (consultados % 50 === 0) saveLlamadas(); // progreso parcial
        }
      } catch(e) { /* skip */ }
      await new Promise(r => setTimeout(r, 350));
    }
    llamadasCache.meta = {
      ...llamadasCache.meta,
      lastScan: new Date().toISOString(),
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
  } finally {
    scanState.running = false;
  }
}

// Scheduler: comprueba cada minuto; ejecuta scan si el caché está listo y han
// pasado >6h desde el último scan registrado en llamadas.json.
const SCAN_INTERVAL = 6 * 60 * 60 * 1000;
setInterval(() => {
  if (!cache.stats || cache.loading || scanState.running) return;
  const last = llamadasCache.meta?.lastScan ? new Date(llamadasCache.meta.lastScan).getTime() : 0;
  if (Date.now() - last < SCAN_INTERVAL) return;
  // Ventana: desde el último scan menos 3 días de margen (máx. 30 días atrás)
  const desdeMs = Math.max(last - 3 * 864e5, Date.now() - 30 * 864e5);
  const desde = new Date(desdeMs).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);
  runScanLlamadas(desde, hasta, 'auto');
}, 60 * 1000);

// Auto-refresh del caché principal: cada 30 min comprueba el TTL (6h).
// loadInBackground no toca cache.tickets hasta terminar, así que los dashboards
// siguen sirviendo los datos anteriores durante la recarga.
setInterval(() => { loadInBackground(false); }, 30 * 60 * 1000);

// ── Servir estáticos ──────────────────────────────────────────────────────────
// v4: los HTML se sirven con no-cache para que el navegador revalide siempre
// y reciba la versión nueva tras cada deploy (los JS/CSS van inline en los HTML).
const staticOpts = {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache, must-revalidate');
  },
};
app.use(express.static(path.join(__dirname, 'dashboards'), staticOpts));
app.use(express.static(path.join(__dirname), staticOpts));

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  let cp = null;
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try { const raw = JSON.parse(fs.readFileSync(CHECKPOINT_FILE,'utf8')); cp = { tickets: raw.tickets?.length || 0, savedAt: raw.savedAt, hasAfterUrl: !!raw.afterUrl }; } catch(e) {}
  }
  res.json({ ok: true, version: 'v4', time: new Date().toISOString(), cachedTickets: cache.tickets.length, cachedMetrics: cache.metrics.length, cacheAge: cache.loadedAt ? Math.round((Date.now()-cache.loadedAt)/1000)+'s' : 'none', loading: cache.loading, loadingStage: cache.loadingStage, ticketsPartial: cache.ticketsPartial, lastError: cache.lastError, statsReady: cache.stats !== null, checkpoint: cp, scanLlamadas: { running: scanState.running, lastRun: scanState.lastRun, lastResult: scanState.lastResult, lastScanMeta: llamadasCache.meta?.lastScan || null } });
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
  res.json({ ok: true, message: 'Recarga incremental iniciada (usando checkpoint).' });
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

// ── Endpoints llamadas ────────────────────────────────────────────────────────
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

app.get('/api/llamadas/stats', (req, res) => {
  if (!cache.stats) {
    if (!cache.loading) loadInBackground(false);
    return res.status(202).json({ error: 'Caché principal aún cargando', stage: cache.loadingStage, partial: cache.ticketsPartial, llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running } });
  }
  const period = req.query.period || 'current_month';
  const techIds = new Set(TECNICOS.map(t => String(t.id)));
  const { start, end } = getDateRange(period);
  // Universo: TODOS los tickets válidos asignados a técnicos en el período.
  // Sin filtro por tipo de cliente (alineado con el dashboard de Llamadas Externas).
  const ticketsPeriod = cache.tickets.filter(t => inPeriod(t, start, end) && techIds.has(String(t.assignee_id)) && isValidTicket(t));
  const total = ticketsPeriod.length;
  const conLlamada = ticketsPeriod.filter(t => tieneLlamada(t.id)).length;
  const byAgent = {};
  TECNICOS.forEach(tec => {
    const mine = ticketsPeriod.filter(t => String(t.assignee_id) === tec.id);
    const mineConLlamada = mine.filter(t => tieneLlamada(t.id)).length;
    if (mine.length > 0) byAgent[tec.name] = { total: mine.length, conLlamada: mineConLlamada, pct: Math.round(mineConLlamada/mine.length*100) };
  });
  res.json({ period, desde: start.toISOString().slice(0,10), hasta: end.toISOString().slice(0,10), total, conLlamada, pct: total ? Math.round(conLlamada/total*100) : null, byAgent, llamadasMeta: { ...(llamadasCache.meta || {}), scanning: scanState.running } });
});

// ── Endpoints compatibilidad legacy ──────────────────────────────────────────
app.get('/tickets', (req, res) => {
  if (cache.tickets.length === 0 && !cache.loading) loadInBackground(false);
  if (cache.tickets.length === 0 && cache.loading) {
    return res.status(202).json({ tickets: [], total: 0, loading: true, stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
  let tickets = cache.tickets;
  if (req.query.month) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets, total: tickets.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/metrics', (req, res) => {
  if (cache.metrics.length === 0 && !cache.loading) loadInBackground(false);
  if (cache.metrics.length === 0 && cache.loading) {
    return res.status(202).json({ metrics: [], total: 0, loading: true, stage: cache.loadingStage, partial: cache.ticketsPartial });
  }
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
  // v4: el /refresh legacy pasa a ser INCREMENTAL (usa checkpoint). La recarga
  // completa con borrado de checkpoint queda solo en /api/reload, para evitar
  // recargas de 20 minutos por error desde los dashboards.
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
  console.log(`\nServidor MP Ascensores v4 activo en puerto ${PORT}`);
  console.log('Endpoints: /health  /api/stats  /api/reload  /api/refresh  /api/tickets');
  console.log('Llamadas:  /api/llamadas/stats  /api/llamadas/scan  /api/llamadas/meta');
  console.log('v4: no-store en datos, no-cache en HTML, auto-refresh 6h, auto-scan llamadas 6h\n');
  loadInBackground(false);
});