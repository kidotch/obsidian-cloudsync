import { Notice, Plugin } from "obsidian";
import { DropboxClient } from "./dropbox";
import { SyncEngine } from "./sync";
import { CloudSyncSettingTab, CloudSyncSettings, DEFAULT_SETTINGS } from "./settings";

export default class CloudSyncPlugin extends Plugin {
	settings: CloudSyncSettings;
	private client: DropboxClient;
	private engine: SyncEngine;

	async onload() {
		try {
		await this.loadSettings();
		this.addSettingTab(new CloudSyncSettingTab(this.app, this));
		this.initClient();
		} catch(e) {
			new Notice(`CloudSync 初期化エラー: ${e.message}`);
			console.error("CloudSync onload error:", e);
			return;
		}

		// リボンアイコン（3本線メニュー）
		this.addRibbonIcon("cloud", "CloudSync: 今すぐ同期", () => this.syncNow());

		// 起動時に同期（ネットワーク準備待ちで少し遅延）
		this.app.workspace.onLayoutReady(() => {
			if (this.isReady()) {
				setTimeout(async () => {
					await this.engine.loadIgnoreFile();
					await this.engine.sync();
				}, 3000);
			}
		});

		// ファイル編集時にアップロード
		this.registerEvent(
			this.app.vault.on("modify", file => {
				if (this.isReady()) this.engine.scheduleUpload(file as any);
			})
		);

		// ファイル作成時にアップロード
		this.registerEvent(
			this.app.vault.on("create", file => {
				if (this.isReady()) this.engine.scheduleUpload(file as any);
			})
		);

		// ファイル削除時にDropboxからも削除
		this.registerEvent(
			this.app.vault.on("delete", file => {
				if (this.isReady()) this.engine.handleDelete(file.path);
			})
		);

		// ファイル名変更・移動時
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.isReady()) this.engine.handleRename(file as any, oldPath);
			})
		);

		// コマンド：手動同期
		this.addCommand({
			id: "sync-now",
			name: "今すぐ同期",
			callback: () => this.syncNow(),
		});
	}

	async onunload() {
		// 閉じる前にデバウンス中のアップロードを即時実行
		if (this.isReady()) {
			await this.engine.flushPending();
		}
	}

	getClient(): DropboxClient {
		return this.client;
	}

	async syncNow(): Promise<void> {
		if (!this.isReady()) {
			new Notice("CloudSync: 設定を完了してください");
			return;
		}
		await this.engine.sync();
	}

	private isReady(): boolean {
		return !!(
			this.settings.appKey &&
			this.settings.appSecret &&
			this.settings.refreshToken
		);
	}

	private initClient(): void {
		this.client = new DropboxClient({
			appKey: this.settings.appKey,
			appSecret: this.settings.appSecret,
			refreshToken: this.settings.refreshToken,
			remotePath: this.settings.remotePath,
		});
		this.engine = new SyncEngine(
			this.app,
			this.client,
			this.settings.remotePath,
			async (state) => {
				this.settings.cursor = state.cursor;
				this.settings.syncedFiles = state.syncedFiles;
				delete this.settings.syncedRevs; // 旧形式は破棄
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
}
