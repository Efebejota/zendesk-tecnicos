const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SUBDOMAIN = 'mpascensoresatc';
const EMAIL = 'fbj@mpascensores.com';
const TOKEN = '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';
const AUTH = Buffer.from(EMAIL + '/token:' + TOKEN).toString('base64');
const BASE = 'https://' + SUBDOMAIN + '.zendesk.com/api/v2';
const HEADERS = { 'Authorization': 'Basic ' + AUTH, 'Content-Type': 'application/json' };

// Servir el dashboard en / — reemplaza la URL del proxy dinámicamente
app.get('/', (req, res) => {
  const dashboardPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(dashboardPath)) {
    return res.send('<h2>Falta index.html en la carpeta del proxy</h2>');
  }
  let html = fs.readFileSync(dashboardPath, 'utf8');
  // Reemplazar la URL del proxy con la URL actual (funciona con localhost y con ngrok)
  const baseUrl = req.protocol + '://' + req.get('host');
  html = html.replace(/const PROXY = '[^']*';/, `const PROXY = '${baseUrl}';`);
  res.send(html);
});

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas

function isValidTicket(t) {
  // Excluir tickets fusionados o eliminados
  const tags = t.tags || [];
  if (tags.includes('closed_by_merge')) return false;
  if (t.status === 'deleted') return false;

  // Excluir tipificación "Invalid Ticket"
  const TIPIF_FIELD_ID = 19381692161437;
  const tipifField = (t.custom_fields || []).find(f => f.id === TIPIF_FIELD_ID);
  if (tipifField && tipifField.value === 'invalid_ticket') return false;

  // Excluir tickets sin tipo de cliente
  const TIPO_FIELD_ID = 23076303407645;
  const tipoField = (t.custom_fields || []).find(f => f.id === TIPO_FIELD_ID);
  if (!tipoField || !tipoField.value) return false;

  return true;
}

// Cache con estado de carga
let cache = {
  tickets: [],
  metrics: [],
  organizations: [],
  loadedAt: null,
  loading: false,
  loadingStage: 'idle', // idle | tickets | metrics | orgs | done | error
  ticketsPartial: 0,    // cuántos tickets se han cargado hasta ahora
  lastError: null
};

async function fetchAll(startUrl) {
  let items = [];
  let url = startUrl;
  while (url) {
    let r, retries = 0;
    while (true) {
      r = await fetch(url, { headers: HEADERS });
      if (r.status === 429) {
        const wait = parseInt(r.headers.get('retry-after') || '60');
        console.log(`  Rate limit, esperando ${wait}s...`);
        await new Promise(res => setTimeout(res, wait * 1000));
        continue;
      }
      // Reintentar errores temporales de Zendesk (502, 503, 504)
      if ([502, 503, 504].includes(r.status)) {
        retries++;
        if (retries > 5) throw new Error('Zendesk ' + r.status + ' (tras 5 reintentos)');
        const wait = retries * 30; // 30s, 60s, 90s, 120s, 150s
        console.log(`  Error ${r.status} (intento ${retries}/5), esperando ${wait}s...`);
        await new Promise(res => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) throw new Error('Zendesk ' + r.status);
      break;
    }
    const data = await r.json();
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'facets');
    if (key) items = items.concat(data[key]);
    url = data.next_page || null;
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  return items;
}

async function fetchIncremental() {
  let items = [];
  let url = BASE + '/incremental/tickets/cursor.json?start_time=0&per_page=100';
  let page = 0;
  while (url) {
    page++;
    if (page % 10 === 0) console.log(`  Tickets: pagina ${page} (${items.length} cargados)...`);
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
      // Actualizar caché parcial para que el dashboard pueda mostrar algo
      cache.ticketsPartial = items.filter(isValidTicket).length;
    }
    if (data.end_of_stream === true) {
      url = null;
    } else {
      url = data.after_url || null;
    }
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  return items;
}

// Carga en segundo plano — NO bloquea el servidor
async function loadInBackground(force) {
  if (cache.loading) {
    console.log('Ya hay una carga en curso, ignorando.');
    return;
  }
  const now = Date.now();
  if (!force && cache.loadedAt && (now - cache.loadedAt < CACHE_TTL) && cache.tickets.length > 0) {
    console.log('Cache vigente, no recargando.');
    return;
  }

  cache.loading = true;
  cache.loadingStage = 'tickets';
  cache.lastError = null;
  console.log('\n=== Iniciando carga en background ===');

  try {
    // 1. Tickets (incremental — trae todos los estados)
    console.log('Cargando tickets (todos los estados)...');
    const allTickets = await fetchIncremental();
    cache.tickets = allTickets.filter(isValidTicket);
    console.log(`Tickets validos: ${cache.tickets.length}`);

    // 2. Métricas
    cache.loadingStage = 'metrics';
    console.log('Cargando métricas...');
    cache.metrics = await fetchAll(BASE + '/ticket_metrics.json?per_page=100');
    console.log(`Metricas: ${cache.metrics.length}`);

    // 3. Organizaciones
    cache.loadingStage = 'orgs';
    console.log('Cargando organizaciones...');
    try {
      const orgs = await fetchAll(BASE + '/organizations.json?per_page=100');
      const orgById = {};
      orgs.forEach(o => { orgById[o.id] = o.name; });
      cache.tickets = cache.tickets.map(t => ({
        ...t,
        organization_name: t.organization_id ? (orgById[t.organization_id] || null) : null
      }));
      cache.organizations = orgs;
      console.log(`Organizaciones: ${orgs.length}`);
    } catch(e) {
      console.log('Organizaciones: error (no crítico) -', e.message);
    }

    cache.loadedAt = Date.now();
    cache.loadingStage = 'done';
    console.log('=== Carga completa ===\n');
  } catch(e) {
    cache.loadingStage = 'error';
    cache.lastError = e.message;
    console.error('Error en carga:', e.message);
  } finally {
    cache.loading = false;
  }
}

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    cachedTickets: cache.tickets.length,
    cachedMetrics: cache.metrics.length,
    cacheAge: cache.loadedAt ? Math.round((Date.now() - cache.loadedAt) / 1000) + 's' : 'none',
    loading: cache.loading,
    loadingStage: cache.loadingStage,
    ticketsPartial: cache.ticketsPartial,
    lastError: cache.lastError
  });
});

