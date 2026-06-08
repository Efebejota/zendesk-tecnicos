const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SUBDOMAIN = 'mpascensoresatc';
const EMAIL = 'fbj@mpascensores.com';
const TOKEN = '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';
const AUTH = Buffer.from(EMAIL + '/token:' + TOKEN).toString('base64');
const BASE = 'https://' + SUBDOMAIN + '.zendesk.com/api/v2';

const HEADERS = { 'Authorization': 'Basic ' + AUTH, 'Content-Type': 'application/json' };

function isValidTicket(ticket) {
  return !(ticket.tags || []).includes('closed_by_merge');
}

async function fetchAll(startUrl) {
  let items = [];
  let url = startUrl;
  let page = 0;
  while (url) {
    page++;
    process.stdout.write('\r  Pagina ' + page + ' (' + items.length + ' items)...');
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' en ' + url);
    const data = await r.json();
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'facets');
    if (key) items = items.concat(data[key]);
    url = data.next_page || null;
  }
  console.log(' -> ' + items.length + ' total');
  return items;
}

async function fetchAllIncremental(startTime) {
  let items = [];
  let url = BASE + `/incremental/tickets/cursor.json?start_time=${startTime}&per_page=100`;
  let page = 0;
  while (url) {
    page++;
    process.stdout.write('\r  Pagina ' + page + ' (' + items.length + ' items)...');
    const r = await fetch(url, { headers: HEADERS });
    // Rate limit: esperar y reintentar
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('retry-after') || '60');
      console.log(`\n  Rate limit alcanzado. Esperando ${retryAfter}s...`);
      await new Promise(res => setTimeout(res, retryAfter * 1000));
      continue; // reintentar la misma URL
    }
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' en ' + url);
    const data = await r.json();
    if (data.tickets) items = items.concat(data.tickets);
    if (data.end_of_stream === true) {
      url = null;
    } else {
      url = data.after_url || null;
    }
    // Pequeña pausa entre páginas para evitar rate limit
    if (url) await new Promise(res => setTimeout(res, 500));
  }
  console.log(' -> ' + items.length + ' total');
  return items;
}

// Cache
let cache = {
  tickets: null,
  metrics: null,
  loadedAt: null
};
const CACHE_TTL = 10 * 60 * 1000;

async function loadAll(force) {
  const now = Date.now();
  if (!force && cache.tickets && cache.loadedAt && (now - cache.loadedAt < CACHE_TTL)) {
    return;
  }
  console.log('\n=== Cargando datos de Zendesk ===');

  console.log('Tickets (exportación incremental - todos los estados)...');
  // start_time=0 significa desde el principio (epoch unix)
  // La API incremental devuelve TODOS los tickets: open, pending, hold, solved, closed, deleted
  const allTickets = await fetchAllIncremental(0);
  // Filtrar solo tickets (excluir los deleted que vienen con status='deleted')
  const onlyTickets = allTickets.filter(t => t.status !== 'deleted');
  cache.tickets = onlyTickets.filter(isValidTicket);
  console.log('Tickets validos: ' + cache.tickets.length + ' (excluidos deleted/merged: ' + (allTickets.length - cache.tickets.length) + ')');

  console.log('Ticket metrics...');
  cache.metrics = await fetchAll(BASE + '/ticket_metrics.json?per_page=100');
  console.log('Metrics: ' + cache.metrics.length);

  cache.loadedAt = Date.now();
  console.log('=== Carga completa ===\n');
}

// Health
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    cachedTickets: cache.tickets ? cache.tickets.length : 0,
    cachedMetrics: cache.metrics ? cache.metrics.length : 0,
    cacheAge: cache.loadedAt ? Math.round((Date.now() - cache.loadedAt) / 1000) + 's' : 'none'
  });
});

// Tickets
app.get('/tickets', async (req, res) => {
  try {
    await loadAll(req.query.refresh === 'true');
    let tickets = cache.tickets;
    if (req.query.month) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.month));
    else if (req.query.year) tickets = tickets.filter(t => (t.created_at||'').startsWith(req.query.year));
    res.json({ tickets, total: tickets.length, cachedAt: cache.loadedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Metrics
app.get('/metrics', async (req, res) => {
  try {
    await loadAll(false);
    res.json({ metrics: cache.metrics, total: cache.metrics.length, cachedAt: cache.loadedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Todo junto (tickets + metrics combinados por ticket_id)
app.get('/all', async (req, res) => {
  try {
    await loadAll(req.query.refresh === 'true');

    // Indexar metrics por ticket_id
    const metricsById = {};
    (cache.metrics || []).forEach(m => { metricsById[m.ticket_id] = m; });

    // Combinar
    let combined = cache.tickets.map(t => ({
      ...t,
      _metrics: metricsById[t.id] || null
    }));

    if (req.query.month) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.month));
    else if (req.query.year) combined = combined.filter(t => (t.created_at||'').startsWith(req.query.year));

    res.json({ tickets: combined, total: combined.length, cachedAt: cache.loadedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sample
app.get('/sample', async (req, res) => {
  try {
    const r = await fetch(BASE + '/tickets.json?per_page=3&sort_by=created_at&sort_order=desc', { headers: HEADERS });
    const data = await r.json();
    // Enriquecer con metrics
    const enriched = await Promise.all((data.tickets||[]).map(async t => {
      const mr = await fetch(BASE + '/tickets/' + t.id + '/metrics.json', { headers: HEADERS });
      const md = await mr.json();
      return { ...t, _metrics: md.ticket_metric || null };
    }));
    res.json({ tickets: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ticket fields
app.get('/ticket_fields', async (req, res) => {
  try {
    const r = await fetch(BASE + '/ticket_fields.json', { headers: HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Refresh forzado
app.get('/refresh', async (req, res) => {
  try {
    cache = { tickets: null, metrics: null, loadedAt: null };
    await loadAll(true);
    res.json({ ok: true, tickets: cache.tickets.length, metrics: cache.metrics.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3333, () => {
  console.log('Proxy Zendesk activo en http://localhost:3333');
  console.log('Filtro: excluye tickets con tag "closed_by_merge"');
  console.log('Endpoints: /tickets /metrics /all /sample /health /refresh');
});
