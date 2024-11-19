const { Plugin, PluginSettingTab, Setting, Notice, getIcon } = require('obsidian');
const fs = require('fs').promises; // 使用promises版本，便于使用async/await
const path = require('path');
const { exec } = require('child_process');

// 设置默认值
const DEFAULT_SETTINGS = {
    source_folder: "",
    target_folder: "",
    autoGit: false, // 添加新的设置项默认值为 false
    gitPushBranch: "main" // 新增设置项，默认推送分支为main，可根据实际修改
};

// 插件主体
module.exports = class MyPlugin extends Plugin {
    async onload() {
        // 加载配置文件
        await this.loadSettings();

        // 添加按钮
        this.addRibbonIcon("clipboard-paste", "笔记推送", async () => {
            await this.copyMarkdownFiles();
        });

        // 添加配置面板
        this.addSettingTab(new MySettingTab(this.app, this));
    }

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async copyMarkdownFiles() {
        // 第一个是相对路径 
        const basePath = this.app.vault.adapter.basePath;
        const source = path.join(basePath, this.settings.source_folder);
        const target = this.settings.target_folder;

        // 检查源文件夹和目标文件夹路径是否设置，修正条件判断逻辑
        if (source === "" || target === "") {
            new Notice("请先设置源文件夹和目标文件夹路径");
            return;
        }

        // 判断文件夹是否正确
        if (!await fs.access(target).then(() => true).catch(() => false)) {
            new Notice(`目标文件夹不存在，请确认路径是否正确。`);
            return;
        }

        try {
            const files = await fs.readdir(source);
            let copiedFiles = [];
            for (const file of files) {
                const filePath = path.join(source, file);
                const fileStats = await fs.stat(filePath);
                if (fileStats.isFile() && path.extname(file) === '.md') {
                    const targetFilePath = path.join(target, file);
                    try {
                        // 判断目标文件夹中是否已存在该文件并获取其状态
                        const targetStat = await fs.stat(targetFilePath);
                        // 比较文件的修改时间，只有源文件修改时间更新才复制
                        if (fileStats.mtimeMs > targetStat.mtimeMs) {
                            await fs.copyFile(filePath, targetFilePath);
                            copiedFiles.push(file);
                        }
                    } catch (error) {
                        if (error.code === 'ENOENT') {
                            // 文件不存在则直接复制
                            await fs.copyFile(filePath, targetFilePath);
                            copiedFiles.push(file);
                        } else {
                            // 其他错误情况处理
                            throw error;
                        }
                    }
                }
            }
            if (copiedFiles.length > 0) {
                new Notice("复制了以下文件：");
                for (const file of copiedFiles) {
                    new Notice(`${file}`);
                    }
                if (this.settings.autoGit) {
                    await this.autoPushToHexo();
                }
            } else if(copiedFiles.length == 0) {
                new Notice("没有新的文件需要复制。");
            }
        } catch (error) {
            new Notice(`文件复制出现错误: ${error.message}`);
        }
    }

    // 自动推送到Hexo
    async autoPushToHexo() {
        const hexoProjectPath = this.settings.target_folder;
        if (!hexoProjectPath) {
            new Notice("未找到Hexo项目路径，请检查配置。");
            return;
        }
        try {
            // 进入Hexo项目目录
            process.chdir(hexoProjectPath);

            // 1. 添加所有文件变更到Git暂存区
            await this.executeCommand('git add .');

            // 2. 提交变更，这里提交信息简单写为 "Auto update from Obsidian"，你可按需修改
            await this.executeCommand('git commit -m "Auto update from Obsidian"');

            // 3. 推送变更到远程仓库，使用设置中的分支名称
            const branch = this.settings.gitPushBranch;
            await this.executeCommand(`git push origin ${branch}`);
            new Notice("已成功将文件推送到Hexo。");
        } catch (error) {
            const errorMessage = `自动推送到Hexo出现错误: ${error.message}，详细错误信息: ${error.stderr}`;
            new Notice(errorMessage);
        }
    }

    async executeCommand(command) {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    const errorMessage = `执行命令 "${command}" 出错: ${error.message}，详细错误信息: ${stderr}`;
                    reject(new Error(errorMessage));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
};

// 设置面板
class MySettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
          .setName("源文件夹")
          .setDesc("本地路径（相对路径）")
          .addText((text) =>
                text
                  .setPlaceholder("输入文件夹路径(相对路径)")
                  .setValue(this.plugin.settings.source_folder)
                  .onChange(async (value) => {
                        this.plugin.settings.source_folder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
          .setName("目标文件夹")
          .setDesc("博客所在文件夹（绝对路径）")
          .addText((text) =>
                text
                  .setPlaceholder("输入文件夹路径")
                  .setValue(this.plugin.settings.target_folder)
                  .onChange(async (value) => {
                        this.plugin.settings.target_folder = value;
                        await this.plugin.saveSettings();
                    })
            );

        // 自动推送开关设置
        new Setting(containerEl)
          .setName("开启自动推送")
          .setDesc("自动推送到Hexo")
          .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoGit);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoGit = value;
                    await this.plugin.saveSettings();
                });
            });

        // 新增设置，用于输入git推送的分支名称
        new Setting(containerEl)
          .setName("Git推送分支")
          .setDesc("设置自动推送时git push的目标分支")
          .addText((text) =>
                text
                  .setPlaceholder("输入分支名称，如main或master等")
                  .setValue(this.plugin.settings.gitPushBranch)
                  .onChange(async (value) => {
                        if (value.trim() === "") {
                            new Notice("请输入有效的分支名称");
                            return;
                        }
                        this.plugin.settings.gitPushBranch = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}