// pickle-fetch: make the Pickle Mac app download one attachment by itself, without calling Pickle's servers.
// Clicking an attachment bubble makes the app download the original into its container at
// Library/Caches/attachment-originals/<sha256(attachment path)> and open a Quick Look window. This tool finds the
// bubble, clicks it once, waits for that file, then closes Quick Look.
// Finding the bubble, scrolling and closing Quick Look happen in the background through Accessibility. Only the click
// itself brings the Pickle window forward, then the previous app, window, clipboard and mouse position are restored
// (same approach as pickle-send).
// Usage: pickle-fetch [--idle <sec>] --name <file name shown in the bubble> --want <file path to wait for>
//   --locate             only find the bubble, scroll it into view and print the click point as PFLOC x=<> y=<> pages_up=<>
//                        (pickle-bg.ts then clicks it in the background)
//   --finish --pages <N> close Quick Look and, if the list was scrolled up (N>0), scroll back to the bottom
// Output, one line: PFOK bytes=<size> steal_ms=... restore=... / PFERR <reason> ...
// Must run from a process that has Accessibility permission (for example the herdr tab the bridge runs in).
// The AX labels below ("메시지 보내기", "채팅", "메뉴", "친구 초대", "... 프로필", "첨부 추가") are Pickle's Korean UI strings.
import Cocoa
import ApplicationServices

func out(_ s: String) { print(s); fflush(stdout) }
var idleNeed = 2.0, name = "", want = "", locateOnly = false, finishOnly = false, pagesUp = 0
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  switch a {
  case "--idle": idleNeed = Double(it.next() ?? "2") ?? 2
  case "--name": name = it.next() ?? ""
  case "--want": want = it.next() ?? ""
  case "--locate": locateOnly = true
  case "--finish": finishOnly = true
  case "--pages": pagesUp = Int(it.next() ?? "0") ?? 0
  default: break
  }
}
if !finishOnly && (name.isEmpty || want.isEmpty) { out("PFERR args"); exit(2) }
let fm = FileManager.default
func size(_ p: String) -> Int { ((try? fm.attributesOfItem(atPath: p))?[.size] as? Int) ?? -1 }
if !finishOnly && size(want) > 0 { out("PFOK cached bytes=\(size(want))"); exit(0) }
guard AXIsProcessTrusted() else { out("PFERR noax"); exit(3) }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.pickle.client").first else { out("PFERR notrunning"); exit(4) }
let pid = app.processIdentifier
let axApp = AXUIElementCreateApplication(pid)
let t0 = Date()
func ms(_ from: Date) -> Int { Int(Date().timeIntervalSince(from) * 1000) }

