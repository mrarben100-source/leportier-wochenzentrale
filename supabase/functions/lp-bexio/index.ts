import { createClient } from "npm:@supabase/supabase-js@2";

// Bexio-Anbindung der Wochenzentrale. Nur für Admins.
// Der Zugangsschlüssel kommt ausschliesslich aus dem Secret BEXIO_TOKEN (Personal Access Token).
// sync:            liest Kontakte, Kundenrechnungen, Lieferantenrechnungen und Konten (nur lesend)
//                  und legt Lieferantenrechnungen als Einträge unter «Rechnungen» an bzw. aktualisiert sie.
// invoice_paid:    bucht eine Zahlung auf eine Kundenrechnung in Bexio (nur auf ausdrücklichen Klick).
// bill_paid:       erfasst eine Zahlung zu einer Lieferantenrechnung in Bexio (nur auf ausdrücklichen Klick).
// contact_create:  legt einen Kontakt in Bexio an.
// Es wird in Bexio nie etwas gelöscht. Jede Schreibaktion wird in lp_changes protokolliert.
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
  return { call, all };
}

// Felder tolerant lesen (Bexio-Versionen unterscheiden sich)
const num = (...v: any[]) => { for (const x of v) { const n = parseFloat(x); if (x != null && x !== "" && !isNaN(n)) return Math.round(n * 100) / 100; } return null; };
const day = (v: any) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const contactName = (c: any) => [c?.name_1, c?.name_2].filter(Boolean).join(" ").trim();
const billFirma = (b: any, contacts: Map<string, any>) =>
  b.lastname_company || b.supplier_name || b.contact_name || contactName(contacts.get(String(b.contact_id ?? b.supplier_id ?? ""))) || "Lieferant";
const billAmount = (b: any) => num(b.amount_man, b.amount_calc, b.total_gross, b.gross, b.total, b.amount);
const billOpen = (b: any) => num(b.pending_amount, b.open_amount, b.amount_open);
const billPaid = (b: any) => /^paid$|^bezahlt/i.test(String(b.status ?? ""));
const billCancelled = (b: any) => /cancel|storn/i.test(String(b.status ?? ""));
const billDraft = (b: any) => /draft|entwurf/i.test(String(b.status ?? ""));

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

    const token = Deno.env.get("BEXIO_TOKEN");
    if (!token) return json({ error: "not_configured" });
    const B = bx(token);
    const body = await req.json().catch(() => ({}));
    const log = (action: string, key: string, after: unknown) =>
      sb.from("lp_changes").insert({ actor_id: user.id, action, table_name: "bexio", row_key: key, after_value: after });

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
        bill_id: id, payment_type: "MANUAL", execution_date: date, amount: value, currency_code: body.currency || "CHF",
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
    const res: Record<string, any> = { counts: {}, warnings: [] as string[] };
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
        res.warnings.push(msg); return [];
      }
    };
    const contacts = await tryList("contact", () => B.all("/2.0/contact"));
    const invoices = await tryList("invoice", () => B.all("/2.0/kb_invoice"));
    const bills = await tryList("bill", () => B.all("/4.0/purchase/bills", true));
    await tryList("account", () => B.all("/2.0/accounts"));
    await tryList("bank_account", () => B.call("GET", "/3.0/banking/accounts").then((d) => (Array.isArray(d) ? d : d?.data ?? [])));
    if (!contacts.length && !invoices.length && !bills.length && res.warnings.length >= 4)
      return json({ error: "Bexio nicht erreichbar oder Schlüssel ungültig", warnings: res.warnings }, 502);

    // Lieferantenrechnungen -> Einträge unter «Rechnungen»
    const cmap = new Map(contacts.map((c: any) => [String(c.id), c]));
    const { data: recs } = await sb.from("lp_records").select("id,source_key,title,amount_chf,status,details,notes,updated_at")
      .in("category", ["zahlung", "lieferant", "vertrag"]);
    const R = recs ?? [];
    let neu = 0, akt = 0, verkn = 0;
    for (const b of bills) {
      if (billDraft(b)) continue;
      const key = "bexio-bill-" + b.id, firma = billFirma(b, cmap), amt = billAmount(b), paid = billPaid(b), canc = billCancelled(b);
      const open = billOpen(b);
      const status = canc || paid ? "erledigt" : "offen";
      const det = { firma, bexio: { kind: "bill", id: String(b.id), nr: b.document_no ?? b.vendor_ref ?? null, status: b.status ?? null, open_amount: open } };
      let r = R.find((x: any) => x.source_key === key || x.details?.bexio?.kind === "bill" && x.details?.bexio?.id === String(b.id));
      if (!r && amt != null) {
        const f = firma.toLowerCase().split(/\s+/)[0];
        const cand = R.filter((x: any) => !x.details?.bexio && x.amount_chf != null && Math.abs(+x.amount_chf - amt) <= 0.05 &&
          f.length > 2 && (x.title + " " + (x.details?.firma ?? "")).toLowerCase().includes(f));
        if (cand.length === 1) {
          r = cand[0];
          await sb.from("lp_records").update({ details: { ...(r.details || {}), ...det },
            notes: (r.notes || "") + `\nBEXIO: verknüpft mit Lieferantenrechnung ${det.bexio.nr ?? b.id} (${b.status ?? "?"}).` }).eq("id", r.id);
          verkn++; continue;
        }
      }
      if (r) {
        if (r.details?.bexio?.status !== det.bexio.status || (status === "erledigt" && r.status !== "erledigt")) {
          await sb.from("lp_records").update({ status: status === "erledigt" ? "erledigt" : r.status, details: { ...(r.details || {}), ...det } }).eq("id", r.id);
          akt++;
        }
        continue;
      }
      if (status === "erledigt") continue; // alte, bereits bezahlte Rechnungen nicht neu anlegen
      const { error } = await sb.from("lp_records").insert({
        source_key: key, category: "zahlung", status: "offen", priority: "mittel", responsible: "Arben",
        title: "Rechnung " + firma + (det.bexio.nr ? " – " + det.bexio.nr : ""), amount_chf: open ?? amt,
        due_date: day(b.due_date), notes: "Aus Bexio übernommen (Lieferantenrechnung, Status " + (b.status ?? "?") + ").", details: det,
      });
      if (error) res.warnings.push("Rechnung " + b.id + ": " + error.message); else neu++;
    }
    res.bills = { neu, aktualisiert: akt, verknuepft: verkn };
    res.synced_at = now;
    return json(res);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
