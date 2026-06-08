const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3001;

const ZDOMAIN = 'mpascensoresatc';
const ZEMAIL = 'fbj@mpascensores.com';
const ZTOKEN = '3LpjcUPFnB9Fgk7mQwCRcVBHE17rz1GsJhBcZyXK';

const FIELD_TIPO_CLIENTE = 23076303407645;
const FIELD_PUNTOS = 19324034176285;
const VALID_TIPO = ['tipo_cliente_1','tipo_cliente_2','tipo_cliente_3'];
const TAG_FUSIONADO = 'closed_by_merge';

const TECNICOS = {
  '18823504352925': 'Amine Laaguidi',
  '22511063320093': 'Javier Sosa Jimenez',
  '19330437521693': 'Eduardo Robles Gamito',
  '19330468060189': 'Pedro Calvo Estallo',
  '22510403813533': 'Carlos Perez Osuna',
  '27405062363805': 'Raidel Alba',
  '35441820724509': 'Michael Prieto',
  '22829521407261': 'Ruud Barten',
  '27939255391261': 'Kamal Arrad',
  '24252949539869': 'Mar Durán',
  '25081523536157': 'Andreas Scheidl',
  '26600613366301': 'Alexis Didelot',
  '25238078751389': 'Nicklas Jonsson',
  '26600564602525': 'Antonio Gómez',
  '34726482176285': 'Multimarca',
  '24254682817949': 'Fernando Becerra',
};

app.use(cors({ allowedHeaders: ['ngrok-skip-browser-warning', 'Content-Type'] }));
app.use(express.json());

const auth = () => 'Basic ' + Buffer.from(`${ZEMAIL}/token:${ZTOKEN}`).toString('base64');

// ── Cache ─────────────────────────────────────────────────
let cache = { tickets: [], loadedAt: null, loading: false, loadingStage: 'idle', partial: 0, lastError: null };

function getCustomField(ticket, fieldId) {
  if (!ticket.custom_fields) return null;
  const f = ticket.custom_fields.find(f => String(f.id) === String(fieldId));
  return f ? f.value : null;
}

function isValidTicket(t) {
  if (t.tags && t.tags.includes(TAG_FUSIONADO)) return false;
  if (t.subject && t.subject.toUpperCase().includes('INVALID TICKET')) return false;
  const tc = getCustomField(t, FIELD_TIPO_CLIENTE);
  if (!tc || !VALID_TIPO.includes(String(tc))) return false;
  return true;
}

function enrichTicket(t) {
  t._valid = isValidTicket(t);
  t._tipoCliente = getCustomField(t, FIELD_TIPO_CLIENTE);
  t._puntos = parseFloat(getCustomField(t, FIELD_PUNTOS)) || 0;
  t._agentId = String(t.assignee_id);
  t._agentName = TECNICOS[String(t.assignee_id)] || `Agente ${t.assignee_id || '?'}`;
  return t;
}

async function fetchAllTickets() {
  const year = new Date().getFullYear();
  const startDate = `${year}-01-01`;
  let tickets = [], page = 1, hasMore = true;
      while (hasMore && page <= 120) {
    const url = `https://${ZDOMAIN}.zendesk.com/api/v2/tickets.json?page=${page}&per_page=100&sort_by=created_at&sort_order=desc`;
    const r = await fetch(url, { headers: { 'Authorization': auth() } });
    const d = await r.json();
    if (!r.ok) throw new Error(`Zendesk tickets error: ${JSON.stringify(d)}`);
    const batch = d.tickets || [];
    const filtered = batch.filter(t => new Date(t.created_at) >= new Date(startDate));
    filtered.forEach(enrichTicket);
    tickets = tickets.concat(filtered);
    const oldest = batch[batch.length - 1];
    if (!d.next_page || !oldest || new Date(oldest.created_at) < new Date(startDate)) hasMore = false;
    page++;
  }
  return tickets;
}

