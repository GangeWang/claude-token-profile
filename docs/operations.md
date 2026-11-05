# 安裝、備份與還原流程

路徑以 macOS 為例。Windows 的 `~` 是 `C:\Users\<使用者>`。

## 安裝

1. 確認有 Python 3：`python3 --version`。
2. 在 Claude app 的 Code 分頁點輸入框旁的 **+**，選 **Plugins**，用 **Add marketplace** 加入
   `GangeWang/claude-token-profile`，再按 **Add plugin**。
3. 開新 session 並傳一則訊息，輸入框上方會出現今日和累計用量。

## 設定多台電腦同步（選用）

1. 在 GitHub 建立一個**私人** repo，建立時勾選新增 README，讓它有初始 commit。
2. 在每台電腦登入 GitHub：

   ```bash
   gh auth login
   gh auth setup-git
   ```

3. 在每台電腦下載 repo：

   ```bash
   git clone https://github.com/<帳號>/<私人 repo>.git ~/.claude/token-profile/sync
   ```

4. 開新 session 並傳一則訊息。每台電腦最多每 10 分鐘同步一次。

## 備份

1. 跑一次對話，等 10 分鐘內的同步完成，確認頁面沒有「同步失敗」。
2. 備份 `~/.claude`：

   ```bash
   tar -czf ~/Desktop/claude-backup.tgz -C ~ .claude
   ```

3. 把備份檔放到外接硬碟或其他私人空間。檔案裡有對話內容，不要放到公開位置。

只想備份用量時，至少要帶 `~/.claude/token-profile`，裡面有帳本、電腦 ID 和同步資料夾。

## 還原

### 有完整備份

1. 安裝 Claude app 並登入，裝好 Python 和 git。需要同步時，再執行 `gh auth login` 和 `gh auth setup-git`。
2. 還原備份：

   ```bash
   tar -xzf ~/Desktop/claude-backup.tgz -C ~
   ```

3. 依上方步驟重新安裝外掛，開新 session 並傳一則訊息。
4. 確認累計數字接上，頁面沒有「同步失敗」。

### 沒有備份，但有同步 repo

1. 依上方步驟安裝外掛，並下載同步 repo。
2. 累計數字會回來，這台電腦會以新電腦身分繼續累計。最後一次同步之後的用量無法找回。

## 注意事項

- `~/.claude/projects` 和 `~/.claude/token-profile` 要一起還原。只還原 `projects` 且有同步時，
  這台會被當成新電腦，用量會重複計算。
- 還原後，舊電腦不要繼續使用同一份資料，否則兩台會共用同一個電腦 ID。
- 帳本保留累計數字，所以 `projects` 被清掉不影響統計。
- 離線時頁面會顯示「同步失敗」，本機數字不受影響，恢復連線後會自動補上。
