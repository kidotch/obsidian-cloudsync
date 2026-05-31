/**
 * Dropbox API クライアント
 * Obsidian の requestUrl を使って動作（モバイル対応）
 */
import { requestUrl } from "obsidian";

export interface DropboxSettings {
	appKey: string;
	appSecret: string;
	refreshToken: string;
	remotePath: string;
}

export interface FileEntry {
	path: string;
	rev: string;
	serverModified: string;
	size: number;
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

		let res = await requestUrl({
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
						rev: entry.rev,
						serverModified: entry.server_modified,
						size: entry.size,
					});
				}
			}
			if (!res.json.has_more) break;
			res = await requestUrl({
				url: "https://api.dropboxapi.com/2/files/list_folder/continue",
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ cursor: res.json.cursor }),
			});
		}
		return results;
	}

	// ────────────────────────────────────────────
	// アップロード
	// ────────────────────────────────────────────

	async upload(remotePath: string, content: ArrayBuffer): Promise<string> {
		const headers = await this.authHeader();
		const res = await requestUrl({
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
		const res = await requestUrl({
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
		await requestUrl({
			url: "https://api.dropboxapi.com/2/files/delete_v2",
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ path: remotePath }),
		});
	}
}
