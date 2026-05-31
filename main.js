var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CloudSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/dropbox.ts
var import_obsidian = require("obsidian");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransientNetworkError(e) {
  var _a;
  const msg = String((_a = e == null ? void 0 : e.message) != null ? _a : e);
  return /network|connection|lost|timeout|ECONN|ERR_|fetch failed|socket|reset by peer|aborted/i.test(msg);
}
function escapeForHeader(obj) {
  return JSON.stringify(obj).replace(
    /[^\x00-\x7F]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
var DropboxClient = class {
  constructor(settings) {
    this.settings = settings;
    this.accessToken = "";
    this.tokenExpiry = 0;
  }
  // requestUrl のラッパー。一時的な通信エラーだけ指数バックオフで再試行する。
  // （認証エラーや 4xx は再試行しても無駄なので即座に投げる）
  async req(options, retries = 3) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await (0, import_obsidian.requestUrl)(options);
      } catch (e) {
        lastErr = e;
        if (!isTransientNetworkError(e) || attempt === retries) throw e;
        await sleep(1e3 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }
  // ────────────────────────────────────────────
  // 認証
  // ────────────────────────────────────────────
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.settings.refreshToken)}&client_id=${encodeURIComponent(this.settings.appKey)}&client_secret=${encodeURIComponent(this.settings.appSecret)}`;
    const res = await (0, import_obsidian.requestUrl)({
      url: "https://api.dropbox.com/oauth2/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false
    });
    if (res.status !== 200) {
      throw new Error(`Auth failed (${res.status}): ${res.text}`);
    }
    const data = res.json;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1e3;
    return this.accessToken;
  }
  async authHeader() {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }
  // ────────────────────────────────────────────
  // OAuth 初回認証（設定画面から呼ぶ）
  // ────────────────────────────────────────────
  getAuthUrl() {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.appKey,
      token_access_type: "offline"
    });
    return `https://www.dropbox.com/oauth2/authorize?${params}`;
  }
  async exchangeCode(code) {
    const body = `code=${encodeURIComponent(code)}&grant_type=authorization_code&client_id=${encodeURIComponent(this.settings.appKey)}&client_secret=${encodeURIComponent(this.settings.appSecret)}`;
    const res = await (0, import_obsidian.requestUrl)({
      url: "https://api.dropbox.com/oauth2/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false
    });
    if (res.status !== 200) {
      throw new Error(`Auth exchange failed (${res.status}): ${res.text}`);
    }
    return res.json.refresh_token;
  }
  // ────────────────────────────────────────────
  // ファイル一覧
  // ────────────────────────────────────────────
  async listFiles() {
    const headers = await this.authHeader();
    const results = [];
    let res = await this.req({
      url: "https://api.dropboxapi.com/2/files/list_folder",
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: this.settings.remotePath, recursive: true })
    });
    while (true) {
      for (const entry of res.json.entries) {
        if (entry[".tag"] === "file") {
          results.push({
            path: entry.path_display,
            // 大文字小文字を保持
            pathLower: entry.path_lower,
            rev: entry.rev,
            serverModified: entry.server_modified,
            size: entry.size
          });
        }
      }
      if (!res.json.has_more) break;
      res = await this.req({
        url: "https://api.dropboxapi.com/2/files/list_folder/continue",
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: res.json.cursor })
      });
    }
    return results;
  }
  // ────────────────────────────────────────────
  // 差分同期（cursor / delta）
  // ────────────────────────────────────────────
  // 現時点の最新 cursor を取得（以降の変更だけを追跡する起点）
  async getLatestCursor() {
    const headers = await this.authHeader();
    const res = await this.req({
      url: "https://api.dropboxapi.com/2/files/list_folder/get_latest_cursor",
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: this.settings.remotePath, recursive: true })
    });
    return res.json.cursor;
  }
  // cursor 以降の変更（追加・更新・削除）を取得し、新しい cursor を返す
  async listDelta(cursor) {
    const headers = await this.authHeader();
    const entries = [];
    let c = cursor;
    while (true) {
      const res = await this.req({
        url: "https://api.dropboxapi.com/2/files/list_folder/continue",
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: c })
      });
      for (const entry of res.json.entries) {
        const tag = entry[".tag"];
        if (tag === "file") {
          entries.push({
            tag: "file",
            path: entry.path_display,
            pathLower: entry.path_lower,
            rev: entry.rev,
            serverModified: entry.server_modified,
            size: entry.size
          });
        } else if (tag === "deleted") {
          entries.push({
            tag: "deleted",
            path: entry.path_display,
            pathLower: entry.path_lower
          });
        }
      }
      c = res.json.cursor;
      if (!res.json.has_more) break;
    }
    return { entries, cursor: c };
  }
  // ────────────────────────────────────────────
  // アップロード
  // ────────────────────────────────────────────
  async upload(remotePath, content) {
    const headers = await this.authHeader();
    const res = await this.req({
      url: "https://content.dropboxapi.com/2/files/upload",
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": escapeForHeader({
          path: remotePath,
          mode: "overwrite",
          autorename: false
        })
      },
      body: content
    });
    return res.json.rev;
  }
  // ────────────────────────────────────────────
  // ダウンロード
  // ────────────────────────────────────────────
  async download(remotePath) {
    const headers = await this.authHeader();
    const res = await this.req({
      url: "https://content.dropboxapi.com/2/files/download",
      method: "POST",
      headers: {
        ...headers,
        "Dropbox-API-Arg": escapeForHeader({ path: remotePath })
      }
    });
    return res.arrayBuffer;
  }
  // ────────────────────────────────────────────
  // 削除
  // ────────────────────────────────────────────
  async deleteFile(remotePath) {
    const headers = await this.authHeader();
    await this.req({
      url: "https://api.dropboxapi.com/2/files/delete_v2",
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: remotePath })
    });
  }
};

