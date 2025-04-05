const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const fs = require("node:fs").promises;
const path = require("node:path");
const { exec } = require("node:child_process");

const DEFAULT_SETTINGS = {
	source_folder: "",
	blogs: [
		{
			name: "默认博客",
			target_folder: "",
			autoGit: false,
			gitPushBranch: "main",
			enableFolderMatching: false,
			autoSlug: false,
			slugPrefix: "",
			slugSuffix: "",
			slugSeparator: "-",
		},
	],
};

module.exports = class MultiBlogPublisher extends Plugin {
	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("clipboard-paste", "笔记推送", async () => {
			await this.copyMarkdownFiles();
		});

		this.addSettingTab(new MultiBlogSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async copyMarkdownFiles() {
		const vaultPath = this.app.vault.adapter.basePath;
		const sourceRelative = this.settings.source_folder;
		const source = sourceRelative ? path.join(vaultPath, sourceRelative) : "";

		if (!this.settings.source_folder || this.settings.blogs.length === 0) {
			new Notice("请先设置源文件夹和至少一个博客配置");
			return;
		}
		try {
			await fs.access(source); // 检查路径是否存在
			const files = await fs.readdir(source);
			const mdFiles = files.filter(
				(file) => path.extname(file).toLowerCase() === ".md",
			);
			const newMdFiles = await this.getNewMdFiles(mdFiles, source);
			const deletedFiles = await this.getDeletedFiles(mdFiles, source);

			if (newMdFiles.length === 0 && deletedFiles.length === 0) {
				new Notice("源文件夹中没有新的或被删除的 Markdown 文件");
				return;
			}
			await this.processBlogPushes(newMdFiles, deletedFiles);
		} catch (error) {
			new Notice(`文件处理出错: ${error.message}`);
			console.error(error);
		}
	}

	async getNewMdFiles(mdFiles, source) {
		const newMdFiles = [];
		const lastRunTimestampPath = path.join(source, ".lastRunTimestamp");
		let lastRunTimestamp = 0;

		try {
			const timestampData = await fs.readFile(lastRunTimestampPath, "utf8");
			lastRunTimestamp = Number.parseInt(timestampData, 10);
		} catch (error) {
			// 首次运行或文件不存在，忽略错误
		}

		for (const file of mdFiles) {
			const filePath = path.join(source, file);
			const stats = await fs.stat(filePath);
			if (stats.mtimeMs > lastRunTimestamp) {
				newMdFiles.push(file);
			}
		}

		// 更新时间戳
		await fs.writeFile(lastRunTimestampPath, Date.now().toString());

		return newMdFiles;
	}

	async getDeletedFiles(currentFiles, source) {
		const deletedFiles = [];
		const lastRunFilesPath = path.join(source, ".lastRunFiles");
		let lastRunFiles = [];

		try {
			const filesData = await fs.readFile(lastRunFilesPath, "utf8");
			lastRunFiles = JSON.parse(filesData);
		} catch (error) {
			// 首次运行或文件不存在，忽略错误
		}

		for (const file of lastRunFiles) {
			if (!currentFiles.includes(file)) {
				deletedFiles.push(file);
			}
		}

		// 更新文件列表
		await fs.writeFile(lastRunFilesPath, JSON.stringify(currentFiles));

		return deletedFiles;
	}

	async processBlogPushes(newMdFiles, deletedFiles) {
		const vaultPath = this.app.vault.adapter.basePath;
		const sourceRelative = this.settings.source_folder;
		const source = sourceRelative ? path.join(vaultPath, sourceRelative) : "";

		try {
			let resultMessage = "文件推送结果:\n\n";

			for (const blog of this.settings.blogs) {
				if (!blog.target_folder) continue;

				// 目标路径直接使用用户输入的绝对路径
				const target = blog.target_folder;
				let blogMessage = `博客【${blog.name}】:\n`;
				let fileCount = 0;

				try {
					await fs.mkdir(target, { recursive: true });

					for (const file of newMdFiles) {
						const sourcePath = path.join(source, file);
						const targetFilename = this.generateSlugFilename(file, blog);
						const targetPath = path.join(target, targetFilename);

						// 确保目标目录存在
						await fs.mkdir(path.dirname(targetPath), { recursive: true });

						await fs.copyFile(sourcePath, targetPath);

						const originalFilename = path.basename(file);
						const newFilename = path.basename(targetPath);

						if (originalFilename !== newFilename) {
							blogMessage += `- ${originalFilename} → ${newFilename}\n`;
						} else {
							blogMessage += `- ${originalFilename}\n`;
						}

						fileCount++;

						if (blog.autoSlug) {
							await this.processFileSlug(targetPath, blog);
						}
					}

					for (const file of deletedFiles) {
						const targetFilename = this.generateSlugFilename(file, blog);
						const targetPath = path.join(target, targetFilename);
						try {
							await fs.unlink(targetPath);
							blogMessage += `- 🗑️ ${targetFilename}\n`;
						} catch (error) {
							// 文件可能已不存在，忽略错误
						}
					}

					blogMessage += `共推送 ${fileCount} 个新文件，删除 ${deletedFiles.length} 个文件\n\n`;

					if (blog.autoGit && (fileCount > 0 || deletedFiles.length > 0)) {
						try {
							await this.autoPushToBlog(target, blog.gitPushBranch);
							blogMessage += "✅ 自动Git推送完成\n";
						} catch (gitError) {
							blogMessage += `❌ Git推送失败: ${gitError.message}\n`;
						}
					}

					if (blog.enableFolderMatching) {
						const extraDeletedFiles = await this.matchAndDeleteExtraFiles(
							source,
							target,
						);
						if (extraDeletedFiles.length > 0) {
							blogMessage += `🗑️ 删除多余文件: ${extraDeletedFiles.join(", ")}\n`;
						}
					}

					resultMessage += blogMessage;
				} catch (error) {
					resultMessage += `处理博客 ${blog.name} 出错: ${error.message}\n`;
					console.error(`处理博客 ${blog.name} 出错:`, error);
				}
			}

			new Notice(resultMessage, 15000); // 15秒后自动关闭
		} catch (error) {
			new Notice(`推送处理出错: ${error.message}`);
			console.error("推送处理出错:", error);
		}
	}

	async autoPushToBlog(targetFolder, branch = "main") {
		return new Promise((resolve, reject) => {
			const commands = [
				`cd "${targetFolder}"`,
				"git add .",
				`git commit -m "自动提交: ${new Date().toLocaleString()}"`,
				`git push origin ${branch}`,
			].join(" && ");

			exec(commands, (error, stdout, stderr) => {
				if (error) {
					console.error("Git推送错误:", stderr);
					reject(new Error(stderr || "Git推送失败"));
				} else {
					console.log("Git推送成功:", stdout);
					resolve();
				}
			});
		});
	}

	// 处理文件内容中的slug
	async processFileSlug(filePath, blog) {
		try {
			let content = await fs.readFile(filePath, "utf8");

			// 这里可以根据你的需求修改文件内容
			// 例如添加front matter中的slug字段
			if (content.startsWith("---")) {
				const frontMatterEnd = content.indexOf("\n---", 3);
				if (frontMatterEnd > 0) {
					const frontMatter = content.slice(0, frontMatterEnd + 4);
					const body = content.slice(frontMatterEnd + 4);

					// 如果已经有slug字段则跳过
					if (!frontMatter.includes("\nslug:")) {
						const slugValue = path.basename(filePath, path.extname(filePath));
						const newFrontMatter = frontMatter.replace(
							"---",
							`---\nslug: "${slugValue}"`,
						);
						content = newFrontMatter + body;
					}
				}
			}

			await fs.writeFile(filePath, content);
		} catch (error) {
			console.error(`处理文件slug出错: ${filePath}`, error);
		}
	}

	// 修改后的matchAndDeleteExtraFiles返回删除的文件列表
	async matchAndDeleteExtraFiles(sourceFolder, targetFolder) {
		const deletedFiles = [];
		try {
			const sourceFiles = await fs.readdir(sourceFolder);
			const targetFiles = await fs.readdir(targetFolder);

			const sourceMdFiles = sourceFiles.filter(
				(file) => path.extname(file) === ".md",
			);
			const targetMdFiles = targetFiles.filter(
				(file) => path.extname(file) === ".md",
			);

			for (const file of targetMdFiles.filter(
				(f) => !sourceMdFiles.includes(f),
			)) {
				await fs.unlink(path.join(targetFolder, file));
				deletedFiles.push(file);
			}
		} catch (error) {
			console.error("删除文件出错:", error);
		}
		return deletedFiles;
	}

	// 生成带有slug的文件名，这里简单返回原文件名，你可以根据需要修改
	generateSlugFilename(file, blog) {
		return file;
	}
};

class MultiBlogSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		// 添加CSS样式
		containerEl.createEl("style", {
			text: `
           .blog-config {
                background: var(--background-secondary);
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 16px;
                border: 1px solid var(--background-modifier-border);
                position: relative;
            }
           .blog-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }
           .blog-actions {
                display: flex;
                gap: 8px;
            }
           .delete-blog {
                color: var(--text-error);
            }
           .setting-item {
                padding: 8px 0;
            }
        `,
		});

		containerEl.createEl("h2", { text: "多博客发布设置" });

		new Setting(containerEl)
			.setName("源文件夹")
			.setDesc("相对路径，相对于Obsidian仓库根目录，例如: _posts")
			.addText((text) => {
				text
					.setPlaceholder("_posts")
					.setValue(this.plugin.settings.source_folder)
					.onChange(async (value) => {
						this.plugin.settings.source_folder = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h3", { text: "博客配置" });

		new Setting(containerEl).setName("添加新博客").addButton((button) => {
			button
				.setButtonText("+ 添加博客")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.blogs.push({
						name: `博客${this.plugin.settings.blogs.length + 1}`,
						target_folder: "",
						autoGit: false,
						gitPushBranch: "main",
						enableFolderMatching: false,
						autoSlug: false,
						slugPrefix: "",
						slugSuffix: "",
						slugSeparator: "-",
					});
					await this.plugin.saveSettings();
					this.display();
				});
		});

		this.plugin.settings.blogs.forEach((blog, index) => {
			const blogDiv = containerEl.createEl("div", { cls: "blog-config" });

			// 博客标题和删除按钮
			const header = blogDiv.createEl("div", { cls: "blog-header" });
			header.createEl("h3", { text: blog.name });

			const actions = header.createEl("div", { cls: "blog-actions" });

			// 删除按钮
			new Setting(actions).addButton((button) => {
				button
					.setButtonText("删除")
					.setClass("delete-blog")
					.onClick(async () => {
						this.plugin.settings.blogs.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});

			new Setting(blogDiv).setName("博客名称").addText((text) => {
				text.setValue(blog.name).onChange(async (value) => {
					this.plugin.settings.blogs[index].name = value;
					await this.plugin.saveSettings();
					this.display(); // 刷新显示以更新标题
				});
			});

			new Setting(blogDiv)
				.setName("目标文件夹")
				.setDesc("绝对路径，例如: F:\\Blog\\target\\posts")
				.addText((text) => {
					text
						.setPlaceholder("F:\\Blog\\target\\posts")
						.setValue(blog.target_folder)
						.onChange(async (value) => {
							this.plugin.settings.blogs[index].target_folder = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(blogDiv)
				.setName("自动Git推送")
				.setDesc("推送后自动提交并推送到Git仓库")
				.addToggle((toggle) => {
					toggle.setValue(blog.autoGit).onChange(async (value) => {
						this.plugin.settings.blogs[index].autoGit = value;
						await this.plugin.saveSettings();
						this.display();
					});
				});

			if (blog.autoGit) {
				new Setting(blogDiv).setName("Git推送分支").addText((text) => {
					text
						.setPlaceholder("例如: main")
						.setValue(blog.gitPushBranch)
						.onChange(async (value) => {
							this.plugin.settings.blogs[index].gitPushBranch = value;
							await this.plugin.saveSettings();
						});
				});
			}

			new Setting(blogDiv)
				.setName("启用文件夹匹配")
				.setDesc("删除目标文件夹中不存在于源文件夹的文件")
				.addToggle((toggle) => {
					toggle.setValue(blog.enableFolderMatching).onChange(async (value) => {
						this.plugin.settings.blogs[index].enableFolderMatching = value;
						await this.plugin.saveSettings();
					});
				});

			new Setting(blogDiv)
				.setName("自动添加slug")
				.setDesc("根据标题自动生成slug")
				.addToggle((toggle) => {
					toggle.setValue(blog.autoSlug).onChange(async (value) => {
						this.plugin.settings.blogs[index].autoSlug = value;
						await this.plugin.saveSettings();
						this.display();
					});
				});

			if (blog.autoSlug) {
				new Setting(blogDiv).setName("slug前缀").addText((text) => {
					text
						.setPlaceholder("例如: post")
						.setValue(blog.slugPrefix)
						.onChange(async (value) => {
							this.plugin.settings.blogs[index].slugPrefix = value;
							await this.plugin.saveSettings();
						});
				});

				new Setting(blogDiv).setName("slug后缀").addText((text) => {
					text
						.setPlaceholder("例如: 2023")
						.setValue(blog.slugSuffix)
						.onChange(async (value) => {
							this.plugin.settings.blogs[index].slugSuffix = value;
							await this.plugin.saveSettings();
						});
				});

				new Setting(blogDiv).setName("slug分隔符").addDropdown((dropdown) => {
					dropdown.addOption("-", "连字符 (-)");
					dropdown.addOption("_", "下划线 (_)");
					dropdown.setValue(blog.slugSeparator).onChange(async (value) => {
						this.plugin.settings.blogs[index].slugSeparator = value;
						await this.plugin.saveSettings();
					});
				});
			}
		});
	}
}
