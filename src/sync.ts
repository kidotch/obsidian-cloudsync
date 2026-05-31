/**
 * 同期ロジック（cursor / delta ベース）
 *
 * 設計の柱:
 *  1. 状態は path_lower（Dropboxの正準キー）で一本化する
 *     → 端末ごとの大文字小文字の違いに依存しない
 *  2. 変更検出は Dropbox の cursor（delta API）を唯一のソースにする
 *     → 起動時も手動同期も同じロジック。全件比較しない
 *  3. echo 抑制は rev で行う
 *     → 自分が上げた変更が delta で返ってきても rev 一致で無視
 *
 * フロー:
 *  - cursor 未保持      : fullSync()（初回フル照合）→ cursor を確定
 *  - cursor 保持        : deltaSync()（差分のみ remote→local）
 *  - どちらの後でも     : pushLocalChanges()（local→remote をまとめて反映）
 */
import { App, Notice, TFile } from "obsidian";
import { DropboxClient, FileEntry } from "./dropbox";
import { FileState } from "./settings";

export interface SyncState {
	cursor: string;
	syncedFiles: Record<string, FileState>;
}

export class SyncEngine {
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private debounceMs = 5000;
	private cursor = "";
	private syncedFiles = new Map<string, FileState>(); // path_lower → 状態
	private downloading = new Set<string>();
	private startupDone = false;
	private syncing = false;
	private ignorePatterns: string[] = [];

	constructor(
		private app: App,
		private dbx: DropboxClient,
		private remotePath: string,
		private onSaveState?: (state: SyncState) => void
	) {}

	// 旧 syncedRevs（lower→rev）を含めて状態をロード・移行する
	loadState(state: { cursor?: string; syncedFiles?: Record<string, FileState>; syncedRevs?: Record<string, string> }) {
		this.cursor = state.cursor ?? "";
		this.syncedFiles = new Map();
		// 新形式
		for (const [k, v] of Object.entries(state.syncedFiles ?? {})) {
			this.syncedFiles.set(k.toLowerCase(), v);
		}
		// 旧形式（rev のみ）からの移行：hash は空で入れておき、fullSync で補完する
		for (const [k, rev] of Object.entries(state.syncedRevs ?? {})) {
			const lower = k.toLowerCase();
			if (!this.syncedFiles.has(lower)) {
				this.syncedFiles.set(lower, { rev, hash: "", path: k });
			}
		}
	}

	private saveState() {
		this.onSaveState?.({
			cursor: this.cursor,
			syncedFiles: Object.fromEntries(this.syncedFiles),
		});
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
	// 同期エントリーポイント（起動時・手動 共通）
	// ────────────────────────────────────────────

	async sync(retry = 0): Promise<void> {
		if (this.syncing) {
			new Notice("☁️ 同期中です…");
			return;
		}
		this.syncing = true;
		new Notice("☁️ 同期中...");
		await this.loadIgnoreFile();
		try {
			const updated: string[] = [];
			const deleted: string[] = [];
			const failed: string[] = []; // 通信不良などでスキップしたファイル

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
				new Notice("☁️ 最新の状態です");
			} else {
				const entries = [
					...updated.map(f => ({ path: f, action: "↓取得" as const })),
					...uploaded.map(f => ({ path: f, action: "↑送信" as const })),
					...deleted.map(f => ({ path: f, action: "🗑削除" as const })),
				];
				const preview = entries.slice(0, 3).map(e => `• ${e.action} ${e.path.split("/").pop()}`).join("\n");
				const more = entries.length > 3 ? `\n他 ${entries.length - 3} 件` : "";
				const warn = failed.length ? `\n⚠️ ${failed.length}件は通信不良でスキップ（次回再試行）` : "";
				new Notice(`☁️ ${total}件を同期しました${warn}\n${preview}${more}`, 6000);
				if (entries.length) await this.appendLog(entries);
			}
		} catch (e) {
			if (retry < 2) {
				this.syncing = false;
				new Notice(`☁️ 同期リトライ中... (${retry + 1}/2)`);
				setTimeout(() => this.sync(retry + 1), 5000);
				return;
			}
			this.startupDone = true; // エラーでも編集は受け付ける
			new Notice(`☁️ 同期エラー: ${e.message}`);
			console.error("CloudSync sync error:", e);
		} finally {
			this.syncing = false;
		}
	}

	// ────────────────────────────────────────────
	// 初回フル照合（cursor 未保持時のみ）
	// ────────────────────────────────────────────

