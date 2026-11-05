// pickle-send: type a message into the Pickle Mac app (the iOS app running on Apple silicon) and press Send.
// Pickle has no official way to send from outside (no Shortcuts action or URL scheme), and background key events
// or AX value setting do not reach its input box. So the Pickle window is brought forward only for one paste, the
// previous app, window and clipboard are restored right away, and checking the text and pressing Send happen in
// the background through Accessibility.
// Usage: pickle-send [--no-send] [--clear] [--idle <sec>] [--file <path>]... <text | ->   ("-" reads stdin; use "" for files only)
//   --no-send  only put the text in the input box (for testing)
//   --clear    clear the input box only if it equals <text> (cleanup after a test)
//   --idle N   take the screen only after you have not touched the keyboard/mouse for N seconds (default 2, waits up to 90 s)
// Output, one line: PSOK steal_ms=<ms the window was in front> ... / PSERR <reason> ...
// Must run from a process that has Accessibility permission (for example the herdr tab the bridge runs in).
// The AX labels below ("메시지 보내기", "보내기", "채팅", "첨부 추가", "파일", "문서", "열기", "취소") are Pickle's Korean UI strings.
// Change them if your Mac runs Pickle in another language.
import Cocoa
import ApplicationServices

func out(_ s: String) { print(s); fflush(stdout) }
var noSend = false, clearOnly = false, idleNeed = 2.0
var text: String? = nil
var files: [String] = []
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  switch a {
  case "--no-send": noSend = true
  case "--clear": clearOnly = true
  case "--idle": idleNeed = Double(it.next() ?? "2") ?? 2
  case "--file": if let f = it.next() { files.append(f) }
  default: text = a
  }
}
if text == "-" { text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) }
let msg = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
if msg.isEmpty && files.isEmpty { out("PSERR notext"); exit(2) }
for f in files where !FileManager.default.fileExists(atPath: f) { out("PSERR nofile"); exit(2) }
guard AXIsProcessTrusted() else { out("PSERR noax"); exit(3) }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.pickle.client").first else { out("PSERR notrunning"); exit(4) }
let pid = app.processIdentifier
let axApp = AXUIElementCreateApplication(pid)
let squash = { (s: String) in s.filter { !$0.isWhitespace } }
let t0 = Date()
func ms(_ from: Date) -> Int { Int(Date().timeIntervalSince(from) * 1000) }

func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func findEl(_ e: AXUIElement, role: String, desc: String, _ depth: Int = 0) -> AXUIElement? {
  if (attr(e, "AXRole") as? String) == role && (attr(e, "AXDescription") as? String) == desc { return e }
  if depth > 12 { return nil }
  for c in (attr(e, "AXChildren") as? [AXUIElement]) ?? [] {
    if (attr(c, "AXRole") as? String) == "AXStaticText" { continue }
    if let f = findEl(c, role: role, desc: desc, depth + 1) { return f }
  }
  return nil
}
func inputValue(_ e: AXUIElement) -> String { (attr(e, "AXValue") as? String) ?? "" }

let src = CGEventSource(stateID: .hidSystemState)
func key(_ code: CGKeyCode, cmd: Bool = false) {
  for down in [true, false] {
    let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
    ev.flags = cmd ? .maskCommand : []
    ev.post(tap: .cghidEventTap)
    usleep(10000)
  }
}
let pb = NSPasteboard.general
let savedClip: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
  item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
}
func restoreClip() {
  pb.clearContents()
  let items: [NSPasteboardItem] = savedClip.map { pairs in
    let it = NSPasteboardItem(); for (t, d) in pairs { it.setData(d, forType: t) }; return it
  }
  if !items.isEmpty { pb.writeObjects(items) }
}

func frontPid() -> pid_t? { RunLoop.current.run(until: Date().addingTimeInterval(0.03)); return NSWorkspace.shared.frontmostApplication?.processIdentifier }
func bringFront(_ p: pid_t) { AXUIElementSetAttributeValue(AXUIElementCreateApplication(p), "AXFrontmost" as CFString, kCFBooleanTrue) }
_ = frontPid()
let prev = NSWorkspace.shared.frontmostApplication
let prevWasPickle = prev?.processIdentifier == pid
let prevWin: AXUIElement? = prev.flatMap { attr(AXUIElementCreateApplication($0.processIdentifier), "AXFocusedWindow") as! AXUIElement? }
var restored = "skip"
func restore() {
  guard !prevWasPickle, let p = prev else { return }
  restored = "FAIL"
  for attempt in 0..<3 {
    bringFront(p.processIdentifier)
    if attempt > 0 { p.activate(options: []) }
    for _ in 0..<15 where frontPid() == p.processIdentifier { restored = "ok\(attempt)"; break }
    if restored != "FAIL" { break }
  }
  if restored == "FAIL", let bid = p.bundleIdentifier {
    let t = Process(); t.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    t.arguments = ["-e", "tell application id \"\(bid)\" to activate"]; try? t.run(); t.waitUntilExit()
    for _ in 0..<15 where frontPid() == p.processIdentifier { restored = "ok-osa"; break }
  }
  if let w = prevWin {
    AXUIElementPerformAction(w, "AXRaise" as CFString)
    AXUIElementSetAttributeValue(w, "AXMain" as CFString, kCFBooleanTrue)
    let now = attr(AXUIElementCreateApplication(p.processIdentifier), "AXFocusedWindow") as! AXUIElement?
    restored += (now.map { CFEqual($0, w) } ?? false) ? "+win" : "+win?"
  }
}

