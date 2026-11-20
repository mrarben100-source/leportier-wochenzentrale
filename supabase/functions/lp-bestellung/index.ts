import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.171";
import nodemailer from "npm:nodemailer@6.9.16";
import MailComposer from "npm:nodemailer@6.9.16/lib/mail-composer/index.js";
import webpush from "npm:web-push@3.6.7";

// Stardrinks-Bestellungen mit Freigabe.
// - einreichen (admin, editor, bestellung): Mengen aus dem Bestellrechner → Eintrag «wartet auf Freigabe», Push an die Admins.
// - vorschau / freigeben / ablehnen (nur admin): Freigeben schickt das Bestellmail von info@leportier.ch an info@stardrinks.ch
//   (Kundennummern + Artikel, OHNE Preise) und legt eine Kopie in «Gesendet» ab. Sonst wird nichts gesendet, nichts bezahlt.
const AN = "info@stardrinks.ch", KD_WE = "739625", KD_AG = "435753";
const cors = { "Access-Control-Allow-Origin": "https://mrarben100-source.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fd = (s: string) => s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "";
const WT = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const wtag = (s: string) => s ? WT[new Date(s + "T12:00:00Z").getUTCDay()] + ", " + fd(s) : "";
const today = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

function mail(rec: any) {
  const d = rec.details, P = d.positionen || [];
  const zeilen = P.map((p: any) => `${p.menge} × ${p.einheit ? p.einheit + "  " : ""}${p.produkt}${p.mat_nr ? "  (Art.-Nr. " + p.mat_nr + ")" : ""}`);
  const betreff = `Bestellung Le Portier N° 35 – Kundennr. ${KD_WE}` + (d.liefertermin ? ` – Lieferung ${fd(d.liefertermin)}` : "");
  const text = [
    "Guten Tag", "", "Gerne bestellen wir folgende Artikel:", "",
    `Kundennr. WE ${KD_WE} – Le Portier N° 35, Aarbergergasse 35, 3011 Bern`,
    `Kundennr. AG ${KD_AG} – PrimeVibes GmbH`,
    ...(d.liefertermin ? [`Gewünschte Lieferung: ${wtag(d.liefertermin)}`] : []), "",
    ...zeilen, "",
    ...(d.bemerkung ? [String(d.bemerkung).trim(), ""] : []),
    "Besten Dank für die kurze Bestätigung.", "", "Freundliche Grüsse",
    d.freigabe?.eingereicht_von || "", "Le Portier N° 35 | PrimeVibes GmbH",
  ].join("\n").replace(/\n{3,}/g, "\n\n");
  return { an: AN, betreff, text };
}
async function push(sb: any, userIds: string[], payload: any) {
  if (!userIds.length) return 0;
  const { data: K } = await sb.from("lp_push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
  if (!K) return 0;
  webpush.setVapidDetails("mailto:info@leportier.ch", K.public_key, K.private_key);
  const { data: subs } = await sb.from("lp_push_subs").select("id,sub").in("user_id", userIds);
  let ok = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 86400, urgency: "high" }); ok++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("lp_push_subs").delete().eq("id", s.id); }
  }
  return ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ua = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: { user } } = await ua.auth.getUser();
  if (!user) return json({ error: "Nicht angemeldet" }, 401);
  const { data: me } = await sb.from("lp_members").select("role,display_name").eq("user_id", user.id).maybeSingle();
  const body = await req.json().catch(() => ({}));
  const name = me?.display_name || user.email || "";
  const isAdmin = me?.role === "admin";

  if (body.action === "einreichen") {
    if (!["admin", "editor", "bestellung"].includes(me?.role)) return json({ error: "Keine Berechtigung" }, 403);
    const { data: pr } = await sb.from("lp_records").select("details").not("details->preise_provisorisch", "is", null).limit(1).maybeSingle();
    const pos = pr?.details?.preise_provisorisch?.positionen || [], Pz = pr?.details?.preise_provisorisch;
    const L: any[] = [];
    for (const q of (body.positionen || []) as any[]) {
      const m = Math.floor(+q.menge);
      if (!(m > 0 && m < 1000)) continue;
      const p = Number.isInteger(q.i) ? pos[q.i] : null;
      if (p && p.produkt === q.produkt) L.push({ produkt: p.produkt, mat_nr: p.mat_nr || null, einheit: p.einheit || (p.gebinde ? p.gebinde + "er Gebinde" : ""), gebinde: p.gebinde ?? null, menge: m, gebindepreis: p.gebindepreis ?? null, summe: p.gebindepreis != null ? r2(m * p.gebindepreis) : 0, ...(p.gebindepreis == null ? { preis_zu_pruefen: true } : {}) });
      else if (q.produkt && String(q.produkt).trim()) L.push({ produkt: String(q.produkt).trim().slice(0, 120), menge: m, summe: 0, preis_zu_pruefen: true });
    }
    if (!L.length) return json({ error: "Bitte mindestens eine Position mit Menge erfassen" }, 400);
    const sum = r2(L.reduce((s, l) => s + (l.summe || 0), 0)), ok = !!Pz?.bestaetigt && !L.some((l) => l.preis_zu_pruefen);
    const d = today(), li = /^\d{4}-\d{2}-\d{2}$/.test(body.liefertermin || "") ? body.liefertermin : null;
    const { data: rec, error } = await sb.from("lp_records").insert({
      category: "lieferant", title: "Bestellung Stardrinks " + fd(d), status: "wartet", priority: "hoch", due_date: li, responsible: "Arben + Levent", evidence: "Bestellrechner (zur Freigabe)",
      notes: `Eingereicht von ${name} am ${fd(d)}${li ? ", Lieferung " + fd(li) : ""}. Summe CHF ${sum.toFixed(2)} laut Preisliste${ok ? "" : " (Preis teilweise zu prüfen)"}. Wartet auf Freigabe durch Arben oder Levent – erst dann geht das Mail an Stardrinks.`,
      details: { art: "bestellung", lieferant: "stardrinks", lieferant_name: "Stardrinks", lieferant_domain: "stardrinks.ch", firma: "Stardrinks", bestelldatum: d, liefertermin: li, positionen: L, summe_exkl_mwst: sum, preise_bestaetigt: ok, preisstand: Pz?.gueltig_ab || null, bemerkung: String(body.bemerkung || "").trim().slice(0, 600) || null,
        freigabe: { status: "offen", eingereicht_von: name, eingereicht_von_id: user.id, eingereicht_am: new Date().toISOString() } },
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    const { data: admins } = await sb.from("lp_members").select("user_id").eq("role", "admin");
    await push(sb, (admins || []).map((a: any) => a.user_id).filter((id: string) => id !== user.id), { title: "Bestellung zur Freigabe", body: `${name}: Stardrinks, ${L.length} Position(en), CHF ${sum.toFixed(2)}. Tippen zum Prüfen und Freigeben.`, url: "./#bestellungen", tag: "best-" + rec.id });
    return json({ ok: true, id: rec.id, summe: sum });
  }

  if (!["vorschau", "freigeben", "ablehnen"].includes(body.action)) return json({ error: "unbekannte Aktion" }, 400);
  if (!isAdmin) return json({ error: "Nur Arben oder Levent (Administrator) können freigeben" }, 403);
  const { data: rec } = await sb.from("lp_records").select("*").eq("id", body.id).maybeSingle();
  if (!rec || rec.details?.art !== "bestellung" || rec.details?.lieferant !== "stardrinks" || !rec.details?.freigabe) return json({ error: "Bestellung nicht gefunden" }, 404);
  if (body.action === "vorschau") return json(mail(rec));
  if (rec.details.freigabe.status !== "offen") return json({ error: "Diese Bestellung ist bereits " + (rec.details.freigabe.status === "gesendet" ? "gesendet" : "erledigt") }, 409);

  if (body.action === "ablehnen") {
    const grund = String(body.grund || "").trim().slice(0, 300);
    const det = { ...rec.details, freigabe: { ...rec.details.freigabe, status: "abgelehnt", von: name, am: new Date().toISOString(), grund } };
    const { data: up } = await sb.from("lp_records").update({ status: "erledigt", notes: (rec.notes || "") + `\nAbgelehnt von ${name} am ${fd(today())}${grund ? ": " + grund : ""}. Es wurde nichts gesendet.`, details: det }).eq("id", rec.id).eq("updated_at", rec.updated_at).select("id");
    if (!up?.length) return json({ error: "Inzwischen geändert, bitte neu laden" }, 409);
    await push(sb, [rec.details.freigabe.eingereicht_von_id].filter(Boolean), { title: "Bestellung abgelehnt", body: `${name} hat die Stardrinks-Bestellung vom ${fd(rec.details.bestelldatum)} abgelehnt${grund ? ": " + grund : ""}.`, url: "./#bestellungen" });
    return json({ ok: true });
  }

  // freigeben: zuerst sperren (verhindert doppeltes Senden), dann senden
  const u = Deno.env.get("HOSTPOINT_USER"), p = Deno.env.get("HOSTPOINT_PASS");
  if (!u || !p) return json({ error: "Postfach nicht eingerichtet" }, 500);
  const lockDet = { ...rec.details, freigabe: { ...rec.details.freigabe, status: "sendet", von: name, am: new Date().toISOString() } };
  const { data: locked } = await sb.from("lp_records").update({ details: lockDet }).eq("id", rec.id).eq("updated_at", rec.updated_at).select("id,updated_at");
  if (!locked?.length) return json({ error: "Inzwischen geändert, bitte neu laden" }, 409);
  const m = mail(rec), msgId = `<bestellung-${rec.id}@leportier.ch>`;
  const opts = { from: { name: "Le Portier N° 35", address: u }, to: AN, subject: m.betreff, text: m.text, messageId: msgId, date: new Date() };
  let raw: Uint8Array;
  try {
    raw = await new Promise<Uint8Array>((ok, no) => new (MailComposer as any)(opts).compile().build((e: any, b: Uint8Array) => e ? no(e) : ok(b)));
    const tr = nodemailer.createTransport({ host: Deno.env.get("HOSTPOINT_SMTP_HOST") || "asmtp.mail.hostpoint.ch", port: 465, secure: true, auth: { user: u, pass: p } });
    await tr.sendMail({ envelope: { from: u, to: [AN] }, raw });
  } catch (e) {
    await sb.from("lp_records").update({ details: { ...rec.details } }).eq("id", rec.id);
    return json({ error: "Mail konnte nicht gesendet werden: " + String((e as Error)?.message ?? e).slice(0, 200) }, 502);
  }
  // Kopie in «Gesendet» (wie aus dem Mailprogramm); Fehler hier ändern nichts am Versand
  let kopie = false;
  try {
    const c = new ImapFlow({ host: Deno.env.get("HOSTPOINT_IMAP_HOST") || "imap.mail.hostpoint.ch", port: 993, secure: true, auth: { user: u, pass: p }, logger: false });
    await c.connect();
    const boxes = await c.list();
    const sent = boxes.find((b: any) => b.specialUse === "\\Sent") || boxes.find((b: any) => /^(inbox\.)?(sent|gesendet|gesendete)/i.test(b.path));
    if (sent) { await c.append(sent.path, raw, ["\\Seen"]); kopie = true; }
    await c.logout();
  } catch (e) { console.warn("Kopie Gesendet", String((e as Error)?.message ?? e)); }
  const key = "mail-bestellung-" + msgId.replace(/[<>\s"\\,()]/g, "");
  const det = { ...rec.details, quelle: "bestellrechner", ordner: "Gesendet", mail_betreff: m.betreff, freigabe: { ...lockDet.freigabe, status: "gesendet", gesendet_am: new Date().toISOString(), an: AN, kopie_gesendet: kopie } };
  await sb.from("lp_records").update({ source_key: key, status: "offen", priority: "mittel", evidence: "Bestellmail an " + AN, notes: (rec.notes || "") + `\nFreigegeben von ${name} am ${fd(today())} und per Mail an ${AN} gesendet (ohne Preise). Betrag wird mit der Auftragsbestätigung von Stardrinks aktualisiert. Keine Zahlung ausgelöst.`, details: det }).eq("id", rec.id);
  await push(sb, [rec.details.freigabe.eingereicht_von_id].filter((id: string) => id && id !== user.id), { title: "Bestellung freigegeben", body: `${name} hat die Stardrinks-Bestellung freigegeben. Das Mail ist an Stardrinks gesendet.`, url: "./#bestellungen" });
  return json({ ok: true, an: AN, kopie });
});
