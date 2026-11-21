# 把芹查裝到手機：TestFlight 步驟

流程跟花椰菜相機一樣，只多一件事：芹查有「螢幕廣播擴充」，app 和擴充要靠 **App Group** 共用配對資料，所以要多註冊一個 App Group 和一個擴充用的 Bundle ID。全部做完大概 25 分鐘，一半在等 Apple。

要做的事：

1. 註冊 App Group
2. 註冊兩個 Bundle ID，都打開 App Groups
3. 在 App Store Connect 建 App
4. 把四個 secrets 設到 GitHub
5. 觸發建置，在手機上用 TestFlight 安裝

## 一、註冊 App Group

到 <https://developer.apple.com/account/resources/identifiers/list/applicationGroup>。

1. 按 Identifiers 旁邊的「＋」
2. 選 **App Groups**，Continue
3. Description 填 `Celery Check Group`
4. Identifier 填 `group.org.domyweb.celerycheck`
5. Continue，再按 Register

## 二、註冊兩個 Bundle ID

到 <https://developer.apple.com/account/resources/identifiers/list>。

### App 本體

1. 按「＋」→ App IDs → App → Continue
2. Description 填 `Celery Check`
3. Bundle ID 選 Explicit，填 `org.domyweb.celerycheck`
4. 下面 Capabilities 勾 **App Groups**
5. Continue → Register
6. 回到清單點剛建的 `org.domyweb.celerycheck`，在 App Groups 那列按「Configure」（或「Edit」），勾 `group.org.domyweb.celerycheck`，Continue → Save

### 螢幕廣播擴充

同樣的步驟再做一次：

- Description 填 `Celery Check Broadcast`
- Bundle ID 填 `org.domyweb.celerycheck.broadcast`
- 一樣勾 App Groups，並設定成 `group.org.domyweb.celerycheck`

兩個 ID 都要一字不差，`ios/project.yml` 寫的就是它們。

## 三、在 App Store Connect 建 App

到 <https://appstoreconnect.apple.com/apps>。

1. 左上「＋」→「新增 App」
2. 平台勾 iOS
3. 名稱填 `芹查`（被用掉的話先填 `芹查 真機回報`，只影響商店，不影響手機桌面上的名字）
4. 主要語言選繁體中文
5. 套件識別碼選 `org.domyweb.celerycheck`（**不是** `.broadcast` 那個）
6. SKU 填 `celerycheck`
7. 使用者存取權限選「完整存取權限」，按「建立」

## 四、設定 GitHub secrets

跟你其他 app 用同一組四個值：`ASC_KEY_ID`、`ASC_ISSUER_ID`、`ASC_KEY_P8`、`APPLE_TEAM_ID`。不過 secrets 是每個 repo 各自設的，新 repo 要再設一次。

在 Git Bash 執行（把中文換成你的值）：

```bash
gh secret set ASC_KEY_ID --repo domyweb666/Celery-Check --body "你的KeyID"
gh secret set ASC_ISSUER_ID --repo domyweb666/Celery-Check --body "你的IssuerID"
gh secret set APPLE_TEAM_ID --repo domyweb666/Celery-Check --body "你的TeamID"
gh secret set ASC_KEY_P8 --repo domyweb666/Celery-Check < "C:/Users/fcharlie/Downloads/AuthKey_XXXXXXXXXX.p8"
```

用 PowerShell 的話，最後一行改成：

```powershell
Get-Content -Raw "C:\Users\fcharlie\Downloads\AuthKey_XXXXXXXXXX.p8" | gh secret set ASC_KEY_P8 --repo domyweb666/Celery-Check
```

或到 <https://github.com/domyweb666/Celery-Check/settings/secrets/actions> 一個一個貼。

## 五、觸發建置、安裝

```bash
gh workflow run iOS --repo domyweb666/Celery-Check
```

約 5 到 8 分鐘，進度在 <https://github.com/domyweb666/Celery-Check/actions>。「上傳 TestFlight」那步只跑幾秒就打勾，代表 secrets 沒讀到。

上傳後等 Apple 處理 5 到 15 分鐘，然後：

1. App Store Connect → 芹查 → TestFlight → 內部測試，把自己加進群組
2. 手機打開 TestFlight，安裝芹查

之後只有改到 `ios/` 底下的檔案才會重新編譯上傳；只改電腦端不會觸發。

## 卡住的時候

| 錯誤訊息裡有 | 原因 | 怎麼處理 |
|---|---|---|
| `No profiles for 'org.domyweb.celerycheck.broadcast'` | 擴充的 Bundle ID 沒註冊 | 回第二步 |
| `requires a provisioning profile with the App Groups feature` | Bundle ID 沒勾 App Groups，或沒設定成那個 group | 回第二步第 6 點，兩個 ID 都要做 |
| `Authentication credentials are missing or invalid` | Key ID、Issuer ID、`.p8` 對不起來 | 確認三個值來自同一把有效的金鑰 |
| `maximum number of certificates` | 發佈憑證滿了 | 到 <https://developer.apple.com/account/resources/certificates/list> 撤銷舊的 Apple Distribution 憑證 |
| `No suitable application records were found` | App Store Connect 還沒建 App | 回第三步 |

## 裝好之後要確認的事

這是第一次在真機上跑，下面幾件事只有真機測得出來：

1. 掃電腦上的 QR code 後，app 顯示「連得到」
2. 按「開始投影」會跳出系統面板，面板裡選的是「芹查」，按「開始廣播」後三秒內電腦上出現畫面
3. 切到別的 app（例如設定），電腦上的畫面跟著變
4. 把手機轉橫，電腦上的畫面方向正確
5. 投影 5 分鐘以上不會自己斷掉

有問題就在電腦上的芹查標記下來，丟給我。
