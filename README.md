# Claude Token 用量頁面

在 Claude app 裡用個人檔案風格的頁面查看 Claude Code 的 token 用量：累計 token、單日最高、
最長任務、連續天數，以及每日熱力圖、每週長條圖和累計曲線。

> 這是非官方的個人專案，與 Anthropic 沒有關聯，也未經其認可。

## 安裝

在 Claude app 的 Code 分頁：點輸入框旁的 **+**，選 **Plugins**，用 **Add marketplace** 加入
`GangeWang/claude-token-profile`，再按 **Add plugin**。

在終端機的 Claude Code：

```text
/plugin install token-profile --marketplace GangeWang/claude-token-profile
```

需要 Python 3，外掛會依序尋找 `python3`、`python`、`py -3`。

## 使用

安裝後，輸入框上方會出現今日和累計用量，點一下就能打開頁面；也可以輸入 `/token-profile`。
同一台電腦的所有對話會顯示相同的數字和畫面狀態。

Remote Control 視窗不會顯示入口和頁面，這時 `/token-profile` 會回傳文字摘要。

## 資料與隱私

- 統計 `~/.claude/projects` 裡的 Claude Code 紀錄，不含 claude.ai 網頁與手機聊天。
- 帳本在 `~/.claude/token-profile/usage.sqlite`，只存 token 數、時間、模型與資料夾名稱，
  不存對話內容。舊紀錄被清掉後，累計數字仍會保留，請勿刪除。
- 有設定 `CLAUDE_CONFIG_DIR` 時，帳本和對話紀錄都改用該目錄。
- 沒有設定多台電腦同步時，資料不會離開你的電腦。

## 多台電腦同步（選用）

建立一個有初始 commit 的**私人** git repo，clone 到 `~/.claude/token-profile/sync` 就會開始同步。

每台電腦最多每 10 分鐘上傳一次自己的檔案 `<電腦 ID>.json`，頁面會合併所有電腦的數字。
檔案內容是每日 token 數、模型、專案資料夾名稱和電腦名稱，不含對話內容。
同步失敗時，頁面會顯示原因，本機統計不受影響。

換電腦時，把 `~/.claude/projects` 和 `~/.claude/token-profile` 一起搬，用量才不會重複計算。

## 支援平台

| 平台 | 狀態 |
|---|---|
| macOS | 完整功能 |
| Windows | 可用；頭像會顯示名字首字 |
| Linux | 未測試 |

## 授權

依 [PolyForm Noncommercial 1.0.0](LICENSE) 授權，只限非商業用途。
這不是 OSI 定義的開源授權；商業使用請先聯絡作者。
