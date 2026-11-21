# 芹查（Celery-Check）開發說明

多米的 iPhone 真機測試回報工具。使用者是多米本人，只說中文；介面、訊息、文件一律繁體中文。

## 結構

- `desktop/`：Node.js 22，ESM，沒有建置步驟。依賴只有 `ws`、`qrcode`、`@modelcontextprotocol/sdk`、`zod`
  - `server/index.js`：HTTP＋WebSocket。`/ingest` 收手機畫面（要配對碼），其他 API 和網頁只限本機（`isLocal`）
  - `server/store.js`：純檔案儲存，伺服器和 MCP 共用，寫檔用「暫存檔＋改名」
  - `server/mcp.js`：stdio MCP，工具名稱一律 `celery_` 開頭
  - `web/`：原生 JS，沒有框架
- `ios/`：XcodeGen（`project.yml`），SwiftUI，iOS 17 起，Swift 5 模式
  - `CeleryCheck/`：app 本體
  - `Broadcast/`：Broadcast Upload Extension，記憶體上限約 50MB，不要在這裡快取畫面
  - `Shared/`：兩個 target 都會編譯，只能用擴充允許的 API

## 流程

一場測試（session）＝從「開始測試」到「結束測試」的整段錄影，存在 `data/clips/<id>/`：`frames/*.jpg`、`frames.json`、`meta.json`（含 `markers` 書籤、`project`、`number`）、`drafts.json`（排查時的草稿，每筆綁一格）。F8 只插書籤不跳頁；沒在測試時按 F8 會自動開一場並補前 20 秒。「全部送出」把草稿逐筆轉成 `data/notes/<編號>/`。

MCP 依 Claude Code 的資料夾（git remote 或設定裡的資料夾）判斷專案，`celery_list_notes` 預設只列那個專案。

## 手機到電腦的格式

WebSocket 二進位訊息：前 8 位元組是 big-endian 毫秒時間戳，後面是 JPEG。文字訊息 `{"type":"hello","device","model"}`。改格式時兩邊要一起改。

## 測試

```bash
cd desktop
CELERY_DATA_DIR=/tmp/cc-data node server/index.js     # 用暫存資料夾，不要動到多米的資料
CELERY_DATA_DIR=/tmp/cc-data npm run fake-phone        # 模擬手機（要 ffmpeg）
CELERY_DATA_DIR=/tmp/cc-data node tools/mcp-test.mjs   # 測 MCP 工具
```

iOS 沒有 Mac 可以編譯，靠 GitHub Actions（`.github/workflows/ios.yml`）。只有動到 `ios/` 才會觸發。

## 規則

- 多米偏好一次把功能做完再給他測，不要每一小步就停下來
- 不要隨便 push 觸發 TestFlight 建置，累積一批或他開口再 push
