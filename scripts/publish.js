#!/usr/bin/env node
/**
 * 一键发布脚本
 *
 * 功能：
 *   1. 读取 package.json 版本号
 *   2. 调用 pack.js 打包 vsix
 *   3. 调用 code --install-extension 安装到 VSCode
 *   4. 更新 .gitignore 的 vsix 例外规则（只保留最新版本）
 *   5. 删除旧的 vsix 文件（本地 + Git 跟踪的）
 *   6. git add + commit + push
 *
 * 用法:
 *   node scripts/publish.js          # 打包+安装+提交推送
 *   node scripts/publish.js --no-install   # 不安装，只打包+提交推送
 *   node scripts/publish.js --no-push      # 不推送，只本地提交
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(PROJECT_DIR, 'package.json');
const GITIGNORE = path.join(PROJECT_DIR, '.gitignore');
const PACK_SCRIPT = path.join(__dirname, 'pack.js');

// 读取版本号
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
const version = packageJson.version;
const name = packageJson.name;
const newVsixName = `${name}-${version}.vsix`;
const newVsixPath = path.join(PROJECT_DIR, newVsixName);

console.log('========================================');
console.log('  一键发布 - v' + version);
console.log('========================================');
console.log('');

// 解析参数
const args = process.argv.slice(2);
const noInstall = args.includes('--no-install');
const noPush = args.includes('--no-push');

// 1. 打包
console.log('📦 [1/5] 打包 vsix...');
try {
    execSync(`node "${PACK_SCRIPT}"`, { stdio: 'inherit', cwd: PROJECT_DIR });
} catch (e) {
    console.error('❌ 打包失败');
    process.exit(1);
}

if (!fs.existsSync(newVsixPath)) {
    console.error('❌ 打包后未找到 vsix 文件:', newVsixPath);
    process.exit(1);
}
console.log('✅ 打包完成:', newVsixName);
console.log('');

// 2. 安装到 VSCode
if (!noInstall) {
    console.log('🔌 [2/5] 安装到 VSCode...');
    try {
        execSync(`code --install-extension "${newVsixPath}" --force`, { stdio: 'inherit' });
        console.log('✅ 安装完成');
    } catch (e) {
        console.error('⚠️ 安装失败（不影响后续步骤）:', e.message);
    }
} else {
    console.log('⏭️ [2/5] 跳过安装（--no-install）');
}
console.log('');

// 3. 更新 .gitignore：只保留最新 vsix
console.log('📝 [3/5] 更新 .gitignore...');
let gitignoreContent = fs.readFileSync(GITIGNORE, 'utf-8');

// 移除旧的 !my-vscode-plugin-*.vsix 例外行
const lines = gitignoreContent.split('\n');
const filteredLines = lines.filter(line => {
    const trimmed = line.trim();
    // 保留注释行和 *.vsix 规则
    if (trimmed.startsWith('#')) return true;
    if (trimmed === '*.vsix') return true;
    if (trimmed.startsWith('_vsix_tmp')) return true;
    // 删掉旧的 !xxx.vsix 例外
    if (trimmed.match(/^!.*\.vsix$/)) return false;
    // 其他行保留
    return true;
});

// 在 *.vsix 后面插入新的例外
const newLines = [];
for (const line of filteredLines) {
    newLines.push(line);
    if (line.trim() === '*.vsix') {
        newLines.push('# 最新版本安装包（由 publish.js 自动维护）');
        newLines.push(`!${newVsixName}`);
    }
}

fs.writeFileSync(GITIGNORE, newLines.join('\n'), 'utf-8');
console.log('✅ .gitignore 已更新，例外:', newVsixName);
console.log('');

// 4. 删除旧的 vsix 文件（保留新的）
console.log('🧹 [4/5] 清理旧 vsix...');
const allFiles = fs.readdirSync(PROJECT_DIR);
const oldVsixFiles = allFiles.filter(f => f.endsWith('.vsix') && f !== newVsixName);

// 从文件系统删除旧 vsix
for (const f of oldVsixFiles) {
    const fp = path.join(PROJECT_DIR, f);
    try {
        fs.unlinkSync(fp);
        console.log('  删除:', f);
    } catch (e) {
        console.log('  删除失败:', f, e.message);
    }
}

// 从 Git 中移除旧 vsix（git rm --cached）
if (oldVsixFiles.length > 0) {
    try {
        const rmCmd = `git rm --cached ${oldVsixFiles.map(f => `"${f}"`).join(' ')}`;
        execSync(rmCmd, { cwd: PROJECT_DIR, stdio: 'pipe' });
        console.log('  已从 Git 移除旧 vsix');
    } catch (e) {
        // 可能旧 vsix 没被 Git 跟踪，忽略
    }
}
console.log('✅ 清理完成');
console.log('');

// 5. Git 提交推送
console.log('📤 [5/5] Git 提交推送...');
try {
    // git add
    execSync('git add .gitignore', { cwd: PROJECT_DIR, stdio: 'pipe' });
    // 添加新 vsix（如果还没被跟踪）
    try {
        execSync(`git add "${newVsixName}"`, { cwd: PROJECT_DIR, stdio: 'pipe' });
    } catch (e) { /* 可能已暂存 */ }
    // 添加其他改动（如 package.json, src/ 等）
    execSync('git add -A', { cwd: PROJECT_DIR, stdio: 'pipe' });

    // 检查是否有改动
    const status = execSync('git status --short', { cwd: PROJECT_DIR, encoding: 'utf-8' });
    if (!status.trim()) {
        console.log('ℹ️  没有改动需要提交');
    } else {
        // 提交
        execSync(`git commit -m "release: v${version}"`, { cwd: PROJECT_DIR, stdio: 'pipe' });
        console.log('✅ 已提交: release: v' + version);

        // 推送
        if (!noPush) {
            try {
                execSync('git push', { cwd: PROJECT_DIR, stdio: 'inherit' });
                console.log('✅ 已推送到远程');
            } catch (e) {
                console.error('⚠️ 推送失败（网络问题？）:', e.message);
                console.log('   稍后可手动执行: git push');
            }
        } else {
            console.log('⏭️ 跳过推送（--no-push）');
        }
    }
} catch (e) {
    console.error('❌ Git 操作失败:', e.message);
}

console.log('');
console.log('========================================');
console.log('  ✅ 发布完成! v' + version);
console.log('========================================');
console.log('');
console.log('请重新加载 VSCode 窗口使新版本生效:');
console.log('  Ctrl+Shift+P → Reload Window');