// Wait until you pause, so your own typing does not land in Pickle while its window is in front
let anyInput = CGEventType(rawValue: ~0)!
while min(CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput),
          CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)) < idleNeed {
  if Date().timeIntervalSince(t0) > 90 { out("PSERR busy"); exit(5) }
  usleep(300_000)
}
let waitMs = ms(t0)

var input: AXUIElement? = nil
for _ in 0..<20 { input = findEl(axApp, role: "AXTextArea", desc: "메시지 보내기"); if input != nil { break }; usleep(100_000) }
// If the window is on another tab (for example the profile tab) there is no input box, so press the Chat tab first
var tabNote = ""
if input == nil, let chatTab = first(axApp, { (attr($0, "AXRole") as? String) == "AXRadioButton" && (attr($0, "AXDescription") as? String) == "채팅" }) {
  press(chatTab)
  for _ in 0..<30 { input = findEl(axApp, role: "AXTextArea", desc: "메시지 보내기"); if input != nil { break }; usleep(100_000) }
  // Pasting into an input box found right after switching tabs did not work, so wait 1 s for the screen to settle and look it up again
  if input != nil { usleep(1_000_000); input = findEl(axApp, role: "AXTextArea", desc: "메시지 보내기") }
  tabNote = input != nil ? " tab=chat" : " tab=chat-fail"
}
guard let ta = input else { out("PSERR noinput\(tabNote)"); exit(7) }
let before = inputValue(ta)
if clearOnly && squash(before) != squash(msg) { out("PSERR clear-mismatch"); exit(11) }
if !clearOnly && !squash(before).isEmpty { out("PSERR draft"); exit(8) }

func steal(_ body: () -> Void) -> Int {
  let s = Date()
  if !prevWasPickle { bringFront(pid) }
  var ok = false
  for _ in 0..<60 where frontPid() == pid { ok = true; break }
  if !ok { restore(); out("PSERR activate restore=\(restored)"); exit(6) }
  AXUIElementSetAttributeValue(ta, "AXFocused" as CFString, kCFBooleanTrue)
  usleep(120_000)
  // Setting AXFocused can report success while focus stays on a parent AXGroup, so the paste goes nowhere. AXPress on the input box gives it focus
  if (attr(ta, "AXFocused") as? Bool) != true { AXUIElementPerformAction(ta, "AXPress" as CFString); usleep(200_000) }
  if frontPid() == pid { body() } else { restore(); out("PSERR lost-front restore=\(restored)"); exit(6) }
  restore()
  return ms(s)
}

if clearOnly {
  let st = steal { key(0, cmd: true); key(51) }
  usleep(300_000)
  let left = inputValue(ta)
  out(squash(left).isEmpty ? "PSOK cleared steal_ms=\(st) restore=\(restored)" : "PSERR clear-left steal_ms=\(st) restore=\(restored)")
  exit(squash(left).isEmpty ? 0 : 12)
}