async function fetchMetrics(ticketId) {
  try {
    const r = await fetch(`https://${ZDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/metrics.json`, {
      headers: { 'Authorization': auth() }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.ticket_metric || null;
  } catch { return null; }
}

async function loadCache() {
  if (cache.loading) return;
  cache.loading = true;
  cache.lastError = null;
  try {
    cache.loadingStage = 'tickets';
    console.log('Cargando tickets...');
    const tickets = await fetchAllTickets();
    cache.tickets = tickets;
    cache.partial = 0;
    console.log(`${tickets.length} tickets cargados. Cargando métricas...`);
    cache.loadingStage = 'metrics';

    // Cargar métricas en lotes de 5 para no saturar la API
    const BATCH = 5;
    for (let i = 0; i < tickets.length; i += BATCH) {
      const batch = tickets.slice(i, i + BATCH);
      await Promise.all(batch.map(async t => {
        const m = await fetchMetrics(t.id);
        if (m) {
          t._frMin = m.reply_time_in_minutes ? m.reply_time_in_minutes.business : null;
          t._resMin = m.full_resolution_time_in_minutes ? m.full_resolution_time_in_minutes.business : null;
        } else {
          t._frMin = null; t._resMin = null;
        }
      }));
      cache.partial = i + BATCH;
      if ((i / BATCH) % 20 === 0) console.log(`Métricas: ${Math.min(i + BATCH, tickets.length)}/${tickets.length}`);
    }

    cache.loadedAt = new Date();
    cache.loadingStage = 'done';
    console.log('Cache completa.');
  } catch(e) {
    cache.lastError = e.message;
    cache.loadingStage = 'error';
    console.error('Error cargando cache:', e.message);
  } finally {
    cache.loading = false;
  }
}

// ── Endpoints ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date(),
    cachedTickets: cache.tickets.length,
    cachedMetrics: cache.tickets.filter(t => t._frMin !== undefined).length,
    cacheAge: cache.loadedAt ? Math.round((Date.now() - cache.loadedAt) / 1000) + 's' : null,
    loading: cache.loading,
    loadingStage: cache.loadingStage,
    ticketsPartial: cache.partial,
    lastError: cache.lastError
  });
});

app.get('/api/tickets', (req, res) => {
  if (cache.tickets.length === 0 && cache.loading) {
    return res.status(202).json({ loading: true, stage: cache.loadingStage, partial: cache.partial });
  }
  // Devolver solo los campos necesarios para el dashboard
  const slim = cache.tickets.map(t => ({
    id: t.id,
    created_at: t.created_at,
    status: t.status,
    subject: t.subject,
    assignee_id: t.assignee_id,
    _agentId: t._agentId,
    _agentName: t._agentName,
    _valid: t._valid,
    _tipoCliente: t._tipoCliente,
    _puntos: t._puntos,
    _frMin: t._frMin,
    _resMin: t._resMin,
  }));
  res.json({ tickets: slim, total: slim.length, loading: cache.loading, stage: cache.loadingStage, partial: cache.partial });
});

function getDateRange(period) {
  const now = new Date();
  let start, end;
  if (period === 'last_week') {
    const day = now.getDay() || 7;
    end = new Date(now); end.setDate(now.getDate() - day); end.setHours(23,59,59,999);
    start = new Date(end); start.setDate(end.getDate() - 6); start.setHours(0,0,0,0);
  } else if (period === 'current_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now);
  } else if (period === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth()-1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now);
  }
  return { start, end };
}

