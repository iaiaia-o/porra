// La Porra del Cocido · función de servidor (Netlify Functions + Netlify Blobs)
// Ruta pública: /api/porra
//   GET                         → estado de la urna (cifras ocultas hasta el cierre)
//   POST { action: "vote" }     → sella una papeleta nueva (un alias = una papeleta, sin modificaciones)
//   POST { action: "evaluate" } → escrutinio final (solo tras el cierre y con ADMIN_KEY)
//
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   ADMIN_KEY     (obligatoria) clave para lanzar el escrutinio
//   DEADLINE_ISO  (opcional)    hora de cierre; por defecto 2026-11-28T00:00:00+01:00
//   STORE_NAME    (opcional)    nombre del almacén; úsalo para pruebas (p. ej. "porra-pruebas")

import { getStore } from "@netlify/blobs";

const PARTIES = [
  { id: "frente_amplio", name: "Frente Amplio" },
  { id: "pp", name: "PP" },
  { id: "psoe", name: "PSOE" },
  { id: "vox", name: "Vox" }
];
const MAX_SEATS = 350;
const DEFAULT_DEADLINE = "2026-11-28T00:00:00+01:00"; // viernes 27 nov a las 24:00, hora peninsular
const DEFAULT_STORE = "porra-cocido-2026";

function env(name) {
  try {
    const v = globalThis.Netlify?.env?.get(name);
    if (v !== undefined && v !== null && v !== "") return v;
  } catch {}
  return process.env[name];
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function deadlineMs() {
  const parsed = Date.parse(env("DEADLINE_ISO") || DEFAULT_DEADLINE);
  return Number.isNaN(parsed) ? Date.parse(DEFAULT_DEADLINE) : parsed;
}

function normalizeAlias(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

function aliasKey(alias) {
  return "vote:" + encodeURIComponent(alias.toLocaleLowerCase("es"));
}

// Valida un objeto { partido: escaños } → { ok, seats } o { ok:false, error }
function parseSeats(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "Faltan las cifras" };
  const seats = {};
  let total = 0;
  for (const p of PARTIES) {
    const v = Number(input[p.id]);
    if (!Number.isInteger(v) || v < 0 || v > MAX_SEATS) {
      return { ok: false, error: `Revisa los escaños de ${p.name} (número entero 0–${MAX_SEATS})` };
    }
    seats[p.id] = v;
    total += v;
  }
  if (total > MAX_SEATS) {
    return { ok: false, error: `La suma de los 4 partidos (${total}) supera los ${MAX_SEATS} escaños` };
  }
  return { ok: true, seats };
}

// Fórmula acordada: 100 - |est - real| * 100 / real, con mínimo 0 %.
// Si un partido obtiene 0 escaños: 100 % si se pronosticó 0, 0 % en otro caso.
function partyScore(est, real) {
  if (real === 0) return est === 0 ? 100 : 0;
  return Math.max(0, 100 - (Math.abs(est - real) * 100) / real);
}

async function loadVotes(store) {
  const { blobs } = await store.list({ prefix: "vote:" });
  const votes = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return votes
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export default async (req) => {
  const store = getStore({ name: env("STORE_NAME") || DEFAULT_STORE, consistency: "strong" });
  const closed = Date.now() >= deadlineMs();

  try {
    // ---------- LECTURA ----------
    if (req.method === "GET") {
      const votes = await loadVotes(store);
      const evaluation = await store.get("evaluation", { type: "json" });
      return json(200, {
        closed,
        deadline: new Date(deadlineMs()).toISOString(),
        serverTime: new Date().toISOString(),
        count: votes.length,
        // Hasta el cierre solo se publican los alias; las cifras viajan únicamente después.
        entries: votes.map((v) =>
          closed
            ? { alias: v.alias, createdAt: v.createdAt, picks: v.picks }
            : { alias: v.alias, createdAt: v.createdAt }
        ),
        evaluation: evaluation || null
      });
    }

    if (req.method !== "POST") return json(405, { error: "Método no permitido" });

    let body;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Datos ilegibles" });
    }

    // ---------- SELLAR PAPELETA ----------
    if (body.action === "vote") {
      if (closed) return json(403, { error: "La urna está cerrada por jornada de reflexión" });

      const alias = normalizeAlias(body.alias);
      if (alias.length < 2 || alias.length > 24) {
        return json(400, { error: "El alias debe tener entre 2 y 24 caracteres" });
      }

      const parsed = parseSeats(body.picks);
      if (!parsed.ok) return json(400, { error: parsed.error });

      const key = aliasKey(alias);
      const existing = await store.get(key, { type: "json" });
      if (existing) {
        return json(409, { error: "Ese alias ya tiene papeleta sellada. Elige otro alias." });
      }

      const entry = { alias, picks: parsed.seats, createdAt: new Date().toISOString() };
      await store.setJSON(key, entry);
      return json(201, { ok: true, entry });
    }

    // ---------- ESCRUTINIO ----------
    if (body.action === "evaluate") {
      const adminKey = env("ADMIN_KEY");
      if (!adminKey) return json(500, { error: "Falta configurar ADMIN_KEY en Netlify" });
      if (String(body.adminKey || "") !== adminKey) return json(401, { error: "Clave de administrador incorrecta" });
      if (!closed) return json(403, { error: "El escrutinio se abre después del cierre" });

      const parsed = parseSeats(body.real);
      if (!parsed.ok) return json(400, { error: parsed.error });
      const real = parsed.seats;

      const votes = await loadVotes(store);
      if (!votes.length) return json(400, { error: "No hay papeletas en la urna" });

      const ranking = votes.map((v) => {
        const detail = PARTIES.map((p) => {
          const est = v.picks[p.id];
          const r = real[p.id];
          return {
            party: p.name,
            est,
            real: r,
            diff: Math.abs(est - r),
            approx: Math.round(partyScore(est, r) * 100) / 100
          };
        });
        const avg = detail.reduce((s, d) => s + partyScore(d.est, d.real), 0) / PARTIES.length;
        const totalDiff = detail.reduce((s, d) => s + d.diff, 0);
        return { alias: v.alias, avg: Math.round(avg * 100) / 100, totalDiff, detail };
      });

      // Mayor media primero; desempate: menor desviación total; después, orden alfabético.
      ranking.sort((a, b) =>
        b.avg !== a.avg ? b.avg - a.avg
        : a.totalDiff !== b.totalDiff ? a.totalDiff - b.totalDiff
        : a.alias.localeCompare(b.alias, "es")
      );

      const evaluation = { real, ranking, savedAt: new Date().toISOString() };
      await store.setJSON("evaluation", evaluation);
      return json(200, { ok: true, evaluation });
    }

    return json(400, { error: "Acción desconocida" });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Error interno del servidor" });
  }
};

export const config = { path: "/api/porra" };