func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func findAll(_ e: AXUIElement, _ pred: (AXUIElement) -> Bool, _ depth: Int = 0, _ acc: inout [AXUIElement]) {
  if pred(e) { acc.append(e) }
  if depth > 30 { return }
  for c in children(e) { findAll(c, pred, depth + 1, &acc) }
}
func first(_ e: AXUIElement, _ pred: (AXUIElement) -> Bool) -> AXUIElement? { var a: [AXUIElement] = []; findAll(e, pred, 0, &a); return a.first }
func press(_ e: AXUIElement) { AXUIElementPerformAction(e, "AXPress" as CFString) }
func waitFor(_ secs: Double, _ f: () -> AXUIElement?) -> AXUIElement? {
  let end = Date().addingTimeInterval(secs)
  while Date() < end { if let x = f() { return x }; usleep(150_000) }
  return nil
}
var attachSteal = 0
var staged: [URL] = []
atexit { for u in staged { try? FileManager.default.removeItem(at: u) } }
func attachFile(_ src: String) -> String? {
  let docs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")
  let name = "pickle-bridge-\(Int(Date().timeIntervalSince1970 * 1000))-\((src as NSString).lastPathComponent)"
  let dst = docs.appendingPathComponent(name)
  do { try FileManager.default.copyItem(at: URL(fileURLWithPath: src), to: dst) } catch { return "copy" }
  staged.append(dst)
  let win = attr(axApp, "AXFocusedWindow") as! AXUIElement? ?? ((attr(axApp, "AXWindows") as? [AXUIElement])?.first)
  guard let w = win else { return "nowindow" }
  guard let plus = findEl(axApp, role: "AXButton", desc: "첨부 추가") else { return "noplus" }
  press(plus)
  guard let fileBtn = waitFor(3, { findEl(axApp, role: "AXButton", desc: "파일") }) else { return "nofilebutton" }
  press(fileBtn)
  guard let sheet = waitFor(6, { children(w).first { (attr($0, "AXRole") as? String) == "AXSheet" } }) else { return "nosheet" }
  if let loc = first(sheet, { (attr($0, "AXRole") as? String) == "AXPopUpButton" }), (attr(loc, "AXValue") as? String) != "문서",
     let side = first(sheet, { (attr($0, "AXRole") as? String) == "AXStaticText" && ["Documents", "문서"].contains((attr($0, "AXValue") as? String) ?? "") }),
     let row = attr(attr(side, "AXParent") as! AXUIElement, "AXParent") as! AXUIElement? {
    AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue)
    usleep(800_000)
  }
  guard let tf = waitFor(6, { first(sheet, { (attr($0, "AXRole") as? String) == "AXTextField" && (attr($0, "AXValue") as? String) == name }) }),
        let cell = attr(tf, "AXParent") as! AXUIElement?, let row = attr(cell, "AXParent") as! AXUIElement? else {
    if let c = first(sheet, { (attr($0, "AXRole") as? String) == "AXButton" && (attr($0, "AXTitle") as? String ?? attr($0, "AXDescription") as? String) == "취소" }) { press(c) }
    return "nofileinpanel"
  }
  AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue)
  usleep(400_000)
  guard let open = first(sheet, { (attr($0, "AXRole") as? String) == "AXButton" && ((attr($0, "AXTitle") as? String) == "열기" || (attr($0, "AXDescription") as? String) == "열기") }) else { return "noopen" }
  press(open)
  _ = waitFor(6, { children(w).contains { (attr($0, "AXRole") as? String) == "AXSheet" } ? nil : w })
  usleep(1_500_000)
  return nil
}

for f in files {
  let s0 = Date()
  let err = attachFile(f)
  if !prevWasPickle && frontPid() != prev?.processIdentifier { restore(); attachSteal += ms(s0) }
  if let e = err { restoreClip(); out("PSERR attach-\(e) restore=\(restored)"); exit(13) }
}

let stealMs = msg.isEmpty ? 0 : steal {
  pb.clearContents(); pb.setString(msg, forType: .string)
  usleep(60_000)
  key(9, cmd: true)
  usleep(200_000)
  restoreClip()
}
var typed = ""
for _ in 0..<20 { typed = inputValue(ta); if squash(typed) == squash(msg) { break }; usleep(100_000) }
if squash(typed) != squash(msg) {
  let st2 = squash(typed).isEmpty ? 0 : steal { key(0, cmd: true); key(51) }
  out("PSERR typed-mismatch got=\(typed.count) want=\(msg.count) steal_ms=\(stealMs)+\(st2) restore=\(restored)")
  exit(9)
}
if noSend { out("PSOK typed-only steal_ms=\(stealMs) wait_ms=\(waitMs) restore=\(restored)"); exit(0) }

guard let sendBtn = findEl(axApp, role: "AXButton", desc: "보내기") else {
  out("PSERR nosendbutton steal_ms=\(stealMs) restore=\(restored)"); exit(10)
}
AXUIElementPerformAction(sendBtn, "AXPress" as CFString)
var cleared = false
for _ in 0..<30 { if squash(inputValue(ta)).isEmpty && findEl(axApp, role: "AXButton", desc: "보내기") == nil { cleared = true; break }; usleep(100_000) }
out(cleared ? "PSOK steal_ms=\(stealMs) attach_restore_ms=\(attachSteal) files=\(files.count) wait_ms=\(waitMs) total_ms=\(ms(t0)) prev=\(prev?.localizedName ?? "?") restore=\(restored)\(tabNote)"
            : "PSERR enter-not-sent steal_ms=\(stealMs) restore=\(restored)")
exit(cleared ? 0 : 10)
