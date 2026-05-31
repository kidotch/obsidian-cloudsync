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
	private syncedRevs = new Map<string, string>();
	private downloading = new Set<string>();
	private startupDone = false;
	private ignorePatterns: string[] = [];
	private syncedHashes = new Map<string, string>(); // lowerPath → content hash

	constructor(
		private app: App,
		private dbx: DropboxClient,
		private remotePath: string,
		private onSaveRevs?: (revs: Record<string, string>) => void
	) {}

	loadRevs(revs: Record<string, string>) {
		// キーを小文字に正規化してロード（大文字小文字混在データの移行）
		this.syncedRevs = new Map(
			Object.entries(revs ?? {}).map(([k, v]) => [k.toLowerCase(), v])
		);
	}

	private saveRevs() {
		this.onSaveRevs?.(Object.fromEntries(this.syncedRevs));
	}

	async loadIgnoreFile(): Promise<void> {
		try {
			const content = await this.app.vault.adapter.read(".cloudsync_ignore");
			this.ignorePatterns = content.split("\n")
				.map(l => l.trim())
				.filter(l => l && !l.startsWith("#"));
		} catch {
			this.ignorePatterns = [];
		}
	}

	// ────────────────────────────────────────────
	// 起動時同期（Dropbox → ローカル）
	// ────────────────────────────────────────────

	async pullOnStartup(retry = 0): Promise<void> {
		new Notice("☁️ 同期中...");
		await this.loadIgnoreFile();
		try {
			const remoteFiles = await this.dbx.listFiles();
			// 大文字小文字を無視して比較するためすべて小文字で管理
			const remotePathLower = new Map(
				remoteFiles.map(f => {
					const lp = this.toLocalPath(f.path);
					return lp ? [lp.toLowerCase(), f] : null;
				}).filter(Boolean) as [string, typeof remoteFiles[0]][]
			);
			const updatedFiles: string[] = [];
			const uploadedFiles: string[] = [];

			// Dropbox → ローカル（ダウンロード）
			for (const remote of remoteFiles) {
				const localPath = this.toLocalPath(remote.path);
				if (!localPath) continue;

				const localFile = this.app.vault.getAbstractFileByPath(localPath);
				const syncedRev = this.syncedRevs.get(localPath.toLowerCase());
				if (syncedRev === remote.rev) continue;

				if (!localFile || await this.isRemoteNewer(localFile as TFile, remote)) {
					await this.downloadFile(remote.path, localPath);
					this.syncedRevs.set(localPath.toLowerCase(), remote.rev);
					updatedFiles.push(localPath);
				} else {
					this.syncedRevs.set(localPath.toLowerCase(), remote.rev);
				}
			}

			// Dropboxで削除されたファイルをローカルからも削除
			const deletedFiles: string[] = [];
			const locallyDeleted = new Set<string>();
			// 実際のファイル一覧を小文字パス→ファイルのマップで持つ
			const allFilesNow = this.app.vault.getFiles();
			const fileByLower = new Map(allFilesNow.map(f => [f.path.toLowerCase(), f]));

			for (const [lowerPath] of this.syncedRevs) {
				if (remotePathLower.has(lowerPath)) continue;
				const actualFile = fileByLower.get(lowerPath);
				if (actualFile) {
					try {
						await this.app.vault.adapter.remove(actualFile.path); // 正確なケースで削除
						this.syncedRevs.delete(lowerPath);
						locallyDeleted.add(lowerPath);
						deletedFiles.push(actualFile.path);
					} catch (e) {
						console.error(`CloudSync: 削除失敗 ${actualFile.path}:`, e);
					}
				} else {
					this.syncedRevs.delete(lowerPath);
				}
			}

			// ローカル → Dropbox（ローカルにあってDropboxにないものをアップロード）
			const allLocalFiles = this.app.vault.getFiles();
			for (const file of allLocalFiles) {
				if (this.isExcluded(file.path)) continue;
				if (remotePathLower.has(file.path.toLowerCase())) continue;
				if (locallyDeleted.has(file.path.toLowerCase())) continue; // 今回削除したものはスキップ
				const remotePath = this.toRemotePath(file.path);
				if (!remotePath) continue;
				const content = await this.app.vault.readBinary(file).catch(() => null);
				if (!content) continue; // 読み込めない場合はスキップ
				const hash = await this.hashContent(content);
				const rev = await this.dbx.upload(remotePath, content);
				this.syncedRevs.set(file.path.toLowerCase(), rev);
				this.syncedHashes.set(file.path.toLowerCase(), hash);
				uploadedFiles.push(file.path);
			}

			// 起動時アップロード済みのデバウンスタイマーをキャンセル（二重アップロード防止）
			for (const path of uploadedFiles) {
				const timer = this.debounceTimers.get(path);
				if (timer) { clearTimeout(timer); this.debounceTimers.delete(path); }
			}

			const total = updatedFiles.length + uploadedFiles.length + deletedFiles.length;
			if (total === 0) {
				new Notice("☁️ 最新の状態です");
			} else {
				const logEntries = [
					...updatedFiles.map(f => ({ path: f, action: "↓取得" as const })),
					...uploadedFiles.map(f => ({ path: f, action: "↑送信" as const })),
					...deletedFiles.map(f => ({ path: f, action: "🗑削除" as const })),
				];
				const preview = logEntries.slice(0, 3).map(e => `• ${e.action} ${e.path.split("/").pop()}`).join("\n");
				const more = logEntries.length > 3 ? `\n他 ${logEntries.length - 3} 件` : "";
				new Notice(`☁️ ${total}件を同期しました\n${preview}${more}`, 6000);
				await this.appendLog(logEntries);
			}
			this.startupDone = true;
			this.saveRevs();
		} catch (e) {
			if (retry < 2) {
				new Notice(`☁️ 同期リトライ中... (${retry + 1}/2)`);
				setTimeout(() => this.pullOnStartup(retry + 1), 5000);
			} else {
				this.startupDone = true;  // エラーでも編集は受け付ける
				new Notice(`☁️ 同期エラー: ${e.message}`);
				console.error("CloudSync pull error:", e);
			}
		}
	}

	// ────────────────────────────────────────────
	// 編集時アップロード（デバウンス付き）
	// ────────────────────────────────────────────

	private isExcluded(path: string): boolean {
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

	scheduleUpload(file: TFile): void {
		if (!this.startupDone) return;
		if (this.isExcluded(file.path)) return;
		if (this.downloading.has(file.path)) return;
		const existing = this.debounceTimers.get(file.path);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			const name = file.name;
			const lowerPath = file.path.toLowerCase();
			try {
				const content = await this.app.vault.readBinary(file);
				const hash = await this.hashContent(content);
				// 内容が変わっていなければスキップ（自動保存による不要アップロード防止）
				if (this.syncedHashes.get(lowerPath) === hash) return;
				const rev = await this.dbx.upload(this.toRemotePath(file.path)!, content);
				if (rev) {
					this.syncedRevs.set(lowerPath, rev);
					this.syncedHashes.set(lowerPath, hash);
				}
				new Notice(`☁️ ${name} をアップロードしました`);
			} catch (e) {
				new Notice(`CloudSync: アップロード失敗 (${name}): ${e.message}`);
				console.error(`CloudSync upload error (${file.path}):`, e);
			}
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

	private async hashContent(content: ArrayBuffer): Promise<string> {
		const buf = await crypto.subtle.digest("SHA-256", content);
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
	}

	private async uploadFile(file: TFile): Promise<string | null> {
		const remotePath = this.toRemotePath(file.path);
		if (!remotePath) return null;
		const content = await this.app.vault.readBinary(file);
		return await this.dbx.upload(remotePath, content);
	}

	private async appendLog(entries: { path: string; action: "↓取得" | "↑送信" | "🗑削除" }[]): Promise<void> {
		const logPath = "cloudsync-log.md";
		const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
		const lines = [`\n## ${now}\n`, ...entries.map(e => `- ${e.action} ${e.path}`)].join("\n");
		try {
			const existing = await this.app.vault.adapter.exists(logPath)
				? await this.app.vault.adapter.read(logPath) : "# CloudSync Log\n";
			await this.app.vault.adapter.write(logPath, existing + lines + "\n");
		} catch (e) {
			console.error("CloudSync log write error:", e);
		}
	}

	private async downloadFile(remotePath: string, localPath: string): Promise<void> {
		this.downloading.add(localPath);
		try {
			const content = await this.dbx.download(remotePath);
			const dir = localPath.substring(0, localPath.lastIndexOf("/"));
			if (dir) {
				await this.app.vault.adapter.mkdir(dir).catch(() => {});
			}
			await this.app.vault.adapter.writeBinary(localPath, content);
		} finally {
			// 少し待ってからフラグを解除（vaultイベントが落ち着くまで）
			setTimeout(() => this.downloading.delete(localPath), 3000);
		}
	}

	private async isRemoteNewer(local: TFile, remote: FileEntry): Promise<boolean> {
		const remoteMs = new Date(remote.serverModified).getTime();
		return remoteMs > local.stat.mtime;
	}

	private toRemotePath(localPath: string): string | null {
		if (this.isExcluded(localPath)) return null;
		return this.remotePath.replace(/\/$/, "") + "/" + localPath;
	}

	private toLocalPath(remotePath: string): string | null {
		const prefix = this.remotePath.toLowerCase().replace(/\/$/, "") + "/";
		if (!remotePath.toLowerCase().startsWith(prefix)) return null;
		const rel = remotePath.substring(prefix.length);
		if (this.isExcluded(rel)) return null;
		return rel;
	}
}
