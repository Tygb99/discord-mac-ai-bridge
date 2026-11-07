#!/usr/bin/env bun
// discord-mac-ai-bridge: talk to AI chat apps on your Mac from Discord channels.
//
// What it does (each service is optional; leave its channel empty in the config to turn it off)
//   grok      your message -> Aside opens the Grok Bot chat on grok.com and types it
//             Grok Bot replies and messages it sends first -> read from the Grok Bot Mac app's local transcript copy -> Discord
//             Grok scheduled-task result mails -> read with zele (Gmail CLI) -> Discord
//   instinct  your message -> macOS Messages (iMessage) to one handle
//             replies and texts it sends first -> ~/Library/Messages/chat.db -> Discord
//   pickle    your message -> Pickle Mac app input box (helpers/pickle-send, Accessibility)
//             replies, call transcripts, attachments -> the app's local chat mirror (ChatMirror db.sqlite) -> Discord
//   dots      your message -> Aside opens a ChatGPT "dots" room on chatgpt.com and types it
//             room messages -> read from the logged-in tab (every 2 h, every 15 s right after you send) -> Discord
//   gateway.ts writes Discord messages from these channels (and their threads) to the inbox file this bridge reads.
//
// Running
//   bun bridge.ts              the bridge itself. Reading chat.db needs Full Disk Access, so it runs inside a herdr tab
//                              (a terminal that has the permission), not directly under launchd.
//   bun bridge.ts --keeper     run every minute by a LaunchAgent: if the bridge heartbeat stopped, reopen its herdr tab;
//                              if the optional end date passed, stop everything.
//   bun bridge.ts --end-check  only run the stop procedure if the end date passed (for testing).
// Environment: BRIDGE_DIR (default ~/.config/discord-mac-ai-bridge), BRIDGE_CONFIG, DISCORD_BOT_TOKEN,
//   test overrides GIB_END (ISO end time), GIB_STATE, GIB_REPORTS, GIB_LOG, GIB_FLAG, GIB_LABEL, GIB_TAB_LABEL, GIB_NO_POST=1, GIB_NO_BOOTOUT=1
// Secrets and phone numbers live only in the config file (chmod 600) and are never written to logs or Discord.
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, closeSync, readSync, renameSync } from "node:fs";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const DIR = process.env.BRIDGE_DIR ?? `${HOME}/.config/discord-mac-ai-bridge`;
const CONF_PATH = process.env.BRIDGE_CONFIG ?? `${DIR}/config.json`;
const CONF = JSON.parse(readFileSync(CONF_PATH, "utf8"));
const STATE = process.env.GIB_STATE ?? `${DIR}/state.json`;
const HB = `${STATE}.hb`;
const FLAG = process.env.GIB_FLAG ?? `${DIR}/bridge.ended`;
const REPORTS: string | undefined = process.env.GIB_REPORTS ?? CONF.reports_log;
const LOG = process.env.GIB_LOG ?? CONF.log ?? `${DIR}/bridge.log`;
const NO_POST = process.env.GIB_NO_POST === "1";
const END_MS = (process.env.GIB_END ?? CONF.end_at) ? Date.parse(process.env.GIB_END ?? CONF.end_at) : Infinity;
const LABEL = process.env.GIB_LABEL ?? CONF.launchd_label ?? "com.example.discord-mac-ai-bridge";
const TAB_LABEL: string = process.env.GIB_TAB_LABEL ?? CONF.tab_label ?? "mac-ai-bridge";
const INBOX: string = CONF.inbox ?? `${DIR}/inbox.jsonl`;
const which = (name: string) => CONF.bin?.[name] ?? Bun.which(name) ?? name;
const ASIDE = which("aside");
const HERDR = which("herdr");
const BUN = which("bun");
const ZELE = which("zele");
const SELF = import.meta.path;
const GROK_DIR = `${HOME}/Library/Application Support/Grok Bot/sand-client-persistence`;
const CHAT_DB = `${HOME}/Library/Messages/chat.db`;
const PICKLE_DIR = `${HOME}/Library/Group Containers/group.com.pickle.client/ChatMirror`;
const HELPERS = CONF.helpers_dir ?? `${import.meta.dir}/helpers`;
const PICKLE_SEND = `${HELPERS}/pickle-send`;
const MEDIA = `${DIR}/tmp/bridge-media`;
const DISCORD_FILE_MAX = 10 * 1024 * 1024;
const GROK_IMG_CACHE = `${HOME}/Library/Application Support/Grok Bot/attachment-image-cache`;
const PICKLE_THUMBS = `${HOME}/Library/Containers/com.pickle.client/Data/Library/Caches/attachment-thumbnails`;
for (const d of [DIR, `${MEDIA}/in`, `${MEDIA}/out`]) mkdirSync(d, { recursive: true });
const on = (k: "grok" | "instinct" | "pickle" | "dots") => Boolean(CONF[`${k}_channel`]);

const usedCache = new Set<string>();
function imgInfo(p: string): { w: number; h: number; ext: string } | null {
  const b = readFileSync(p);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ext: "png" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), ext: "jpg" };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { w: 0, h: 0, ext: "jpg" };
  }
  if (b.length > 10 && b.subarray(0, 3).toString() === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), ext: "gif" };
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return { w: 0, h: 0, ext: "webp" };
  return null;
}
// Apps write received images to a cache whose file names cannot be derived from the message, so pick the file
// created within +/-2 minutes of the message whose size (or aspect ratio) matches.
async function findCachedImage(dir: string, atMs: number, w?: number, h?: number): Promise<string | null> {
  for (let t = 0; t < 20; t++) {
    let best: { f: string; d: number; ext: string } | null = null;
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const p = `${dir}/${f}`;
      if (usedCache.has(p)) continue;
      const born = statSync(p).birthtimeMs;
      if (Math.abs(born - atMs) > 120_000) continue;
      const info = imgInfo(p);
      if (!info) continue;
      const fits = !w || !h || !info.w || (info.w === w && info.h === h) || Math.abs(info.w / info.h - w / h) < 0.02;
      if (fits && (!best || Math.abs(born - atMs) < best.d)) best = { f: p, d: Math.abs(born - atMs), ext: info.ext };
    }
    if (best) {
      usedCache.add(best.f);
      const out = `${MEDIA}/out/${Date.now()}-${best.f.split("/").pop()!.slice(0, 12)}.${best.ext}`;
      await Bun.write(out, Bun.file(best.f));
      return out;
    }
    await sleep(1000);
  }
  return null;
}
const PATHS = [...new Set([...[ASIDE, HERDR, BUN, ZELE].map((p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean))].join(":");
const FAIL_REPORT_MS = 30 * 60_000;
const TAG = "mac-ai-bridge";

const local = (ms = Date.now()) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => appendFileSync(LOG, `${local()} ${a.map(String).join(" ")}\n`);
const report = (line: string) => { if (REPORTS) appendFileSync(REPORTS, `REPORT [${TAG}] ${line}\n`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fail = { since: number; posted: boolean; reported: boolean; why: string };
type Pending = { at: number; warned: boolean } | null;
type State = {
  inbox_off?: number; chat_rowid?: number; grok_seq?: number; grok_epoch?: unknown; mail_seen?: string[]; mail_at?: number;
  dots_last?: string; dots_at?: number; dots_fast?: number;
  pickle_order?: number; pickle_cand?: Record<string, { sig: string; t: number }>;
  pending: { grok: Pending; instinct: Pending; pickle?: Pending; dots?: Pending }; fail: Record<string, Fail>;
};
const loadState = (): State => {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { pending: { grok: null, instinct: null }, fail: {} }; }
};
const saveState = (s: State) => { writeFileSync(`${STATE}.tmp`, JSON.stringify(s)); renameSync(`${STATE}.tmp`, STATE); };

async function run(cmd: string[], opts: { timeout?: number; env?: Record<string, string> } = {}) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: PATHS, ...(opts.env ?? {}) } });
  const t = setTimeout(() => p.kill(), opts.timeout ?? 120_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(t);
  return { code, out, err };
}

