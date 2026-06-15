/**
 * MP Ascensores — Módulo canónico
 * Fuente única de verdad para los KPIs del equipo TAT. Lee tecnicos.json del
 * DATA_DIR (o del repo) y expone las funciones que TODOS los dashboards deben
 * usar para clasificar tickets, evitando que cada cliente reinvente sus propias
 * reglas y produzca discrepancias.
 *
 * CANON:
 *   - Universo: solo tickets asignados a las entidades del equipo TAT (tech +
 *     mailbox). Los 'manager' (Fernando) NO entran en agregados — solo se
 *     exponen en el dashboard de Técnicos como referencia.
 *   - Tipo cliente: para volumen de KPIs solo Tipo 1 y Tipo 2. Tipo 3 y
 *     Sin Tipo quedan visibles en una tabla informativa aparte (no entran
 *     en los KPIs principales).
 *   - Ticket inválido: por asunto "INVALID TICKET" Y por tipificación
 *     'invalid_ticket'. Cualquiera de las dos invalida.
 *   - Tiempos y SLA: solo en minutos LABORABLES (business). Sin fallback a
 *     calendar. Si no hay métrica business, el ticket queda fuera del cálculo.
 *   - SLA: T1 ≤15 min business (objetivo 50%), T2 ≤25 min business (obj. 75%).
 *   - Semana: laborable, lunes-viernes.
 *   - Llamadas: VoiceComment outbound real (scan), NUNCA campo canal_telefono.
 */

const fs   = require('fs');
const path = require('path');

const CF_TIPO_CLIENTE = 23076303407645;
const CF_PUNTOS       = 19324034176285;
const CF_TIPIFICACION = 19381692161437;

const SLA_TARGET_T1 = 15;  // minutos laborables
const SLA_TARGET_T2 = 25;
const SLA_PCT_T1    = 50;  // % objetivo cumplimiento T1
const SLA_PCT_T2    = 75;

// ── Carga de tecnicos.json ───────────────────────────────────────────────────
// Prioriza DATA_DIR (volumen Railway con cambios en caliente) y cae al repo.
function loadTecnicos(dataDir) {
  const candidates = [
    dataDir ? path.join(dataDir, 'tecnicos.json') : null,
    path.join(__dirname, 'tecnicos.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = raw.tecnicos || raw;
        if (!Array.isArray(list)) throw new Error('formato inválido');
        console.log(`tecnicos.json cargado desde ${file}: ${list.length} entradas`);
        return list;
      } catch (e) { console.warn(`Error leyendo ${file}:`, e.message); }
    }
  }
  throw new Error('No se encontró tecnicos.json en DATA_DIR ni en el repo.');
}

// ── Helpers de campos ────────────────────────────────────────────────────────
function getField(t, fieldId) {
  return (t.custom_fields || []).find(f => f.id === fieldId)?.value ?? null;
}
function getTipoCliente(t)   { return getField(t, CF_TIPO_CLIENTE); }
function getPuntos(t)        { return parseInt(getField(t, CF_PUNTOS)) || 0; }
function getTipificacion(t)  { return getField(t, CF_TIPIFICACION); }

// ── Validación de ticket (canon: asunto Y tipificación) ──────────────────────
function isValidTicket(t) {
  if ((t.tags || []).includes('closed_by_merge')) return false;
  if (t.status === 'deleted') return false;
  if ((t.subject || '').toUpperCase().includes('INVALID TICKET')) return false;
  if (getTipificacion(t) === 'invalid_ticket') return false;
  return true;
}

// ── Universo del equipo TAT ──────────────────────────────────────────────────
function buildTeamSets(tecnicos) {
  const agregadosIds = new Set(); // tech + mailbox: cuentan en agregados
  const rankingIds   = new Set(); // solo tech: cuentan en ranking individual
  const mailboxIds   = new Set(); // buzones (etiquetados aparte en ranking)
  const allIds       = new Set(); // tech + mailbox + manager: cualquier referencia
  tecnicos.forEach(t => {
    allIds.add(String(t.id));
    if (t.role === 'tech') { agregadosIds.add(String(t.id)); rankingIds.add(String(t.id)); }
    else if (t.role === 'mailbox') { agregadosIds.add(String(t.id)); mailboxIds.add(String(t.id)); }
    // manager: NO entra en agregados
  });
  return { agregadosIds, rankingIds, mailboxIds, allIds };
}

