# sh-agent

집 PC의 LM Studio에서 도는 모델(`google/gemma-4-e2b`)을 폰에서 쓰기 위한 웹 UI + 로컬 릴레이.

**UI** → https://jacky92q.github.io/sh-agent/

```
폰 브라우저                     PC
─────────────                 ──────────────────────────────────
GitHub Pages (정적 UI)  ──▶  Cloudflare 터널 (https)
                              └▶ 릴레이 :8787  (토큰 검증 · CORS)
                                  └▶ LM Studio :1234  (모델)
```

대화 내용은 폰의 `localStorage`에만 남고, 요청은 전부 이 PC로만 갑니다.

## PC에서 (서버 켜기)

한 번만:

```powershell
winget install --id Cloudflare.cloudflared
```

매번:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

스크립트가 하는 일:

1. LM Studio 서버를 `:1234`에 올림 (`lms server start`)
2. 릴레이를 `:8787`에 올림
3. Cloudflare 임시 터널을 열어 `https://...trycloudflare.com` 주소를 받음
4. **페어링 링크**를 출력하고 클립보드에 복사

옵션:

| 플래그 | 설명 |
| --- | --- |
| `-NewKey` | 액세스 키 재발급 (기존 기기는 다시 페어링 필요) |
| `-NoTunnel` | 터널 없이 LAN 주소만 사용 (같은 Wi-Fi + 로컬로 연 UI 전용) |
| `-RelayPort` / `-LmsPort` | 포트 변경 |

`Ctrl+C`로 릴레이와 터널이 함께 종료됩니다.

## 폰에서 (처음 한 번)

출력된 페어링 링크를 폰에서 열면 끝입니다. 링크의 `#c=...` 조각에 서버 주소와 키가 들어있고,
프래그먼트는 서버로 전송되지 않습니다. 값은 브라우저에 저장된 뒤 주소창에서 지워집니다.

수동으로 넣으려면 우측 상단 톱니 → **서버 주소**와 **액세스 키**에 콘솔 출력값을 입력하세요.

> 터널 주소는 실행할 때마다 바뀝니다. PC를 껐다 켜면 새 링크를 다시 열어야 합니다.
> 고정 주소가 필요하면 Cloudflare 계정을 붙여 named tunnel로 바꾸면 됩니다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `web/` | 빌드 없는 정적 UI. Pages로 배포되는 유일한 디렉터리 |
| `server/relay.mjs` | 의존성 없는 Node 릴레이. 토큰 게이트 · CORS · SSE 패스스루 |
| `scripts/start.ps1` | LM Studio + 릴레이 + 터널 기동, 페어링 링크 출력 |
| `.github/workflows/deploy.yml` | `main` 푸시 → 문법 검사 → Pages 배포 |

## 릴레이 API

| 엔드포인트 | 인증 | 설명 |
| --- | --- | --- |
| `GET /health` | 없음 | 릴레이/업스트림 상태, 모델 목록 |
| `GET /v1/models` | Bearer | LM Studio 패스스루 |
| `POST /v1/chat/completions` | Bearer | 스트리밍 패스스루 |

릴레이는 단독으로도 뜹니다:

```powershell
$env:RELAY_TOKEN='...'; node server/relay.mjs
```

## 참고

- 터널 주소는 공개 URL입니다. 액세스 키가 유일한 방어선이니 링크를 공유하지 마세요.
- 키는 `.sh-agent/access.key`에 저장되며 git에는 올라가지 않습니다.
- Pages는 HTTPS라 `http://` 서버 주소는 브라우저가 차단합니다. 터널이 필요한 이유입니다.
