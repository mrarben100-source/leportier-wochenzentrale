import { createClient } from "npm:@supabase/supabase-js@2";

// Bexio-Anbindung der Wochenzentrale. Nur für Admins.
// Der Zugangsschlüssel kommt ausschliesslich aus dem Secret BEXIO_TOKEN (Personal Access Token).
// sync:            liest Kontakte, Kundenrechnungen, Lieferantenrechnungen und Konten (nur lesend)
//                  und verknüpft Lieferantenrechnungen mit bestehenden Einträgen (legt nichts neu an).
// invoice_paid:    bucht eine Zahlung auf eine Kundenrechnung in Bexio (nur auf ausdrücklichen Klick).
// bill_paid:       erfasst eine Zahlung zu einer Lieferantenrechnung in Bexio (nur auf ausdrücklichen Klick).
// contact_create:  legt einen Kontakt in Bexio an.
// check:           testet nur die Verbindung (GET) und meldet den genauen Fehler.
// fetch_pdf:       lädt ein PDF/Bild aus Bexio (Kundenrechnung oder Beleg) ins Archiv der Wochenzentrale.
// Es wird in Bexio nie etwas gelöscht, keine Zahlung ausgeführt (nur MANUAL = bereits erfolgte Zahlung
// verbuchen) und kein Abo geändert. Jede Schreibaktion wird in lp_changes protokolliert.
const API = "https://api.bexio.com";
const cors = {
  "Access-Control-Allow-Origin": "https://mrarben100-source.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

class BexioError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function bx(token: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new BexioError(r.status, `Bexio ${method} ${path}: ${r.status} ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  };
  // v2/v3: limit/offset und Array als Antwort; v4: page/limit und {data, paging}
  const all = async (path: string, v4 = false, max = 5000) => {
    const out: any[] = [];
    if (v4) {
      for (let page = 1; out.length < max; page++) {
        const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=100`);
        const d = Array.isArray(r) ? r : (r?.data ?? []);
        out.push(...d);
        const pc = r?.paging?.page_count ?? r?.paging?.pageCount;
        if (!d.length || (pc && page >= pc) || (!pc && d.length < 100)) break;
      }
    } else {
      for (let off = 0; out.length < max; off += 500) {
        const d = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=500&offset=${off}`);
        if (!Array.isArray(d)) break;
        out.push(...d);
        if (d.length < 500) break;
      }
    }
    return out;
  };
  // Datei roh herunterladen (Belege)
  const bin = async (path: string) => {
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "*/*" } });
    if (!r.ok) throw new BexioError(r.status, `Bexio GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") || "application/octet-stream" };
  };
  return { call, all, bin };
}

// Felder tolerant lesen (Bexio-Versionen unterscheiden sich)
const num = (...v: any[]) => { for (const x of v) { const n = parseFloat(x); if (x != null && x !== "" && !isNaN(n)) return Math.round(n * 100) / 100; } return null; };
const day = (v: any) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const contactName = (c: any) => [c?.name_1, c?.name_2].filter(Boolean).join(" ").trim();
const billFirma = (b: any, contacts: Map<string, any>) =>
  b.vendor || b.lastname_company || b.supplier_name || b.contact_name || contactName(contacts.get(String(b.contact_id ?? b.supplier_id ?? ""))) || "Lieferant";
const billAmount = (b: any) => num(b.amount_man, b.amount_calc, b.total_gross, b.gross, b.total, b.amount);
const billOpen = (b: any) => num(b.pending_amount, b.open_amount, b.amount_open);
const billPaid = (b: any) => /^paid$|^bezahlt/i.test(String(b.status ?? ""));
// Firmenname vergleichbar machen: Rechtsform und Sonderzeichen weg, Alias (Bank/Bexio-Name ≠ Gläubiger)
const ALIAS: [RegExp, string][] = [[/leons böden/i, "gezim"]];
const norm = (s: string) => { for (const [r, a] of ALIAS) if (r.test(s)) return a; return s.toLowerCase().replace(/\b(gmbh|ag|sa|sàrl|in|und|&)\b/g, " ").replace(/[^a-zäöüéèà0-9 ]/g, " ").replace(/\s+/g, " ").trim(); };
const sameFirm = (a: string, b: string) => { const x = norm(a).split(" ").filter((w) => w.length > 2), y = norm(b); return x.some((w) => y.includes(w)); };
const billCancelled = (b: any) => /cancel|storn/i.test(String(b.status ?? ""));
const billDraft = (b: any) => /draft|entwurf/i.test(String(b.status ?? ""));