// ── Rangos de fechas (semana laborable L-V) ──────────────────────────────────
function getDateRange(period, refDate) {
  const now = refDate || new Date();
  let start, end;
  if (period === 'current_week') {
    // Semana laborable actual: lunes 00:00 hasta hoy (o viernes 23:59:59 si ya estamos en sábado/domingo)
    const day = now.getDay() || 7;
    const mon = new Date(now); mon.setDate(now.getDate() - day + 1); mon.setHours(0,0,0,0);
    if (day >= 6) { // sábado o domingo: la semana ya cerró el viernes
      end = new Date(mon); end.setDate(mon.getDate() + 4); end.setHours(23,59,59,999);
    } else {
      end = now;
    }
    start = mon;
  } else if (period === 'last_week') {
    // Última semana cerrada: lunes a viernes (5 días laborables)
    const day = now.getDay() || 7;
    const monCur = new Date(now); monCur.setDate(now.getDate() - day + 1); monCur.setHours(0,0,0,0);
    start = new Date(monCur); start.setDate(monCur.getDate() - 7);
    end = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23,59,59,999);
  } else if (period === 'current_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = now;
  } else if (period === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else { // year
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end   = now;
  }
  return { start, end };
}

function inPeriod(ticket, start, end) {
  const d = new Date(ticket.created_at);
  return d >= start && d <= end;
}

// ── Numeración ISO de semana ─────────────────────────────────────────────────
// Número de semana ISO 8601 (lunes-domingo, primera semana es la que contiene
// el primer jueves del año). Útil para etiquetas tipo "S23".
function getISOWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// Rango de una semana N hacia atrás contando desde "ahora". weeksAgo=0 es la
// semana actual (parcial). weeksAgo=1 es la última cerrada. Semana laborable L-V.
function getWeekRangeBack(weeksAgo, refDate) {
  const now = refDate || new Date();
  const day = now.getDay() || 7;
  const monCur = new Date(now); monCur.setDate(now.getDate() - day + 1); monCur.setHours(0,0,0,0);
  const start = new Date(monCur); start.setDate(monCur.getDate() - weeksAgo * 7);
  const end = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23,59,59,999);
  return { start, end, isoWeek: getISOWeekNumber(start) };
}

// ── Rangos comparativos ──────────────────────────────────────────────────────
// Para un período, devuelve el "anterior" inmediato (mes-1, semana-1, año YTD = año anterior YTD).
function getPreviousRange(period, refDate) {
  const now = refDate || new Date();
  if (period === 'current_month') {
    // Mes anterior completo
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start, end, label: 'Mes anterior' };
  }
  if (period === 'last_month') {
    // Antepenúltimo mes (mes -2)
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0);
    const end   = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59, 999);
    return { start, end, label: 'Mes anterior' };
  }
  if (period === 'current_week') {
    const day = now.getDay() || 7;
    const monCur = new Date(now); monCur.setDate(now.getDate() - day + 1); monCur.setHours(0,0,0,0);
    const start = new Date(monCur); start.setDate(monCur.getDate() - 7);
    const end = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23,59,59,999);
    return { start, end, label: 'Semana anterior' };
  }
  if (period === 'last_week') {
    const day = now.getDay() || 7;
    const monCur = new Date(now); monCur.setDate(now.getDate() - day + 1); monCur.setHours(0,0,0,0);
    const start = new Date(monCur); start.setDate(monCur.getDate() - 14);
    const end = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23,59,59,999);
    return { start, end, label: 'Semana anterior' };
  }
  if (period === 'year') {
    // Año anterior YTD: enero a misma fecha del año pasado
    const start = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0);
    const end   = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { start, end, label: 'YTD año anterior' };
  }
  return null;
}

// Para un período, devuelve el "mismo período del año anterior" (comparativa estacional).
function getSamePeriodLastYear(period, refDate) {
  const now = refDate || new Date();
  if (period === 'current_month') {
    // Mismo mes año anterior, hasta el mismo día
    const start = new Date(now.getFullYear() - 1, now.getMonth(), 1, 0, 0, 0, 0);
    const end   = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { start, end, label: 'Mismo período año anterior' };
  }
  if (period === 'last_month') {
    // Mismo mes año anterior completo
    const y = now.getFullYear() - 1, m = now.getMonth() - 1;
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const end   = new Date(y, m + 1, 0, 23, 59, 59, 999);
    return { start, end, label: 'Mismo mes año anterior' };
  }
  if (period === 'year') {
    // YTD año anterior (igual que previous para 'year')
    return getPreviousRange('year', refDate);
  }
  // Semanas: no tiene mucho sentido la comparativa anual semanal exacta, devolvemos null
  return null;
}

