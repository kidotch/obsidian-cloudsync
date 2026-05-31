/**
 * Dropbox API クライアント
 * Obsidian の requestUrl を使って動作（モバイル対応）
 */
import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 一時的なネットワーク障害かどうか（これだけリトライ対象にする）
function isTransientNetworkError(e: unknown): boolean {
	const msg = String((e as { message?: string })?.message ?? e);
	return /network|connection|lost|timeout|ECONN|ERR_|fetch failed|socket|reset by peer|aborted/i.test(msg);
}

export interface DropboxSettings {
	appKey: string;
	appSecret: string;
	refreshToken: string;
	remotePath: string;
}

export interface FileEntry {
	path: string;      // path_display（大文字小文字を保持）
	pathLower: string; // path_lower（Dropboxの正準キー）
	rev: string;
	serverModified: string;
	size: number;
}

// 差分（delta）エントリ。ファイル・削除の両方を表す
export interface DeltaEntry {
	tag: "file" | "deleted";
	path: string;      // path_display
	pathLower: string; // path_lower
	rev?: string;
	serverModified?: string;
	size?: number;
}

export interface DeltaResult {
	entries: DeltaEntry[];
	cursor: string;
}

// HTTPヘッダー用に非ASCII文字をUnicodeエスケープ
function escapeForHeader(obj: object): string {
	return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, c =>
		`\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
	);
}

export class DropboxClient {
	private accessToken = "";
	private tokenExpiry = 0;

	constructor(private settings: DropboxSettings) {}

	// requestUrl のラッパー。一時的な通信エラーだけ指数バックオフで再試行する。
	// （認証エラーや 4xx は再試行しても無駄なので即座に投げる）
	private async req(options: RequestUrlParam, retries = 3): Promise<RequestUrlResponse> {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await requestUrl(options);
			} catch (e) {
				lastErr = e;
				if (!isTransientNetworkError(e) || attempt === retries) throw e;
				await sleep(1000 * Math.pow(2, attempt)); // 1s → 2s → 4s
			}
		}
		throw lastErr;
	}

	// ────────────────────────────────────────────
	// 認証
	// ────────────────────────────────────────────

	async getAccessToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.tokenExpiry) {
			return this.accessToken;
		}
		const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.settings.refreshToken)}&client_id=${encodeURIComponent(this.settings.appKey)}&client_secret=${encodeURIComponent(this.settings.appSecret)}`;
		const res = await requestUrl({
			url: "https://api.dropbox.com/oauth2/token",
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			throw: false,
		});
		if (res.status !== 200) {
			throw new Error(`Auth failed (${res.status}): ${res.text}`);
		}
		const data = res.json;
		this.accessToken = data.access_token;
		this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
		return this.accessToken;
	}

	private async authHeader(): Promise<Record<string, string>> {
		return { Authorization: `Bearer ${await this.getAccessToken()}` };
	}

	// ────────────────────────────────────────────
	// OAuth 初回認証（設定画面から呼ぶ）
	// ────────────────────────────────────────────

	getAuthUrl(): string {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.settings.appKey,
			token_access_type: "offline",
		});
		return `https://www.dropbox.com/oauth2/authorize?${params}`;
	}

	async exchangeCode(code: string): Promise<string> {
		const body = `code=${encodeURIComponent(code)}&grant_type=authorization_code&client_id=${encodeURIComponent(this.settings.appKey)}&client_secret=${encodeURIComponent(this.settings.appSecret)}`;
		const res = await requestUrl({
			url: "https://api.dropbox.com/oauth2/token",
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			throw: false,
		});
		if (res.status !== 200) {
			throw new Error(`Auth exchange failed (${res.status}): ${res.text}`);
		}
		return res.json.refresh_token;
	}

	// ────────────────────────────────────────────
	// ファイル一覧
	// ────────────────────────────────────────────

	async listFiles(): Promise<FileEntry[]> {
		const headers = await this.authHeader();
		const results: FileEntry[] = [];

		let res = await this.req({
			url: "https://api.dropboxapi.com/2/files/list_folder",
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ path: this.settings.remotePath, recursive: true }),
		});

		while (true) {
			for (const entry of res.json.entries) {
				if (entry[".tag"] === "file") {
					results.push({
						path: entry.path_display, // 大文字小文字を保持
						pathLower: entry.path_lower,
						rev: entry.rev,
						serverModified: entry.server_modified,
						size: entry.size,
					});
				}
			}
			if (!res.json.has_more) break;
			res = await this.req({
				url: "https://api.dropboxapi.com/2/files/list_folder/continue",
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ cursor: res.json.cursor }),
			});
		}
		return results;
	}

	// ────────────────────────────────────────────
	// 差分同期（cursor / delta）
	// ────────────────────────────────────────────

	// 現時点の最新 cursor を取得（以降の変更だけを追跡する起点）
	async getLatestCursor(): Promise<string> {
		const headers = await this.authHeader();
		const res = await this.req({
			url: "https://api.dropboxapi.com/2/files/list_folder/get_latest_cursor",
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ path: this.settings.remotePath, recursive: true }),
		});
		return res.json.cursor;
	}

	// cursor 以降の変更（追加・更新・削除）を取得し、新しい cursor を返す
	async listDelta(cursor: string): Promise<DeltaResult> {
		const headers = await this.authHeader();
		const entries: DeltaEntry[] = [];
		let c = cursor;
		while (true) {
			const res = await this.req({
				url: "https://api.dropboxapi.com/2/files/list_folder/continue",
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ cursor: c }),
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
						size: entry.size,
					});
				} else if (tag === "deleted") {
					entries.push({
						tag: "deleted",
						path: entry.path_display,
						pathLower: entry.path_lower,
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

	async upload(remotePath: string, content: ArrayBuffer): Promise<string> {
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
					autorename: false,
				}),
			},
			body: content,
		});
		return res.json.rev;
	}

	// ────────────────────────────────────────────
	// ダウンロード
	// ────────────────────────────────────────────

	async download(remotePath: string): Promise<ArrayBuffer> {
		const headers = await this.authHeader();
		const res = await this.req({
			url: "https://content.dropboxapi.com/2/files/download",
			method: "POST",
			headers: {
				...headers,
				"Dropbox-API-Arg": escapeForHeader({ path: remotePath }),
			},
		});
		return res.arrayBuffer;
	}

	// ────────────────────────────────────────────
	// 削除
	// ────────────────────────────────────────────

	async deleteFile(remotePath: string): Promise<void> {
		const headers = await this.authHeader();
		await this.req({
			url: "https://api.dropboxapi.com/2/files/delete_v2",
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ path: remotePath }),
		});
	}
}
