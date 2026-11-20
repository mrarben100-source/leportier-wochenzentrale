import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.171";
import { Buffer } from "node:buffer";
import webpush from "npm:web-push@3.6.7";

// Push-Mitteilungen aufs Handy (Web Push, gratis, ohne Telefonnummer).
// - Ohne Anmeldung (pg_cron alle 5 Min): neue Mails in info@ und contact@ prüfen, Anfragen/Clubmiete/Offerten als Aufgabe
//   für Levent anlegen (gleiche Erkennung wie im Dashboard) und neue Anfragen/Mahnungen an die abonnierten Geräte schicken.
// - Mit Anmeldung: action 'key' (öffentlicher Schlüssel) oder 'test' (Test-Mitteilung an die eigenen Geräte).
// Sicherheit: Postfächer nur lesend; der private Schlüssel wird hier erzeugt und bleibt in lp_push_config (nur Server).
const cors = { "Access-Control-Allow-Origin": "https://mrarben100-source.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const MK = {
  rechnung: /rechnung|invoice|faktura|facture|mahnung|zahlungserinnerung|betreibung|zahlung|inkasso|verlustschein|ratenplan|saldo/i,
  auto: /^(automatische antwort|auto(?:matic)? ?reply|abwesenheit|out of office|r[ée]ponse automatique|unzustellbar|undeliverable|delivery status)/i,
  offerte: /offerte|\bangebot|quotation|\bquote\b|\bdevis\b|kostenvoranschlag|preisliste|konditionen|unverbindlich(?:e|es)? (?:angebot|offerte)/i,
  anfrage: /club ?miete|club (?:mieten|buchen|reservieren)|clubvermietung|vermietung|(?:club|lokal|location|raum|bar) (?:zu )?mieten|exklusiv(?:e|es)? (?:miete|nutzung)|privatparty|private party|polterabend|hochzeit|weihnachtsessen|weihnachtsfeier|firmenfeier|teamevent|apéro|apero|verfügbarkeit|freie[rn]? (?:termin|datum)|zusammenarbeit|kooperation|partnerschaft|sponsoring|sponsor|booking|buchungsanfrage|\banfrage\b|reservation|reservierung|location (?:mieten|miete|buchen)|raum ?miete|eventlocation|event bei (?:euch|ihnen)|firmenanlass|firmenevent|privatanlass|geburtstag(?:sfeier|sparty)|auftritt|auftreten|\bdj\b|künstler|artist|collaboration|partnership|cooperation|influencer|promotion|veranstalt(?:en|ung) bei/i,
  werbung: /newsletter|abmelden|unsubscribe|no-?reply|noreply|wordpress|please moderate|medienmitteilung|pressemitteilung|press release|media release|mailchimp|sendinblue|brevo|hubspot|linkedin|facebookmail|google\.com|apple\.com/i,
};
const KINDL: Record<string, string> = { offerte: "Offerte", anfrage: "Anfrage / Zusammenarbeit" };
function kind(subj: string, att: string, snip: string, from: string) {
  const head = subj + " " + att, all = head + " " + snip;
  if (MK.auto.test(subj.trim())) return null;
  if (MK.rechnung.test(head)) return null;
  if (MK.werbung.test(from) || /wordpress|please moderate|medienmitteilung|pressemitteilung|press release/i.test(subj) || /unsubscribe|abmelden|newsletter/i.test(snip)) return null;
  if (MK.offerte.test(head) || (MK.offerte.test(snip) && !MK.anfrage.test(head))) return "offerte";
  if (MK.anfrage.test(all)) return "anfrage";
  return null;
}
function atts(node: any, out: string[] = []) { if (!node) return out; const n = node.dispositionParameters?.filename || node.parameters?.name; if (n) out.push(n); for (const c of node.childNodes || []) atts(c, out); return out; }
function textPart(node: any, want: string): string | null { if (!node) return null; if (node.type === want && node.disposition !== "attachment") return node.part || "1"; for (const c of node.childNodes || []) { const p = textPart(c, want); if (p) return p; } return null; }
const strip = (s: string) => s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const iso = (d: Date) => d.toISOString().slice(0, 10), fd = (s: string) => s.split("-").reverse().join(".");

async function keys(sb: any) {
  const { data } = await sb.from("lp_push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (data) return data;
  const k = webpush.generateVAPIDKeys();
  await sb.from("lp_push_config").insert({ id: 1, public_key: k.publicKey, private_key: k.privateKey });
  const { data: d2 } = await sb.from("lp_push_config").select("public_key,private_key").eq("id", 1).single();
  return d2;
}
async function senden(sb: any, subs: any[], payload: any) {
  let ok = 0, weg = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 86400, urgency: "high" }); ok++; await sb.from("lp_push_subs").update({ last_ok: new Date().toISOString() }).eq("id", s.id); }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) { await sb.from("lp_push_subs").delete().eq("id", s.id); weg++; } else console.warn("push", e?.statusCode, String(e?.body || e?.message || e).slice(0, 200)); }
  }
  return { ok, weg };
}