func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func all(_ e: AXUIElement, _ acc: inout [AXUIElement], _ d: Int = 0) { acc.append(e); if d > 40 { return }; for c in children(e) { all(c, &acc, d + 1) } }
func actions(_ e: AXUIElement) -> [String] { var a: CFArray?; AXUIElementCopyActionNames(e, &a); return (a as? [String]) ?? [] }
func desc(_ e: AXUIElement) -> String { (attr(e, "AXDescription") as? String) ?? "" }
func role(_ e: AXUIElement) -> String { (attr(e, "AXRole") as? String) ?? "" }
func rect(_ e: AXUIElement) -> CGRect {
  var pt = CGPoint.zero, sz = CGSize.zero
  if let p = attr(e, "AXPosition") { AXValueGetValue(p as! AXValue, .cgPoint, &pt) }
  if let s = attr(e, "AXSize") { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
  return CGRect(origin: pt, size: sz)
}
func press(_ e: AXUIElement) { AXUIElementPerformAction(e, "AXPress" as CFString) }
func mainWindow() -> AXUIElement? { ((attr(axApp, "AXWindows") as? [AXUIElement]) ?? []).first { (attr($0, "AXIdentifier") as? String) == "SceneWindow" } }
func elements() -> [AXUIElement] { var a: [AXUIElement] = []; if let w = mainWindow() { all(w, &a) }; return a }
func quickLook() -> AXUIElement? { ((attr(axApp, "AXWindows") as? [AXUIElement]) ?? []).first { (attr($0, "AXSubrole") as? String) == "Quick Look" } }

guard mainWindow() != nil else { out("PFERR nowindow"); exit(7) }
func closeQuickLook() -> String {
  var r = "none"
  for _ in 0..<20 { if quickLook() != nil { break }; usleep(100_000) }
  for i in 0..<30 {
    guard let q = quickLook() else { if i > 0 { r = "ok\(i)" }; break }
    if let b = attr(q, "AXCloseButton") { press(b as! AXUIElement) }
    usleep(400_000)
    r = "FAIL"
  }
  return r
}
func scrollToBottom() { for _ in 0..<150 { guard let sc = elements().first(where: { actions($0).contains("AXScrollDownByPage") }) else { return }; AXUIElementPerformAction(sc, "AXScrollDownByPage" as CFString); usleep(250_000) } }
if finishOnly {
  let ql = closeQuickLook()
  if pagesUp > 0 { scrollToBottom() }
  out("PFOK finish ql=\(ql) pages_up=\(pagesUp)"); exit(0)
}
// On another tab there is no chat list, so press the Chat tab in the background (same as pickle-send)
if !elements().contains(where: { role($0) == "AXTextArea" && desc($0) == "메시지 보내기" }),
   let tab = elements().first(where: { role($0) == "AXRadioButton" && desc($0) == "채팅" }) {
  press(tab); usleep(1_200_000)
}

// Find the bubble: current screen, then down to the end, then up to the end. The end is where the visible text stops changing
func hit() -> AXUIElement? { elements().first { role($0) == "AXStaticText" && desc($0) == name } }
func scroller(_ act: String) -> AXUIElement? { elements().first { actions($0).contains(act) } }
func sig() -> String { elements().filter { role($0) == "AXStaticText" }.map(desc).joined(separator: "|") }
var moved = 0
// At the end the scroll action for that direction disappears. Right after launch the app may pause while loading older messages, so only three unchanged pages in a row count as the end
func search(_ act: String, _ maxPages: Int) -> AXUIElement? {
  if let h = hit() { return h }
  var last = sig(), same = 0
  for _ in 0..<maxPages {
    guard let sc = scroller(act) else { return nil }
    AXUIElementPerformAction(sc, act as CFString); moved += act == "AXScrollUpByPage" ? 1 : 0
    usleep(same > 0 ? 1_000_000 : 350_000)
    if let h = hit() { return h }
    let now = sig(); if now == last { same += 1; if same >= 3 { return nil } } else { same = 0 }; last = now
  }
  return nil
}
func toBottom() { for _ in 0..<150 { guard let sc = scroller("AXScrollDownByPage") else { return }; AXUIElementPerformAction(sc, "AXScrollDownByPage" as CFString); usleep(250_000) } }
guard let bubble = search("AXScrollDownByPage", 40) ?? search("AXScrollUpByPage", 150) else { toBottom(); out("PFERR nobubble"); exit(8) }
AXUIElementPerformAction(bubble, "AXScrollToVisible" as CFString)
usleep(600_000)

// Click point: the middle of the file-name text, not covered by the header (profile, menu) or the input bar
func clickPoint() -> CGPoint? {
  guard let w = mainWindow() else { return nil }
  let wr = rect(w), br = rect(bubble)
  let els = elements()
  let top = els.filter { role($0) == "AXButton" && (["메뉴", "친구 초대"].contains(desc($0)) || desc($0).hasSuffix(" 프로필")) }.map { rect($0).maxY }.max() ?? (wr.minY + 120)
  let bottom = els.first { role($0) == "AXButton" && desc($0) == "첨부 추가" }.map { rect($0).minY - 16 } ?? (wr.maxY - 120)
  let lo = max(br.minY, top + 8), hi = min(br.maxY, bottom)
  if br.width < 4 || hi - lo < 6 { return nil }
  return CGPoint(x: br.midX, y: (lo + hi) / 2)
}
// While scrolling glides the bubble moves, so wait until the same point comes up twice in a row
func stablePoint() -> CGPoint? {
  var last = clickPoint()
  for _ in 0..<15 { usleep(250_000); let now = clickPoint(); if let a = now, let b = last, abs(a.x - b.x) < 1, abs(a.y - b.y) < 1 { return a }; last = now }
  return nil
}
var pt = stablePoint()
if pt == nil, let sc = scroller("AXScrollDownByPage") { AXUIElementPerformAction(sc, "AXScrollDownByPage" as CFString); usleep(400_000); AXUIElementPerformAction(bubble, "AXScrollToVisible" as CFString); usleep(600_000); pt = stablePoint() }
guard pt != nil else { toBottom(); out("PFERR covered"); exit(9) }
if locateOnly { out("PFLOC x=\(Int(pt!.x)) y=\(Int(pt!.y)) pages_up=\(moved)"); exit(0) }

let pb = NSPasteboard.general
let savedClip: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
  item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
}
let clipCount = pb.changeCount
func restoreClip() {
  if pb.changeCount == clipCount { return }
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
  if Date().timeIntervalSince(t0) > 120 { toBottom(); out("PFERR busy"); exit(5) }
  usleep(300_000)
}
let waitMs = ms(t0)

