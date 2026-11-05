#!/usr/bin/env bun
// pickle-bg: control the Pickle Mac app in the background, without bringing its window forward.
// It starts the OmO desktop engine (the engine behind OmO's computer-use tool, `senpi-desktop-engine --stdio`, JSON-RPC)
// and uses its background AX clicks and typing. Your front app, mouse and clipboard are not touched.
// Optional: if the engine is not installed or anything fails it prints PBERR, and the bridge falls back once to
// pickle-send / pickle-fetch (which bring the window forward briefly).
// Usage: bun pickle-bg.ts send [--no-send] [--clear] -        text on stdin, single line only (PBERR multiline otherwise)
//        bun pickle-bg.ts fetch --name <file name shown in the bubble> --want <file path to wait for>
// Output, one line: PBOK ... front=<same|changed> mouse=<same|changed> clip=<same|changed> / PBERR <reason> ...
// Must run from a process that has Accessibility permission (for example the herdr tab the bridge runs in).
// Environment: OMO_DESKTOP_ENGINE overrides the engine path.
// The window and AX names below ("피클", "메시지 보내기", "채팅", "보내기") are Pickle's Korean UI strings.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const ENGINE = process.env.OMO_DESKTOP_ENGINE ?? `${HOME}/.omo/engines/senpi-desktop-engine/darwin-arm64/senpi-desktop-engine`;
const FETCH = `${import.meta.dir}/pickle-fetch`;
const STOP_CHORD = "ctrl+alt+shift+escape";
const MAX_LEN = 500;
const t0 = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const squash = (t: string) => t.replace(/\s/g, "");
const size = (p: string) => (existsSync(p) ? statSync(p).size : -1);

let finished = false;
function done(line: string, code = 0): never {
  if (!finished) { finished = true; console.log(line); }
  try { eng?.kill(); } catch {}
  process.exit(code);
}

const PROBE = `ObjC.import('AppKit');const f=$.NSWorkspace.sharedWorkspace.frontmostApplication;const m=$.NSEvent.mouseLocation;
JSON.stringify({front:f.processIdentifier,mouse:Math.round(m.x)+','+Math.round(m.y),clip:Number($.NSPasteboard.generalPasteboard.changeCount)})`;
async function probe(): Promise<{ front: number; mouse: string; clip: number } | null> {
  try { return JSON.parse((await Bun.$`/usr/bin/osascript -l JavaScript -e ${PROBE}`.quiet().text()).trim()); } catch { return null; }
}

let eng: ReturnType<typeof Bun.spawn> | undefined;
let buf = "", seq = 0;
const waiters = new Map<number, (m: any) => void>();
async function startEngine() {
  if (!existsSync(ENGINE)) done("PBERR noengine", 3);
  eng = Bun.spawn([ENGINE, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  (async () => {
    const d = new TextDecoder();
    for await (const c of eng!.stdout as ReadableStream<Uint8Array>) {
      buf += d.decode(c);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(l); if (m.id != null) { waiters.get(m.id)?.(m); waiters.delete(m.id); } } catch {}
      }
    }
  })();
  await call("engine.hello", {});
  await call("session.open", { macosCanary: "off", showCursor: false });
  const sp = await call("stopPath.start", { chord: STOP_CHORD });
  if (sp?.stopPath === "none") done("PBERR nostoppath", 3);
  setInterval(() => { send("stopPath.heartbeat", {}); }, 500);
}
function send(method: string, params: unknown) {
  const id = ++seq;
  (eng!.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  (eng!.stdin as import("bun").FileSink).flush();
  return id;
}
async function call(method: string, params: unknown, ms = 20_000): Promise<any> {
  const id = send(method, params);
  const m = await Promise.race([new Promise<any>((r) => waiters.set(id, r)), sleep(ms).then(() => ({ error: { message: "timeout", data: { code: "Timeout" } } }))]);
  if (m.error) throw new Error(`${method}:${m.error.data?.code ?? m.error.code}:${String(m.error.message).slice(0, 120)}`);
  return m.result;
}

async function pickleWindow(): Promise<string> {
  const ws = (await call("windows", {})) as { id: string; app: string; title: string; width: number; height: number }[];
  const mine = ws.filter((w) => w.app === "피클");
  const w = mine.find((x) => x.title === "피클") ?? mine.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!w) done("PBERR nowindow", 7);
  return w.id;
}
async function snapshot(win: string): Promise<string[]> {
  return String((await call("ax.snapshot", { target: win, opts: { maxDepth: 40 } })).text).split("\n");
}
const refOf = (lines: string[], start: string) => lines.map((l) => l.trim()).find((l) => l.startsWith(start))?.match(/\[ref=(e\d+)\]/)?.[1];
const TA = '- textarea "메시지 보내기"';

async function inputRef(win: string): Promise<{ ta: string; tab: string }> {
  let lines = await snapshot(win);
  let ta = refOf(lines, TA), tab = "";
  if (!ta) {
    const chat = refOf(lines, '- radio "채팅"');
    if (chat) { await call("ax.perform", { ref: chat, action: "press" }); await sleep(1200); lines = await snapshot(win); ta = refOf(lines, TA); tab = " tab=chat"; }
  }
  if (!ta) done(`PBERR noinput${tab ? " tab=chat-fail" : ""}`, 7);
  return { ta, tab };
}
const valueOf = async (ref: string) => String((await call("ax.node", { ref }))?.value ?? "");
async function wipe(win: string, ta: string) {
  await call("ax.click", { ref: ta, opts: {} });
  await call("keyChord", { target: win, keys: ["cmd", "a"], opts: {} });
  await call("keyChord", { target: win, keys: ["delete"], opts: {} });
  await sleep(300);
  return squash(await valueOf(ta)) === "";
}