const TOKEN: string = process.env.DISCORD_BOT_TOKEN ?? CONF.discord_bot_token ?? "";
const UA = "discord-mac-ai-bridge (local, 1)";
async function discord(method: string, path: string, body?: unknown) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      method, headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json", "User-Agent": UA },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 429) { await sleep(1000 * (Number((await r.json().catch(() => ({}))).retry_after) || 2)); continue; }
    if (!r.ok) throw new Error(`discord ${method} ${path.split("/").slice(0, 3).join("/")} -> ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("discord 429 repeated");
}
function chunks(msg: string, max = 1900): string[] {
  const out = [""];
  for (const line of msg.split(/(?<=\n)/)) {
    const pieces = line.length <= max ? [line] : line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g"))!;
    for (const p of pieces) { if (out[out.length - 1].length + p.length > max) out.push(""); out[out.length - 1] += p; }
  }
  return out.filter((x) => x.trim());
}
async function post(ch: string, msg: string): Promise<string[]> {
  if (NO_POST) { log("[NO_POST]", ch, msg.slice(0, 200).replace(/\n/g, " ")); return []; }
  const ids: string[] = [];
  for (const part of chunks(msg)) {
    const m: any = await discord("POST", `/channels/${ch}/messages`, { content: part, allowed_mentions: { parse: [] } });
    ids.push(m.id);
  }
  log("posted", ch, ids.join(","));
  return ids;
}
async function postFiles(ch: string, msg: string, paths: string[]): Promise<string[]> {
  const fit = paths.filter((p) => existsSync(p) && statSync(p).size <= DISCORD_FILE_MAX).slice(0, 10);
  const big = paths.length - fit.length;
  const text = (msg + (big ? `\n(${big} photo(s)/file(s) were too large or missing, see the app)` : "")).slice(0, 1900);
  if (NO_POST) { log("[NO_POST files]", ch, fit.length, text.slice(0, 120).replace(/\n/g, " ")); return []; }
  if (!fit.length) return post(ch, text);
  for (let i = 0; i < 4; i++) {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: text, allowed_mentions: { parse: [] } }));
    fit.forEach((p, k) => fd.append(`files[${k}]`, Bun.file(p), p.split("/").pop()!.replace(/^[^-]*-\d+-/, "")));
    const r = await fetch(`https://discord.com/api/v10/channels/${ch}/messages`, { method: "POST", headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA }, body: fd, signal: AbortSignal.timeout(120_000) });
    if (r.status === 429) { await sleep(1000 * (Number((await r.json().catch(() => ({}))).retry_after) || 2)); continue; }
    if (!r.ok) throw new Error(`discord file post -> ${r.status}`);
    const m: any = await r.json(); log("posted files", ch, m.id, fit.length); return [m.id];
  }
  throw new Error("discord 429 repeated");
}
async function fetchAttachments(ev: any): Promise<{ path: string; url: string; name: string }[]> {
  const out: { path: string; url: string; name: string }[] = [];
  let i = 0;
  for (const a of ev.attachments ?? []) {
    const name = `${String(ev.id).replace(/\W/g, "")}-${i++}-${String(a.filename ?? "file").replace(/[^\w.\-가-힣]/g, "_").slice(-80)}`;
    const r = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`could not download the Discord attachment (${r.status})`);
    const path = `${MEDIA}/in/${name}`;
    await Bun.write(path, await r.arrayBuffer());
    out.push({ path, url: a.url, name });
  }
  return out;
}
async function react(ch: string, id: string, emoji: string) {
  if (NO_POST || id.startsWith("test-")) return;
  await discord("PUT", `/channels/${ch}/messages/${id}/reactions/${encodeURIComponent(emoji)}/@me`).catch((e) => log("react fail", e.message));
}

async function failNow(st: State, key: string, ch: string, why: string) {
  const f = st.fail[key] ?? { since: Date.now(), posted: false, reported: false, why };
  f.why = why;
  if (!f.posted) { await post(ch, `⚠️ ${why}`).catch((e) => log("post fail", e.message)); f.posted = true; }
  if (!f.reported && Date.now() - f.since >= FAIL_REPORT_MS) {
    report(`error · ${key} · ${Math.round((Date.now() - f.since) / 60_000)} min: ${why}`); f.reported = true;
  }
  st.fail[key] = f; log("fail", key, why);
}
async function failClear(st: State, key: string, ch: string) {
  const f = st.fail[key];
  if (!f) return;
  delete st.fail[key];
  if (f.posted) await post(ch, `✅ Working again (${key}, after ${Math.round((Date.now() - f.since) / 60_000)} min)`).catch(() => {});
  if (f.reported) report(`recovered · ${key}`);
  log("recovered", key);
}

function endFlagCreate(): boolean {
  try { closeSync(openSync(FLAG, "wx")); return true; } catch { return false; }
}
async function endNow() {
  if (endFlagCreate()) {
    for (const ch of [CONF.grok_channel, CONF.instinct_channel, CONF.pickle_channel, CONF.dots_channel].filter(Boolean)) await post(ch, "🛑 The bridge reached its end date and stopped. Messages here are no longer forwarded").catch(() => {});
    report("ended");
    log("ended");
  }
  await closeBridgeTabs();
  if (process.env.GIB_NO_BOOTOUT !== "1") await run(["/bin/launchctl", "bootout", `gui/${process.getuid!()}/${LABEL}`]);
}