// src/sync.ts
var import_obsidian2 = require("obsidian");
var SyncEngine = class {
  constructor(app, dbx, remotePath, onSaveState) {
    this.app = app;
    this.dbx = dbx;
    this.remotePath = remotePath;
    this.onSaveState = onSaveState;
    this.debounceTimers = /* @__PURE__ */ new Map();
    this.debounceMs = 5e3;
    this.cursor = "";
    this.syncedFiles = /* @__PURE__ */ new Map();
    // path_lower → 状態
    this.downloading = /* @__PURE__ */ new Set();
    this.startupDone = false;
    this.syncing = false;
    this.ignorePatterns = [];
  }
  // 旧 syncedRevs（lower→rev）を含めて状態をロード・移行する
  loadState(state) {
    var _a, _b, _c;
    this.cursor = (_a = state.cursor) != null ? _a : "";
    this.syncedFiles = /* @__PURE__ */ new Map();
    for (const [k, v] of Object.entries((_b = state.syncedFiles) != null ? _b : {})) {
      this.syncedFiles.set(k.toLowerCase(), v);
    }
    for (const [k, rev] of Object.entries((_c = state.syncedRevs) != null ? _c : {})) {
      const lower = k.toLowerCase();
      if (!this.syncedFiles.has(lower)) {
        this.syncedFiles.set(lower, { rev, hash: "", path: k });
      }
    }
  }
  saveState() {
    var _a;
    (_a = this.onSaveState) == null ? void 0 : _a.call(this, {
      cursor: this.cursor,
      syncedFiles: Object.fromEntries(this.syncedFiles)
    });
  }
  async loadIgnoreFile() {
    try {
      const content = await this.app.vault.adapter.read(".cloudsync_ignore");
      this.ignorePatterns = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } catch (e) {
      this.ignorePatterns = [];
    }
  }
  // ────────────────────────────────────────────
  // 同期エントリーポイント（起動時・手動 共通）
  // ────────────────────────────────────────────
  async sync(retry = 0) {
    if (this.syncing) {
      new import_obsidian2.Notice("\u2601\uFE0F \u540C\u671F\u4E2D\u3067\u3059\u2026");
      return;
    }
    this.syncing = true;
    new import_obsidian2.Notice("\u2601\uFE0F \u540C\u671F\u4E2D...");
    await this.loadIgnoreFile();
    try {
      const updated = [];
      const deleted = [];
      const failed = [];
      if (!this.cursor) {
        await this.fullSync(updated, deleted, failed);
      } else {
        await this.deltaSync(updated, deleted, failed);
      }
      const uploaded = await this.pushLocalChanges(failed);
      this.startupDone = true;
      this.saveState();
      const total = updated.length + uploaded.length + deleted.length;
      if (total === 0 && failed.length === 0) {
        new import_obsidian2.Notice("\u2601\uFE0F \u6700\u65B0\u306E\u72B6\u614B\u3067\u3059");
      } else {
        const entries = [
          ...updated.map((f) => ({ path: f, action: "\u2193\u53D6\u5F97" })),
          ...uploaded.map((f) => ({ path: f, action: "\u2191\u9001\u4FE1" })),
          ...deleted.map((f) => ({ path: f, action: "\u{1F5D1}\u524A\u9664" }))
        ];
        const preview = entries.slice(0, 3).map((e) => `\u2022 ${e.action} ${e.path.split("/").pop()}`).join("\n");
        const more = entries.length > 3 ? `
\u4ED6 ${entries.length - 3} \u4EF6` : "";
        const warn = failed.length ? `
\u26A0\uFE0F ${failed.length}\u4EF6\u306F\u901A\u4FE1\u4E0D\u826F\u3067\u30B9\u30AD\u30C3\u30D7\uFF08\u6B21\u56DE\u518D\u8A66\u884C\uFF09` : "";
        new import_obsidian2.Notice(`\u2601\uFE0F ${total}\u4EF6\u3092\u540C\u671F\u3057\u307E\u3057\u305F${warn}
${preview}${more}`, 6e3);
        if (entries.length) await this.appendLog(entries);
      }
    } catch (e) {
      if (retry < 2) {
        this.syncing = false;
        new import_obsidian2.Notice(`\u2601\uFE0F \u540C\u671F\u30EA\u30C8\u30E9\u30A4\u4E2D... (${retry + 1}/2)`);
        setTimeout(() => this.sync(retry + 1), 5e3);
        return;
      }
      this.startupDone = true;
      new import_obsidian2.Notice(`\u2601\uFE0F \u540C\u671F\u30A8\u30E9\u30FC: ${e.message}`);
      console.error("CloudSync sync error:", e);
    } finally {
      this.syncing = false;
    }
  }
  // ────────────────────────────────────────────
  // 初回フル照合（cursor 未保持時のみ）
  // ────────────────────────────────────────────
  async fullSync(updated, deleted, failed) {
    var _a, _b;
    const latestCursor = await this.dbx.getLatestCursor();
    const remoteFiles = await this.dbx.listFiles();
    const remoteByLower = /* @__PURE__ */ new Map();
    for (const f of remoteFiles) {
      const lp = this.toLocalPath(f.path);
      if (lp) remoteByLower.set(lp.toLowerCase(), f);
    }
    const fileByLower = this.buildFileMap();
    for (const remote of remoteFiles) {
      const localPath = this.toLocalPath(remote.path);
      if (!localPath) continue;
      const lower = localPath.toLowerCase();
      const state = this.syncedFiles.get(lower);
      if (state && state.rev === remote.rev) {
        if (!state.hash) {
          const lf = fileByLower.get(lower);
          if (lf) {
            const content = await this.app.vault.readBinary(lf).catch(() => null);
            if (content) {
              state.hash = await this.hashContent(content);
              state.path = remote.path;
              this.syncedFiles.set(lower, state);
            }
          }
        }
        continue;
      }
      const localFile = fileByLower.get(lower);
      if (!localFile || await this.isRemoteNewer(localFile, remote)) {
        try {
          await this.downloadFile(remote.path, (_a = localFile == null ? void 0 : localFile.path) != null ? _a : localPath);
          const content = await this.app.vault.adapter.readBinary((_b = localFile == null ? void 0 : localFile.path) != null ? _b : localPath);
          this.syncedFiles.set(lower, {
            rev: remote.rev,
            hash: await this.hashContent(content),
            path: remote.path
          });
          updated.push(localPath);
        } catch (e) {
          failed.push(localPath);
          console.error(`CloudSync: \u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u5931\u6557 ${localPath}:`, e);
        }
      }
    }
    for (const [lower] of [...this.syncedFiles]) {
      if (remoteByLower.has(lower)) continue;
      const lf = fileByLower.get(lower);
      if (lf) {
        try {
          await this.app.vault.adapter.remove(lf.path);
          deleted.push(lf.path);
        } catch (e) {
          console.error(`CloudSync: \u524A\u9664\u5931\u6557 ${lf.path}:`, e);
        }
      }
      this.syncedFiles.delete(lower);
    }
    if (failed.length === 0) this.cursor = latestCursor;
  }
  // ────────────────────────────────────────────
  // 差分同期（cursor 保持時）
  // ────────────────────────────────────────────
  async deltaSync(updated, deleted, failed) {
    var _a, _b;
    const { entries, cursor } = await this.dbx.listDelta(this.cursor);
    const fileByLower = this.buildFileMap();
    for (const entry of entries) {
      const localPath = this.toLocalPath(entry.path);
      if (!localPath) continue;
      const lower = localPath.toLowerCase();
      if (entry.tag === "deleted") {
        const state2 = this.syncedFiles.get(lower);
        if (!state2) continue;
        const lf2 = fileByLower.get(lower);
        if (lf2) {
          try {
            await this.app.vault.adapter.remove(lf2.path);
            deleted.push(lf2.path);
          } catch (e) {
            console.error(`CloudSync: \u524A\u9664\u5931\u6557 ${lf2.path}:`, e);
          }
        }
        this.syncedFiles.delete(lower);
        continue;
      }
      const state = this.syncedFiles.get(lower);
      if (state && state.rev === entry.rev) continue;
      const lf = fileByLower.get(lower);
      if (lf && state) {
        const cur = await this.app.vault.readBinary(lf).catch(() => null);
        if (cur && await this.hashContent(cur) !== state.hash) {
          await this.makeConflictCopy(lf);
        }
      }
      try {
        await this.downloadFile(entry.path, (_a = lf == null ? void 0 : lf.path) != null ? _a : localPath);
        const content = await this.app.vault.adapter.readBinary((_b = lf == null ? void 0 : lf.path) != null ? _b : localPath);
        this.syncedFiles.set(lower, {
          rev: entry.rev,
          hash: await this.hashContent(content),
          path: entry.path
        });
        updated.push(localPath);
      } catch (e) {
        failed.push(localPath);
        console.error(`CloudSync: \u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u5931\u6557 ${localPath}:`, e);
      }
    }
    if (failed.length === 0) this.cursor = cursor;
  }
  // ────────────────────────────────────────────
  // local → remote（変化したローカルファイルをまとめて反映）
  // ────────────────────────────────────────────
  async pushLocalChanges(failed) {
    const uploaded = [];
    for (const file of this.app.vault.getFiles()) {
      if (this.isExcluded(file.path)) continue;
      const remotePath = this.toRemotePath(file.path);
      if (!remotePath) continue;
      const content = await this.app.vault.readBinary(file).catch(() => null);
      if (!content) continue;
      const hash = await this.hashContent(content);
      const lower = file.path.toLowerCase();
      const state = this.syncedFiles.get(lower);
      if (state && state.hash === hash) continue;
      try {
        const rev = await this.dbx.upload(remotePath, content);
        this.syncedFiles.set(lower, { rev, hash, path: file.path });
        uploaded.push(file.path);
        const t = this.debounceTimers.get(lower);
        if (t) {
          clearTimeout(t);
          this.debounceTimers.delete(lower);
        }
      } catch (e) {
        failed.push(file.path);
        console.error(`CloudSync: \u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u5931\u6557 ${file.path}:`, e);
      }
    }
    return uploaded;
  }
  // ────────────────────────────────────────────
  // 編集時アップロード（デバウンス付き）
  // ────────────────────────────────────────────
  scheduleUpload(file) {
    if (!this.startupDone) return;
    if (this.isExcluded(file.path)) return;
    if (this.downloading.has(file.path)) return;
    const key = file.path.toLowerCase();
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      const name = file.name;
      try {
        const content = await this.app.vault.readBinary(file);
        const hash = await this.hashContent(content);
        const state = this.syncedFiles.get(key);
        if (state && state.hash === hash) return;
        const rev = await this.dbx.upload(this.toRemotePath(file.path), content);
        this.syncedFiles.set(key, { rev, hash, path: file.path });
        this.saveState();
        new import_obsidian2.Notice(`\u2601\uFE0F ${name} \u3092\u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u3057\u307E\u3057\u305F`);
      } catch (e) {
        new import_obsidian2.Notice(`CloudSync: \u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u5931\u6557 (${name}): ${e.message}`);
        console.error(`CloudSync upload error (${file.path}):`, e);
      }
    }, this.debounceMs);
    this.debounceTimers.set(key, timer);
  }
  // デバウンス中の全ファイルを即時アップロード（終了時用）
  async flushPending() {
    var _a;
    const keys = [...this.debounceTimers.keys()];
    if (keys.length === 0) return;
    for (const key of keys) {
      clearTimeout(this.debounceTimers.get(key));
      this.debounceTimers.delete(key);
      const state = this.syncedFiles.get(key);
      const file = this.app.vault.getAbstractFileByPath((_a = state == null ? void 0 : state.path) != null ? _a : key);
      if (!file) continue;
      try {
        const content = await this.app.vault.readBinary(file);
        const hash = await this.hashContent(content);
        if (state && state.hash === hash) continue;
        const rev = await this.dbx.upload(this.toRemotePath(file.path), content);
        this.syncedFiles.set(key, { rev, hash, path: file.path });
      } catch (e) {
        console.error(`CloudSync flush error (${key}):`, e);
      }
    }
    this.saveState();
  }
  // 削除をDropboxに反映
  async handleDelete(path) {
    const lower = path.toLowerCase();
    this.syncedFiles.delete(lower);
    const t = this.debounceTimers.get(lower);
    if (t) {
      clearTimeout(t);
      this.debounceTimers.delete(lower);
    }
    this.saveState();
    const remotePath = this.toRemotePath(path);
    if (!remotePath) return;
    try {
      await this.dbx.deleteFile(remotePath);
    } catch (e) {
      console.error(`CloudSync delete error (${path}):`, e);
    }
  }
  // 名前変更・移動
  async handleRename(file, oldPath) {
    await this.handleDelete(oldPath);
    try {
      const content = await this.app.vault.readBinary(file);
      const hash = await this.hashContent(content);
      const rev = await this.dbx.upload(this.toRemotePath(file.path), content);
      this.syncedFiles.set(file.path.toLowerCase(), { rev, hash, path: file.path });
      this.saveState();
    } catch (e) {
      console.error(`CloudSync rename error (${file.path}):`, e);
    }
  }
  // ────────────────────────────────────────────
  // 内部処理
  // ────────────────────────────────────────────
  // vault の全ファイルを path_lower → TFile のマップにする
  buildFileMap() {
    return new Map(this.app.vault.getFiles().map((f) => [f.path.toLowerCase(), f]));
  }
  isExcluded(path) {
    for (const pattern of this.ignorePatterns) {
      if (pattern.endsWith("/") && path.startsWith(pattern)) return true;
      if (pattern.includes("*")) {
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        if (re.test(path)) return true;
      }
      if (path === pattern) return true;
    }
    return false;
  }
  async makeConflictCopy(file) {
    try {
      const content = await this.app.vault.readBinary(file);
      const dot = file.path.lastIndexOf(".");
      const base = dot > 0 ? file.path.slice(0, dot) : file.path;
      const ext = dot > 0 ? file.path.slice(dot) : "";
      const ts = (/* @__PURE__ */ new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/[/:]/g, "-");
      const conflictPath = `${base} (\u7AF6\u5408 ${ts})${ext}`;
      await this.app.vault.adapter.writeBinary(conflictPath, content);
    } catch (e) {
      console.error(`CloudSync conflict copy error (${file.path}):`, e);
    }
  }
  async hashContent(content) {
    const buf = await crypto.subtle.digest("SHA-256", content);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async appendLog(entries) {
    const logPath = "cloudsync-log.md";
    const header = "# CloudSync Log";
    const now = (/* @__PURE__ */ new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const block = [`## ${now}`, ...entries.map((e) => `- ${e.action} ${e.path}`)].join("\n");
    try {
      const prev = await this.app.vault.adapter.exists(logPath) ? await this.app.vault.adapter.read(logPath) : header + "\n";
      const rest = prev.startsWith(header) ? prev.slice(header.length).replace(/^\n+/, "") : prev;
      const out = `${header}

${block}

${rest}`.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
      await this.app.vault.adapter.write(logPath, out);
    } catch (e) {
      console.error("CloudSync log write error:", e);
    }
  }
  async downloadFile(remotePath, localPath) {
    this.downloading.add(localPath);
    try {
      const content = await this.dbx.download(remotePath);
      const dir = localPath.substring(0, localPath.lastIndexOf("/"));
      if (dir) {
        await this.app.vault.adapter.mkdir(dir).catch(() => {
        });
      }
      await this.app.vault.adapter.writeBinary(localPath, content);
    } finally {
      setTimeout(() => this.downloading.delete(localPath), 3e3);
    }
  }
  async isRemoteNewer(local, remote) {
    const remoteMs = new Date(remote.serverModified).getTime();
    return remoteMs > local.stat.mtime;
  }
  toRemotePath(localPath) {
    if (this.isExcluded(localPath)) return null;
    return this.remotePath.replace(/\/$/, "") + "/" + localPath;
  }
  toLocalPath(remotePath) {
    const prefix = this.remotePath.toLowerCase().replace(/\/$/, "") + "/";
    if (!remotePath.toLowerCase().startsWith(prefix)) return null;
    const rel = remotePath.substring(prefix.length);
    if (this.isExcluded(rel)) return null;
    return rel;
  }
};

// src/settings.ts
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  appKey: "",
  appSecret: "",
  refreshToken: "",
  remotePath: "/base",
  cursor: "",
  syncedFiles: {}
};
var CloudSyncSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian3.Setting(containerEl).setName("Dropbox App Key").addText(
      (t) => t.setValue(this.plugin.settings.appKey).onChange(async (v) => {
        this.plugin.settings.appKey = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Dropbox App Secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(this.plugin.settings.appSecret).onChange(async (v) => {
        this.plugin.settings.appSecret = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian3.Setting(containerEl).setName("Remote path").setDesc("Dropbox\u4E0A\u306E\u540C\u671F\u30D5\u30A9\u30EB\u30C0\uFF08\u4F8B: /base\uFF09").addText(
      (t) => t.setValue(this.plugin.settings.remotePath).onChange(async (v) => {
        this.plugin.settings.remotePath = v;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u8A8D\u8A3C" });
    if (!this.plugin.settings.refreshToken) {
      new import_obsidian3.Setting(containerEl).setName("Step 1: \u8A8D\u8A3CURL\u3092\u958B\u304F").addButton((b) => b.setButtonText("\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u304F").onClick(() => {
        const url = this.plugin.getClient().getAuthUrl();
        window.open(url);
      }));
      let authCode = "";
      new import_obsidian3.Setting(containerEl).setName("Step 2: \u8A8D\u8A3C\u30B3\u30FC\u30C9\u3092\u5165\u529B").addText((t) => t.setPlaceholder("\u8A8D\u8A3C\u30B3\u30FC\u30C9").onChange((v) => {
        authCode = v;
      })).addButton((b) => b.setButtonText("\u8A8D\u8A3C").onClick(async () => {
        try {
          const token = await this.plugin.getClient().exchangeCode(authCode);
          this.plugin.settings.refreshToken = token;
          await this.plugin.saveSettings();
          new import_obsidian3.Notice("\u8A8D\u8A3C\u5B8C\u4E86\uFF01");
          this.display();
        } catch (e) {
          new import_obsidian3.Notice("\u8A8D\u8A3C\u5931\u6557: " + e.message);
        }
      }));
    } else {
      new import_obsidian3.Setting(containerEl).setName("\u8A8D\u8A3C\u6E08\u307F").setDesc("Dropbox\u3068\u63A5\u7D9A\u3055\u308C\u3066\u3044\u307E\u3059").addButton((b) => b.setButtonText("\u4ECA\u3059\u3050\u540C\u671F").onClick(() => this.plugin.syncNow())).addButton((b) => b.setButtonText("\u8A8D\u8A3C\u89E3\u9664").setWarning().onClick(async () => {
        this.plugin.settings.refreshToken = "";
        await this.plugin.saveSettings();
        this.display();
      }));
    }
  }
};

// src/main.ts
var CloudSyncPlugin = class extends import_obsidian4.Plugin {
  async onload() {
    try {
      await this.loadSettings();
      this.addSettingTab(new CloudSyncSettingTab(this.app, this));
      this.initClient();
    } catch (e) {
      new import_obsidian4.Notice(`CloudSync \u521D\u671F\u5316\u30A8\u30E9\u30FC: ${e.message}`);
      console.error("CloudSync onload error:", e);
      return;
    }
    this.addRibbonIcon("cloud", "CloudSync: \u4ECA\u3059\u3050\u540C\u671F", () => this.syncNow());
    this.app.workspace.onLayoutReady(() => {
      if (this.isReady()) {
        setTimeout(async () => {
          await this.engine.loadIgnoreFile();
          await this.engine.sync();
        }, 3e3);
      }
    });
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isReady()) this.engine.scheduleUpload(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isReady()) this.engine.scheduleUpload(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.isReady()) this.engine.handleDelete(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.isReady()) this.engine.handleRename(file, oldPath);
      })
    );
    this.addCommand({
      id: "sync-now",
      name: "\u4ECA\u3059\u3050\u540C\u671F",
      callback: () => this.syncNow()
    });
  }
  async onunload() {
    if (this.isReady()) {
      await this.engine.flushPending();
    }
  }
  getClient() {
    return this.client;
  }
  async syncNow() {
    if (!this.isReady()) {
      new import_obsidian4.Notice("CloudSync: \u8A2D\u5B9A\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044");
      return;
    }
    await this.engine.sync();
  }
  isReady() {
    return !!(this.settings.appKey && this.settings.appSecret && this.settings.refreshToken);
  }
  initClient() {
    this.client = new DropboxClient({
      appKey: this.settings.appKey,
      appSecret: this.settings.appSecret,
      refreshToken: this.settings.refreshToken,
      remotePath: this.settings.remotePath
    });
    this.engine = new SyncEngine(
      this.app,
      this.client,
      this.settings.remotePath,
      async (state) => {
        this.settings.cursor = state.cursor;
        this.settings.syncedFiles = state.syncedFiles;
        delete this.settings.syncedRevs;
        await this.saveData(this.settings);
      }
    );
    this.engine.loadState(this.settings);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.initClient();
  }
};