function sameNote(a: Awaited<ReturnType<typeof probe>>, b: Awaited<ReturnType<typeof probe>>) {
  if (!a || !b) return "front=? mouse=? clip=?";
  return `front=${a.front === b.front ? "same" : "changed"} mouse=${a.mouse === b.mouse ? "same" : "changed"} clip=${a.clip === b.clip ? "same" : "changed"}`;
}

async function doSend(args: string[]) {
  const noSend = args.includes("--no-send"), clearOnly = args.includes("--clear");
  const msg = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!msg) done("PBERR notext", 2);
  if (/\n/.test(msg)) done("PBERR multiline", 2);
  if (msg.length > MAX_LEN) done(`PBERR long len=${msg.length}`, 2);
  const before = await probe();
  await startEngine();
  const win = await pickleWindow();
  const { ta, tab } = await inputRef(win);
  const cur = await valueOf(ta);
  if (clearOnly) {
    if (squash(cur) !== squash(msg)) done("PBERR clear-mismatch", 11);
    const ok = await wipe(win, ta);
    done(ok ? `PBOK cleared ${sameNote(before, await probe())}` : "PBERR clear-left", ok ? 0 : 12);
  }
  if (squash(cur)) done("PBERR draft", 8);
  await call("ax.click", { ref: ta, opts: {} });
  const node = await call("ax.node", { ref: ta });
  if (!node?.focused) done("PBERR nofocus", 9);
  await call("ax.typeText", { ref: ta, text: msg, opts: {} });
  let typed = "";
  for (let i = 0; i < 20; i++) { typed = await valueOf(ta); if (squash(typed) === squash(msg)) break; await sleep(100); }
  if (squash(typed) !== squash(msg)) {
    const wiped = squash(typed) ? await wipe(win, ta) : true;
    done(`PBERR typed-mismatch got=${typed.length} want=${msg.length} wiped=${wiped}`, 9);
  }
  const typedNote = sameNote(before, await probe());
  if (noSend) done(`PBOK typed-only ms=${Date.now() - t0} ${typedNote}${tab}`);
  const sendBtn = refOf(await snapshot(win), '- button "보내기"');
  if (!sendBtn) { const wiped = await wipe(win, ta); done(`PBERR nosendbutton wiped=${wiped}`, 10); }
  await call("ax.perform", { ref: sendBtn, action: "press" });
  for (let i = 0; i < 30; i++) {
    const lines = await snapshot(win);
    const v = refOf(lines, TA) ? await valueOf(refOf(lines, TA)!) : "";
    if (!squash(v) && !refOf(lines, '- button "보내기"')) done(`PBOK sent ms=${Date.now() - t0} ${sameNote(before, await probe())}${tab}`);
    await sleep(100);
  }
  done("PBERR enter-not-sent", 10);
}

async function doFetch(args: string[]) {
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? "" : ""; };
  const name = get("--name"), want = get("--want");
  if (!name || !want) done("PBERR args", 2);
  if (size(want) > 0) done(`PBOK cached bytes=${size(want)}`);
  const before = await probe();
  const loc = (await Bun.$`${FETCH} --locate --name ${name} --want ${want}`.nothrow().quiet().text()).trim().split("\n").pop() ?? "";
  if (loc.startsWith("PFOK")) done(`PBOK cached bytes=${size(want)}`);
  if (!loc.startsWith("PFLOC")) done(`PBERR locate ${loc.replace(/^PFERR /, "") || "?"}`, 8);
  const pages = Number(loc.match(/pages_up=(\d+)/)?.[1] ?? 0);
  const finish = async () => (await Bun.$`${FETCH} --finish --pages ${pages}`.nothrow().quiet().text()).trim().match(/ql=(\S+)/)?.[1] ?? "?";
  await startEngine();
  const win = await pickleWindow();
  const bubble = refOf(await snapshot(win), `- statictext ${JSON.stringify(name)}`);
  if (!bubble) { const ql = await finish(); done(`PBERR nobubble ql=${ql}`, 8); }
  const known = new Set(((await call("windows", {})) as { id: string; app: string }[]).filter((w) => w.app === "피클").map((w) => w.id));
  await call("ax.click", { ref: bubble, opts: {} });
  let opened = false;
  for (let i = 0; i < 66 && !opened; i++) {
    if (size(want) > 0) { opened = true; break; }
    const ws = (await call("windows", {})) as { id: string; app: string }[];
    if (ws.some((w) => w.app === "피클" && !known.has(w.id))) opened = true; else await sleep(150);
  }
  if (opened) for (let i = 0; i < 400 && size(want) <= 0; i++) await sleep(150);
  const ql = await finish();
  const note = sameNote(before, await probe());
  done(size(want) > 0 ? `PBOK bytes=${size(want)} ms=${Date.now() - t0} pages_up=${pages} ql=${ql} ${note}` : `PBERR ${opened ? "nofile" : "noopen"} ql=${ql} ${note}`, size(want) > 0 ? 0 : 10);
}

const [cmd, ...rest] = process.argv.slice(2);
setTimeout(() => done("PBERR timeout", 14), 170_000);
try {
  if (cmd === "send") await doSend(rest);
  else if (cmd === "fetch") await doFetch(rest);
  else done("PBERR usage", 2);
} catch (e) {
  done(`PBERR engine ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 160)}`, 13);
}