async function herdr(...a: string[]) {
  const r = await run([HERDR, ...a], { timeout: 30_000 });
  if (r.code !== 0) throw new Error(`herdr ${a.slice(0, 2).join(" ")} rc=${r.code} ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out || "{}").result;
}
async function bridgeTabs(): Promise<{ tab_id: string }[]> {
  const ws = (await herdr("workspace", "list")).workspaces as { workspace_id: string }[];
  const out: { tab_id: string }[] = [];
  for (const w of ws) for (const t of (await herdr("tab", "list", "--workspace", w.workspace_id)).tabs) if (t.label === TAB_LABEL) out.push(t);
  return out;
}
async function closeBridgeTabs() {
  try { for (const t of await bridgeTabs()) { await herdr("tab", "close", t.tab_id); log("tab closed", t.tab_id); } } catch (e: any) { log("tab close fail", e.message); }
}

async function keeper() {
  if (existsSync(FLAG) || Date.now() >= END_MS) { await endNow(); return; }
  const age = existsSync(HB) ? Date.now() - statSync(HB).mtimeMs : Infinity;
  if (age < 90_000) return;
  const st = loadState();
  try {
    await closeBridgeTabs();
    const ws = (await herdr("workspace", "list")).workspaces as { workspace_id: string }[];
    const wsId = ws.length ? ws[0].workspace_id : (await herdr("workspace", "create", "--cwd", DIR, "--label", "bridges", "--no-focus")).workspace.workspace_id;
    const tab = await herdr("tab", "create", "--workspace", wsId, "--cwd", DIR, "--label", TAB_LABEL, "--no-focus");
    const pane = tab.root_pane.pane_id;
    await herdr("pane", "run", pane, `'${BUN}' '${SELF}'`);
    log("keeper started bridge", pane, `hb age ${age === Infinity ? "none" : Math.round(age / 1000) + "s"}`);
    // If the bridge does not come back within a minute, the next keeper run tries again. Report once after 30 minutes.
    if (age !== Infinity && age > FAIL_REPORT_MS && !st.fail.keeper?.reported) {
      st.fail.keeper = { since: Date.now() - age, posted: true, reported: true, why: "bridge stopped for over 30 minutes (keeper is reopening the herdr tab)" };
      report(`error · bridge stopped for ${Math.round(age / 60_000)} min, keeper is reopening the herdr tab`);
      saveState(st);
    }
  } catch (e: any) {
    log("keeper fail", e.message);
  }
}

function decodeAttributed(ab: Uint8Array | null): string {
  if (!ab) return "";
  const b = Buffer.from(ab);
  const i = b.indexOf("NSString");
  if (i < 0) return "";
  let p = i + 8 + 5;
  let len = b[p];
  if (len === 0x81) { len = b.readUInt16LE(p + 1); p += 3; } else if (len === 0x82) { len = b.readUInt32LE(p + 1); p += 5; } else p += 1;
  return b.subarray(p, p + len).toString("utf8");
}
function chatRows(after: number) {
  const db = new Database(CHAT_DB, { readonly: true });
  try {
    return db.query(`select m.ROWID rowid, m.is_from_me me, m.text text, m.attributedBody ab, m.error err, m.service svc, m.cache_has_attachments att, m.associated_message_type amt
      from message m join chat_message_join cmj on cmj.message_id = m.ROWID join chat c on c.ROWID = cmj.chat_id
      where c.chat_identifier = ? and m.ROWID > ? order by m.ROWID`).all(CONF.instinct_handle, after) as any[];
  } finally { db.close(); }
}
async function instinctFiles(rowid: number): Promise<string[]> {
  for (let i = 0; i < 15; i++) {
    const db = new Database(CHAT_DB, { readonly: true });
    let rows: any[];
    try { rows = db.query(`select a.filename f from attachment a join message_attachment_join j on j.attachment_id = a.ROWID where j.message_id = ?`).all(rowid) as any[]; } finally { db.close(); }
    const paths = rows.map((x) => String(x.f ?? "").replace(/^~/, HOME)).filter(Boolean);
    if (paths.length && paths.every((p) => existsSync(p))) return paths;
    await sleep(1000);
  }
  return [];
}
function chatMax(): number {
  const db = new Database(CHAT_DB, { readonly: true });
  try { return (db.query("select coalesce(max(ROWID),0) m from message").get() as any).m; } finally { db.close(); }
}
async function sendInstinctFile(src: string) {
  // On macOS 15+ Messages sends files from outside its sandbox as empty messages, so copy each file into a fresh
  // folder under ~/Library/Messages, pass it as an alias, then confirm the transfer in chat.db.
  const dir = `${HOME}/Library/Messages/.send-staging/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = `${dir}/${src.split("/").pop()}`;
  await run(["/bin/mkdir", "-p", dir]);
  await Bun.write(path, Bun.file(src));
  const before = chatMax();
  const AS = `on run argv
  set f to (POSIX file (item 1 of argv)) as alias
  tell application "Messages"
    set s to 1st account whose service type = iMessage
    send f to participant (item 2 of argv) of s
  end tell
end run`;
  try {
    const r = await run(["/usr/bin/osascript", "-e", AS, path, CONF.instinct_handle], { timeout: 90_000 });
    if (r.code !== 0) throw new Error(`Messages could not send the photo (osascript rc=${r.code} ${r.err.trim().slice(0, 120)})`);
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const db = new Database(CHAT_DB, { readonly: true });
      let rows: any[];
      try {
        rows = db.query(`select m.error e, a.transfer_state ts from message m join chat_message_join cmj on cmj.message_id = m.ROWID join chat c on c.ROWID = cmj.chat_id
          left join message_attachment_join j on j.message_id = m.ROWID left join attachment a on a.ROWID = j.attachment_id
          where c.chat_identifier = ? and m.ROWID > ? and m.is_from_me = 1`).all(CONF.instinct_handle, before) as any[];
      } finally { db.close(); }
      if (rows.some((x) => x.ts === 5)) return;
      if (rows.some((x) => x.e)) throw new Error(`Messages failed to send the photo (error ${rows.find((x) => x.e).e})`);
    }
    throw new Error("Messages did not send the photo within a minute");
  } finally {
    await run(["/bin/rm", "-rf", dir]);
  }
}
async function sendInstinct(text: string) {
  const AS = `on run argv
  tell application "Messages"
    set s to 1st account whose service type = iMessage
    send (item 1 of argv) to participant (item 2 of argv) of s
  end tell
end run`;
  const r = await run(["/usr/bin/osascript", "-e", AS, text, CONF.instinct_handle], { timeout: 60_000 });
  if (r.code !== 0) throw new Error(`Messages could not send (osascript rc=${r.code} ${r.err.trim().slice(0, 120)})`);
}
async function pollInstinct(st: State) {
  const rows = chatRows(st.chat_rowid ?? 0);
  for (const r of rows) {
    st.chat_rowid = r.rowid;
    const text = (r.text || decodeAttributed(r.ab) || "").replace(/\uFFFC/g, "").trim();
    if (r.me === 0 && r.amt >= 2000) {
      await post(CONF.instinct_channel, `👆 Instinct reacted: ${text.split(" to “")[0]}`);
    } else if (r.me === 0) {
      const files = r.att ? await instinctFiles(r.rowid) : [];
      if (files.length) await postFiles(CONF.instinct_channel, `💬 **Instinct**: ${text || "(photo)"}`, files);
      else await post(CONF.instinct_channel, `💬 **Instinct**: ${text || "(no text)"}${r.att ? "\n(has an attachment, see the Messages app)" : ""}`);
      st.pending.instinct = null;
      await failClear(st, "instinct_reply", CONF.instinct_channel);
    } else if (r.err) {
      await failNow(st, "instinct_send", CONF.instinct_channel, `A message to Instinct did not go out (Messages error ${r.err}, ${r.svc}). iMessage may be off for this Mac's account`);
    }
  }
}

