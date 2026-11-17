import { createClient } from "npm:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import * as XLSX from "npm:xlsx@0.18.5";

// Liest den Text noch nicht gelesener Dokumente im Archiv (PDF, Excel, CSV) serverseitig aus und
// speichert ihn in lp_documents.content_text, damit Abgleiche ohne geöffneten Browser funktionieren.
// Sicherheit: nimmt keine Eingaben an und gibt keine Inhalte zurück – nur Zähler. Wird alle 5 Minuten
// von pg_cron aufgerufen; ein zusätzlicher Aufruf kann nichts anderes tun, als dieselbe Arbeit zu erledigen.
const MAX = 600000, BATCH = 15, MAXBYTES = 15 * 1024 * 1024;

function kind(b: Uint8Array, name: string) {
  const h = String.fromCharCode(...b.slice(0, 5));
  if (h.startsWith("%PDF")) return "pdf";
  if (h.startsWith("PK")) return /\.docx$/i.test(name) ? "other" : "xlsx";
  if (b[0] === 0xff && b[1] === 0xd8 || h.startsWith("\x89PNG")) return "image";
  if (/\.(csv|txt)$/i.test(name)) return "text";
  const sample = b.slice(0, 2000); let bad = 0; for (const c of sample) if (c < 9 || (c > 13 && c < 32)) bad++;
  return bad < sample.length * 0.02 ? "text" : "other";
}