// ── Tiempos (solo business, sin fallback) ────────────────────────────────────
function getBusinessFR(t, metricsById)  { return metricsById[t.id]?.reply_time_in_minutes?.business ?? null; }
function getBusinessRes(t, metricsById) { return metricsById[t.id]?.full_resolution_time_in_minutes?.business ?? null; }

function slaCumplido(t, metricsById) {
  const v = getBusinessFR(t, metricsById);
  if (v == null) return null;
  const tipo = getTipoCliente(t);
  if (tipo === 'tipo_cliente_1') return v <= SLA_TARGET_T1;
  if (tipo === 'tipo_cliente_2') return v <= SLA_TARGET_T2;
  return null; // solo T1 y T2 entran en SLA
}

// ── Filtros canónicos ────────────────────────────────────────────────────────
// Filtro 1: tickets del equipo (asignados a tech o mailbox) y válidos.
//          Base para volumen general, llamadas y métricas de actividad.
function teamTickets(allTickets, { agregadosIds }) {
  return allTickets.filter(t => isValidTicket(t) && agregadosIds.has(String(t.assignee_id)));
}

// Filtro 2: tickets canónicos para KPIs de tiempos/SLA: del equipo + Tipo 1 o Tipo 2.
function kpiTickets(teamT) {
  return teamT.filter(t => {
    const tp = getTipoCliente(t);
    return tp === 'tipo_cliente_1' || tp === 'tipo_cliente_2';
  });
}

// ── Métricas por agente (canónicas) ──────────────────────────────────────────
function avgRound(arr) { return arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : null; }

function computeAgentMetrics(tickets, metricsById) {
  const tipo1 = tickets.filter(t => getTipoCliente(t) === 'tipo_cliente_1');
  const tipo2 = tickets.filter(t => getTipoCliente(t) === 'tipo_cliente_2');
  const resolved = tickets.filter(t => t.status === 'solved' || t.status === 'closed').length;
  const puntos   = tickets.reduce((s, t) => s + getPuntos(t), 0);
  const fr1  = tipo1.map(t => getBusinessFR(t, metricsById)).filter(v => v !== null);
  const fr2  = tipo2.map(t => getBusinessFR(t, metricsById)).filter(v => v !== null);
  const res1 = tipo1.map(t => getBusinessRes(t, metricsById)).filter(v => v !== null);
  const res2 = tipo2.map(t => getBusinessRes(t, metricsById)).filter(v => v !== null);
  const sla1c = fr1.filter(v => v <= SLA_TARGET_T1).length;
  const sla2c = fr2.filter(v => v <= SLA_TARGET_T2).length;
  return {
    total: tickets.length, resolved, puntos,
    tipo1cnt: tipo1.length, tipo2cnt: tipo2.length,
    avgFR:  avgRound([...fr1, ...fr2]),
    avgFR1: avgRound(fr1), avgFR2: avgRound(fr2),
    avgRes: avgRound([...res1, ...res2]),
    avgRes1: avgRound(res1), avgRes2: avgRound(res2),
    sla1: fr1.length ? Math.round(sla1c / fr1.length * 100) : null,
    sla2: fr2.length ? Math.round(sla2c / fr2.length * 100) : null,
    sla1Den: fr1.length, sla2Den: fr2.length,
  };
}

// ── Resumen general del período (canónico) ───────────────────────────────────
function computePeriodSummary(tickets, metricsById) {
  return computeAgentMetrics(tickets, metricsById);
}

module.exports = {
  // constantes
  CF_TIPO_CLIENTE, CF_PUNTOS, CF_TIPIFICACION,
  SLA_TARGET_T1, SLA_TARGET_T2, SLA_PCT_T1, SLA_PCT_T2,
  // carga
  loadTecnicos, buildTeamSets,
  // helpers
  getField, getTipoCliente, getPuntos, getTipificacion,
  isValidTicket, getDateRange, inPeriod,
  getPreviousRange, getSamePeriodLastYear,
  getISOWeekNumber, getWeekRangeBack,
  getBusinessFR, getBusinessRes, slaCumplido,
  // filtros canónicos
  teamTickets, kpiTickets,
  // cálculos
  computeAgentMetrics, computePeriodSummary, avgRound,
};