let grokFile: string | null = null;
function findGrokFile(): string | null {
  if (grokFile && existsSync(grokFile)) return grokFile;
  for (const f of readdirSync(GROK_DIR)) {
    if (!f.endsWith(".blob")) continue;
    let n = f.slice(0, -5).toUpperCase();
    n += "=".repeat((8 - (n.length % 8)) % 8);
    const name = b32decode(n);
    if (name.includes(`transcript.replicas.${CONF.grok_bot_id}`)) return (grokFile = `${GROK_DIR}/${f}`);
  }
  return null;
}
function b32decode(s: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, "")) {
    const i = A.indexOf(c); if (i < 0) return "";
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out).toString("utf8");
}
function grokEntries(): { epoch: unknown; entries: any[] } | null {
  const f = findGrokFile();
  if (!f) return null;
  if (Date.now() - statSync(f).mtimeMs < 2000) return { epoch: undefined, entries: [] }; // being written, try next round
  const j = JSON.parse(readFileSync(f, "utf8"));
  return { epoch: j.value?.epochHint, entries: j.value?.entries ?? [] };
}
async function grokAppRunning() {
  return (await run(["/usr/bin/pgrep", "-x", "Grok Bot"])).code === 0;
}
async function pollGrok(st: State) {
  const g = grokEntries();
  if (!g) return;
  if (g.epoch === undefined) return;
  const maxSeq = Math.max(0, ...g.entries.map((e) => e.seq ?? 0));
  if (st.grok_epoch !== undefined && JSON.stringify(st.grok_epoch) !== JSON.stringify(g.epoch) && maxSeq < (st.grok_seq ?? 0)) {
    log("grok replica epoch changed, rebaseline", st.grok_seq, "->", maxSeq);
    st.grok_seq = maxSeq; st.grok_epoch = g.epoch; return;
  }
  st.grok_epoch = g.epoch;
  for (const e of g.entries) {
    if ((e.seq ?? 0) <= (st.grok_seq ?? 0)) continue;
    st.grok_seq = e.seq;
    if (e.kind === "send-message") {
      const m = e.message ?? {};
      if (m.type === "attachment" || m.type === "image") {
        const img = await findCachedImage(GROK_IMG_CACHE, e.timestampMs ?? Date.now(), m.width, m.height);
        const label = `🤖 **Grok Bot**: (photo${m.file_name ? ` ${m.file_name}` : ""})${m.alt ? ` ${m.alt}` : ""}`;
        if (img) await postFiles(CONF.grok_channel, label, [img]);
        else await post(CONF.grok_channel, `${label}\n(see the photo in the Grok Bot app, it was not in the app cache)`);
      } else {
        const body = m.type === "text" ? String(m.content ?? "") : `(${m.type ?? "unknown"} message, see the Grok Bot app)`;
        await post(CONF.grok_channel, `🤖 **Grok Bot**: ${body}`);
      }
      st.pending.grok = null;
      await failClear(st, "grok_reply", CONF.grok_channel);
    } else if (e.kind === "event" && e.event?.type === "automation-changed") {
      await post(CONF.grok_channel, `⚙️ Grok Bot automation ${e.event.action ?? ""}: ${e.event.automationName ?? e.event.automationId ?? ""}`);
    }
  }
}
async function sendGrok(text: string, files: { url: string; name: string }[] = []) {
  const JS = `
const files = ${JSON.stringify(files.map((f) => ({ url: f.url, name: f.name })))};
const paths = [];
const pg = await openTab(${JSON.stringify(CONF.grok_bot_url)});
try {
  await sleep(6000);
  // If the tab is not on the Grok Bot chat URL, go back to it once
  if (!(await pg.evaluate(() => location.href)).startsWith(${JSON.stringify(CONF.grok_bot_url)})) { console.log('GIBNOTE back-to-room ' + (await pg.evaluate(() => location.href))); await pg.evaluate((u) => { location.href = u; }, ${JSON.stringify(CONF.grok_bot_url)}); await sleep(6000); }
  const url = await pg.evaluate(() => location.href);
  // A newsletter sign-up dialog on grok.com can hold keyboard focus so typed text never reaches the input. Press only its decline button
  const popup = await pg.evaluate(() => { const no=['아니요, 감사합니다','No, thanks','No thanks']; const out=[]; for (const d of document.querySelectorAll('[role=dialog],[role=alertdialog]')) { if(!d.getClientRects().length) continue; const b=[...d.querySelectorAll('button')].find(b=>no.includes(b.innerText.trim())); if(b){ out.push((d.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40)); b.click(); } } return out; });
  if (popup.length) { console.log('GIBNOTE popup-declined ' + popup.join(' | ')); await sleep(1000); }
  const ok = await pg.evaluate(() => { const c=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null); const e=c[c.length-1]; if(!e) return false; e.focus(); if (document.activeElement !== e) { const d=[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].find(d=>d.getClientRects().length); return 'blocked ' + (d ? (d.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40) : String(document.activeElement && document.activeElement.tagName)); } return true; });
  const composer = () => pg.evaluate(() => { const ed=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null).pop(); let n=ed; for(let i=0;i<6&&n;i++) n=n.parentElement; return n ? n.innerText : ""; });
  if (!ok) { console.log('GIBERR nologin ' + url); }
  else if (ok !== true) { console.log('GIBERR focus-' + ok); }
  else {
    await pg.keyboard.press('Meta+A'); await pg.keyboard.press('Backspace');
    let attached = true;
    if (files.length) {
      for (const f of files) {
        const r = await fetch(f.url);
        await fs.writeFile(f.name, Buffer.from(await r.arrayBuffer()));
        paths.push(await fs.resolvePath(f.name));
      }
      await pg.locator('input[type=file]').last().setInputFiles(paths);
      attached = false;
      for (let i = 0; i < 30 && !attached; i++) { await sleep(500); const c = await composer(); attached = files.every((f) => c.includes(f.name)); }
      await sleep(2500);
    }
    if (!attached) console.log('GIBERR attach-fail');
    else {
      const lines = ${JSON.stringify(text)}.split('\\n');
      for (let i = 0; i < lines.length; i++) {
        if (i) { await pg.keyboard.down('Shift'); await pg.keyboard.press('Enter'); await pg.keyboard.up('Shift'); }
        if (lines[i]) await pg.keyboard.type(lines[i]);
      }
      await sleep(400);
      const v = await pg.evaluate(() => { const c=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null); return c[c.length-1].innerText; });
      if (v.replace(/\\s/g,'') !== ${JSON.stringify(text.replace(/\s/g, ""))}) console.log('GIBERR typed-mismatch ' + v.length);
      else {
        const key = ${JSON.stringify(text.trim().split("\n")[0].slice(0, 24))};
        const bubbles = () => pg.evaluate((k) => { const ed=[...document.querySelectorAll('[contenteditable="true"]')].map(e=>e.innerText).join(''); const m=(document.querySelector('main')||document.body).innerText; return m.split(k).length - 1 - (ed.split(k).length - 1); }, key);
        const before = key ? await bubbles() : 0;
        await pg.keyboard.press('Enter');
        let sent = false;
        for (let i = 0; i < 40 && !sent; i++) {
          await sleep(500);
          const c = await composer();
          sent = (key ? (await bubbles()) > before : true) && files.every((f) => !c.includes(f.name));
        }
        if (sent) await sleep(2500);
        console.log(sent ? 'GIBOK' : 'GIBERR not-in-chat');
      }
    }
  }
} finally { await closeTab(pg); for (const f of files) { try { await fs.unlink(f.name); } catch (e) {} } }
`;
  const r = await run([ASIDE, "repl", JS], { timeout: 120_000 });
  const note = r.out.split("\n").find((l) => l.startsWith("GIBNOTE"));
  if (note) log("grok", note);
  const line = r.out.split("\n").find((l) => l.startsWith("GIBOK") || l.startsWith("GIBERR"));
  if (line === "GIBOK") return;
  if (!line) throw new Error(`could not send to Grok Bot through Aside (Aside is closed or not answering, rc=${r.code})`);
  if (line.includes("nologin")) throw new Error("the Grok Bot chat has no input box (the grok.com login may have expired)");
  if (line.includes("focus-blocked")) throw new Error(`a dialog on grok.com blocked the input box (${line.slice(21, 70)})`);
  if (line.includes("attach-fail")) throw new Error("the photo did not attach in the Grok Bot input box");
  throw new Error(`could not confirm the Grok Bot input (${line.slice(7, 60)})`);
}

