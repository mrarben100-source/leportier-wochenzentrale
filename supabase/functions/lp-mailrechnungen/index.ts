import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.171";
import { Buffer } from "node:buffer";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

// Rechnungen aus allen Ordnern des Hostpoint-Postfachs (ab 01.08.2025) ins Archiv übernehmen, auslesen und erfassen.
// - Ordner «Rechnungen» (jede Ebene): jede Mail mit PDF; übrige Ordner: nur Mails mit Rechnungs-Stichwort.
// - Eingehend → Lieferantenrechnung (Schuld, «zu prüfen»), selbst verschickt → Kundenrechnung (details.art 'kundenrechnung').
// - Bank: nur eindeutige Treffer (gleicher Betrag, passender Name, Datum danach) werden verknüpft.
// - Bexio: nichts wird automatisch gebucht; Abgleich bleibt in der App per Klick.
// Sicherheit: Postfach nur lesend, keine Eingaben, Rückgabe nur Zähler. Jede Mail wird sofort gespeichert (abgebrochene Läufe werden fortgesetzt).
const SEIT = new Date("2025-08-01T00:00:00Z"), MAXPDF = 8 * 1024 * 1024, PROLAUF = 8; // höchstens 8 PDFs pro Lauf (Rechenzeit-Grenze)
const cors = { "Access-Control-Allow-Origin": "https://mrarben100-source.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// echte Rechnungs-Stichwörter (ganze Wörter oder «Rechnung_123»), keine Jahres-/Erfolgsrechnungen, Abrechnungen, Bilanzen
const RE = /(^|[^a-zäöü])(rechnung|rechnungen|invoice|faktura|mahnung|zahlungserinnerung|facture|quittung)([^a-zäöü]|$)|rechnungs-?nr|rechnung_\d/i;
const NICHT = /jahresrechnung|erfolgsrechnung|bilanz|konkurs|abrechnung|lohn|offerte|angebot|vertrag|budget|kontoauszug|steuererkl/i;
const MAHN = /mahnung|zahlungserinnerung|betreibung|rappel|reminder/i;
const BESTELL = /auftragsbest|bestellbest|order confirmation|bestellung/i;
const SKIPBOX = /trash|papierkorb|gelöscht|deleted|junk|spam|draft|entw(ü|ue)rf/i;
const amt = (s: string) => { let x = s.replace(/['’\s]/g, ""); if (/,\d{2}$/.test(x)) x = x.replace(/\./g, "").replace(",", "."); else x = x.replace(/,/g, ""); return parseFloat(x); };
function total(t: string): { betrag: number; zeile: string } | null {
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const cand: { b: number; z: string; w: number }[] = [];
  lines.forEach((l, i) => {
    if (!/(total|gesamt|summe|endbetrag|rechnungsbetrag|zu bezahlen|zahlbetrag|betrag|montant|amount due)/i.test(l)) return;
    if (/zwischensumme|subtotal|mwst[- ]?betrag|rabatt|anzahl|menge|bereits bezahlt|anzahlung/i.test(l) && !/inkl/i.test(l)) return;
    const s = l + " " + (lines[i + 1] || "");
    for (const m of s.matchAll(/(?:CHF|Fr\.?|SFr\.?)?\s*(\d{1,3}(?:['’ .]\d{3})+[.,]\d{2}|\d+[.,]\d{2})\b/g)) {
      const b = amt(m[1]); if (!(b > 0 && b < 500000)) continue;
      cand.push({ b, z: l.slice(0, 120), w: /inkl|brutto|zu bezahlen|endbetrag|gesamtbetrag|rechnungsbetrag|total chf|zahlbetrag|montant total/i.test(l) ? 2 : 1 });
    }
  });
  if (!cand.length) return null;
  cand.sort((a, b) => b.w - a.w || b.b - a.b);
  return { betrag: Math.round(cand[0].b * 100) / 100, zeile: cand[0].z };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
function faellig(t: string, datum: Date): string | null {
  const m = t.match(/(zahlbar\s*bis|f(ä|ae)llig(keit)?(\s*am)?|zahlungsfrist|payable|due date|échéance|valuta)[^\d\n]{0,30}(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})/i);
  if (m) { const y = +m[7] < 100 ? 2000 + +m[7] : +m[7]; const d = new Date(Date.UTC(y, +m[6] - 1, +m[5])); if (!isNaN(+d)) return iso(d); }
  const n = t.match(/(zahlbar|zahlungsfrist|innert|innerhalb|netto)[^\d\n]{0,20}(\d{1,3})\s*tag/i);
  if (n && +n[2] <= 120) return iso(new Date(+datum + +n[2] * 864e5));
  return null;
}
const rnr = (t: string) => { const v = t.match(/(rechnungs?-?\s*(nr|nummer)|invoice\s*(no|number|#)|faktura\s*nr|facture\s*n[o°])\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{2,24})/i)?.[4] || null; return v && /\d/.test(v) ? v : null; };
const dom = (a?: string) => (a || "").split("@")[1]?.toLowerCase().replace(/^(mail|info|shop|order|noreply|no-reply|rechnung|billing|invoice)\./, "") || "";
const firma = (name?: string, addr?: string) => {
  const d = dom(addr).split(".").slice(-2, -1)[0] || "";
  const via = (name || "").match(/\(([^()]+?)\s+via\s+[\w.-]+\)/i)?.[1];
  if (via) return via.trim();
  const n = (name || "").replace(/["']/g, "").replace(/\b(no-?reply|info|rechnung(en)?|buchhaltung|billing|invoice|kundendienst|service|team)\b/gi, "").replace(/\s+/g, " ").trim();
  return n.length >= 3 && !/@/.test(n) ? n : d ? d.charAt(0).toUpperCase() + d.slice(1) : (addr || "Unbekannt");
};
const STOP = new Set(["ag", "gmbh", "sa", "sarl", "sàrl", "kg", "ltd", "inc", "und", "the", "der", "die", "das", "von", "info", "schweiz", "suisse", "switzerland", "bern", "zürich", "zurich"]);
const norm = (s: string) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function same(a: string, b: string) {
  const A = norm(a), B = norm(b); if (!A || !B) return false;
  const ca = A.replace(/ /g, ""), cb = B.replace(/ /g, "");
  if (ca.length >= 4 && cb.length >= 4 && (cb.includes(ca) || ca.includes(cb))) return true;
  return A.split(" ").filter((w) => w.length >= 4 && !STOP.has(w)).some((w) => B.split(" ").includes(w));
}
const safe = (n: string) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-90);
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
function pdfs(node: any, out: any[] = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name || "";
  if (/pdf/i.test(node.type + " " + name)) out.push({ part: node.part || "1", size: node.size ?? 0, name: name || "Rechnung.pdf" });
  for (const c of node.childNodes || []) pdfs(c, out);
  return out;
}
async function dl(client: ImapFlow, uid: number, part: string, max: number) {
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes: max });
  const ch: Uint8Array[] = []; for await (const c of content) ch.push(c as Uint8Array);
  return Buffer.concat(ch);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = Deno.env.get("HOSTPOINT_USER"), p = Deno.env.get("HOSTPOINT_PASS");
  if (!u || !p) return json({ error: "not_configured" });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const res: any = { ordner: [] as string[], kandidaten: 0, archiviert: 0, schon_im_archiv: 0, neue_rechnungen: 0, kundenrechnungen: 0, verknuepft: 0, mahnungen: 0, bank: 0, ohne_betrag: 0, fehler: 0 };
  const ownDom = dom(u), t0 = Date.now(); let n = 0;
  // Bekanntes vorab laden (Dubletten vermeiden, ohne Download)
  const docIds = new Set<string>(), docSig = new Set<string>();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("lp_documents").select("library_file_id,file_name,size_bytes").range(f, f + 999);
    for (const d of (data || []) as any[]) { docIds.add(d.library_file_id); docSig.add(d.file_name + "|" + d.size_bytes); }
    if (!data || data.length < 1000) break;
  }
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("lp_mail_seen").select("id").range(f, f + 999);
    for (const d of (data || []) as any[]) docIds.add(d.id);
    if (!data || data.length < 1000) break;
  }
  const seen = async (id: string, grund: string) => { docIds.add(id); await sb.from("lp_mail_seen").upsert({ id, grund }); };
  const recs: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("lp_records").select("id,title,status,amount_chf,source_key,details,notes,category").in("category", ["zahlung", "lieferant", "vertrag"]).range(f, f + 999);
    recs.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  const tx: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from("lp_bank_tx").select("id,booking_date,amount_chf,description,notes,record_id,review_state").neq("review_state", "duplikat").is("record_id", null).range(f, f + 999);
    tx.push(...(data || [])); if (!data || data.length < 1000) break;
  }
  const konten = [{ u, p, pre: "" }];
  const cu = Deno.env.get("CONTACT_USER"), cp = Deno.env.get("CONTACT_PASS");
  if (cu && cp) konten.push({ u: cu.trim(), p: cp, pre: "contact/" });
  for (const konto of konten) {
  if (Date.now() - t0 > 100000 || n >= PROLAUF) break;
  const client = new ImapFlow({ host: Deno.env.get("HOSTPOINT_IMAP_HOST") || "imap.mail.hostpoint.ch", port: 993, secure: true, auth: { user: konto.u, pass: konto.p }, logger: false });
  await client.connect();
  try {
    const boxes = (await client.list()).filter((b: any) => !b.flags?.has?.("\\Noselect") && !SKIPBOX.test(b.path) && !["\\Trash", "\\Junk", "\\Drafts"].includes(b.specialUse));
    for (const box of boxes) {
      if (Date.now() - t0 > 100000 || n >= PROLAUF) break; // Rest im nächsten Lauf
      const rechOrdner = /rechnung/i.test(box.path);
      res.ordner.push(konto.pre + box.path);
      const lock = await client.getMailboxLock(box.path, { readOnly: true });
      try {
        const uids = ((await client.search({ since: SEIT }, { uid: true })) || []) as number[];
        if (!uids.length) continue;
        const kand: any[] = [];
        for await (const m of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true }, { uid: true })) {
          const e: any = m.envelope || {}, subj = e.subject || "", P = pdfs(m.bodyStructure);
          if (!P.length) continue;
          const txt = subj + " " + P.map((x) => x.name).join(" ");
          if (NICHT.test(txt)) continue;
          if (!rechOrdner && (!RE.test(txt) || BESTELL.test(subj))) continue;
          const mid = hash(e.messageId || konto.pre + box.path + ":" + m.uid);
          const files = P.filter((x) => !docIds.has("mail_" + mid + "_" + safe(x.name))).slice(0, 3);
          if (!files.length) continue;
          kand.push({ uid: m.uid, e, subj, mid, files, date: e.date ? new Date(e.date) : new Date() });
        }
        res.kandidaten += kand.length;
        kand.sort((a, b) => +a.date - +b.date);
        for (const k of kand) {
          if (Date.now() - t0 > 110000 || n >= PROLAUF) break;
          const from = k.e.from?.[0] || {}, to = k.e.to?.[0] || {}, aus = dom(from.address) === ownDom, partner = aus ? to : from;
          const lf = firma(partner.name, partner.address), d = iso(k.date);
          if (!partner.address || dom(partner.address) === ownDom) continue; // interne Mails (info@ ↔ contact@)
          for (const f of k.files) {
            const id = "mail_" + k.mid + "_" + safe(f.name);
            try {
              if (f.size > MAXPDF * 1.4) { await seen(id, "zu gross"); continue; }
              if (n >= PROLAUF) break;
              const b = new Uint8Array(await dl(client, k.uid, f.part, MAXPDF));
              if (docSig.has(f.name + "|" + b.length)) { res.schon_im_archiv++; await seen(id, "schon im Archiv"); continue; }
              docIds.add(id); n++;
              let t = ""; try { const pdf = await getDocumentProxy(b.slice()); t = ((await extractText(pdf, { mergePages: false })).text as string[]).join("\n"); } catch (_) { /* gescanntes PDF ohne Text */ }
              t = t.replace(/\u0000/g, "").slice(0, 600000);
              const cat = aus ? "Kundenrechnungen" : "Lieferantenrechnungen", path = (aus ? "kundenrechnungen/" : "lieferantenrechnungen/") + crypto.randomUUID().slice(0, 8) + "-" + safe(f.name);
              const up = await sb.storage.from("lp-dokumente").upload(path, b, { contentType: "application/pdf" });
              if (up.error) throw up.error;
              const src = (aus ? "E-Mail an " : "E-Mail von ") + lf + " <" + (partner.address || "") + "> vom " + d.split("-").reverse().join(".") + " («" + k.subj.slice(0, 120) + "», Ordner " + konto.pre + box.path + ")";
              const di = await sb.from("lp_documents").insert({ library_file_id: id, file_name: f.name, category: cat, state: "in_supabase", storage_path: path, doc_date: d, modified_on: iso(new Date()), size_bytes: b.length, notes: src.slice(0, 300), content_text: t || null, content_at: new Date().toISOString() });
              if (di.error) throw di.error;
              docSig.add(f.name + "|" + b.length); res.archiviert++;
              // Auslesen und erfassen
              const tot = total(t), due = faellig(t, k.date), nr = rnr(t), mahn = MAHN.test(k.subj + " " + f.name);
              if (!tot) res.ohne_betrag++;
              const offen = (r: any) => r.status !== "erledigt" && !["bestellung", "wiederkehrend"].includes(r.details?.art);
              const nameOk = (r: any) => same(lf, r.title + " " + (r.details?.firma || "")) || (partner.address && same(dom(partner.address).split(".")[0], r.title + " " + (r.details?.firma || "")));
              let rec: any = null;
              if (!aus) {
                rec = recs.find((r) => offen(r) && r.details?.art !== "kundenrechnung" && nameOk(r) && ((tot && r.amount_chf != null && Math.abs(+r.amount_chf - tot.betrag) <= 0.05) || (nr && (r.details?.rechnung_nr === nr || (r.notes || "").includes(nr)))));
                if (!rec && mahn) rec = recs.find((r) => offen(r) && r.details?.art !== "kundenrechnung" && nameOk(r));
                // über Bexio verschickte Rechnungen sind meist schon als Bexio-Lieferantenrechnung erfasst → nur verknüpfen
                if (!rec && /bexio/i.test((from.name || "") + " " + (from.address || ""))) rec = recs.find((r) => r.details?.art !== "kundenrechnung" && r.details?.bexio && nameOk(r));
              }
              const notiz = `\nMAIL ${d}: ${mahn ? "Mahnung/Zahlungserinnerung" : "Rechnung"} «${f.name}» (${src})` + (tot ? `, Betrag CHF ${tot.betrag.toFixed(2)}` : "") + (due ? `, fällig ${due.split("-").reverse().join(".")}` : "") + ".";
              if (rec) {
                await sb.from("lp_records").update({ notes: (rec.notes || "") + notiz, details: { ...(rec.details || {}), ...(nr && !rec.details?.rechnung_nr ? { rechnung_nr: nr } : {}), ...(mahn ? { mahnung_am: d } : {}) } }).eq("id", rec.id);
                rec.notes = (rec.notes || "") + notiz;
                await sb.from("lp_documents").update({ record_id: rec.id }).eq("library_file_id", id);
                mahn ? res.mahnungen++ : res.verknuepft++;
              } else {
                const det: any = { quelle: "email", firma: lf, absender: partner.address || null, ordner: konto.pre + box.path, rechnung_nr: nr, mail_betreff: k.subj.slice(0, 200), betrag_zeile: tot?.zeile || null, ...(aus ? { art: "kundenrechnung" } : {}), ...(mahn ? { mahnung_am: d } : {}) };
                const title = (aus ? "Kundenrechnung " : mahn ? "Mahnung " : "Rechnung ") + lf + (nr ? " – " + nr : "");
                const ins = await sb.from("lp_records").insert({ source_key: "mailrechnung-" + k.mid + "-" + hash(f.name), category: "zahlung", title, status: aus ? "offen" : "zu_pruefen", priority: "mittel", amount_chf: tot?.betrag ?? null, due_date: due, responsible: "Arben", evidence: f.name,
                  notes: `Automatisch aus ${src}. Betrag${due ? " und Fälligkeit" : ""} aus dem PDF gelesen (${tot ? "«" + tot.zeile + "»" : "nicht erkannt"}) – bitte prüfen. Keine Zahlung ausgelöst, nichts in Bexio gebucht.`, details: det }).select("id,title,status,amount_chf,source_key,details,notes,category").single();
                if (ins.error) { if (!/duplicate/i.test(ins.error.message)) throw ins.error; continue; }
                rec = ins.data; recs.push(rec);
                await sb.from("lp_documents").update({ record_id: rec.id }).eq("library_file_id", id);
                aus ? res.kundenrechnungen++ : res.neue_rechnungen++;
              }
              // Bank: genau eine passende Buchung → verknüpfen
              if (tot && !mahn) {
                const sign = aus ? 1 : -1, bis = iso(new Date(+k.date + 150 * 864e5)), ab = iso(new Date(+k.date - 5 * 864e5));
                const hits = tx.filter((x) => !x.record_id && Math.abs(+x.amount_chf - sign * tot.betrag) <= 0.05 && x.booking_date >= ab && x.booking_date <= bis && (same(lf, x.description || "") || (partner.address && same(dom(partner.address).split(".")[0], x.description || ""))));
                if (hits.length === 1) {
                  const h = hits[0], n = ((h.notes || "") + ` ${aus ? "Zahlungseingang zu" : "Zahlung zu"} «${rec.title}» (aus Mail-Rechnung, automatisch) am ${iso(new Date()).split("-").reverse().join(".")}.`).trim();
                  await sb.from("lp_bank_tx").update({ record_id: rec.id, notes: n }).eq("id", h.id); h.record_id = rec.id; res.bank++;
                  await sb.from("lp_records").update({ notes: (rec.notes || "") + `\nBANK: ${aus ? "Zahlungseingang" : "Zahlung"} am ${h.booking_date.split("-").reverse().join(".")} über CHF ${Math.abs(+h.amount_chf).toFixed(2)} gefunden und verknüpft.` }).eq("id", rec.id);
                }
              }
            } catch (err) { res.fehler++; console.warn("lp-mailrechnungen", box.path, f.name, String((err as Error)?.message ?? err)); }
          }
        }
      } finally { lock.release(); }
    }
  } catch (e) {
    console.warn("lp-mailrechnungen", konto.u, String((e as Error)?.message ?? e)); res.fehler++;
  } finally { await client.logout().catch(() => {}); }
  }
  res.ordner = res.ordner.length; res.fertig = n < PROLAUF; // nur Zähler zurückgeben
  return json(res);
});