// BF-POS-Tagesabschluss (PDF «Tagesabschluss · alle Terminals») erkennen und in Kassenwerte umsetzen
const MON: Record<string, string> = { januar: "01", februar: "02", "märz": "03", april: "04", mai: "05", juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12" };
const amt = (s: string) => parseFloat(s.replace(/['’\s]/g, "").replace(",", "."));
function parsePos(t: string) {
  if (!/Tagesabschluss/i.test(t) || !/Umsatz \(Netto\)/i.test(t)) return null;
  const dm = t.match(/(\d{1,2})\.\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})/i);
  if (!dm) return null;
  const datum = `${dm[3]}-${MON[dm[2].toLowerCase()]}-${dm[1].padStart(2, "0")}`;
  const val = (label: RegExp) => { const m = t.match(new RegExp(label.source + "\\s*\\n?\\s*CHF\\s*([\\d'’.,]+)", "i")); return m ? amt(m[1]) : null; };
  const netto = val(/Umsatz \(Netto\)/), tg = val(/Trinkgeld/), brutto = val(/Total \(Brutto\)/);
  if (netto == null) return null;
  // Zahlungsmethoden: «CARD 106 CHF 1698.00 CHF 34.75 CHF 1732.75»
  const sec = t.split(/Nach Zahlungsmethode/i)[1]?.split(/Nach Mitarbeiter|Total \d/i)[0] ?? "";
  let bar = 0, unbar = 0, sonst = 0;
  for (const m of sec.matchAll(/([A-ZÄÖÜa-zäöü_ ]+?)\s+(\d+)\s+CHF\s*([\d'’.,]+)\s+CHF\s*([\d'’.,]+)\s+CHF\s*([\d'’.,]+)/g)) {
    const meth = m[1].trim().toUpperCase(), u = amt(m[3]);
    if (/^(BAR|CASH)/.test(meth)) bar += u; else if (/CARD|KARTE|DEBIT|CREDIT|MAESTRO|VISA|MASTER/.test(meth)) unbar += u; else sonst += u;
  }
  if (Math.abs(bar + unbar + sonst - netto) > 0.05) { unbar = netto - bar - sonst; }
  const zr = t.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);
  const belege = +(t.match(/Belege\s*\n?\s*(\d+)/i)?.[1] ?? 0);
  return { quelle: "bfpos-pdf", datum, terminal: "alle Terminals (PDF)", abschluss: datum.slice(8) + "." + datum.slice(5, 7) + ".", bar: Math.round(bar * 100) / 100, unbar: Math.round(unbar * 100) / 100, sonstige: Math.round(sonst * 100) / 100, netto, trinkgeld: tg ?? 0, brutto: brutto ?? netto + (tg ?? 0), belege, zeitraum: zr ? zr[1] + "–" + zr[2] : null, produkte: [], methoden: [], mwst: [], ok: true };
}
async function posToEvent(sb: any, d: any, t: string) {
  const K = parsePos(t); if (!K) return null;
  let ev: any = null;
  if (d.record_id) { const { data } = await sb.from("lp_records").select("id,category,title,details,notes,due_date").eq("id", d.record_id).maybeSingle(); if (data?.category === "event") ev = data; }
  if (!ev) { const { data } = await sb.from("lp_records").select("id,category,title,details,notes,due_date").eq("category", "event").eq("due_date", K.datum); if ((data ?? []).length === 1) ev = data[0]; else return "kein eindeutiges Event am " + K.datum; }
  const sameDay = (await sb.from("lp_records").select("id", { count: "exact", head: true }).eq("category", "event").eq("due_date", K.datum)).count ?? 1;
  const det = { ...(ev.details || {}) }, alt: any[] = det.kassen || [];
  // Werte aus genau diesem Dokument ersetzen, andere Kassenabschlüsse bleiben
  const rest = alt.filter((k) => k.doc !== d.library_file_id && !(k.quelle === "bfpos-pdf" && k.datum === K.datum && !k.doc && k.terminal === K.terminal));
  det.kassen = [...rest, { ...K, doc: d.library_file_id }];
  const hinweis = `\nKASSE ${new Date().toISOString().slice(0, 10)} (automatisch aus «${d.file_name}»): Tagesabschluss ${K.abschluss}: Umsatz netto CHF ${K.netto.toFixed(2)} (Bar ${K.bar.toFixed(2)}, Karte ${K.unbar.toFixed(2)}, TWINT/Sonstige ${K.sonstige.toFixed(2)}), Trinkgeld ${K.trinkgeld.toFixed(2)}${K.zeitraum ? ", Zeitraum " + K.zeitraum : ""}.` +
    (sameDay > 1 && !K.zeitraum ? ` Achtung: An diesem Tag gibt es ${sameDay} Events; der Abschluss deckt den ganzen Tag ab – Aufteilung prüfen.` : "");
  await sb.from("lp_records").update({ details: det, notes: (ev.notes || "") + hinweis }).eq("id", ev.id);
  if (!d.record_id) await sb.from("lp_documents").update({ record_id: ev.id }).eq("library_file_id", d.library_file_id);
  return "Event «" + ev.title + "»";
}

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // eigene Uploads zuerst, danach Bexio-Belege
  const q = () => sb.from("lp_documents").select("library_file_id,file_name,storage_path,size_bytes,record_id,category")
    .is("content_at", null).not("storage_path", "is", null).order("created_at", { ascending: false }).limit(BATCH);
  const a = await q().not("library_file_id", "like", "bexio_%");
  if (a.error) return new Response(JSON.stringify({ error: a.error.message }), { status: 500 });
  let docs = a.data ?? [];
  if (docs.length < BATCH) { const b = await q().like("library_file_id", "bexio_%"); docs = [...docs, ...(b.data ?? [])].slice(0, BATCH); }
  const res = { gelesen: 0, leer: 0, fehler: 0, kasse: 0 };
  const seen = new Set<string>();
  for (const d of docs ?? []) {
    if (seen.has(d.storage_path)) continue; seen.add(d.storage_path);
    let t = "";
    try {
      if (+(d.size_bytes ?? 0) > MAXBYTES) throw new Error("Datei zu gross");
      const dl = await sb.storage.from("lp-dokumente").download(d.storage_path);
      if (dl.error) throw dl.error;
      const b = new Uint8Array(await dl.data.arrayBuffer()), k = kind(b, d.file_name);
      if (k === "pdf") { const pdf = await getDocumentProxy(b); const r = await extractText(pdf, { mergePages: false }); t = (r.text as string[]).join("\n"); }
      else if (k === "xlsx") { const wb = XLSX.read(b, { type: "array", cellDates: true }); t = wb.SheetNames.map((n) => "### Blatt: " + n + "\n" + XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS: ";", blankrows: false })).join("\n\n"); }
      else if (k === "text") { t = new TextDecoder("utf-8").decode(b); if (t.includes("�")) t = new TextDecoder("windows-1252").decode(b); }
      t = t.replace(/\u0000/g, "");
      if (t.length > MAX) t = t.slice(0, MAX) + "\n[… gekürzt, Original hat " + t.length + " Zeichen]";
      t.trim() ? res.gelesen++ : res.leer++;
    } catch (e) {
      res.fehler++; t = ""; console.warn("lp-doctext", d.file_name, String((e as Error)?.message ?? e));
    }
    await sb.from("lp_documents").update({ content_text: t, content_at: new Date().toISOString() }).eq("storage_path", d.storage_path);
    if (t) { try { const z = await posToEvent(sb, d, t); if (z) { res.kasse++; console.log("lp-doctext kasse", d.file_name, "→", z); } } catch (e) { console.warn("lp-doctext kasse", d.file_name, String((e as Error)?.message ?? e)); } }
  }
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
});