const DOTS_READ_JS = (after: string) => `
const pg = await openTab("https://chatgpt.com/robots.txt");
try {
  const out = await pg.evaluate(async (a) => {
    const s = await (await fetch('/api/auth/session')).json();
    if (!s.accessToken) return { err: 'nologin' };
    const r = await fetch('/backend-api/messaging/rooms/${CONF.dots_room}/messages', { headers: { Authorization: 'Bearer ' + s.accessToken } });
    if (!r.ok) return { err: 'http ' + r.status };
    const j = await r.json();
    const H = { Authorization: 'Bearer ' + s.accessToken };
    const b64 = async (u) => { const r = await fetch(u, { headers: H }); if (!r.ok) return null; const b = await r.blob(); if (b.size > 8 * 1024 * 1024) return null; return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(b); }); };
    const items = [];
    for (const m of j.items.filter(m => !a || m.created_at > a)) {
      const atts = [];
      for (const x of (m.content?.attachments ?? [])) {
        const f = x.file ?? {};
        const isDot = m.account_user_id === ${JSON.stringify(CONF.dots_member)};
        atts.push({ type: x.type, name: f.name ?? null, mime: f.mime_type ?? null, data: isDot && f.download_url ? await b64(f.download_url) : null });
      }
      items.push({ id: m.id, at: m.created_at, who: m.account_user_id, text: m.content?.text ?? null, atts });
    }
    return { items, last: j.items.length ? j.items[j.items.length - 1].created_at : null };
  }, ${JSON.stringify(after)});
  console.log("DOTS " + JSON.stringify(out));
} finally { await closeTab(pg); }`;
async function dotsRead(after: string): Promise<{ items: any[]; last: string | null }> {
  const r = await run([ASIDE, "repl", DOTS_READ_JS(after)], { timeout: 60_000 });
  const line = r.out.split("\n").find((l) => l.startsWith("DOTS "));
  if (!line) throw new Error(`could not read the dots room through Aside (rc=${r.code})`);
  const j = JSON.parse(line.slice(5));
  if (j.err === "nologin") throw new Error("the chatgpt.com login expired (Aside)");
  if (j.err) throw new Error(`reading the dots room failed (${j.err})`);
  return j;
}
async function pollDots(st: State, force = false) {
  const every = st.pending.dots || Date.now() < (st.dots_fast ?? 0) ? 15_000 : 7_200_000; // every 2 h normally, every 15 s right after sending
  if (!force && Date.now() - (st.dots_at ?? 0) < every) return;
  st.dots_at = Date.now();
  const j = await dotsRead(st.dots_last ?? "");
  for (const m of j.items) {
    st.dots_last = m.at > (st.dots_last ?? "") ? m.at : st.dots_last;
    if (m.who !== CONF.dots_member) continue; // your own messages (from the app, the web or this bridge) are not posted back
    const files: string[] = [];
    let missed = 0;
    for (const a of (m.atts ?? []).filter((a: any) => a.type !== "widget")) {
      if (!a.data) { missed++; continue; }
      const p = `${MEDIA}/out/${Date.now()}-${String(a.name ?? "file").replace(/[^\w.\-가-힣]/g, "_").slice(-60)}`;
      await Bun.write(p, Buffer.from(a.data, "base64"));
      files.push(p);
    }
    const note = ((m.atts ?? []).some((a: any) => a.type === "widget") ? "\n(has cards or buttons, see the room on chatgpt.com)" : "") + (missed ? `\n(${missed} attachment(s) too large or not received, see the room on chatgpt.com)` : "");
    const body = `🟣 **dots**: ${m.text || (files.length ? "(photo/file)" : note ? "" : "(no text)")}${note}`;
    if (files.length) await postFiles(CONF.dots_channel, body, files);
    else await post(CONF.dots_channel, body);
    st.pending.dots = null;
    st.dots_fast = Math.max(st.dots_fast ?? 0, Date.now() + 120_000);
    await failClear(st, "dots_reply", CONF.dots_channel);
  }
}
async function sendDots(text: string, files: { url: string; name: string }[] = []) {
  const JS = `
const files = ${JSON.stringify(files.map((f) => ({ url: f.url, name: f.name })))};
const pg = await openTab(${JSON.stringify(CONF.dots_url)});
const mine = async () => pg.evaluate(async () => { const s = await (await fetch('/api/auth/session')).json(); const j = await (await fetch('/backend-api/messaging/rooms/${CONF.dots_room}/messages', { headers: { Authorization: 'Bearer ' + s.accessToken } })).json(); return j.items.filter(m => m.account_user_id !== ${JSON.stringify(CONF.dots_member)}).map(m => m.id); });
try {
  await sleep(6000);
  const ok = await pg.evaluate(() => { const e=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null).pop(); if(!e) return false; e.focus(); return true; });
  if (!ok) { console.log('GIBERR nologin'); }
  else {
    await pg.keyboard.press('Meta+A'); await pg.keyboard.press('Backspace');
    if (files.length) {
      const paths = [];
      for (const f of files) { const r = await fetch(f.url); await fs.writeFile(f.name, Buffer.from(await r.arrayBuffer())); paths.push(await fs.resolvePath(f.name)); }
      await pg.locator('input[type=file]').last().setInputFiles(paths);
      await sleep(5000);
    }
    const lines = ${JSON.stringify(text)}.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) { await pg.keyboard.down('Shift'); await pg.keyboard.press('Enter'); await pg.keyboard.up('Shift'); }
      if (lines[i]) await pg.keyboard.type(lines[i]);
    }
    await sleep(400);
    const v = await pg.evaluate(() => [...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetParent!==null).pop().innerText);
    if (v.replace(/\\s/g,'') !== ${JSON.stringify(text.replace(/\s/g, ""))}) console.log('GIBERR typed-mismatch ' + v.length);
    else {
      const before = await mine();
      // The send button label follows the ChatGPT UI language (Korean UI: 보내기)
      await pg.evaluate((labels) => { const b=[...document.querySelectorAll('button')].filter(b=>labels.includes(b.getAttribute('aria-label'))).pop(); b && b.click(); }, ${JSON.stringify(CONF.dots_send_labels ?? ["보내기", "Send"])});
      let sent = false;
      for (let i = 0; i < 40 && !sent; i++) { await sleep(500); sent = (await mine()).some(id => !before.includes(id)); }
      console.log(sent ? 'GIBOK' : 'GIBERR not-in-chat');
    }
  }
} finally { await closeTab(pg); for (const f of files) { try { await fs.unlink(f.name); } catch (e) {} } }
`;
  const r = await run([ASIDE, "repl", JS], { timeout: 120_000 });
  const line = r.out.split("\n").find((l) => l.startsWith("GIBOK") || l.startsWith("GIBERR"));
  if (line === "GIBOK") return;
  if (!line) throw new Error(`could not send to dots through Aside (Aside is closed or not answering, rc=${r.code})`);
  if (line.includes("nologin")) throw new Error("the dots room has no input box (the chatgpt.com login may have expired)");
  throw new Error(`could not confirm the dots input (${line.slice(7, 60)})`);
}