	private async fullSync(updated: string[], deleted: string[], failed: string[]): Promise<void> {
		// 起点 cursor を先に確保（list の最中の変更は次回 delta で拾う）
		const latestCursor = await this.dbx.getLatestCursor();
		const remoteFiles = await this.dbx.listFiles();

		const remoteByLower = new Map<string, FileEntry>();
		for (const f of remoteFiles) {
			const lp = this.toLocalPath(f.path);
			if (lp) remoteByLower.set(lp.toLowerCase(), f);
		}
		const fileByLower = this.buildFileMap();

		// remote → local（ダウンロード／更新）
		for (const remote of remoteFiles) {
			const localPath = this.toLocalPath(remote.path);
			if (!localPath) continue;
			const lower = localPath.toLowerCase();
			const state = this.syncedFiles.get(lower);

			if (state && state.rev === remote.rev) {
				// 既に同期済み。移行データで hash が空なら補完して再アップロードを防ぐ
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
					await this.downloadFile(remote.path, localFile?.path ?? localPath);
					const content = await this.app.vault.adapter.readBinary(localFile?.path ?? localPath);
					this.syncedFiles.set(lower, {
						rev: remote.rev,
						hash: await this.hashContent(content),
						path: remote.path,
					});
					updated.push(localPath);
				} catch (e) {
					failed.push(localPath); // 1ファイルの失敗で全体を止めない
					console.error(`CloudSync: ダウンロード失敗 ${localPath}:`, e);
				}
			}
			// ローカルの方が新しい場合は触らない → pushLocalChanges が上げる
		}

		// syncedFiles にあるが remote に無い → ローカルからも削除
		for (const [lower] of [...this.syncedFiles]) {
			if (remoteByLower.has(lower)) continue;
			const lf = fileByLower.get(lower);
			if (lf) {
				try {
					await this.app.vault.adapter.remove(lf.path);
					deleted.push(lf.path);
				} catch (e) {
					console.error(`CloudSync: 削除失敗 ${lf.path}:`, e);
				}
			}
			this.syncedFiles.delete(lower);
		}