// Neue Zugangsanfragen (lp_members.role = 'pending') an die Geräte der Admins melden, je Anfrage einmal
async function zugang(sb: any) {
  const { data: offen } = await sb.from("lp_members").select("user_id,display_name,email").eq("role", "pending").is("notified_at", null);
  if (!offen?.length) return 0;
  const { data: admins } = await sb.from("lp_members").select("user_id").eq("role", "admin");
  const { data: subs } = await sb.from("lp_push_subs").select("id,sub,user_id").in("user_id", (admins || []).map((a: any) => a.user_id));
  let n = 0;
  for (const p of offen) {
    const r = await senden(sb, subs || [], { title: "Neue Zugangsanfrage", body: (p.display_name || "Jemand") + (p.email ? " (" + p.email + ")" : "") + " möchte Zugang zur Wochenzentrale. Tippen zum Freischalten.", url: "./#uebersicht", tag: "zugang-" + p.user_id });
    await sb.from("lp_members").update({ notified_at: new Date().toISOString() }).eq("user_id", p.user_id);
    n += r.ok;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const K = await keys(sb);
  webpush.setVapidDetails("mailto:info@leportier.ch", K.public_key, K.private_key);
  const auth = req.headers.get("Authorization") || "";
  const body = await req.json().catch(() => ({}));
  if (body.action) {
    // nur angemeldete Mitglieder
    const ua = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await ua.auth.getUser();
    if (!user) return json({ error: "Nicht angemeldet" }, 401);
    const { data: m } = await sb.from("lp_members").select("role,display_name").eq("user_id", user.id).maybeSingle();
    if (!m) return json({ error: "Keine Berechtigung" }, 403);
    if (body.action === "key") return json({ publicKey: K.public_key });
    if (body.action === "zugang") return json({ gemeldet: await zugang(sb) });
    if (body.action === "test") {
      const { data: subs } = await sb.from("lp_push_subs").select("id,sub").eq("user_id", user.id);
      const r = await senden(sb, subs || [], { title: "Wochenzentrale", body: "Test: Push-Mitteilungen funktionieren auf diesem Gerät, " + (m.display_name || "") + ".", url: "./#uebersicht" });
      return json(r);
    }
    return json({ error: "unbekannte Aktion" }, 400);
  }

  // --- Lauf ohne Anmeldung (Cron) ---
  const res: any = { neue_anfragen: 0, gesendet: 0, fehler: 0, warteschlange: 0, zugang: 0 };
  try { res.zugang = await zugang(sb); } catch (e) { console.warn("zugang", String(e)); }
  // Warteschlange (lp_push_queue, nur Server): einzelne Mitteilungen, z. B. Tests oder Hinweise
  {
    const { data: q } = await sb.from("lp_push_queue").select("*").is("sent_at", null).order("created_at").limit(20);
    if (q?.length) {
      const { data: alle } = await sb.from("lp_push_subs").select("id,sub,topics,user_id");
      for (const m of q) {
        const ziel = (alle || []).filter((s: any) => (!m.user_id || s.user_id === m.user_id) && (!m.topic || (s.topics || []).includes(m.topic)));
        const r = await senden(sb, ziel, { title: m.title, body: m.body, url: m.url, tag: "q-" + m.id });
        await sb.from("lp_push_queue").update({ sent_at: new Date().toISOString(), sent_count: r.ok }).eq("id", m.id);
        res.warteschlange += r.ok;
      }
    }
  }
  const u = Deno.env.get("HOSTPOINT_USER"), p = Deno.env.get("HOSTPOINT_PASS");
  const konten = u && p ? [{ u, p, pre: "", pf: "info" }] : [];
  const cu = Deno.env.get("CONTACT_USER"), cp = Deno.env.get("CONTACT_PASS");
  if (cu && cp) konten.push({ u: cu.trim(), p: cp, pre: "c:", pf: "contact" });
  const since = new Date(Date.now() - 2 * 864e5);
  for (const k of konten) {
    const c = new ImapFlow({ host: Deno.env.get("HOSTPOINT_IMAP_HOST") || "imap.mail.hostpoint.ch", port: 993, secure: true, auth: { user: k.u, pass: k.p }, logger: false });
    try {
      await c.connect();
      const lock = await c.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = ((await c.search({ since }, { uid: true })) || []) as number[];
        if (!uids.length) continue;
        const keysWanted = uids.map((x) => "mail-" + k.pre + x + "-lead");
        const { data: vorh } = await sb.from("lp_records").select("source_key").in("source_key", keysWanted);
        const have = new Set((vorh || []).map((r: any) => r.source_key));
        const msgs: any[] = [];
        for await (const m of c.fetch(uids.filter((x) => !have.has("mail-" + k.pre + x + "-lead")), { envelope: true, bodyStructure: true, uid: true }, { uid: true })) msgs.push(m);
        for (const m of msgs) {
          const e: any = m.envelope || {}, f = e.from?.[0] || {};
          if ((f.address || "").toLowerCase().endsWith("@leportier.ch")) continue;
          let snip = "";
          const pl = textPart(m.bodyStructure, "text/plain"), ht = pl ? null : textPart(m.bodyStructure, "text/html");
          if (pl || ht) { try { const { content } = await c.download(String(m.uid), (pl || ht)!, { uid: true, maxBytes: 12000 }); const ch: Uint8Array[] = []; for await (const x of content) ch.push(x as Uint8Array); const s = Buffer.concat(ch).toString("utf-8"); snip = (ht ? strip(s) : s.replace(/\s+/g, " ").trim()).slice(0, 1500); } catch (_) { /* optional */ } }
          const kd = kind(e.subject || "", atts(m.bodyStructure).join(" "), snip, (f.address || "") + " " + (f.name || ""));
          if (!kd) continue;
          const from = f.name || f.address, when = e.date ? iso(new Date(e.date)) : iso(new Date()), due = iso(new Date(Date.parse(when) + 3 * 864e5));
          const { error } = await sb.from("lp_records").insert({ source_key: "mail-" + k.pre + m.uid + "-lead", category: "aufgabe", title: (kd === "offerte" ? "Offerte: " : "Anfrage/Zusammenarbeit: ") + from + " – " + String(e.subject || "(ohne Betreff)").slice(0, 90), status: "offen", priority: "mittel", responsible: "Levent", due_date: due,
            notes: "Automatisch aus E-Mail erkannt (" + KINDL[kd] + "). Von " + from + " <" + (f.address || "") + "> am " + fd(when) + ".\nAuszug: " + snip.slice(0, 600) + "\nZuständig: Levent (Anfragen, Clubmiete, Offerten)" + (k.pf === "contact" ? "; eingegangen an contact@" : "") + ". Bitte prüfen und beantworten. Es wurde nichts beantwortet oder zugesagt.",
            details: { art: "mail_lead", mail_uid: k.pre + m.uid, mail_kind: kd, firma: from, postfach: k.pf } });
          if (!error) res.neue_anfragen++;
        }
      } finally { lock.release(); }
    } catch (e) { res.fehler++; console.warn("lp-notify mail", k.pf, String((e as Error)?.message ?? e)); }
    finally { await c.logout().catch(() => {}); }
  }

  // Mitteilungen für noch nicht gemeldete Einträge (nur neue, höchstens 3 Tage alt)
  const ab = new Date(Date.now() - 3 * 864e5).toISOString();
  const { data: offen } = await sb.from("lp_records").select("id,title,details,notes,source_key,created_at").gte("created_at", ab).is("details->>push_at", null).limit(50);
  const { data: subs } = await sb.from("lp_push_subs").select("id,sub,topics");
  for (const r of offen || []) {
    const d = r.details || {};
    const topic = d.art === "mail_lead" ? "anfragen" : (String(r.source_key || "").startsWith("mailrechnung-") && d.mahnung_am) ? "mahnungen" : String(r.source_key || "").startsWith("mailrechnung-") && !d.dublette ? "rechnungen" : null;
    if (!topic) continue;
    const ziel = (subs || []).filter((s: any) => (s.topics || []).includes(topic));
    const payload = topic === "anfragen"
      ? { title: (d.mail_kind === "offerte" ? "Neue Offerte" : "Neue Anfrage") + (d.postfach === "contact" ? " (contact@)" : ""), body: String(r.title).replace(/^(Offerte|Anfrage\/Zusammenarbeit): /, ""), url: "./#aufgaben", tag: "lead-" + r.id }
      : { title: topic === "mahnungen" ? "Mahnung eingegangen" : "Neue Rechnung", body: String(r.title), url: "./#rechnungen", tag: "rech-" + r.id };
    if (ziel.length) { const s = await senden(sb, ziel, payload); res.gesendet += s.ok; }
    await sb.from("lp_records").update({ details: { ...d, push_at: new Date().toISOString() } }).eq("id", r.id);
  }
  return json(res);
});
