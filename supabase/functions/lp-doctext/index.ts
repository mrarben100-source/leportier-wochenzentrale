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

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: docs, error } = await sb.from("lp_documents").select("library_file_id,file_name,storage_path,size_bytes")
    .is("content_at", null).not("storage_path", "is", null).order("created_at", { ascending: false }).limit(BATCH);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const res = { gelesen: 0, leer: 0, fehler: 0 };
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
  }
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
});