		// 全ファイル成功したときだけ cursor を進める。
		// 失敗が残っていれば cursor は空のままにして、次回もう一度フル照合で取りこぼしを拾う
		if (failed.length === 0) this.cursor = latestCursor;
	}

	// ────────────────────────────────────────────
	// 差分同期（cursor 保持時）
	// ────────────────────────────────────────────

	private async deltaSync(updated: string[], deleted: string[], failed: string[]): Promise<void> {
		const { entries, cursor } = await this.dbx.listDelta(this.cursor);
		const fileByLower = this.buildFileMap();

		for (const entry of entries) {
			const localPath = this.toLocalPath(entry.path);
			if (!localPath) continue;
			const lower = localPath.toLowerCase();

			if (entry.tag === "deleted") {
				// 自分が把握しているファイルだけ削除（誤削除・カスケード削除を防ぐ）
				const state = this.syncedFiles.get(lower);
				if (!state) continue;
				const lf = fileByLower.get(lower);
				if (lf) {
					try {
						await this.app.vault.adapter.remove(lf.path);
						deleted.push(lf.path);
					} catch (e) {
						console.error(`CloudSync: 削除失敗 ${lf.path}:`, e);
					}
				}
				this.syncedFiles.delete(lower);
				continue;
			}

			// file
			const state = this.syncedFiles.get(lower);
			if (state && state.rev === entry.rev) continue; // 自分のアップロード or 既に最新

			// ローカルがオフライン編集されていれば競合 → ローカルを退避してから取得
			const lf = fileByLower.get(lower);
			if (lf && state) {
				const cur = await this.app.vault.readBinary(lf).catch(() => null);
				if (cur && (await this.hashContent(cur)) !== state.hash) {
					await this.makeConflictCopy(lf);
				}
			}

			try {
				await this.downloadFile(entry.path, lf?.path ?? localPath);
				const content = await this.app.vault.adapter.readBinary(lf?.path ?? localPath);
				this.syncedFiles.set(lower, {
					rev: entry.rev!,
					hash: await this.hashContent(content),
					path: entry.path,
				});
				updated.push(localPath);
			} catch (e) {
				failed.push(localPath); // 1ファイルの失敗で全体を止めない
				console.error(`CloudSync: ダウンロード失敗 ${localPath}:`, e);
			}
		}

		// 取りこぼしがあれば cursor を進めない（次回同じ差分を取り直す。rev一致で済んだ分はスキップ）
		if (failed.length === 0) this.cursor = cursor;
	}

	// ────────────────────────────────────────────
	// local → remote（変化したローカルファイルをまとめて反映）
	// ────────────────────────────────────────────

	private async pushLocalChanges(failed: string[]): Promise<string[]> {
		const uploaded: string[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (this.isExcluded(file.path)) continue;
			const remotePath = this.toRemotePath(file.path);
			if (!remotePath) continue;
			const content = await this.app.vault.readBinary(file).catch(() => null);
			if (!content) continue;
			const hash = await this.hashContent(content);
			const lower = file.path.toLowerCase();
			const state = this.syncedFiles.get(lower);
			if (state && state.hash === hash) continue; // 変化なし

			try {
				const rev = await this.dbx.upload(remotePath, content);
				this.syncedFiles.set(lower, { rev, hash, path: file.path });
				uploaded.push(file.path);

				// デバウンス中のタイマーがあればキャンセル（二重アップロード防止）
				const t = this.debounceTimers.get(lower);
				if (t) { clearTimeout(t); this.debounceTimers.delete(lower); }
			} catch (e) {
				failed.push(file.path); // 1ファイルの失敗で全体を止めない
				console.error(`CloudSync: アップロード失敗 ${file.path}:`, e);
			}
		}
		return uploaded;
	}

	// ────────────────────────────────────────────
	// 編集時アップロード（デバウンス付き）
	// ────────────────────────────────────────────

	scheduleUpload(file: TFile): void {
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
				if (state && state.hash === hash) return; // 内容が変わっていなければ何もしない
				const rev = await this.dbx.upload(this.toRemotePath(file.path)!, content);
				this.syncedFiles.set(key, { rev, hash, path: file.path });
				this.saveState();
				new Notice(`☁️ ${name} をアップロードしました`);
			} catch (e) {
				new Notice(`CloudSync: アップロード失敗 (${name}): ${e.message}`);
				console.error(`CloudSync upload error (${file.path}):`, e);
			}
		}, this.debounceMs);

		this.debounceTimers.set(key, timer);
	}

	// デバウンス中の全ファイルを即時アップロード（終了時用）
	async flushPending(): Promise<void> {
		const keys = [...this.debounceTimers.keys()];
		if (keys.length === 0) return;
		for (const key of keys) {
			clearTimeout(this.debounceTimers.get(key));
			this.debounceTimers.delete(key);
			const state = this.syncedFiles.get(key);
			const file = this.app.vault.getAbstractFileByPath(state?.path ?? key) as TFile;
			if (!file) continue;
			try {
				const content = await this.app.vault.readBinary(file);
				const hash = await this.hashContent(content);
				if (state && state.hash === hash) continue;
				const rev = await this.dbx.upload(this.toRemotePath(file.path)!, content);
				this.syncedFiles.set(key, { rev, hash, path: file.path });
			} catch (e) {
				console.error(`CloudSync flush error (${key}):`, e);
			}
		}
		this.saveState();
	}

	// 削除をDropboxに反映
	async handleDelete(path: string): Promise<void> {
		const lower = path.toLowerCase();
		this.syncedFiles.delete(lower); // 再アップロード防止のため状態から消す
		const t = this.debounceTimers.get(lower);
		if (t) { clearTimeout(t); this.debounceTimers.delete(lower); }
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
	async handleRename(file: TFile, oldPath: string): Promise<void> {
		await this.handleDelete(oldPath);
		try {
			const content = await this.app.vault.readBinary(file);
			const hash = await this.hashContent(content);
			const rev = await this.dbx.upload(this.toRemotePath(file.path)!, content);
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
	private buildFileMap(): Map<string, TFile> {
		return new Map(this.app.vault.getFiles().map(f => [f.path.toLowerCase(), f]));
	}

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

	private async makeConflictCopy(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.readBinary(file);
			const dot = file.path.lastIndexOf(".");
			const base = dot > 0 ? file.path.slice(0, dot) : file.path;
			const ext = dot > 0 ? file.path.slice(dot) : "";
			const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/[/:]/g, "-");
			const conflictPath = `${base} (競合 ${ts})${ext}`;
			await this.app.vault.adapter.writeBinary(conflictPath, content);
		} catch (e) {
			console.error(`CloudSync conflict copy error (${file.path}):`, e);
		}
	}

	private async hashContent(content: ArrayBuffer): Promise<string> {
		const buf = await crypto.subtle.digest("SHA-256", content);
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
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
