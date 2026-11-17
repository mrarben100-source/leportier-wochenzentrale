import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.171";
import { Buffer } from "node:buffer";

// Hostpoint-Postfach, nur lesend. Zugangsdaten ausschliesslich aus Secrets.
// v5: liefert pro E-Mail zusätzlich einen kurzen Textauszug (snippet), damit das
// Dashboard Offerten und Anfragen erkennen kann. Das Postfach wird schreibgeschützt
// geöffnet; nichts wird gelesen-markiert, verändert, gelöscht oder gesendet.
const cors = {
  "Access-Control-Allow-Origin": "https://mrarben100-source.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function attachments(node: any, out: any[] = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (node.disposition === "attachment" || (name && node.type !== "text/plain" && node.type !== "text/html")) {
    out.push({ name: name || "Anhang", type: node.type, size: node.size ?? null, part: node.part || "1" });
  }
  for (const c of node.childNodes || []) attachments(c, out);
  return out;
}
// Ersten Textteil finden (text/plain bevorzugt, sonst text/html), keine Anhänge.
function textPart(node: any, want: string): string | null {
  if (!node) return null;
  if (node.type === want && node.disposition !== "attachment") return node.part || "1";
  for (const c of node.childNodes || []) { const p = textPart(c, want); if (p) return p; }
  return null;
}
const strip = (s: string) =>
  s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
const MAX = 10 * 1024 * 1024;
const SNIP = 1500;

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

    const u = Deno.env.get("HOSTPOINT_USER"), p = Deno.env.get("HOSTPOINT_PASS");
    if (!u || !p) return json({ error: "not_configured" });
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(+body.limit || 30, 1), 50);

    const client = new ImapFlow({
      host: Deno.env.get("HOSTPOINT_IMAP_HOST") || "imap.mail.hostpoint.ch",
      port: 993, secure: true, auth: { user: u, pass: p }, logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      if (body.action === "attachments") {
        const uid = String(parseInt(body.uid, 10));
        if (uid === "NaN") return json({ error: "uid fehlt" }, 400);
        const msg: any = await client.fetchOne(uid, { bodyStructure: true, envelope: true }, { uid: true });
        if (!msg) return json({ error: "E-Mail nicht gefunden" }, 404);
        const files: any[] = [];
        for (const a of attachments(msg.bodyStructure)) {
          const tn = a.type + " " + a.name;
          if (!/pdf|jpe?g|png|csv/i.test(tn)) continue;
          if ((a.size ?? 0) > MAX * 1.4) { files.push({ name: a.name, type: a.type, skipped: "zu gross" }); continue; }
          const { content } = await client.download(uid, a.part, { uid: true });
          const chunks: Uint8Array[] = [];
          for await (const c of content) chunks.push(c as Uint8Array);
          const buf = Buffer.concat(chunks);
          if (buf.length > MAX) { files.push({ name: a.name, type: a.type, skipped: "zu gross" }); continue; }
          const type = /pdf/i.test(tn) ? "application/pdf" : /csv/i.test(tn) ? "text/csv" : a.type;
          files.push({ name: a.name, type, size: buf.length, b64: buf.toString("base64") });
        }
        const f = msg.envelope?.from?.[0];
        return json({ uid: +uid, subject: msg.envelope?.subject ?? "", date: msg.envelope?.date ?? null, from_name: f?.name ?? "", from_address: f?.address ?? "", files });
      }
      const total = (client.mailbox as any).exists as number;
      const out: any[] = [];
      const parts: { i: number; uid: number; part: string; html: boolean }[] = [];
      if (total > 0) {
        for await (const msg of client.fetch(`${Math.max(1, total - limit + 1)}:*`, { envelope: true, flags: true, bodyStructure: true, uid: true })) {
          const f = msg.envelope?.from?.[0];
          const plain = textPart(msg.bodyStructure, "text/plain"), html = plain ? null : textPart(msg.bodyStructure, "text/html");
          if (body.snippets !== false && (plain || html)) parts.push({ i: out.length, uid: msg.uid, part: (plain || html)!, html: !plain });
          out.push({
            uid: msg.uid,
            date: msg.envelope?.date ?? null,
            subject: msg.envelope?.subject ?? "",
            from_name: f?.name ?? "",
            from_address: f?.address ?? "",
            seen: msg.flags?.has("\\Seen") ?? false,
            attachments: attachments(msg.bodyStructure).map(({ part, ...a }) => a),
            snippet: "",
          });
        }
        // Textauszüge nach dem Listing holen (eine Abfrage pro E-Mail, Grösse begrenzt).
        for (const t of parts) {
          try {
            const { content } = await client.download(String(t.uid), t.part, { uid: true, maxBytes: 12000 });
            const chunks: Uint8Array[] = [];
            for await (const c of content) chunks.push(c as Uint8Array);
            const s = Buffer.concat(chunks).toString("utf-8");
            out[t.i].snippet = (t.html ? strip(s) : s.replace(/\s+/g, " ").trim()).slice(0, SNIP);
          } catch (_) { /* Auszug ist optional */ }
        }
      }
      return json({ mailbox: u, total, messages: out.reverse() });
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
  } catch (e) {
    return json({ error: String((e as any)?.responseText || (e as any)?.message || e) }, 500);
  }
});
