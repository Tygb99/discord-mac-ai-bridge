# discord-mac-ai-bridge

[English](README.md)

맥에 깔린 AI 대화 앱을 디스코드 채널에서 쓰게 해 주는 다리예요. 어느 기기에서든 쓸 수 있어요.
디스코드 채널에 글을 쓰면 다리가 맥의 앱에 대신 입력하고, 앱의 답은 같은 채널에 올라와요.

| 디스코드 채널 | 내 글이 가는 곳 | 답을 읽는 곳 |
| --- | --- | --- |
| 그록봇 | grok.com의 Grok Bot 대화창(Aside 브라우저로 입력) | Grok Bot 맥 앱의 로컬 대화 사본, 그리고 그록 예약 작업 결과 메일(선택, `zele`로 읽음) |
| 인스팅트 | 맥 메시지 앱(iMessage)의 정해진 상대 한 명 | `~/Library/Messages/chat.db` |
| 피클 | 피클 맥 앱 입력칸(손쉬운 사용 도우미 `pickle-send`) | 앱의 로컬 대화 사본(`ChatMirror/db.sqlite`). 전화 내용과 첨부도 올려요 |
| 닷츠 | chatgpt.com의 ChatGPT 닷츠(dots) 대화방(Aside 브라우저로 입력) | 로그인된 Aside 탭 안에서 읽은 대화방 글 |

서비스는 하나씩 켜고 끌 수 있어요. 설정에서 채널을 비워 두면 그 서비스는 건너뛰어요.
디스코드에 붙인 사진·파일은 앱으로 넘기고, 앱에서 온 사진·파일도 디스코드에 올려요(파일 하나에 디스코드 한도 10MB까지).
보낸 글에는 📨 반응이 붙고, 못 보낸 글에는 ⚠️ 반응과 이유 한 줄이 채널에 올라와요.

> **비제휴 고지.** 개인이 만든 도구예요. xAI(그록), 인스팅트, 피클, OpenAI(ChatGPT·닷츠), OmO, 디스코드, 애플이 만들거나 보증하거나 지원하는 것이 아니에요.
> 내 맥에서 내 계정으로, 앱의 보통 사용자 화면을 자동으로 조작해요.
> 각 서비스의 이용 약관은 쓰는 사람이 직접 지켜야 해요.

## 도는 방식

```text
디스코드 ──gateway.ts──▶ inbox.jsonl ──▶ bridge.ts (herdr 탭 안) ──▶ 그록봇 / 메시지 / 피클 / 닷츠
   ▲                                          │
   └──────────── 디스코드 API ◀── 앱 로컬 데이터에서 읽은 답 ◀┘
```

- `gateway.ts`는 디스코드 게이트웨이에 붙어 있다가, 다리 채널(과 그 스레드)에 쓴 내 글을 `inbox.jsonl`에 한 줄씩 적어요.
- `bridge.ts`는 3초마다 인박스를 읽어 맞는 앱으로 보내고, 앱의 답을 살펴봐요.
- `bridge.ts --keeper`는 LaunchAgent가 1분마다 불러요. 다리의 심장 박동 파일이 90초 넘게 멈춰 있으면 herdr 탭에서 다리를 다시 띄워요.
  다리를 launchd에서 바로 돌리지 않고 herdr 탭 안에서 돌리는 이유가 있어요. `chat.db`와 앱 폴더를 읽으려면 전체 디스크 접근 권한이 필요하고, 피클 도우미는 손쉬운 사용 권한이 필요해요. 이 권한은 터미널 앱에 줄 수 있어요.
