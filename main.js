const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
const fs = require("node:fs").promises;
const path = require("node:path");
const { exec } = require("node:child_process");

const DEFAULT_SETTINGS = {
    autoSlug: false, // 全局slug开关
    slugGenerationMethod: "random", // 'random' or 'sequential'
    sequentialSlugStart: 1,
    blogs: [
        {
            name: "默认博客",
            blogRepoPath: "", // Git仓库的根目录
            autoGit: false,
            gitPushBranch: "main",
            pathMappings: [
                {
                    source: "", // 源文件夹（相对于仓库）
                    target: "", // 目标文件夹（相对于Git仓库根目录）
                    enableFolderMatching: false, // 严格同步
                },
            ],
        },
    ],
};

module.exports = class MultiBlogPublisher extends Plugin {
    async onload() {
        await this.loadSettings();
        
        this.dataPath = path.join(
            this.app.vault.adapter.basePath, 
            ".obsidian", 
            "plugins", 
            this.manifest.id
        );
        
        await fs.mkdir(this.dataPath, { recursive: true });

        this.addRibbonIcon("clipboard-paste", "笔记推送", async () => {
            await this.copyMarkdownFiles();
        });

        this.addSettingTab(new MultiBlogSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    
        // --- 迁移逻辑开始 ---
        let needsSave = false;
    
        // 检查是否存在旧的全局 source_folder，这是旧配置的标志
        if (this.settings.source_folder && this.settings.blogs) {
            
            this.settings.blogs.forEach(blog => {
                // 如果博客配置中有 target_folder 且没有 pathMappings，则判定为需要迁移的旧配置
                if (blog.target_folder && !blog.pathMappings) {
                    
                    // 将旧的 target_folder 作为新的 blogRepoPath
                    blog.blogRepoPath = blog.target_folder;
    
                    // 基于旧的全局 source_folder 和博客设置创建路径映射
                    blog.pathMappings = [{
                        source: this.settings.source_folder,
                        target: "", // 目标路径现在相对于 blogRepoPath，所以这里留空
                        enableFolderMatching: blog.enableFolderMatching || false
                    }];
    
                    // 删除已迁移的旧字段
                    delete blog.target_folder;
                    delete blog.enableFolderMatching;
                    
                    needsSave = true;
                }
            });
    
            // 删除全局的旧字段
            delete this.settings.source_folder;
        }
    
        // 确保所有博客配置都有 pathMappings 数组，防止后续操作出错
        if (this.settings.blogs) {
            this.settings.blogs.forEach(blog => {
                if (!blog.pathMappings) {
                    blog.pathMappings = [];
                    needsSave = true;
                }
            });
        }
    
        // 如果执行了迁移，则将新配置保存回 data.json 文件
        if (needsSave) {
            await this.saveSettings();
        }
        // --- 迁移逻辑结束 ---
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async copyMarkdownFiles() {
        if (!this.settings.blogs || this.settings.blogs.length === 0) {
            new Notice("请先配置至少一个博客");
            return;
        }
    
        for (const blog of this.settings.blogs) {
            if (!blog.blogRepoPath || !blog.pathMappings || blog.pathMappings.length === 0) {
                new Notice(`博客 "${blog.name}" 配置不完整，已跳过`);
                continue;
            }
    
            let allChangedFilesForBlog = [];
            let hasChanges = false;
    
            try {
                // 方法：copyMarkdownFiles
                for (const mapping of blog.pathMappings) {
                    const sourceAbs = path.isAbsolute(mapping.source)
                        ? mapping.source
                        : path.join(this.app.vault.adapter.basePath, mapping.source);
                
                    const targetAbs = path.isAbsolute(mapping.target || "")
                        ? mapping.target
                        : path.join(blog.blogRepoPath, mapping.target || "");
                    
                    await fs.mkdir(targetAbs, { recursive: true });
    
                    // 在同步前处理slug
                    const allFilesInSource = await fs.readdir(sourceAbs).catch(() => []);
                    const mdFiles = allFilesInSource.filter(
                        (file) => path.extname(file).toLowerCase() === ".md"
                    );
                    const filesToProcessForSlug = await this.getFilesToProcess(mdFiles, sourceAbs);
    
                    if (this.settings.autoSlug && filesToProcessForSlug.length > 0) {
                        await this.addSlugsToFiles(filesToProcessForSlug, sourceAbs);
                    }
    
                    // 同步文件并获取变更列表
                    const changedFiles = await this.syncDirectories(sourceAbs, targetAbs, mapping.enableFolderMatching);
                    if (changedFiles.length > 0) {
                        hasChanges = true;
                        const changedFilePaths = changedFiles.map(f => path.join(mapping.target || "", f).replace(/\\/g, '/'));
                        allChangedFilesForBlog.push(...changedFilePaths);
                    }
                }
    
                if (hasChanges) {
                    if (blog.autoGit) {
                        const commitMessage = this.createCommitMessage(allChangedFilesForBlog);
                        await this.autoPushToBlog(blog.blogRepoPath, blog.gitPushBranch, commitMessage);
                    }
                    new Notice(`博客 "${blog.name}" 内容已同步`);
                } else {
                    new Notice(`博客 "${blog.name}" 无内容更新`);
                }
    
            } catch (error) {
                console.error(`处理博客 ${blog.name} 出错:`, error);
                new Notice(`推送 ${blog.name} 失败: ${error.message}`);
            }
        }
    }

    createCommitMessage(changedFiles) {
        const fileCount = changedFiles.length;
        if (fileCount === 0) return "自动提交";
    
        // 仅提取文件名，并去重
        const filenames = Array.from(new Set(
            changedFiles.map(p => (p || "").split(/[\\/]/).pop())
        ));
    
        const fileList = filenames.slice(0, 5).join(", ");
        return `更新文件：${fileList}${filenames.length > 5 ? ` 等${filenames.length}个文件` : ""}`;
    }

    async getFilesToProcess(mdFiles, source) {
        const processTimestampPath = path.join(this.dataPath, ".lastProcessTimestamp");
        let lastProcessTimestamp = 0;
        try {
            lastProcessTimestamp = parseInt(await fs.readFile(processTimestampPath), 10);
        } catch {}

        const filesToProcess = [];
        for (const file of mdFiles) {
            const filePath = path.join(source, file);
            const stats = await fs.stat(filePath);
            if (stats.mtimeMs > lastProcessTimestamp || !(await this.hasSlug(filePath))) {
                filesToProcess.push(file);
            }
        }

        await fs.writeFile(processTimestampPath, Date.now().toString());
        return filesToProcess;
    }

    async hasSlug(filePath) {
        try {
            const content = await fs.readFile(filePath, "utf8");
            return content.includes("\nslug:");
        } catch { return false; }
    }

    async addSlugsToFiles(files, source) {
        for (const file of files) {
            await this.addSlugToFile(path.join(source, file));
        }
    }

    async addSlugToFile(filePath) {
  try {
    let content = await fs.readFile(filePath, "utf8");
    if (content.includes("\nslug:")) return;
    
    const numericId = await this.generateUniqueNumericId();
    
    // 确保ID没有引号
    const cleanId = String(numericId).replace(/"/g, '');
    
    // 添加引号写入文件
    const slugValue = `"${cleanId}"`;
    
    // 处理Frontmatter逻辑...
    if (content.startsWith("---")) {
      const end = content.indexOf("\n---", 3);
      // 写入带引号的字符串
      content = content.slice(0, end) + `\nslug: ${slugValue}` + content.slice(end);
    } else {
      content = `---\nslug: ${slugValue}\n---\n${content}`;
    }
    
    await fs.writeFile(filePath, content);
  } catch (error) {
    console.error(`添加slug出错: ${filePath}`, error);
  }
}

    async generateUniqueNumericId() {
        const globalIdPath = path.join(this.dataPath, ".global-ids.json");
        let usedIds = [];
        try {
            usedIds = JSON.parse(await fs.readFile(globalIdPath, "utf8"));
            usedIds = usedIds.map(id => String(id).replace(/"/g, ''));
        } catch {}

        let newId;
        if (this.settings.slugGenerationMethod === 'sequential') {
            let nextId = this.settings.sequentialSlugStart;
            while (usedIds.includes(String(nextId))) {
                nextId++;
            }
            newId = nextId;
            this.settings.sequentialSlugStart = newId + 1;
            await this.saveSettings();
        } else {
            const generateId = () => Math.floor(100000 + Math.random() * 900000);
            do {
                newId = generateId();
            } while (usedIds.includes(String(newId)));
        }

        usedIds.push(String(newId));
        await fs.writeFile(globalIdPath, JSON.stringify(usedIds));

        return String(newId);
    }

    async syncDirectories(sourceDir, targetDir, deleteExtra) {
        const changedFiles = [];
        const sourceFiles = await this.getAllFilesRelative(sourceDir);
        const targetFiles = await this.getAllFilesRelative(targetDir);
        const sourceFileSet = new Set(sourceFiles);
        const targetFileSet = new Set(targetFiles);
    
        // 1. 复制源文件夹中新增或更新的文件
        for (const file of sourceFiles) {
            const sourcePath = path.join(sourceDir, file);
            const targetPath = path.join(targetDir, file);
            
            let needsCopy = false;
            try {
                const sourceStats = await fs.stat(sourcePath);
                if (!targetFileSet.has(file)) {
                    needsCopy = true;
                } else {
                    const targetStats = await fs.stat(targetPath);
                    if (sourceStats.mtimeMs > targetStats.mtimeMs) {
                        needsCopy = true;
                    }
                }
    
                if (needsCopy) {
                    await fs.mkdir(path.dirname(targetPath), { recursive: true });
                    await fs.copyFile(sourcePath, targetPath);
                    changedFiles.push(file);
                }
            } catch (error) {
                console.error(`无法复制文件 ${file}:`, error);
            }
        }
    
        // 2. 如果启用严格匹配，则删除目标文件夹中多余的文件
        if (deleteExtra) {
            for (const file of targetFiles) {
                if (!sourceFileSet.has(file)) {
                    try {
                        const targetPath = path.join(targetDir, file);
                        await fs.unlink(targetPath);
                        changedFiles.push(file); // 记录删除也是一个变更
                    } catch (error) {
                        console.error(`无法删除文件 ${file}:`, error);
                    }
                }
            }
        }
    
        // 3. 删除清理后留下的空文件夹
        await this.deleteEmptyDirs(targetDir);
        return changedFiles;
    }
    
    async getAllFilesRelative(dirPath, rootDir = dirPath) {
        let results = [];
        try {
            const list = await fs.readdir(dirPath, { withFileTypes: true });
            for (const dirent of list) {
                const fullPath = path.join(dirPath, dirent.name);
                if (dirent.isDirectory()) {
                    results = results.concat(await this.getAllFilesRelative(fullPath, rootDir));
                } else {
                    results.push(path.relative(rootDir, fullPath));
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`无法读取文件夹 ${dirPath}:`, error);
            }
        }
        return results;
    }
    
    async deleteEmptyDirs(directory) {
        try {
            const stats = await fs.stat(directory);
            if (!stats.isDirectory()) return;
    
            let files = await fs.readdir(directory);
            for (const file of files) {
                const p = path.join(directory, file);
                await this.deleteEmptyDirs(p);
            }
    
            files = await fs.readdir(directory);
            if (files.length === 0) {
                await fs.rmdir(directory);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`无法处理文件夹 ${directory}:`, error);
            }
        }
    }

    async autoPushToBlog(targetFolder, branch = "main", message = "自动提交") {
        return new Promise((resolve, reject) => {
            const commands = [
                `cd "${targetFolder}"`,
                "git add .",
                `git commit -m "${message}"`,
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
};

class MultiBlogSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "多博客发布设置" });

        new Setting(containerEl)
            .setName("自动添加slug")
            .setDesc("全局开关：自动为文章生成唯一纯数字短链接")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoSlug).onChange(async (value) => {
                    this.plugin.settings.autoSlug = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh settings to show/hide slug options
                });
            });

        if (this.plugin.settings.autoSlug) {
            new Setting(containerEl)
                .setName("Slug 生成方式")
                .setDesc("选择为文章生成slug的方式")
                .addDropdown(dropdown => {
                    dropdown
                        .addOption('random', '随机')
                        .addOption('sequential', '顺序')
                        .setValue(this.plugin.settings.slugGenerationMethod)
                        .onChange(async (value) => {
                            this.plugin.settings.slugGenerationMethod = value;
                            await this.plugin.saveSettings();
                            this.display();
                        });
                });

            if (this.plugin.settings.slugGenerationMethod === 'sequential') {
                new Setting(containerEl)
                    .setName("顺序Slug起始值")
                    .setDesc("设置顺序生成slug的起始数字")
                    .addText(text => {
                        text
                            .setPlaceholder("例如: 1")
                            .setValue(String(this.plugin.settings.sequentialSlugStart))
                            .onChange(async (value) => {
                                const num = parseInt(value, 10);
                                if (!isNaN(num)) {
                                    this.plugin.settings.sequentialSlugStart = num;
                                    await this.plugin.saveSettings();
                                }
                            });
                    });
            }
        }

        containerEl.createEl("h3", { text: "博客配置" });

        new Setting(containerEl).setName("添加新博客").addButton((button) => {
            button
                .setButtonText("+ 添加博客")
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.blogs.push({
                        name: `博客${this.plugin.settings.blogs.length + 1}`,
                        blogRepoPath: "",
                        autoGit: false,
                        gitPushBranch: "main",
                        pathMappings: [{ source: "", target: "", enableFolderMatching: false }],
                    });
                    await this.plugin.saveSettings();
                    this.display();
                });
        });

        this.plugin.settings.blogs.forEach((blog, blogIndex) => {
            const blogDiv = containerEl.createEl("div", { cls: "blog-config" });
            blogDiv.createEl("h4", { text: blog.name });

            // --- 可见设置 ---
            new Setting(blogDiv)
                .setName("自动Git推送")
                .setDesc("推送后自动提交并推送到Git仓库")
                .addToggle((toggle) => {
                    toggle.setValue(blog.autoGit).onChange(async (value) => {
                        this.plugin.settings.blogs[blogIndex].autoGit = value;
                        await this.plugin.saveSettings();
                        this.display(); // 刷新以显示/隐藏分支设置
                    });
                });

            if (blog.pathMappings) {
                blog.pathMappings.forEach((mapping, mappingIndex) => {
                    const mappingDisplayDiv = blogDiv.createEl("div", { cls: "path-mapping-display" });
                    new Setting(mappingDisplayDiv)
                        .setName(`路径映射: ${mapping.source || "未设置"} → ${mapping.target || "根目录"}`)
                        .setDesc("删除目标文件夹中源文件夹不存在的文件")
                        .addToggle(toggle => {
                            toggle.setValue(mapping.enableFolderMatching).onChange(async (value) => {
                                this.plugin.settings.blogs[blogIndex].pathMappings[mappingIndex].enableFolderMatching = value;
                                await this.plugin.saveSettings();
                            });
                        });
                });
            }

            // --- 可折叠的详细设置 ---
            const details = blogDiv.createEl("details");
            details.createEl("summary", { text: "编辑路径与高级选项" });
            const advancedSettingsDiv = details.createDiv();

            new Setting(advancedSettingsDiv)
                .setName("博客名称")
                .addText((text) => {
                    text.setValue(blog.name).onChange(async (value) => {
                        this.plugin.settings.blogs[blogIndex].name = value;
                        await this.plugin.saveSettings();
                        // 移除 this.display()，避免输入时折叠
                    });
                });

            new Setting(advancedSettingsDiv)
                .setName("博客仓库路径")
                .setDesc("Git仓库的绝对路径，例如: F:\\Blog\\target")
                .addText((text) => {
                    text
                        .setPlaceholder("F:\\Blog\\target")
                        .setValue(blog.blogRepoPath)
                        .onChange(async (value) => {
                            this.plugin.settings.blogs[blogIndex].blogRepoPath = value;
                            await this.plugin.saveSettings();
                        });
                });

            if (blog.autoGit) {
                new Setting(advancedSettingsDiv).setName("Git推送分支").addText((text) => {
                    text
                        .setPlaceholder("例如: main")
                        .setValue(blog.gitPushBranch)
                        .onChange(async (value) => {
                            this.plugin.settings.blogs[blogIndex].gitPushBranch = value;
                            await this.plugin.saveSettings();
                        });
                });
            }

            const mappingsDiv = advancedSettingsDiv.createEl("div", { cls: "path-mappings" });
            mappingsDiv.createEl("strong", { text: "路径映射配置" });

            if (blog.pathMappings) {
                blog.pathMappings.forEach((mapping, mappingIndex) => {
                    const mappingEditDiv = mappingsDiv.createEl("div", { cls: "path-mapping-item" });

                    new Setting(mappingEditDiv)
                        .setName("源文件夹")
                        .setDesc("相对于Obsidian仓库根目录的路径")
                        .addText(text => {
                            text.setValue(mapping.source).onChange(async (value) => {
                                this.plugin.settings.blogs[blogIndex].pathMappings[mappingIndex].source = value;
                                await this.plugin.saveSettings();
                                // 移除 this.display()，避免输入时折叠
                            });
                        });

                    new Setting(mappingEditDiv)
                        .setName("目标文件夹")
                        .setDesc("相对于博客仓库路径的路径（可留空）")
                        .addText(text => {
                            text.setValue(mapping.target).onChange(async (value) => {
                                this.plugin.settings.blogs[blogIndex].pathMappings[mappingIndex].target = value;
                                await this.plugin.saveSettings();
                                // 移除 this.display()，避免输入时折叠
                            });
                        });
                    
                    new Setting(mappingEditDiv).addButton(button => {
                        button.setButtonText("删除此映射").onClick(async () => {
                            this.plugin.settings.blogs[blogIndex].pathMappings.splice(mappingIndex, 1);
                            await this.plugin.saveSettings();
                            this.display();
                        });
                    });
                });
            }

            new Setting(advancedSettingsDiv).addButton(button => {
                button.setButtonText("+ 添加路径映射").setCta().onClick(async () => {
                    if (!this.plugin.settings.blogs[blogIndex].pathMappings) {
                        this.plugin.settings.blogs[blogIndex].pathMappings = [];
                    }
                    this.plugin.settings.blogs[blogIndex].pathMappings.push({
                        source: "",
                        target: "",
                        enableFolderMatching: false,
                    });
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

            new Setting(advancedSettingsDiv).addButton(button => {
                button.setButtonText("删除此博客").onClick(async () => {
                    this.plugin.settings.blogs.splice(blogIndex, 1);
                    await this.plugin.saveSettings();
                    this.display();
                });
            });
        });
    }
}