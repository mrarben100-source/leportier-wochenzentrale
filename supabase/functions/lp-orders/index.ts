import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.171";
import { Buffer } from "node:buffer";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

// Liest Bestellungen (Ordner «Gesendet») und Bestellbestätigungen (Posteingang) aus dem Hostpoint-Postfach
// und legt pro Bestellung einen Eintrag in lp_records an (category 'lieferant', details.art 'bestellung').
// Sicherheit: Postfach wird nur lesend geöffnet (nichts markiert, verschoben, gelöscht, gesendet).
// Nimmt keine Eingaben an und gibt keine Inhalte zurück – nur Zähler. Aufruf alle 30 Minuten per pg_cron.
// Jede Mail wird sofort gespeichert; bereits verarbeitete Mails werden ohne Download übersprungen (ein abgebrochener Lauf wird beim nächsten fortgesetzt).
const SEIT = new Date("2025-08-01T00:00:00Z"), MAXPDF = 5 * 1024 * 1024, MAXTXT = 40000;
const cors = { "Access-Control-Allow-Origin": "https://mrarben100-source.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const BEST = /bestellbest(ä|ae)tigung|auftragsbest(ä|ae)tigung|bestellungsbest(ä|ae)tigung|order confirmation|confirmation de commande|ihre bestellung|deine bestellung|bestellung (nr|#|eingegangen|erhalten)|best(ä|ae)tigung (ihrer|deiner) bestellung/i;
const BESTELL = /bestell|order|commande/i;
const SKIP = /newsletter|mahnung|zahlungserinnerung|unsubscribe|abmelden/i, REPLY = /^\s*(re|aw|fw|fwd|wg)\s*:/i;
const strip = (s: string) => s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ");
const amt = (s: string) => { let x = s.replace(/['’\s]/g, ""); if (/,\d{2}$/.test(x)) x = x.replace(/\./g, "").replace(",", "."); else x = x.replace(/,/g, ""); return parseFloat(x); };

// Gesamtbetrag finden: Zeilen mit Total/Gesamt/Summe…, bevorzugt «inkl. MWST»; höchster Betrag dieser Zeilen
function total(t: string): { betrag: number; zeile: string } | null {
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const cand: { b: number; z: string; w: number }[] = [];
  lines.forEach((l, i) => {
    if (!/(total|gesamt|summe|endbetrag|rechnungsbetrag|zu bezahlen|zahlbetrag|bestellwert|betrag)/i.test(l)) return;
    if (/zwischensumme|subtotal|mwst[- ]?betrag|rabatt|versand(kosten)?\s*[:\d]|anzahl|menge/i.test(l) && !/inkl/i.test(l)) return;
    const s = l + " " + (lines[i + 1] || "");
    for (const m of s.matchAll(/(?:CHF|Fr\.?|SFr\.?)?\s*(\d{1,3}(?:['’ .]\d{3})+[.,]\d{2}|\d+[.,]\d{2})\b/g)) {
      const b = amt(m[1]); if (!(b > 0 && b < 200000)) continue;
      cand.push({ b, z: l.slice(0, 120), w: (/inkl|brutto|zu bezahlen|endbetrag|gesamtbetrag|total chf/i.test(l) ? 2 : 1) });
    }
  });
  if (!cand.length) return null;
  cand.sort((a, b) => b.w - a.w || b.b - a.b);
  return { betrag: Math.round(cand[0].b * 100) / 100, zeile: cand[0].z };
}
const dom = (a?: string) => (a || "").split("@")[1]?.toLowerCase().replace(/^(mail|info|shop|order|noreply|no-reply)\./, "") || "";
const firma = (name?: string, addr?: string) => {
  const d = dom(addr).split(".").slice(-2, -1)[0] || "";
  const n = (name || "").replace(/["']/g, "").replace(/\b(no-?reply|info|bestellung(en)?|order(s)?|kundendienst|service|team)\b/gi, "").trim();
  return n.length >= 3 && !/@/.test(n) ? n : d ? d.charAt(0).toUpperCase() + d.slice(1) : (addr || "Lieferant");
};
function textPart(node: any, want: string): string | null {
  if (!node) return null;
  if (node.type === want && node.disposition !== "attachment") return node.part || "1";
  for (const c of node.childNodes || []) { const p = textPart(c, want); if (p) return p; }
  return null;
}
function pdfs(node: any, out: any[] = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name || "";
  if (/pdf/i.test(node.type + " " + name)) out.push({ part: node.part || "1", size: node.size ?? 0, name });
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
  const res = { gesendet: 0, bestaetigungen: 0, neu: 0, aktualisiert: 0, ohne_betrag: 0, fehler: 0, ordner: "" };
  const own = u.toLowerCase(), ownDom = dom(u);
  const client = new ImapFlow({ host: Deno.env.get("HOSTPOINT_IMAP_HOST") || "imap.mail.hostpoint.ch", port: 993, secure: true, auth: { user: u, pass: p }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find((b: any) => b.specialUse === "\\Sent") || boxes.find((b: any) => /^(inbox\.)?(sent|gesendet|gesendete)/i.test(b.path));
    res.ordner = "INBOX" + (sent ? "+" + sent.path : "");
    const since = SEIT;
    const lieferDom = new Set<string>(), known = new Set<string>();
    const keyOf = (mid: string) => "mail-bestellung-" + String(mid).replace(/[<>\s"\\,()]/g, "").slice(0, 180);
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("lp_records").select("source_key,details->>bestaetigung_keys,details->>lieferant_domain").eq("category", "lieferant").eq("details->>art", "bestellung").range(from, from + 999);
      for (const r of (data || []) as any[]) { if (r.source_key) known.add(r.source_key); String(r.bestaetigung_keys || "").split("|").filter(Boolean).forEach((k) => known.add(k)); if (r.lieferant_domain) lieferDom.add(r.lieferant_domain); }
      if (!data || data.length < 1000) break;
    }
    async function handle(f: any) {
      f.typ === "gesendet" ? res.gesendet++ : res.bestaetigungen++;
      const key = f.key; known.add(key);
      const lf = firma(f.partner.name, f.partner.address), d = f.date.toISOString().slice(0, 10), tot = total(f.text || "");
      const voll = (f.text || "").replace(/\r/g, "").replace(/\n\s*\n+/g, "\n").replace(/[ \t]+/g, " ").trim(), auszug = voll.length > 4500 ? voll.slice(0, 1500) + "\n…\n" + voll.slice(-3000) : voll;
      if (f.typ === "bestaetigung") {
        // Stardrinks & Co. teilen eine Bestellung oft auf mehrere Auftragsbestätigungen auf:
        // alle Bestätigungen bis 14 Tage nach der Bestellung werden zur letzten Bestellung davor gezählt (pro Bestell-Nr. die neueste).
        const von = new Date(+f.date - 14 * 864e5).toISOString().slice(0, 10);
        const { data: kand } = await sb.from("lp_records").select("id,notes,details,amount_chf").eq("category", "lieferant").eq("details->>art", "bestellung").eq("details->>lieferant_domain", dom(f.partner.address)).gte("details->>bestelldatum", von).lte("details->>bestelldatum", d).order("details->>bestelldatum", { ascending: false }).limit(1);
        const k = kand?.[0];
        const nr = (f.text || "").match(/Bestell-?\s*Nr\.?\s*:?\s*(\d{5,})/i)?.[1] || f.subj.match(/(\d{7,})/)?.[1] || key;
        if (k) {
        const B: Record<string, any> = { ...(k.details?.bestaetigungen || {}) };
        const keys = (k.details?.bestaetigung_keys || "|") + key + "|";
        if (tot) B[nr] = { betrag: tot.betrag, datum: d, zeile: tot.zeile };
        const sum = Math.round(Object.values(B).reduce((a: number, x: any) => a + (+x.betrag || 0), 0 as number) * 100) / 100;
        const note = tot ? `\nBESTÄTIGUNG ${d} (Nr. ${nr}): CHF ${tot.betrag.toFixed(2)} («${tot.zeile}»)` + (Object.keys(B).length > 1 ? ` – Total aller Bestätigungen CHF ${sum.toFixed(2)}.` : ".") : `\nBESTÄTIGUNG ${d} («${f.subj.slice(0, 80)}»): erhalten, Betrag nicht automatisch erkannt – bitte im Mail nachsehen.`;
        const auszuege = { ...(k.details?.bestaetigung_auszuege || {}) }; auszuege[nr] = auszug.slice(-2500);
        await sb.from("lp_records").update({ ...(tot ? { amount_chf: sum, status: "offen" } : {}), notes: (k.notes || "") + note, details: { ...k.details, bestaetigungen: B, bestaetigung_keys: keys, bestaetigung_auszuege: auszuege, ...(Object.keys(B).length ? { betrag_bestaetigt: true, betrag_ungefaehr: false, betrag_quelle: "Bestellbestätigung" } : {}) } }).eq("id", k.id);
        tot ? res.aktualisiert++ : res.ohne_betrag++;
        return;
        }
        // keine gesendete Bestellung (z. B. telefonisch/Shop): Bestätigung wird zur eigenen Bestellung
      }
      if (!tot) res.ohne_betrag++;
      const nr0 = f.typ === "bestaetigung" ? ((f.text || "").match(/Bestell-?\s*Nr\.?\s*:?\s*(\d{5,})/i)?.[1] || f.subj.match(/(\d{7,})/)?.[1] || key) : null;
      const det = { art: "bestellung", quelle: "mail", ordner: f.typ === "gesendet" ? "Gesendet" : "Posteingang", lieferant_name: lf, lieferant_domain: dom(f.partner.address), firma: lf, bestelldatum: d, mail_betreff: f.subj.slice(0, 200), positionen_text: auszug || null, betrag_bestaetigt: f.typ === "bestaetigung" && !!tot, betrag_ungefaehr: !(f.typ === "bestaetigung" && tot), betrag_quelle: tot ? (f.typ === "bestaetigung" ? "Bestellbestätigung" : "Bestellmail") : null,
        ...(nr0 ? { bestaetigungen: tot ? { [nr0]: { betrag: tot.betrag, datum: d, zeile: tot.zeile } } : {}, bestaetigung_keys: "|" + key + "|", bestaetigung_auszuege: { [nr0]: auszug.slice(-2500) }, ohne_bestellmail: true } : {}) };
      const { error } = await sb.from("lp_records").insert({ source_key: key, category: "lieferant", title: "Bestellung " + lf + " " + d.slice(8) + "." + d.slice(5, 7) + "." + d.slice(0, 4), status: tot ? "offen" : "zu_pruefen", priority: "mittel", amount_chf: tot?.betrag ?? null, responsible: "Arben", evidence: "E-Mail " + (f.typ === "gesendet" ? "(gesendet)" : "(Bestätigung)"),
        notes: `Automatisch aus E-Mail «${f.subj.slice(0, 120)}» vom ${d} (${f.typ === "gesendet" ? "von dir gesendet an " : "von "}${f.partner.address}). ` + (tot ? `Betrag CHF ${tot.betrag.toFixed(2)} laut ${f.typ === "gesendet" ? "Bestellmail" : "Bestätigung"} («${tot.zeile}»).` : "Kein Betrag im Mail gefunden – ungefährer Betrag wird aus früheren Zahlungen vorgeschlagen.") + " Nichts bestellt oder bezahlt.", details: det });
      if (error) { res.fehler++; console.warn("lp-orders insert", error.message); } else res.neu++;
    }

    for (const [box, typ] of [[sent?.path, "gesendet"], ["INBOX", "bestaetigung"]] as [string | undefined, string][]) {
      if (!box) continue;
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        // Posteingang: nur Mails von Lieferanten, an die bestellt wurde
        let uids: number[] = [];
        if (typ === "gesendet") uids = (await client.search({ since }, { uid: true })) || [];
        else for (const d of lieferDom) uids.push(...(((await client.search({ since, from: d }, { uid: true })) || []) as number[]));
        uids = [...new Set(uids)].sort((a, b) => a - b);
        if (!uids.length) continue;
        const found: any[] = [];
        for await (const m of client.fetch(uids.slice(-3000), { envelope: true, bodyStructure: true, uid: true }, { uid: true })) {
          const e: any = m.envelope || {}, subj = e.subject || "", from = e.from?.[0] || {}, to = e.to?.[0] || {};
          const partner = typ === "gesendet" ? to : from;
          if (!partner.address || dom(partner.address) === ownDom || partner.address.toLowerCase() === own) continue;
          if (SKIP.test(subj)) continue;
          if (typ === "gesendet" && (REPLY.test(subj) || !BESTELL.test(subj))) continue;
          if (typ === "bestaetigung" && !(lieferDom.has(dom(partner.address)) && !REPLY.test(subj) && (BEST.test(subj) || /auftragsbest|bestellbest/i.test(subj)))) continue;
          if (typ === "gesendet") lieferDom.add(dom(partner.address));
          const key = keyOf(e.messageId || box + ":" + m.uid);
          if (known.has(key)) continue;
          found.push({ typ, box, uid: m.uid, subj, partner, date: e.date ? new Date(e.date) : new Date(), key, bs: m.bodyStructure });
        }
        // Text und PDF der Treffer lesen (gleiches Lock)
        found.sort((a, b) => +a.date - +b.date);
        for (const f of found) {
          try {
            const pl = textPart(f.bs, "text/plain"), ht = pl ? null : textPart(f.bs, "text/html");
            let t = "";
            if (pl || ht) { const b = await dl(client, f.uid, (pl || ht)!, MAXTXT); t = b.toString("utf-8"); if (ht) t = strip(t); }
            if (f.typ === "bestaetigung" || !total(t)) for (const a of pdfs(f.bs).slice(0, 2)) {
              if (a.size > MAXPDF * 1.4) continue;
              const b = await dl(client, f.uid, a.part, MAXPDF);
              const pdf = await getDocumentProxy(new Uint8Array(b)); const r = await extractText(pdf, { mergePages: false });
              t += "\n" + (r.text as string[]).join("\n");
            }
            f.text = t.replace(/\u0000/g, "");
          } catch (err) { res.fehler++; console.warn("lp-orders lesen", String((err as Error)?.message ?? err)); f.text = ""; }
          await handle(f);
        }
      } finally { lock.release(); }
    }
  } catch (e) {
    console.warn("lp-orders", String((e as Error)?.message ?? e));
    return json({ ...res, error: String((e as any)?.message || e) }, 500);
  } finally { await client.logout().catch(() => {}); }
  return json(res);
});
