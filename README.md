# discord-mac-ai-bridge

[한국어](README.ko.md)

Talk to AI chat apps that live on your Mac from Discord channels, from any device.
You write in a Discord channel, the bridge types it into the app on your Mac, and the app's replies come back to the same channel.

| Discord channel | Where your message goes | Where replies are read from |
| --- | --- | --- |
| Grok Bot | the Grok Bot chat on grok.com, typed through the Aside browser | the Grok Bot Mac app's local transcript copy, plus Grok scheduled-task result mails (optional, via `zele`) |
| Instinct | macOS Messages (iMessage) to one handle | `~/Library/Messages/chat.db` |
| Pickle | the Pickle Mac app's input box (Accessibility helper `pickle-send`) | the app's local chat mirror (`ChatMirror/db.sqlite`), including call transcripts and attachments |
| dots | a ChatGPT dots room on chatgpt.com, typed through the Aside browser | the room's messages, read inside your logged-in Aside tab |

Each service is optional. Leave its channel empty in the config and the bridge skips it.
Photos and files you attach in Discord are passed on, and photos and files from the apps are posted back (up to Discord's 10 MB per file).
Sent messages get a 📨 reaction. Failures get ⚠️ plus a one-line reason in the channel.

> **Not affiliated.** This is a personal tool. It is not made, endorsed or supported by xAI (Grok), Instinct, Pickle, OpenAI (ChatGPT, dots), OmO, Discord or Apple.
> It automates the apps' normal user interfaces on your own Mac with your own accounts.
> You are responsible for following each service's terms of use.

## How it works

```text
Discord ──gateway.ts──▶ inbox.jsonl ──▶ bridge.ts (in a herdr tab) ──▶ Grok Bot / Messages / Pickle / dots
   ▲                                          │
   └──────────── Discord REST ◀── replies from local app data ◀┘
```

- `gateway.ts` keeps a Discord gateway connection and appends your messages from the bridge channels (and their threads) to `inbox.jsonl`.
- `bridge.ts` reads the inbox every 3 seconds, sends each message to the right app, and polls the apps for replies.
- `bridge.ts --keeper` runs every minute from a LaunchAgent. If the bridge heartbeat is older than 90 seconds it reopens the bridge in a herdr tab.
  The bridge runs inside a herdr tab, not directly under launchd, because reading `chat.db` and the app containers needs Full Disk Access and the Pickle helpers need Accessibility. A terminal app can hold those permissions.
- `helpers/pickle-bg.ts` (optional) sends to Pickle and fetches attachments fully in the background, through the OmO desktop engine that OmO's computer-use tool uses. Nothing comes to the front. If the engine is not installed or it fails, the bridge falls back once to the two Swift helpers below.
- `helpers/pickle-send` types into Pickle. Pickle ignores background key events and AX value setting, so the helper waits until you have not touched the keyboard or mouse for 2 seconds, brings Pickle forward for about 1 to 2 seconds to paste, then restores your previous app, window and clipboard. It presses Send in the background.
- `helpers/pickle-fetch` gets an attachment that arrived from another device. It clicks the attachment bubble so the Pickle app downloads it itself. The bridge never reads Pickle's login token and never calls Pickle's servers.

## Requirements

- macOS on Apple silicon (Pickle is an iOS app running on the Mac). Developed and used on a recent macOS release.
- [Bun](https://bun.sh)
- Xcode Command Line Tools (`swiftc`), to build the Pickle helpers
- A Discord bot in your own server with the **Message Content** intent, invited with permission to read and send messages, attach files and add reactions in the bridge channels
- [herdr](https://herdr.dev), the terminal workspace the bridge runs in. Give the app that hosts it **Full Disk Access** and **Accessibility** in System Settings > Privacy & Security
- Per service:
  - Grok Bot: the Aside browser with `aside repl`, logged in to grok.com; the Grok Bot Mac app installed and running (its local transcript is where replies are read). Optional: `zele` with the Gmail account that receives Grok scheduled-task mails
  - Instinct: Messages signed in to iMessage. macOS asks once to allow controlling Messages (Automation)
  - Pickle: the Pickle Mac app, logged in, with its chat screen open. Optional: [OmO](https://omo.dev) installed, so its desktop engine exists at `~/.omo/engines/senpi-desktop-engine/darwin-arm64/senpi-desktop-engine` (or set `OMO_DESKTOP_ENGINE`) for the background path
  - dots: the Aside browser logged in to chatgpt.com, with access to the dots room

## Install

```sh
git clone https://github.com/Tygb99/discord-mac-ai-bridge.git
cd discord-mac-ai-bridge
bun install            # only editor types (@types/bun); the bridge has no runtime dependencies
./build-helpers.sh     # builds helpers/pickle-send and helpers/pickle-fetch

mkdir -p ~/.config/discord-mac-ai-bridge
cp config.example.json ~/.config/discord-mac-ai-bridge/config.json
chmod 600 ~/.config/discord-mac-ai-bridge/config.json
```

Then fill in `~/.config/discord-mac-ai-bridge/config.json`:

| Key | What to put |
| --- | --- |
| `discord_bot_token` | the bot token (or set `DISCORD_BOT_TOKEN` for `gateway.ts`; the bridge in the herdr tab reads the config) |
| `owner_id` | your Discord user ID. Only your messages are forwarded |
| `grok_channel`, `instinct_channel`, `pickle_channel`, `dots_channel` | channel IDs, or `""` to turn a service off |
| `grok_bot_id`, `grok_bot_url` | the Grok Bot ID from the bot chat URL on grok.com, and that URL |
| `mail_account`, `grok_mail_query`, `mail_every_sec` | optional: the `zele` account and search query for Grok scheduled-task mails |
| `instinct_handle` | the phone number or Apple ID of the iMessage contact |
| `dots_url`, `dots_room`, `dots_member`, `dots_send_labels` | the dots room page URL, the room ID, the room member whose messages are posted back, and the send button's label in your ChatGPT UI language |
| `reply_timeout_min` | warn in the channel if no reply comes within this many minutes |
| `end_at` | optional ISO time. After it the bridge posts a stop notice and unloads its LaunchAgent |
| `tab_label`, `launchd_label` | the herdr tab name and the keeper LaunchAgent label |
| `reports_log` | optional file that gets one `REPORT [mac-ai-bridge] ...` line when something stays broken for 30 minutes |
| `bin` | optional absolute paths, e.g. `{"aside": "...", "herdr": "...", "bun": "...", "zele": "..."}`. By default they are found on `PATH` |

Environment variables: `BRIDGE_DIR` (default `~/.config/discord-mac-ai-bridge`) and `BRIDGE_CONFIG` move the config, state, inbox and log.

## Run

Try it in the foreground first, from a herdr tab:

```sh
bun gateway.ts     # in one tab
bun bridge.ts      # in another herdr tab (needs Full Disk Access and Accessibility)
```

On the first start the bridge only records where each conversation is now. Older messages are not posted.
Write something in one of the channels and check the 📨 reaction and the reply.

To keep it running, install the two LaunchAgents (replace the placeholders first):

```sh
for f in launchd/*.plist; do
  sed -e "s#__BUN__#$(command -v bun)#" -e "s#__REPO__#$PWD#" -e "s#__HOME__#$HOME#" "$f" > ~/Library/LaunchAgents/"$(basename "$f")"
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/"$(basename "$f")"
done
```

If you change `launchd_label` in the config, rename the keeper plist and its `Label` to match.
Logs: `~/.config/discord-mac-ai-bridge/bridge.log` and `~/Library/Logs/discord-mac-ai-bridge.*.log`.

## Limits

- macOS only, one user, one Mac. The bridge controls apps on the Mac it runs on.
- Without the OmO desktop engine, or for messages with files or several lines, Pickle briefly comes to the front (about 1 to 2 seconds) for each message and for each attachment it has to download. The helper waits for a 2-second pause in your typing and restores your window, clipboard and mouse position, but you will see it.
- The UI labels the helpers and the dots sender look for (`메시지 보내기`, `보내기`, `채팅` and so on) are the apps' **Korean** UI strings. If your apps run in another language, change them in `helpers/*.swift` and `dots_send_labels`.
- Grok Bot and dots are driven through their web pages, and Grok Bot replies are read from the Mac app's local files. Any change to those pages or file formats can break the bridge until the code is updated.
- dots messages are read with the same web requests the chatgpt.com page itself makes, inside your logged-in tab.
- Files over Discord's 10 MB limit are not posted. The channel gets a note instead.
- No tests are included. The code has been used by its author only.

## License

[MIT](LICENSE)