app.get('/tickets', (req, res) => {
  // Si no hay datos Y no está cargando, arrancar carga
  if (cache.tickets.length === 0 && !cache.loading) {
    loadInBackground(false);
    return res.status(202).json({ error: 'Cargando datos, intenta en unos minutos', loading: true });
  }
  // Si está cargando pero ya tiene datos parciales, devolverlos
  if (cache.tickets.length === 0 && cache.loading) {
    return res.status(202).json({ error: 'Cargando datos, intenta en unos minutos', loading: true, ticketsPartial: cache.ticketsPartial });
  }
  // Tiene datos — devolverlos siempre, aunque esté recargando en background
  let tickets = cache.tickets;
  if (req.query.month) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets, total: tickets.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/metrics', (req, res) => {
  if (cache.metrics.length === 0 && !cache.loading) {
    loadInBackground(false);
    return res.status(202).json({ error: 'Cargando datos, intenta en unos minutos', loading: true });
  }
  if (cache.metrics.length === 0 && cache.loading) {
    return res.status(202).json({ error: 'Cargando datos, intenta en unos minutos', loading: true });
  }
  res.json({ metrics: cache.metrics, total: cache.metrics.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/all', (req, res) => {
  if (cache.tickets.length === 0 && !cache.loading) {
    loadInBackground(false);
    return res.status(202).json({ error: 'Cargando datos, intenta en unos minutos', loading: true });
  }
  const metricsById = {};
  (cache.metrics || []).forEach(m => { metricsById[m.ticket_id] = m; });
  let combined = cache.tickets.map(t => ({ ...t, _metrics: metricsById[t.id] || null }));
  if (req.query.month) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.month));
  else if (req.query.year) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.year));
  res.json({ tickets: combined, total: combined.length, cachedAt: cache.loadedAt, loading: cache.loading });
});

app.get('/refresh', (req, res) => {
  // Dispara recarga en background y responde inmediatamente
  cache.tickets = [];
  cache.metrics = [];
  cache.loadedAt = null;
  loadInBackground(true);
  res.json({ ok: true, message: 'Recarga iniciada en background. Consulta /health para ver el progreso.' });
});

app.get('/sample', async (req, res) => {
  try {
    const r = await fetch(BASE + '/tickets.json?per_page=3&sort_by=created_at&sort_order=desc', { headers: HEADERS });
    const data = await r.json();
    res.json({ tickets: data.tickets || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/ticket_fields', async (req, res) => {
  try {
    const r = await fetch(BASE + '/ticket_fields.json', { headers: HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ARRANCAR ──────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3333, () => {
  console.log('Proxy Zendesk activo en puerto', process.env.PORT || 3333);
  console.log('Endpoints: /tickets /metrics /all /sample /health /refresh');
  // Lanzar carga en background al arrancar (no bloquea el servidor)
  loadInBackground(true);
});