let mouseBack = CGEvent(source: nil)?.location
let src = CGEventSource(stateID: .hidSystemState)
let s0 = Date()
if !prevWasPickle { bringFront(pid) }
var front = false
for _ in 0..<60 where frontPid() == pid { front = true; break }
if !front { restore(); toBottom(); out("PFERR activate restore=\(restored)"); exit(6) }
guard let point = clickPoint() else { restore(); toBottom(); out("PFERR covered-front restore=\(restored)"); exit(9) }
for (t, d) in [(CGEventType.mouseMoved, 80_000), (.leftMouseDown, 60_000), (.leftMouseUp, 0)] as [(CGEventType, useconds_t)] {
  CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  if d > 0 { usleep(d) }
}
// If neither Quick Look nor the file shows up within 10 s, the click did not register. Give the screen back right away
var opened = false
for _ in 0..<66 { if size(want) > 0 || quickLook() != nil { opened = true; break }; usleep(150_000) }
// Give the screen back now and keep waiting for the file in the background (large files, up to 60 s). Closing Quick Look does not need the window in front
restore()
restoreClip()
if let m = mouseBack { CGWarpMouseCursorPosition(m); CGAssociateMouseAndMouseCursorPosition(1) }
let stealMs = ms(s0)
if opened { for _ in 0..<400 where size(want) <= 0 { usleep(150_000) } }
let got = size(want) > 0
usleep(300_000)
// Quick Look is a floating window shown above other apps. Pressing close while it is still opening does nothing, so press again until it is gone
var qlClosed = "none"
for _ in 0..<20 { if quickLook() != nil { break }; usleep(100_000) }
for i in 0..<30 {
  guard let q = quickLook() else { if i > 0 { qlClosed = "ok\(i)" }; break }
  if let b = attr(q, "AXCloseButton") { press(b as! AXUIElement) }
  usleep(400_000)
  qlClosed = "FAIL"
}
if !prevWasPickle && frontPid() == pid { restore() }
if moved > 0 { toBottom() }
let n = size(want)
out(got ? "PFOK bytes=\(n) steal_ms=\(stealMs) wait_ms=\(waitMs) pages_up=\(moved) ql=\(qlClosed) prev=\(prev?.localizedName ?? "?") restore=\(restored)"
        : "PFERR \(opened ? "nofile" : "noopen") steal_ms=\(stealMs) point=\(Int(point.x)),\(Int(point.y)) ql=\(qlClosed) restore=\(restored)")
exit(got ? 0 : 10)