- `helpers/pickle-bg.ts`(선택)는 OmO의 컴퓨터 조작 도구가 쓰는 OmO 데스크톱 엔진으로 피클에 글을 보내고 첨부를 받아요. 창이 앞으로 나오지 않아요. 엔진이 없거나 실패하면 다리가 아래 Swift 도우미 두 개로 한 번 넘어가요.
- `helpers/pickle-send`는 피클에 글을 넣어요. 피클은 뒤에서 보낸 키 입력이나 AX 값 넣기를 받지 않아요. 그래서 키보드·마우스를 2초 동안 안 만질 때를 기다렸다가 피클 창을 1~2초쯤 앞으로 띄워 붙여 넣고, 앞에 있던 앱·창·클립보드를 되돌려요. 「보내기」는 뒤에서 눌러요.
- `helpers/pickle-fetch`는 다른 기기에서 온 첨부를 받아요. 첨부 말풍선을 눌러 피클 앱이 직접 받게 해요. 다리는 피클 로그인 토큰을 읽지 않고, 피클 서버도 부르지 않아요.

## 필요한 것

- Apple 실리콘 맥(피클은 맥에서 도는 iOS 앱이에요). 최근 macOS에서 만들고 써 왔어요.
- [Bun](https://bun.sh)
- Xcode 명령행 도구(`swiftc`): 피클 도우미를 빌드할 때 써요
- 내 디스코드 서버의 봇 하나. **Message Content** 인텐트를 켜고, 다리 채널에서 글 읽기·보내기·파일 첨부·반응 달기 권한을 줘요
- [herdr](https://herdr.dev): 다리가 도는 터미널 작업 공간이에요. 이걸 띄우는 앱에 시스템 설정 > 개인정보 보호 및 보안에서 **전체 디스크 접근 권한**과 **손쉬운 사용**을 줘요
- 서비스별로:
  - 그록봇: `aside repl`을 쓸 수 있는 Aside 브라우저(grok.com 로그인), Grok Bot 맥 앱 설치·실행(답은 이 앱의 로컬 대화 사본에서 읽어요). 선택: 그록 예약 작업 메일을 받는 Gmail 계정을 넣은 `zele`
  - 인스팅트: iMessage에 로그인된 메시지 앱. 처음 한 번 메시지 앱 제어(자동화) 허용 창이 떠요
  - 피클: 로그인된 피클 맥 앱(채팅 화면). 선택: 창을 안 띄우는 방식을 쓰려면 [OmO](https://omo.dev)를 깔아 데스크톱 엔진이 `~/.omo/engines/senpi-desktop-engine/darwin-arm64/senpi-desktop-engine`에 있어야 해요(다른 곳이면 `OMO_DESKTOP_ENGINE`)
  - 닷츠: chatgpt.com에 로그인되어 그 닷츠 대화방에 들어갈 수 있는 Aside 브라우저

## 설치

```sh
git clone https://github.com/Tygb99/discord-mac-ai-bridge.git
cd discord-mac-ai-bridge
bun install            # 편집기용 타입(@types/bun)만 받아요. 다리가 실행 중에 쓰는 패키지는 없어요
./build-helpers.sh     # helpers/pickle-send, helpers/pickle-fetch를 만들어요

mkdir -p ~/.config/discord-mac-ai-bridge
cp config.example.json ~/.config/discord-mac-ai-bridge/config.json
chmod 600 ~/.config/discord-mac-ai-bridge/config.json
```

그다음 `~/.config/discord-mac-ai-bridge/config.json`을 채워요.

| 키 | 넣을 값 |
| --- | --- |
| `discord_bot_token` | 봇 토큰(`gateway.ts`는 `DISCORD_BOT_TOKEN` 환경 변수로도 받아요. herdr 탭의 다리는 설정 파일을 읽어요) |
| `owner_id` | 내 디스코드 사용자 ID. 이 사람 글만 넘겨요 |
| `grok_channel`, `instinct_channel`, `pickle_channel`, `dots_channel` | 채널 ID. 안 쓰는 서비스는 `""` |
| `grok_bot_id`, `grok_bot_url` | grok.com 봇 대화 주소 끝의 Grok Bot ID와 그 주소 |
| `mail_account`, `grok_mail_query`, `mail_every_sec` | 선택: 그록 예약 작업 메일을 읽을 `zele` 계정 이름과 검색어 |
| `instinct_handle` | iMessage 상대의 전화번호나 Apple ID |
| `dots_url`, `dots_room`, `dots_member`, `dots_send_labels` | 닷츠 대화방 페이지 주소, 대화방 ID, 글을 디스코드로 올릴 대화방 참여자, ChatGPT 화면 언어에서의 보내기 단추 이름 |
| `reply_timeout_min` | 이 시간(분) 안에 답이 없으면 채널에 알려요 |
| `end_at` | 선택: ISO 시각. 지나면 멈춤 글을 올리고 LaunchAgent를 내려요 |
| `tab_label`, `launchd_label` | herdr 탭 이름과 keeper LaunchAgent 이름 |
| `reports_log` | 선택: 30분 넘게 고장 나 있으면 `REPORT [mac-ai-bridge] ...` 한 줄을 적을 파일 |
| `bin` | 선택: 절대 경로. 예: `{"aside": "...", "herdr": "...", "bun": "...", "zele": "..."}`. 비우면 `PATH`에서 찾아요 |

환경 변수 `BRIDGE_DIR`(기본 `~/.config/discord-mac-ai-bridge`)·`BRIDGE_CONFIG`로 설정·상태·인박스·로그 위치를 바꿀 수 있어요.

## 실행

먼저 herdr 탭에서 앞에 띄워 시험해 봐요.

```sh
bun gateway.ts     # 탭 하나
bun bridge.ts      # 다른 herdr 탭(전체 디스크 접근·손쉬운 사용 권한 필요)
```

처음 켤 때는 대화마다 지금 위치만 기억하고, 옛 글은 올리지 않아요.
채널에 한 줄 써 보고 📨 반응과 답이 오는지 봐요.

계속 돌리려면 LaunchAgent 두 개를 넣어요(자리 표시를 먼저 바꿔요).

```sh
for f in launchd/*.plist; do
  sed -e "s#__BUN__#$(command -v bun)#" -e "s#__REPO__#$PWD#" -e "s#__HOME__#$HOME#" "$f" > ~/Library/LaunchAgents/"$(basename "$f")"
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/"$(basename "$f")"
done
```

설정의 `launchd_label`을 바꿨다면 keeper plist 파일 이름과 `Label`도 똑같이 바꿔요.
로그: `~/.config/discord-mac-ai-bridge/bridge.log`, `~/Library/Logs/discord-mac-ai-bridge.*.log`.

## 한계

- macOS 전용이고, 한 사람이 맥 한 대에서 써요. 다리는 자기가 도는 맥의 앱을 조작해요.
- OmO 데스크톱 엔진이 없을 때, 또는 파일이 붙거나 여러 줄인 글은 보낼 때마다, 그리고 받아야 할 첨부가 있을 때마다 피클이 1~2초쯤 앞으로 나와요. 손을 2초 쉴 때를 기다리고 창·클립보드·마우스 자리를 되돌리지만 화면에서는 보여요.
- 도우미와 닷츠 보내기가 찾는 화면 글자(`메시지 보내기`, `보내기`, `채팅` 등)는 앱의 **한국어** 화면 글자예요. 앱을 다른 언어로 쓰면 `helpers/*.swift`와 `dots_send_labels`를 고쳐요.
- 그록봇과 닷츠는 웹 페이지를 조작해서 쓰고, 그록봇 답은 맥 앱의 로컬 파일에서 읽어요. 그 페이지나 파일 형식이 바뀌면 코드를 고칠 때까지 다리가 멈출 수 있어요.
- 닷츠 글은 로그인된 탭 안에서 chatgpt.com 페이지가 스스로 보내는 것과 같은 웹 요청으로 읽어요.
- 디스코드 한도 10MB를 넘는 파일은 올리지 않고 채널에 알림만 남겨요.
- 테스트 코드는 없어요. 만든 사람만 써 본 코드예요.

## 라이선스

[MIT](LICENSE)
