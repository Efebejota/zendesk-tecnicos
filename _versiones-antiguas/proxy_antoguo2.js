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
    // detectar qué campo contiene los items
    const key = Object.keys(data).find(k => Array.isArray(data[k]) && k !== 'facets');
    if (key) items = items.concat(data[key]);
    url = data.next_page || null;
  }
  console.log(' -> ' + items.length + ' total');
  return items;
}

// Cache
let cache = {
  tickets: null,
  metrics: null,
  organizations: null,
  loadedAt: null
};
const CACHE_TTL = 10 * 60 * 1000;

async function loadAll(force) {
  const now = Date.now();
  if (!force && cache.tickets && cache.loadedAt && (now - cache.loadedAt < CACHE_TTL)) {
    return;
  }
  console.log('\n=== Cargando datos de Zendesk ===');

  console.log('Tickets...');
  const allTickets = await fetchAll(BASE + '/tickets.json?per_page=100&sort_by=created_at&sort_order=asc');
  cache.tickets = allTickets.filter(isValidTicket);
  console.log('Tickets validos: ' + cache.tickets.length + ' (excluidos: ' + (allTickets.length - cache.tickets.length) + ')');

  console.log('Ticket metrics...');
  cache.metrics = await fetchAll(BASE + '/ticket_metrics.json?per_page=100');
  console.log('Metrics: ' + cache.metrics.length);

  console.log('Organizations...');
  try {
    cache.organizations = await fetchAll(BASE + '/organizations.json?per_page=100');
    console.log('Orgs: ' + cache.organizations.length);
    // Indexar por id para lookup rápido
    const orgById = {};
    cache.organizations.forEach(o => { orgById[o.id] = o.name; });
    // Enriquecer tickets con nombre de organización
    cache.tickets = cache.tickets.map(t => ({
      ...t,
      organization_name: t.organization_id ? (orgById[t.organization_id] || 'Org '+t.organization_id) : null
    }));
  } catch(e) {
    console.log('No se pudieron cargar orgs: ' + e.message);
  }

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