function calcMetrics(tickets) {
  const valid = tickets.filter(t => t._valid);
  const total = valid.length;
  const resolved = valid.filter(t => t.status === 'solved' || t.status === 'closed').length;
  const puntos = valid.reduce((s, t) => s + (t._puntos || 0), 0);
  const sla1T = valid.filter(t => t._tipoCliente === 'tipo_cliente_1');
  const sla2T = valid.filter(t => t._tipoCliente === 'tipo_cliente_2');

  const fr1 = sla1T.map(t => t._frMin).filter(v => v !== null && v !== undefined);
  const fr2 = sla2T.map(t => t._frMin).filter(v => v !== null && v !== undefined);
  const res1 = sla1T.map(t => t._resMin).filter(v => v !== null && v !== undefined);
  const res2 = sla2T.map(t => t._resMin).filter(v => v !== null && v !== undefined);

  return {
    total, resolved,
    puntos: Math.round(puntos * 10) / 10,
    avgFR1: fr1.length ? Math.round(fr1.reduce((a,b)=>a+b,0)/fr1.length) : null,
    avgFR2: fr2.length ? Math.round(fr2.reduce((a,b)=>a+b,0)/fr2.length) : null,
    avgRes1: res1.length ? Math.round(res1.reduce((a,b)=>a+b,0)/res1.length) : null,
    avgRes2: res2.length ? Math.round(res2.reduce((a,b)=>a+b,0)/res2.length) : null,
    sla1: fr1.length ? Math.round(fr1.filter(v=>v<=15).length/fr1.length*100) : null,
    sla2: fr2.length ? Math.round(fr2.filter(v=>v<=25).length/fr2.length*100) : null,
  };
}

app.get('/api/stats', (req, res) => {
  if (cache.loading && cache.tickets.length === 0)
    return res.status(202).json({ loading: true, stage: cache.loadingStage });

  const periods = ['last_week', 'current_month', 'last_month', 'year'];
  const result = {};

  for (const period of periods) {
    const { start, end } = getDateRange(period);
    const filtered = cache.tickets.filter(t => { const d = new Date(t.created_at); return d >= start && d <= end; });

    // General
    result[period] = {
      general: calcMetrics(filtered),
      totalRaw: filtered.length,
      byAgent: {}
    };

    // Por agente
    const byAgent = {};
    filtered.forEach(t => {
      const name = t._agentName || 'Sin asignar';
      if (!byAgent[name]) byAgent[name] = [];
      byAgent[name].push(t);
    });
    for (const [name, tickets] of Object.entries(byAgent)) {
      result[period].byAgent[name] = calcMetrics(tickets);
    }

    // Tickets recientes por técnico
    const TECH_IDS = ['18823504352925','22511063320093','19330437521693','19330468060189','22510403813533','27405062363805','35441820724509','22829521407261','27939255391261','24252949539869','25081523536157','26600613366301','25238078751389','26600564602525','34726482176285','24254682817949'];
    result[period].amineTickets = filtered.filter(t => t._agentId === '18823504352925' && t._valid).slice(0,20).map(t=>({id:t.id,subject:t.subject,status:t.status,created_at:t.created_at,_puntos:t._puntos,_frMin:t._frMin,_resMin:t._resMin}));
    result[period].techTickets = {};
    TECH_IDS.forEach(id => {
      result[period].techTickets[id] = filtered.filter(t => t._agentId === id && t._valid).slice(0,20).map(t=>({id:t.id,subject:t.subject,status:t.status,created_at:t.created_at,_puntos:t._puntos,_frMin:t._frMin,_resMin:t._resMin}));
    });
  }

  result._loading = cache.loading;
  result._stage = cache.loadingStage;
  res.json(result);
});

app.get('/api/reload', (req, res) => {
  cache = { tickets: [], loadedAt: null, loading: false, loadingStage: 'idle', partial: 0, lastError: null };
  loadCache();
  res.json({ ok: true, message: 'Recarga iniciada' });
});

app.get('/api/users', async (req, res) => {
  try {
    const role = req.query.role || 'agent';
    const r = await fetch(`https://${ZDOMAIN}.zendesk.com/api/v2/users.json?role=${role}&per_page=100`, {
      headers: { 'Authorization': auth() }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(d) });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Proxy corriendo en http://localhost:${PORT}`);
  loadCache();
});