function pickleDb(): string {
  for (const d of readdirSync(PICKLE_DIR)) { const f = `${PICKLE_DIR}/${d}/db.sqlite`; if (existsSync(f)) return f; }
  throw new Error("the Pickle chat mirror (ChatMirror) was not found");
}
const PICKLE_COLS = "local_order o, id, kind, channel ch, text, at, duration_s dur, attachments a, files f, file_meta fm, inline_images i, image_meta im";
function pickleRows(after: number): any[] {
  const db = new Database(pickleDb(), { readonly: true });
  try {
    return db.query(`select ${PICKLE_COLS} from messages where local_order > ? order by local_order`).all(after) as any[];
  } finally { db.close(); }
}
function pickleRowsAt(orders: number[]): any[] {
  if (!orders.length) return [];
  const db = new Database(pickleDb(), { readonly: true });
  try { return db.query(`select ${PICKLE_COLS} from messages where local_order in (${orders.map(Number).join(",")}) order by local_order`).all() as any[]; } finally { db.close(); }
}
// Pickle calls: during a call, spoken lines pile up as channel='voice' user/assistant rows; after hanging up a kind='call' row (at=start, duration_s) appears
function pickleVoice(from: number, to: number): any[] {
  const db = new Database(pickleDb(), { readonly: true });
  try { return db.query("select kind, text, at from messages where channel = 'voice' and kind in ('user','assistant') and at between ? and ? order by at, local_order").all(from, to) as any[]; } finally { db.close(); }
}
// The chat mirror only stores attachment paths. The bridge never calls Pickle's servers: it clicks the attachment bubble in the
// app so the app downloads it itself (helpers/pickle-fetch). The app keeps the original at
// Caches/attachment-originals/<sha256(attachment path)>; if that file already exists, nothing is clicked.
const PICKLE_ORIGINALS = `${HOME}/Library/Containers/com.pickle.client/Data/Library/Caches/attachment-originals`;
const PICKLE_FETCH = `${HELPERS}/pickle-fetch`;
// Optional background path (helpers/pickle-bg.ts, needs the OmO desktop engine): try it first without bringing Pickle forward,
// and fall back once to pickle-send / pickle-fetch (which bring the window forward briefly) if it answers PBERR.
const PICKLE_BG = `${HELPERS}/pickle-bg.ts`;
const PICKLE_REPLAY = `${DIR}/tmp/pickle-replay.txt`; // write row numbers (local_order) here and the bridge reposts them once, then renames the file to .done-<time>
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
let pickleFileSeq = 0;
async function pickleFile(path: string, name: string, size?: number, click = true): Promise<{ file?: string; note?: string }> {
  if (size && size > DISCORD_FILE_MAX) return { note: `${name} ${mb(size)}MB (over Discord's 10MB)` };
  const cached = `${PICKLE_ORIGINALS}/${new Bun.CryptoHasher("sha256").update(path).digest("hex")}`;
  if (!existsSync(cached)) {
    if (!click) return { note: `${name} (no original in the Pickle app)` };
    if ((await run(["/usr/bin/pgrep", "-x", "Pickle"])).code !== 0) { await run(["/usr/bin/open", "-g", "-b", "com.pickle.client"]); log("opened Pickle app"); await sleep(6000); }
    const bg = await run([BUN, PICKLE_BG, "fetch", "--name", name, "--want", cached], { timeout: 180_000 });
    log("pickle-bg fetch", bg.out.trim().split("\n").pop() || bg.err.trim().slice(0, 200));
  }
  if (!existsSync(cached)) {
    const g = await run([PICKLE_FETCH, "--name", name, "--want", cached], { timeout: 300_000 });
    const line = g.out.trim() || g.err.trim().slice(0, 200);
    log("pickle-fetch", line);
    if (!existsSync(cached)) return { note: `${name} (could not get it from the Pickle app: ${line.replace(/^PFERR /, "").split(" ")[0] || "?"})` };
  }
  const b = await Bun.file(cached).arrayBuffer();
  if (b.byteLength > DISCORD_FILE_MAX) return { note: `${name} ${mb(b.byteLength)}MB (over Discord's 10MB)` };
  const out = `${MEDIA}/out/pickle${Date.now()}-${pickleFileSeq++}-${name.replace(/[\/\0]/g, "_")}`;
  await Bun.write(out, b); log("pickle file", b.byteLength);
  return { file: out };
}
const jsonOr = <T,>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const pickleName = (p: string, fm: Record<string, { name?: string }>) => (fm[p]?.name ?? p.split("/").pop()!).replace(/-[0-9a-f]{32}(?=\.[^.]+$)/, "");
function pickleMax(): number {
  const db = new Database(pickleDb(), { readonly: true });
  try { return (db.query("select coalesce(max(local_order),0) m from messages").get() as any).m; } finally { db.close(); }
}
const pickleText = (t: string) => String(t ?? "").replace(/<\/bubble>\s*<bubble>/g, "\n\n").replace(/<\/?bubble>/g, "").trim();
const squash = (t: string) => t.replace(/\s/g, "");
async function postPickleRow(r: any, head = "") {
  if (r.kind === "call") {
    const lines = pickleVoice(r.at - 10, r.at + (r.dur ?? 0) + 120)
      .map((v) => [v.kind === "user" ? "🙋 me" : "🥒 Pickle", pickleText(v.text).replace(/\[pause\]/g, " ").replace(/\s+/g, " ").trim()])
      .filter(([, t]) => t).map(([w, t]) => `${w}: ${t}`);
    await post(CONF.pickle_channel, `${head}📞 **Pickle call ${Math.round(r.dur ?? 0)} s** (started ${local(r.at * 1000).slice(5, 16)})\n${lines.length ? lines.join("\n") : "(no call transcript in the chat mirror, see the Pickle app)"}`);
    return;
  }
  const who = r.kind === "assistant" ? "🥒 **Pickle**" : r.kind === "user" ? "🙋 **me (sent from the Pickle app)**" : `ℹ️ Pickle ${r.kind}`;
  const body = pickleText(r.text).replace(/\[file attached: [^\]]*\]/g, "").replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m: string, alt: string) => `(photo${alt ? ` ${alt}` : ""})`).trim();
  const meta = jsonOr<Record<string, { w?: number; h?: number }>>(r.im, {});
  const keys = Object.keys(meta).length ? Object.keys(meta) : Object.values(jsonOr<Record<string, string>>(r.i, {}));
  const fm = jsonOr<Record<string, { name?: string; size?: number }>>(r.fm, {});
  const paths = [...new Set([...jsonOr<string[]>(r.a, []), ...jsonOr<string[]>(r.f, [])])].filter((p) => typeof p === "string" && !keys.includes(p));
  const files: string[] = [], notes: string[] = [];
  for (const k of keys) {
    const p = await findCachedImage(PICKLE_THUMBS, r.at * 1000, meta[k]?.w, meta[k]?.h);
    if (p) { files.push(p); continue; }
    const g = await pickleFile(k, pickleName(k, fm), fm[k]?.size, false); // photo bubbles have no file-name text to search for
    if (g.file) files.push(g.file); else notes.push(g.note!);
  }
  for (const k of paths) { const g = await pickleFile(k, pickleName(k, fm), fm[k]?.size); if (g.file) files.push(g.file); else notes.push(g.note!); }
  const other = notes.length ? `\n(attachments ${notes.join(", ")}, see the Pickle app)` : "";
  const msg = `${head}${who}: ${body || (files.length ? "(attachment)" : "(no text)")}${other}`;
  if (files.length) await postFiles(CONF.pickle_channel, msg, files);
  else await post(CONF.pickle_channel, msg);
}
async function pollPickle(st: State) {
  if (existsSync(PICKLE_REPLAY)) { // repost rows missed earlier, once (rename first so they are never posted twice)
    const want = (readFileSync(PICKLE_REPLAY, "utf8").match(/\d+/g) ?? []).map(Number);
    renameSync(PICKLE_REPLAY, `${PICKLE_REPLAY}.done-${Date.now()}`);
    for (const r of pickleRowsAt(want)) await postPickleRow(r, "↩️ missed earlier\n");
    log("pickle replay", want.join(","));
  }
  const rows = pickleRows(st.pickle_order ?? 0);
  const cand = st.pickle_cand ?? {};
  const now = Date.now();
  for (const r of rows) {
    const key = String(r.o), sig = `${r.id}|${r.text}`;
    if (cand[key]?.sig !== sig) { cand[key] = { sig, t: now }; break; } // new or still being written, look again in 4 s
    if (now - cand[key].t < 4000) break;
    st.pickle_order = r.o; delete cand[key];
    if (now / 1000 - (r.at + (r.kind === "call" ? r.dur ?? 0 : 0)) > 600) { log("pickle skip old row", r.o); continue; } // old history the app re-imported with new row numbers
    if (r.ch === "voice" && (r.kind === "user" || r.kind === "assistant")) { log("pickle voice row (posted with the call row)", r.o); continue; }
    if (r.kind === "user") { // messages you sent from other devices are posted too; only the ones this bridge sent from Discord are skipped
      const k = squash(pickleText(r.text)); const t = pickleBridgeSent.get(k);
      if (t && now - t < 15 * 60_000) { pickleBridgeSent.delete(k); continue; }
    }
    await postPickleRow(r);
    if (r.kind === "user") continue; // your own message does not end the wait for Pickle's reply
    st.pending.pickle = null;
    await failClear(st, "pickle_reply", CONF.pickle_channel);
  }
  st.pickle_cand = Object.fromEntries(Object.entries(cand).filter(([k]) => rows.some((r) => String(r.o) === k)));
}
const PSERR: Record<string, string> = {
  busy: "you kept using the Mac for 90 seconds, so the Pickle window was not brought up",
  notrunning: "the Pickle app is not running",
  noinput: "the Pickle window is open but not on the chat screen, so the input box was not found",
  nowindow: "the Pickle window is closed",
  nofocus: "the Pickle input box was clicked but would not take text",
  nosendbutton: "the Pickle Send button is not visible",
  long: "the message is too long (over 500 characters)",
  draft: "the Pickle input box has a draft, so it was left alone",
  noax: "no Accessibility permission to control Pickle",
  activate: "could not bring the Pickle window forward",
  "typed-mismatch": "the text did not land correctly in the Pickle input box",
  "enter-not-sent": "Send was not pressed in Pickle (text may be left in the input box)",
};
const pickleBridgeSent = new Map<string, number>(); // text this bridge sent from Discord (whitespace removed -> time), so it is not posted back as yours
async function sendPickle(text: string, files: string[] = []) {
  pickleBridgeSent.set(squash(text), Date.now());
  if ((await run(["/usr/bin/pgrep", "-x", "Pickle"])).code !== 0) { await run(["/usr/bin/open", "-g", "-b", "com.pickle.client"]); log("opened Pickle app"); await sleep(6000); }
  const before = pickleMax();
  let bgWhy = ""; // why the background send failed, so a fallback failure reports both reasons
  if (!files.length) {
    const bg = Bun.spawn([BUN, PICKLE_BG, "send", "-"], { stdin: new Blob([text]), stdout: "pipe", stderr: "pipe" });
    const tb = setTimeout(() => bg.kill(), 180_000);
    const bgLine = (await new Response(bg.stdout).text()).trim().split("\n").pop() ?? ""; await bg.exited; clearTimeout(tb);
    log("pickle-bg send", bgLine || "(no answer)");
    if (bgLine.startsWith("PBOK")) return await pickleConfirm(before, text, files, bgLine);
    if (/^PBERR (enter-not-sent|timeout)/.test(bgLine) || /wiped=false/.test(bgLine)) throw new Error(PSERR[bgLine.replace(/^PBERR\s*/, "").split(" ")[0]] ?? `sending to Pickle stopped halfway (${bgLine.slice(0, 80)}), check the Pickle input box`);
    const bk = bgLine.replace(/^PBERR\s*/, "").split(" ")[0];
    const scr = bgLine.match(/screen=(\S+)/)?.[1];
    bgWhy = `${PSERR[bk] ?? (bgLine.slice(0, 60) || "no answer")}${scr && scr !== "?" ? ` · screen now: ${scr.replace(/_/g, " ")}` : ""}`;
  }
  const p = Bun.spawn([PICKLE_SEND, ...files.flatMap((f) => ["--file", f]), "-"], { stdin: new Blob([text]), stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), 150_000);
  const out = (await new Response(p.stdout).text()).trim(); await p.exited; clearTimeout(t);
  const line = out.split("\n").pop() ?? "";
  log("pickle-send", line);
  if (!line.startsWith("PSOK")) {
    const k = line.replace(/^PSERR\s*/, "").split(" ")[0];
    const why = PSERR[k] ?? `could not send to Pickle (${line.slice(0, 80) || "no answer"})`;
    throw new Error(bgWhy && bgWhy !== why ? `${why} (background send: ${bgWhy})` : why);
  }
  if (line.includes("restore=FAIL")) report("warning · could not restore your front window after sending to Pickle");
  return await pickleConfirm(before, text, files, line);
}
async function pickleConfirm(before: number, text: string, files: string[], line: string) {
  for (let i = 0; i < 30; i++) {
    const db = new Database(pickleDb(), { readonly: true });
    try {
      const rows = db.query("select text, attachments a, files f, inline_images i from messages where local_order > ? and kind = 'user'").all(before) as any[];
      if (rows.some((r) => squash(r.text ?? "") === squash(text) && (!files.length || r.a || r.f || r.i))) return line;
    } finally { db.close(); }
    await sleep(500);
  }
  throw new Error("Send was pressed but the message does not show up in the Pickle chat");
}

