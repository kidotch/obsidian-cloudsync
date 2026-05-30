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
    let res = await (0, import_obsidian.requestUrl)({
      url: "https://api.dropboxapi.com/2/files/list_folder",
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: this.settings.remotePath, recursive: true })
    });
    while (true) {
      for (const entry of res.json.entries) {
        if (entry[".tag"] === "file") {
          results.push({
            path: entry.path_lower,
            rev: entry.rev,
            serverModified: entry.server_modified,
            size: entry.size
          });
        }
      }
      if (!res.json.has_more) break;
      res = await (0, import_obsidian.requestUrl)({
        url: "https://api.dropboxapi.com/2/files/list_folder/continue",
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: res.json.cursor })
      });
    }
    return results;
  }
  // ────────────────────────────────────────────
  // アップロード
  // ────────────────────────────────────────────
  async upload(remotePath, content) {
    const headers = await this.authHeader();
    const res = await (0, import_obsidian.requestUrl)({
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
    const res = await (0, import_obsidian.requestUrl)({
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
    await (0, import_obsidian.requestUrl)({
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
  constructor(app, dbx, remotePath, onSaveRevs) {
    this.app = app;
    this.dbx = dbx;
    this.remotePath = remotePath;
    this.onSaveRevs = onSaveRevs;
    this.debounceTimers = /* @__PURE__ */ new Map();
    this.debounceMs = 5e3;
    this.syncedRevs = /* @__PURE__ */ new Map();
    this.downloading = /* @__PURE__ */ new Set();
    this.startupDone = false;
    this.ignorePatterns = [];
  }
  loadRevs(revs) {
    this.syncedRevs = new Map(Object.entries(revs != null ? revs : {}));
  }
  saveRevs() {
    var _a;
    (_a = this.onSaveRevs) == null ? void 0 : _a.call(this, Object.fromEntries(this.syncedRevs));
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
  // 起動時同期（Dropbox → ローカル）
  // ────────────────────────────────────────────
  async pullOnStartup(retry = 0) {
    new import_obsidian2.Notice("\u2601\uFE0F \u540C\u671F\u4E2D...");
    try {
      const remoteFiles = await this.dbx.listFiles();
      let downloaded = 0;
      for (const remote of remoteFiles) {
        const localPath = this.toLocalPath(remote.path);
        if (!localPath) continue;
        const localFile = this.app.vault.getAbstractFileByPath(localPath);
        const syncedRev = this.syncedRevs.get(localPath);
        if (syncedRev === remote.rev) continue;
        if (!localFile || await this.isRemoteNewer(localFile, remote)) {
          await this.downloadFile(remote.path, localPath);
          this.syncedRevs.set(localPath, remote.rev);
          downloaded++;
        } else {
          this.syncedRevs.set(localPath, remote.rev);
        }
      }
      if (downloaded === 0) {
        new import_obsidian2.Notice("\u2601\uFE0F \u6700\u65B0\u306E\u72B6\u614B\u3067\u3059");
      } else {
        new import_obsidian2.Notice(`\u2601\uFE0F ${downloaded}\u4EF6\u306E\u30D5\u30A1\u30A4\u30EB\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F`);
      }
      this.startupDone = true;
      this.saveRevs();
    } catch (e) {
      if (retry < 2) {
        new import_obsidian2.Notice(`\u2601\uFE0F \u540C\u671F\u30EA\u30C8\u30E9\u30A4\u4E2D... (${retry + 1}/2)`);
        setTimeout(() => this.pullOnStartup(retry + 1), 5e3);
      } else {
        this.startupDone = true;
        new import_obsidian2.Notice(`\u2601\uFE0F \u540C\u671F\u30A8\u30E9\u30FC: ${e.message}`);
        console.error("CloudSync pull error:", e);
      }
    }
  }
  // ────────────────────────────────────────────
  // 編集時アップロード（デバウンス付き）
  // ────────────────────────────────────────────
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
  scheduleUpload(file) {
    if (!this.startupDone) return;
    if (this.isExcluded(file.path)) return;
    if (this.downloading.has(file.path)) return;
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      const name = file.name;
      this.uploadFile(file).then(() => new import_obsidian2.Notice(`\u2601\uFE0F ${name} \u3092\u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u3057\u307E\u3057\u305F`)).catch((e) => {
        new import_obsidian2.Notice(`CloudSync: \u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u5931\u6557 (${name}): ${e.message}`);
        console.error(`CloudSync upload error (${file.path}):`, e);
      });
    }, this.debounceMs);
    this.debounceTimers.set(file.path, timer);
  }
  // デバウンス中の全ファイルを即時アップロード（終了時用）
  async flushPending() {
    const paths = [...this.debounceTimers.keys()];
    if (paths.length === 0) return;
    new import_obsidian2.Notice(`\u2601\uFE0F ${paths.length}\u4EF6\u3092\u4FDD\u5B58\u4E2D...`);
    for (const path of paths) {
      clearTimeout(this.debounceTimers.get(path));
      this.debounceTimers.delete(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.uploadFile(file).catch(console.error);
    }
    new import_obsidian2.Notice("\u2601\uFE0F \u4FDD\u5B58\u5B8C\u4E86");
  }
  // 削除をDropboxに反映
  async handleDelete(path) {
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
    await this.uploadFile(file);
  }
  // ────────────────────────────────────────────
  // 内部処理
  // ────────────────────────────────────────────
  async uploadFile(file) {
    const remotePath = this.toRemotePath(file.path);
    if (!remotePath) return;
    const content = await this.app.vault.readBinary(file);
    await this.dbx.upload(remotePath, content);
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
  syncedRevs: {}
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
          await this.engine.pullOnStartup();
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
    await this.engine.pullOnStartup();
  }
  isReady() {
    return !!(this.settings.appKey && this.settings.appSecret && this.settings.refreshToken);
  }
  initClient() {
    var _a;
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
      async (revs) => {
        this.settings.syncedRevs = revs;
        await this.saveData(this.settings);
      }
    );
    this.engine.loadRevs((_a = this.settings.syncedRevs) != null ? _a : {});
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.initClient();
  }
};