// Datei aus Bexio holen und im Archiv der Wochenzentrale ablegen (Speicher lp-dokumente + lp_documents)
const MAXB = 10 * 1024 * 1024;
const safe = (n: string) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-90);
async function archive(sb: any, B: any, kind: string, id: string, meta?: any) {
  const lid = `bexio_${kind}_${id}`;
  const { data: ex } = await sb.from("lp_documents").select("library_file_id,file_name,record_id").eq("library_file_id", lid).maybeSingle();
  if (ex) return { doc: ex, existed: true };
  let bytes: Uint8Array, type: string, name: string, cat: string, folder: string, note: string, date: string | null;
  if (kind === "invoice") {
    const r = await B.call("GET", `/2.0/kb_invoice/${parseInt(id, 10)}/pdf`);
    bytes = Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0)); type = r.mime || "application/pdf";
    name = r.name || `Rechnung_${id}.pdf`; cat = "Buchhaltung"; folder = "vertraulich/buchhaltung";
    const { data: row } = await sb.from("lp_bexio").select("data").eq("kind", "invoice").eq("bexio_id", id).maybeSingle();
    date = row?.data?.is_valid_from ?? null; note = `Aus Bexio: Kundenrechnung ${row?.data?.document_nr ?? id}`;
  } else if (kind === "file") {
    if (!meta) { const { data: row } = await sb.from("lp_bexio").select("data").eq("kind", "file").eq("bexio_id", id).maybeSingle(); meta = row?.data ?? {}; }
    if (+(meta.size_in_bytes ?? meta.size ?? 0) > MAXB) return { error: `Beleg ${meta.name ?? id}: grösser als 10 MB, übersprungen` };
    const d = await B.bin(`/3.0/files/${parseInt(id, 10)}/download`);
    bytes = d.bytes; type = String(meta.mime_type || d.type).split(";")[0];
    name = String(meta.name || `Beleg_${id}`) + (meta.extension && !String(meta.name || "").includes(".") ? "." + meta.extension : "");
    cat = "Lieferantenrechnungen"; folder = "lieferantenrechnungen";
    date = String(meta.created_at ?? meta.uploaded_at ?? "").slice(0, 10) || null; note = `Aus Bexio: Beleg «${meta.name ?? id}»`;
  } else return { error: "Unbekannte Art" };
  if (!/pdf|jpe?g|png/i.test(type + " " + name)) return { error: `${name}: kein PDF/Bild, übersprungen` };
  if (bytes.length > MAXB) return { error: `${name}: grösser als 10 MB, übersprungen` };
  const { data: same } = await sb.from("lp_documents").select("library_file_id,file_name,record_id").eq("file_name", name).eq("size_bytes", bytes.length).not("storage_path", "is", null).maybeSingle();
  if (same) return { doc: same, existed: true };
  const path = `${folder}/${crypto.randomUUID().slice(0, 8)}-${safe(name)}`;
  const up = await sb.storage.from("lp-dokumente").upload(path, new Blob([bytes], { type }), { contentType: type });
  if (up.error) return { error: `${name}: Upload fehlgeschlagen (${up.error.message})` };
  const { data: doc, error } = await sb.from("lp_documents").insert({
    library_file_id: lid, file_name: name, category: cat, state: "in_supabase", storage_path: path,
    doc_date: date ? date.slice(0, 10) : null, modified_on: new Date().toISOString().slice(0, 10), size_bytes: bytes.length, notes: note,
  }).select("library_file_id,file_name,record_id,storage_path,category").single();
  if (error) return { error: `${name}: ${error.message}` };
  return { doc };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "Nicht angemeldet" }, 401);
    const { data: m } = await sb.from("lp_members").select("role").eq("user_id", user.id).maybeSingle();
    if (m?.role !== "admin") return json({ error: "Keine Berechtigung" }, 403);

    // häufige Kopierfehler entfernen: Leerzeichen/Zeilenumbrüche, Anführungszeichen, vorangestelltes «Bearer»
    const raw = Deno.env.get("BEXIO_TOKEN") || "";
    const token = raw.trim().replace(/^["']|["']$/g, "").replace(/^bearer\s+/i, "").replace(/\s+/g, "");
    if (!token) return json({ error: "not_configured" });
    const B = bx(token);
    const body = await req.json().catch(() => ({}));
    const log = (action: string, key: string, after: unknown) =>
      sb.from("lp_changes").insert({ actor_id: user.id, action, table_name: "bexio", row_key: key, after_value: after });

    // ---------- Verbindungstest (nur lesen) ----------
    if (body.action === "check") {
      const info: Record<string, unknown> = { token_set: true, token_length: token.length, token_cleaned: token !== raw, looks_like_jwt: token.split(".").length === 3 };
      for (const path of ["/3.0/users/me", "/2.0/company_profile", "/2.0/contact?limit=1"]) {
        try { const r = await B.call("GET", path); info[path] = { ok: true, sample: Array.isArray(r) ? `${r.length} Einträge` : Object.keys(r || {}).slice(0, 6) }; }
        catch (e) { info[path] = { ok: false, status: (e as BexioError).status ?? null, message: String((e as Error).message).slice(0, 240) }; }
      }
      console.warn("bexio check", JSON.stringify(info));
      return json({ check: info });
    }

    // ---------- Belege/PDFs ins Archiv (liest aus Bexio, schreibt nur in die Wochenzentrale) ----------
    if (body.action === "fetch_pdf") {
      const out = await archive(sb, B, String(body.kind), String(body.id));
      return json(out);
    }

    // ---------- Schreibaktionen ----------
    if (body.action === "invoice_paid") {
      const id = parseInt(body.id, 10), value = num(body.amount), date = day(body.date);
      if (!id || !value || !date) return json({ error: "Rechnung, Betrag und Datum nötig" }, 400);
      const r = await B.call("POST", `/2.0/kb_invoice/${id}/payment`, { value: value.toFixed(2), date });
      await log("bexio_invoice_paid", "invoice:" + id, { value, date, bank_tx: body.bank_tx ?? null, bexio: r });
      return json({ ok: true, result: r });
    }
    if (body.action === "bill_paid") {
      const id = String(body.id ?? ""), value = num(body.amount), date = day(body.date);
      if (!id || !value || !date) return json({ error: "Rechnung, Betrag und Datum nötig" }, 400);
      const r = await B.call("POST", `/4.0/purchase/outgoing-payments`, {
        bill_id: id, payment_type: "MANUAL" /* nur verbuchen, nie ausführen */, execution_date: date, amount: value, currency_code: body.currency || "CHF",
        note: "Erfasst aus der Wochenzentrale" + (body.bank_tx ? " (Bankbuchung " + body.bank_tx + ")" : ""),
      });
      await log("bexio_bill_paid", "bill:" + id, { value, date, bank_tx: body.bank_tx ?? null, bexio: r });
      return json({ ok: true, result: r });
    }
    if (body.action === "contact_create") {
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "Name fehlt" }, 400);
      const me = await B.call("GET", "/3.0/users/me");
      const r = await B.call("POST", "/2.0/contact", {
        contact_type_id: body.person ? 2 : 1, name_1: name.slice(0, 80), mail: body.mail || undefined,
        phone_fixed: body.phone || undefined, remarks: body.remarks || undefined, user_id: me.id, owner_id: me.id,
      });
      await log("bexio_contact_create", "contact:" + r?.id, { name, bexio_id: r?.id });
      return json({ ok: true, result: r });
    }

    // ---------- Abgleich (nur lesen) ----------
    if (body.action !== "sync") return json({ error: "Unbekannte Aktion" }, 400);
    const res: Record<string, any> = { counts: {}, warnings: [] as string[], status: {} as Record<string, number> };
    const now = new Date().toISOString();
    const keep = async (kind: string, items: any[]) => {
      const rows = items.filter((x) => x?.id != null).map((x) => ({ kind, bexio_id: String(x.id), data: x, synced_at: now }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from("lp_bexio").upsert(rows.slice(i, i + 500), { onConflict: "kind,bexio_id" });
        if (error) throw new Error("Speichern " + kind + ": " + error.message);
      }
      res.counts[kind] = rows.length;
    };
    const tryList = async (kind: string, f: () => Promise<any[]>) => {
      try { const d = await f(); await keep(kind, d); return d; }
      catch (e) {
        const msg = e instanceof BexioError && (e.status === 401 || e.status === 403)
          ? `${kind}: kein Zugriff (Berechtigung des Bexio-Schlüssels prüfen)`
          : e instanceof BexioError && e.status === 404 ? `${kind}: in Bexio nicht verfügbar (z. B. neues Einkaufs-Modul nicht aktiv)` : `${kind}: ${(e as Error).message}`;
        res.warnings.push(msg); res.status[kind] = (e as BexioError).status ?? 0; console.warn("bexio sync", msg); return [];
      }
    };
    const contacts = await tryList("contact", () => B.all("/2.0/contact"));
    const invoices = await tryList("invoice", () => B.all("/2.0/kb_invoice"));
    const bills = await tryList("bill", () => B.all("/4.0/purchase/bills", true));
    await tryList("account", () => B.all("/2.0/accounts"));
    await tryList("bank_account", () => B.call("GET", "/3.0/banking/accounts").then((d) => (Array.isArray(d) ? d : d?.data ?? [])));
    const files = await tryList("file", () => B.all("/3.0/files"));
    const st = Object.values(res.status) as number[];
    if (st.length >= 6 && st.every((s) => s === 401 || s === 403))
      return json({ error: st.every((s) => s === 401) ? "Bexio lehnt den Schlüssel ab (401) – Schlüssel ungültig oder abgelaufen" : "Dem Bexio-Schlüssel fehlen Berechtigungen (403)", warnings: res.warnings, status: res.status }, 502);

    // neue Belege ab 2025 automatisch ins Archiv (höchstens 20 pro Durchlauf)
    try {
      const since = "2025-01-01"; // alle Belege ab 2025 (Wunsch Arben), schrittweise je 20 pro Durchlauf
      const { data: have } = await sb.from("lp_documents").select("library_file_id").like("library_file_id", "bexio_%");
      const got = new Set((have ?? []).map((d: any) => d.library_file_id));
      const todo = files.filter((f: any) => !got.has("bexio_file_" + f.id) && String(f.created_at ?? f.uploaded_at ?? "").slice(0, 10) >= since && /pdf|jpe?g|png/i.test(String(f.mime_type ?? f.name ?? "")) && !(f.is_archived === true)).slice(0, 20);
      res.archived = [];
      for (const f of todo) { const a = await archive(sb, B, "file", String(f.id), f); if (a.doc) res.archived.push(a.doc.file_name); else if (a.error) res.warnings.push(a.error); }
    } catch (e) { res.warnings.push("Belege: " + (e as Error).message); }

    // Lieferantenrechnungen -> nur mit bestehenden Einträgen verknüpfen
    const cmap = new Map(contacts.map((c: any) => [String(c.id), c]));
    const { data: recs } = await sb.from("lp_records").select("id,source_key,title,amount_chf,status,details,notes,updated_at")
      .in("category", ["zahlung", "lieferant", "vertrag"]);
    const R = recs ?? [];
    let neu = 0, akt = 0, verkn = 0;
    for (const b of bills) {
      if (billDraft(b)) continue;
      const firma = billFirma(b, cmap), amt = billAmount(b), paid = billPaid(b), canc = billCancelled(b);
      const open = billOpen(b);
      const status = canc || paid ? "erledigt" : "offen";
      const det = { firma, bexio: { kind: "bill", id: String(b.id), nr: b.document_no ?? b.vendor_ref ?? null, status: b.status ?? null, open_amount: open } };
      // Nur verknüpfen, nie neu anlegen und keinen Status überschreiben: Die Wochenzentrale ist mit Bank und
      // Finanzübersicht abgeglichen; Unterschiede werden im Tab «Abgleich» per Klick angeglichen.
      const r = R.find((x: any) => x.details?.bexio?.kind === "bill" && x.details?.bexio?.id === String(b.id));
      if (r) {
        if (r.details?.bexio?.status !== det.bexio.status || r.details?.bexio?.open_amount !== det.bexio.open_amount) {
          await sb.from("lp_records").update({ details: { ...(r.details || {}), bexio: { ...det.bexio } } }).eq("id", r.id); akt++;
        }
        continue;
      }
      if (status === "erledigt") continue;
      const cand = R.filter((x: any) => !x.details?.bexio && x.status !== "erledigt" && sameFirm(firma, x.title + " " + (x.details?.firma ?? "")) &&
        x.amount_chf != null && [open, amt].some((v) => v != null && Math.abs(+x.amount_chf - v) <= 0.05));
      if (cand.length === 1) {
        const c = cand[0];
        await sb.from("lp_records").update({ details: { ...(c.details || {}), bexio: det.bexio },
          notes: (c.notes || "") + `\nBEXIO: verknüpft mit Lieferantenrechnung ${det.bexio.nr ?? b.id} (${b.status ?? "?"}).` }).eq("id", c.id);
        c.details = { ...(c.details || {}), bexio: det.bexio }; verkn++;
      } else neu++; // bleibt «nur in Bexio» – Entscheid im Tab «Abgleich»
    }
    res.bills = { nur_in_bexio: neu, aktualisiert: akt, verknuepft: verkn };
    res.synced_at = now;
    return json(res);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
