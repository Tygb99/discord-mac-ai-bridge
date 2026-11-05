#!/usr/bin/env bun
// Discord gateway listener for discord-mac-ai-bridge. Run it under launchd (no special permissions needed).
// It appends messages from the configured bridge channels (and their threads) to the inbox file, one JSON object
// per line (t, at, id, channel_id, parent_id, guild_id, author, content, attachments, reply_to, mentions_bot).
// bridge.ts reads that file. Messages that mention the bot are skipped, so you can still talk to other bots there.
import { appendFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const DIR = process.env.BRIDGE_DIR ?? `${HOME}/.config/discord-mac-ai-bridge`;
const CONF = JSON.parse(readFileSync(process.env.BRIDGE_CONFIG ?? `${DIR}/config.json`, "utf8"));
const INBOX: string = CONF.inbox ?? `${DIR}/inbox.jsonl`;
const STATE = `${DIR}/gateway-state.json`;
const API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15);
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const WATCHED: string[] = [CONF.grok_channel, CONF.instinct_channel, CONF.pickle_channel, CONF.dots_channel].filter(Boolean);
mkdirSync(DIR, { recursive: true });

type GatewayState = { session_id?: string; resume_url?: string; seq?: number | null };
type Payload = { op: number; d: any; s?: number | null; t?: string | null };

const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

const TOKEN: string | undefined = process.env.DISCORD_BOT_TOKEN ?? CONF.discord_bot_token;
if (!TOKEN) {
  log("no bot token (DISCORD_BOT_TOKEN or discord_bot_token in the config); waiting 10 min before exit");
  await Bun.sleep(600_000);
  process.exit(1);
}
const auth = { Authorization: `Bot ${TOKEN}`, "User-Agent": "discord-mac-ai-bridge (local, 1)" };

async function api(path: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

const me = await api("/users/@me");
const BOT_ID: string = me.id;
const gatewayUrl: string = (await api("/gateway/bot").catch(() => ({ url: "wss://gateway.discord.gg" }))).url;
let state: GatewayState = await Bun.file(STATE).json().catch(() => ({}));
const parentCache = new Map<string, string | null>();
const saveState = () => Bun.write(STATE, JSON.stringify(state));

async function parentOf(channelId: string): Promise<string | null> {
  if (!parentCache.has(channelId)) {
    const ch = await api(`/channels/${channelId}`);
    parentCache.set(channelId, ch.parent_id ?? null);
  }
  return parentCache.get(channelId) ?? null;
}

async function emit(t: string, d: any) {
  if (!d.guild_id) return;
  const mentionsBot = (d.mentions ?? []).some((m: any) => m.id === BOT_ID);
  if (mentionsBot) return;
  const parent = WATCHED.includes(d.channel_id) ? null : await parentOf(d.channel_id);
  if (!WATCHED.includes(d.channel_id) && !(parent && WATCHED.includes(parent))) return;
  const line = {
    t, channel_id: d.channel_id, parent_id: parent, guild_id: d.guild_id,
    at: d.edited_timestamp ?? d.timestamp,
    id: d.id,
    author: { id: d.author?.id, username: d.author?.username, global_name: d.author?.global_name ?? null },
    content: d.content ?? "",
    attachments: (d.attachments ?? []).map((a: any) => ({ filename: a.filename, url: a.url, content_type: a.content_type ?? null, size: a.size })),
    reply_to: d.message_reference?.message_id ?? null,
    mentions_bot: false,
  };
  await appendFile(INBOX, JSON.stringify(line) + "\n");
  log("event", t, d.channel_id);
}

async function dispatch(t: string, d: any) {
  switch (t) {
    case "READY":
      state.session_id = d.session_id;
      state.resume_url = d.resume_gateway_url;
      log("READY", d.user?.username, `guilds=${d.guilds?.length ?? 0}`);
      break;
    case "RESUMED":
      log("RESUMED");
      break;
    case "MESSAGE_CREATE":
      if (d.author && d.author.id !== BOT_ID && !d.author.bot) await emit(t, d);
      break;
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
    case "CHANNEL_UPDATE":
      parentCache.set(d.id, d.parent_id ?? null);
      break;
  }
}

let ws: WebSocket | null = null;
let beatDelay: ReturnType<typeof setTimeout> | undefined;
let beatLoop: ReturnType<typeof setInterval> | undefined;
let acked = true;
let backoff = 1_000;

const send = (op: number, d: unknown) => ws?.send(JSON.stringify({ op, d }));
const resumable = () => Boolean(state.session_id && state.resume_url);
const stopBeat = () => {
  clearTimeout(beatDelay);
  clearInterval(beatLoop);
};

function startBeat(interval: number) {
  stopBeat();
  acked = true;
  const beat = () => {
    if (!acked) {
      log("heartbeat not acked, reconnecting");
      ws?.close(4000, "zombie");
      return;
    }
    acked = false;
    send(1, state.seq ?? null);
  };
  beatDelay = setTimeout(() => {
    beat();
    beatLoop = setInterval(beat, interval);
  }, Math.floor(interval * Math.random()));
}

function identify() {
  send(2, { token: TOKEN, intents: INTENTS, properties: { os: "macos", browser: "discord-mac-ai-bridge", device: "discord-mac-ai-bridge" } });
}

function connect() {
  const url = resumable() ? state.resume_url! : gatewayUrl;
  const socket = new WebSocket(`${url}/?v=10&encoding=json`);
  ws = socket;
  socket.onmessage = async (ev) => {
    const p: Payload = JSON.parse(String(ev.data));
    if (p.s != null) state.seq = p.s;
    switch (p.op) {
      case 10:
        startBeat(p.d.heartbeat_interval);
        if (resumable()) send(6, { token: TOKEN, session_id: state.session_id, seq: state.seq ?? null });
        else identify();
        break;
      case 11:
        acked = true;
        break;
      case 1:
        send(1, state.seq ?? null);
        break;
      case 7:
        log("server asked to reconnect");
        socket.close(4000, "reconnect");
        break;
      case 9:
        log("invalid session, resumable:", p.d);
        if (!p.d) state = {};
        await saveState();
        await Bun.sleep(1_000 + Math.random() * 4_000);
        socket.close(4000, "invalid session");
        break;
      case 0:
        backoff = 1_000;
        await dispatch(String(p.t), p.d).catch((e) => log("dispatch error", p.t, e?.message));
        await saveState();
        break;
    }
  };
  socket.onclose = async (ev) => {
    stopBeat();
    if (ws !== socket) return;
    log("closed", ev.code, ev.reason || "");
    if (FATAL_CLOSE.has(ev.code)) {
      log("fatal close code; waiting 15 min before exit");
      await Bun.sleep(900_000);
      process.exit(1);
    }
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
    connect();
  };
  socket.onerror = () => log("websocket error");
}

log("gateway start", me.username, "watching", WATCHED.length, "channel(s), resume:", resumable());
connect();
