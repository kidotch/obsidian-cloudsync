/**
 * 同期ロジック
 * - 起動時: Dropbox → ローカル（新しいファイルをダウンロード）
 * - 編集時: ローカル → Dropbox（デバウンス付きアップロード）
 */
import { App, Notice, TFile } from "obsidian";
import { DropboxClient, FileEntry } from "./dropbox";

export class SyncEngine {
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private debounceMs = 5000;

	constructor(
		private app: App,
		private dbx: DropboxClient,
		private remotePath: string
	) {}

	// ────────────────────────────────────────────
	// 起動時同期（Dropbox → ローカル）
	// ────────────────────────────────────────────

	async pullOnStartup(): Promise<void> {
		new Notice("CloudSync: 同期中...");
		try {
			const remoteFiles = await this.dbx.listFiles();
			let downloaded = 0;

			for (const remote of remoteFiles) {
				const localPath = this.toLocalPath(remote.path);
				if (!localPath) continue;

				const localFile = this.app.vault.getAbstractFileByPath(localPath);

				// ローカルにない、またはリモートの方が新しければダウンロード
				if (!localFile || await this.isRemoteNewer(localFile as TFile, remote)) {
					await this.downloadFile(remote.path, localPath);
					downloaded++;
				}
			}

			if (downloaded === 0) {
				new Notice("☁️ 最新の状態です");
			} else {
				new Notice(`☁️ ${downloaded}件のファイルを更新しました`);
			}
		} catch (e) {
			new Notice(`☁️ 同期エラー: ${e.message}`);
			console.error("CloudSync pull error:", e);
		}
	}

	// ────────────────────────────────────────────
	// 編集時アップロード（デバウンス付き）
	// ────────────────────────────────────────────

	scheduleUpload(file: TFile): void {
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.debounceTimers.delete(file.path);
			const name = file.name;
			this.uploadFile(file)
				.then(() => new Notice(`☁️ ${name} をアップロードしました`))
				.catch(e => {
					new Notice(`CloudSync: アップロード失敗 (${name}): ${e.message}`);
					console.error(`CloudSync upload error (${file.path}):`, e);
				});
		}, this.debounceMs);

		this.debounceTimers.set(file.path, timer);
	}

	// デバウンス中の全ファイルを即時アップロード（終了時用）
	async flushPending(): Promise<void> {
		const paths = [...this.debounceTimers.keys()];
		if (paths.length === 0) return;
		new Notice(`☁️ ${paths.length}件を保存中...`);
		for (const path of paths) {
			clearTimeout(this.debounceTimers.get(path));
			this.debounceTimers.delete(path);
			const file = this.app.vault.getAbstractFileByPath(path) as TFile;
			if (file) await this.uploadFile(file).catch(console.error);
		}
		new Notice("☁️ 保存完了");
	}

	// 削除をDropboxに反映
	async handleDelete(path: string): Promise<void> {
		const remotePath = this.toRemotePath(path);
		if (!remotePath) return;
		try {
			await this.dbx.deleteFile(remotePath);
		} catch (e) {
			console.error(`CloudSync delete error (${path}):`, e);
		}
	}

	// 名前変更・移動
	async handleRename(file: TFile, oldPath: string): Promise<void> {
		await this.handleDelete(oldPath);
		await this.uploadFile(file);
	}

	// ────────────────────────────────────────────
	// 内部処理
	// ────────────────────────────────────────────

	private async uploadFile(file: TFile): Promise<void> {
		const remotePath = this.toRemotePath(file.path);
		if (!remotePath) return;
		const content = await this.app.vault.readBinary(file);
		await this.dbx.upload(remotePath, content);
	}

	private async downloadFile(remotePath: string, localPath: string): Promise<void> {
		const content = await this.dbx.download(remotePath);
		const dir = localPath.substring(0, localPath.lastIndexOf("/"));
		if (dir) {
			await this.app.vault.adapter.mkdir(dir).catch(() => {});
		}
		await this.app.vault.adapter.writeBinary(localPath, content);
	}

	private async isRemoteNewer(local: TFile, remote: FileEntry): Promise<boolean> {
		const remoteMs = new Date(remote.serverModified).getTime();
		return remoteMs > local.stat.mtime;
	}

	private toRemotePath(localPath: string): string {
		return this.remotePath.replace(/\/$/, "") + "/" + localPath;
	}

	private toLocalPath(remotePath: string): string | null {
		const prefix = this.remotePath.toLowerCase().replace(/\/$/, "") + "/";
		if (!remotePath.toLowerCase().startsWith(prefix)) return null;
		return remotePath.substring(prefix.length);
	}
}