async function pollMail(st: State, baseline: boolean) {
  const r = await run([ZELE, "mail", "list", "--account", CONF.mail_account, "--filter", CONF.grok_mail_query, "--limit", "15"],
    { timeout: 90_000, env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
  if (r.code !== 0) throw new Error(`zele mail list failed rc=${r.code} ${r.err.trim().slice(0, 120)}`);
  const items = ((Bun.YAML.parse(r.out) as any)?.items ?? []) as any[];
  const seen = new Set(st.mail_seen ?? []);
  for (const m of items.slice().reverse()) {
    const id = String(m.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (baseline || !String(m.from ?? "").startsWith("Grok <")) continue; // sign-in notices from other senders are skipped
    const rd = await run([ZELE, "mail", "read", id, "--account", CONF.mail_account], { timeout: 90_000, env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
    const parts = rd.out.split(/─{20,}/);
    let body = (parts[1] ?? rd.out).split("\n").filter((l) => !/^(From|  To|Date|Auth):|^\[image: Grok\]|Unsubscribe|© 20\d\d SpaceX/.test(l)).join("\n");
    body = body.replace(/\n{3,}/g, "\n\n").trim();
    await post(CONF.grok_channel, `📬 **Grok scheduled task mail** · ${m.subject ?? ""}\n${body.slice(0, 3500)}`);
  }
  st.mail_seen = [...seen].slice(-300);
}

function readInbox(st: State): any[] {
  const f = INBOX;
  if (!existsSync(f)) { st.inbox_off ??= 0; return []; }
  const size = statSync(f).size;
  if (st.inbox_off === undefined || st.inbox_off > size) { st.inbox_off = size; return []; }
  if (size === st.inbox_off) return [];
  const fd = openSync(f, "r");
  const buf = Buffer.alloc(size - st.inbox_off);
  readSync(fd, buf, 0, buf.length, st.inbox_off); closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return [];
  st.inbox_off += Buffer.byteLength(text.slice(0, end + 1));
  return text.slice(0, end).split("\n").filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function handle(st: State, ev: any) {
  if (ev.t !== "MESSAGE_CREATE" || ev.author?.id !== CONF.owner_id) return;
  const where = [ev.channel_id, ev.parent_id];
  const hit = (k: "grok" | "instinct" | "pickle" | "dots") => on(k) && where.includes(CONF[`${k}_channel`]);
  const isGrok = hit("grok"), isInst = hit("instinct"), isPickle = hit("pickle"), isDots = hit("dots");
  if (!isGrok && !isInst && !isPickle && !isDots) return;
  const ch = isGrok ? CONF.grok_channel : isInst ? CONF.instinct_channel : isPickle ? CONF.pickle_channel : CONF.dots_channel;
  const k = isGrok ? "grok" : isInst ? "instinct" : isPickle ? "pickle" : "dots", name = isGrok ? "Grok Bot" : isInst ? "Instinct" : isPickle ? "Pickle" : "dots";
  const text = String(ev.content ?? "").trim();
  if (!text && !(ev.attachments ?? []).length) return;
  const test = String(ev.id).startsWith("test-");
  if (test) await post(ch, `🧪 test input (written into the inbox, not typed in Discord): ${text}${(ev.attachments ?? []).length ? ` + ${(ev.attachments ?? []).length} photo(s)` : ""}`);
  log("owner ->", k, ev.id, `${text.length} chars`, `attachments ${(ev.attachments ?? []).length}`);
  try {
    const media = await fetchAttachments(ev);
    if (isGrok) {
      if (!(await grokAppRunning())) { await run(["/usr/bin/open", "-g", "-a", "Grok Bot"]); log("opened Grok Bot app"); }
      await sendGrok(text, media);
      st.pending.grok = { at: Date.now(), warned: false };
      await failClear(st, "grok_send", ch);
    } else if (isInst) {
      if (text) await sendInstinct(text);
      for (const m of media) await sendInstinctFile(m.path);
      st.pending.instinct = { at: Date.now(), warned: false };
      await failClear(st, "instinct_send", ch);
    } else if (isDots) {
      await sendDots(text, media);
      st.pending.dots = { at: Date.now(), warned: false };
      st.dots_fast = Date.now() + 300_000;
      await failClear(st, "dots_send", ch);
    } else {
      await sendPickle(text, media.map((m) => m.path));
      st.pending.pickle = { at: Date.now(), warned: false };
      await failClear(st, "pickle_send", ch);
    }
    await react(ev.channel_id, ev.id, "📨");
  } catch (e: any) {
    await react(ev.channel_id, ev.id, "⚠️");
    await failNow(st, `${k}_send`, ch, `${e.message}. Your message did not reach ${name}`);
    st.fail[`${k}_send`].posted = false; // announce every failed send
  }
}
async function checkPending(st: State) {
  const lim = (CONF.reply_timeout_min ?? 10) * 60_000;
  for (const [k, ch, name] of [["grok", CONF.grok_channel, "Grok Bot"], ["instinct", CONF.instinct_channel, "Instinct"], ["pickle", CONF.pickle_channel, "Pickle"], ["dots", CONF.dots_channel, "dots"]] as const) {
    const p = st.pending[k];
    if (!p || !ch) continue;
    if (Date.now() - p.at > lim && !p.warned) {
      p.warned = true;
      let why = `no reply from ${name} ${Math.round(lim / 60_000)} minutes after sending`;
      if (k === "grok" && !(await grokAppRunning())) why += " (the Grok Bot Mac app is closed, so replies cannot be read)";
      await failNow(st, `${k}_reply`, ch, why);
    }
    if (st.fail[`${k}_reply`]) await failNow(st, `${k}_reply`, ch, st.fail[`${k}_reply`].why);
  }
}

let mediaSweep = 0;
async function main() {
  if (!TOKEN) throw new Error("set DISCORD_BOT_TOKEN or discord_bot_token in the config");
  const st = loadState();
  st.pending ??= { grok: null, instinct: null }; st.pending.pickle ??= null; st.pending.dots ??= null; st.fail ??= {};
  if (on("dots") && st.dots_last === undefined) { try { st.dots_last = (await dotsRead("")).last ?? ""; } catch (e: any) { log("dots baseline fail", e.message); } }
  if (on("pickle") && st.pickle_order === undefined) { try { st.pickle_order = pickleMax(); } catch (e: any) { log("pickle baseline fail", e.message); } }
  if (on("instinct") && st.chat_rowid === undefined) st.chat_rowid = chatMax();
  if (on("grok") && st.grok_seq === undefined) { const g = grokEntries(); st.grok_seq = g ? Math.max(0, ...g.entries.map((e) => e.seq ?? 0)) : 0; st.grok_epoch = g?.epoch; }
  if (st.inbox_off === undefined) readInbox(st);
  const mail = on("grok") && Boolean(CONF.mail_account && CONF.grok_mail_query);
  const mailBaseline = st.mail_seen === undefined;
  if (mail && mailBaseline) { await pollMail(st, true).catch((e) => log("mail baseline fail", e.message)); st.mail_at = Date.now(); }
  saveState(st);
  log("bridge start", `chat_rowid=${st.chat_rowid} grok_seq=${st.grok_seq} pickle_order=${st.pickle_order} inbox_off=${st.inbox_off}`);
  for (;;) {
    if (Date.now() >= END_MS || existsSync(FLAG)) { await endNow(); process.exit(0); }
    writeFileSync(HB, String(Date.now()));
    try {
      for (const ev of readInbox(st)) await handle(st, ev);
    } catch (e: any) { log("inbox err", e.message); }
    if (on("instinct")) {
      try { await pollInstinct(st); await failClear(st, "instinct_read", CONF.instinct_channel); }
      catch (e: any) { await failNow(st, "instinct_read", CONF.instinct_channel, `cannot read Instinct replies (${e.message.slice(0, 120)})`); }
    }
    if (on("grok")) {
      try { await pollGrok(st); await failClear(st, "grok_read", CONF.grok_channel); }
      catch (e: any) { await failNow(st, "grok_read", CONF.grok_channel, `cannot read Grok Bot replies (${e.message.slice(0, 120)})`); }
    }
    if (on("dots")) {
      try { await pollDots(st); await failClear(st, "dots_read", CONF.dots_channel); }
      catch (e: any) { await failNow(st, "dots_read", CONF.dots_channel, `cannot read the dots room (${e.message.slice(0, 120)})`); }
    }
    if (on("pickle")) {
      try { await pollPickle(st); await failClear(st, "pickle_read", CONF.pickle_channel); }
      catch (e: any) { await failNow(st, "pickle_read", CONF.pickle_channel, `cannot read Pickle replies (${e.message.slice(0, 120)})`); }
    }
    if (mail && Date.now() - (st.mail_at ?? 0) >= (CONF.mail_every_sec ?? 120) * 1000) {
      st.mail_at = Date.now();
      try { await pollMail(st, false); await failClear(st, "grok_mail", CONF.grok_channel); }
      catch (e: any) { await failNow(st, "grok_mail", CONF.grok_channel, `cannot read Grok scheduled task mail (${e.message.slice(0, 120)})`); }
    }
    await checkPending(st).catch((e) => log("pending err", e.message));
    if (Date.now() - mediaSweep > 3600_000) { mediaSweep = Date.now(); await run(["/usr/bin/find", MEDIA, "-type", "f", "-mtime", "+1", "-delete"]).catch(() => {}); }
    saveState(st);
    await sleep(3000);
  }
}

if (process.argv.includes("--keeper")) await keeper();
else if (process.argv.includes("--end-check")) { if (Date.now() >= END_MS) await endNow(); else log("end-check: not yet", END_MS === Infinity ? "no end date" : local(END_MS)); }
else await main();
