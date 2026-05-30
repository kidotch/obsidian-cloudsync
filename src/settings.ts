import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudSyncPlugin from "./main";

export interface CloudSyncSettings {
	appKey: string;
	appSecret: string;
	refreshToken: string;
	remotePath: string;
	syncedRevs: Record<string, string>;
}

export const DEFAULT_SETTINGS: CloudSyncSettings = {
	appKey: "",
	appSecret: "",
	refreshToken: "",
	remotePath: "/base",
	syncedRevs: {},
};

export class CloudSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CloudSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Dropbox App Key").addText(t =>
			t.setValue(this.plugin.settings.appKey)
				.onChange(async v => { this.plugin.settings.appKey = v; await this.plugin.saveSettings(); })
		);

		new Setting(containerEl).setName("Dropbox App Secret").addText(t => {
			t.inputEl.type = "password";
			t.setValue(this.plugin.settings.appSecret)
				.onChange(async v => { this.plugin.settings.appSecret = v; await this.plugin.saveSettings(); });
		});

		new Setting(containerEl).setName("Remote path").setDesc("Dropbox上の同期フォルダ（例: /base）").addText(t =>
			t.setValue(this.plugin.settings.remotePath)
				.onChange(async v => { this.plugin.settings.remotePath = v; await this.plugin.saveSettings(); })
		);

		// 認証セクション
		containerEl.createEl("h3", { text: "認証" });

		if (!this.plugin.settings.refreshToken) {
			new Setting(containerEl)
				.setName("Step 1: 認証URLを開く")
				.addButton(b => b.setButtonText("ブラウザで開く").onClick(() => {
					const url = this.plugin.getClient().getAuthUrl();
					window.open(url);
				}));

			let authCode = "";
			new Setting(containerEl)
				.setName("Step 2: 認証コードを入力")
				.addText(t => t.setPlaceholder("認証コード").onChange(v => { authCode = v; }))
				.addButton(b => b.setButtonText("認証").onClick(async () => {
					try {
						const token = await this.plugin.getClient().exchangeCode(authCode);
						this.plugin.settings.refreshToken = token;
						await this.plugin.saveSettings();
						new Notice("認証完了！");
						this.display();
					} catch (e) {
						new Notice("認証失敗: " + e.message);
					}
				}));
		} else {
			new Setting(containerEl)
				.setName("認証済み")
				.setDesc("Dropboxと接続されています")
				.addButton(b => b.setButtonText("今すぐ同期").onClick(() => this.plugin.syncNow()))
				.addButton(b => b.setButtonText("認証解除").setWarning().onClick(async () => {
					this.plugin.settings.refreshToken = "";
					await this.plugin.saveSettings();
					this.display();
				}));
		}
	}
}
