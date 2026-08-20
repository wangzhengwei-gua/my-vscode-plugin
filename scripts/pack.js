#!/usr/bin/env node
/**
 * 简易 .vsix 打包工具（不依赖 vsce，避免 undici 兼容问题）
 * .vsix 本质是 OPC zip：包含 [Content_Types].xml、extension/ 目录、extension.vsixmanifest
 *
 * 用法: node pack.js
 * 输出: ../my-vscode-plugin-<version>.vsix
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8'));
const version = packageJson.version;
const name = packageJson.name;
const publisher = packageJson.publisher;
const displayName = packageJson.displayName || name;
const description = packageJson.description || '';
const outputVsix = path.join(PROJECT_DIR, `${name}-${version}.vsix`);

// 读取 .vscodeignore
const ignoreFile = path.join(PROJECT_DIR, '.vscodeignore');
const ignorePatterns = [];
if (fs.existsSync(ignoreFile)) {
    fs.readFileSync(ignoreFile, 'utf-8').split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) ignorePatterns.push(line);
    });
}
// 默认忽略
ignorePatterns.push('.git/**', '.vsix', '*.vsix', 'pack.js', 'node_modules/**');

console.log('打包中...');
console.log('  插件:', displayName, 'v' + version);
console.log('  发布者:', publisher);

// 创建临时目录
const tmpDir = path.join(PROJECT_DIR, '_vsix_tmp');
if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
}
fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });

// 复制文件到 extension/ 目录（按 .vscodeignore 过滤）
function matchIgnore(relPath) {
    // 统一用正斜杠
    const normPath = relPath.replace(/\\/g, '/');
    // 硬编码忽略 node_modules（最重要）
    if (normPath === 'node_modules' || normPath.startsWith('node_modules/')) return true;
    if (normPath === 'data' || normPath.startsWith('data/')) return true;
    if (normPath === '.git' || normPath.startsWith('.git/')) return true;
    for (const p of ignorePatterns) {
        if (p === 'node_modules/**' || p === 'data/**') continue; // 已硬编码
        // glob 转正则
        let regex = p
            .replace(/\.\*/g, '\\.*')  // 先转义已有的 .*
            .replace(/\*\*/g, '##STARSTAR##')
            .replace(/\*/g, '[^/]*')
            .replace(/##STARSTAR##/g, '.*')
            .replace(/\?/g, '[^/]')
            .replace(/\./g, '\\.');
        // 路径分隔符兼容
        regex = regex.replace(/\//g, '[\\\\/]');
        if (new RegExp('^' + regex).test(normPath)) return true;
    }
    return false;
}

function copyDir(src, dest, relBase) {
    const items = fs.readdirSync(src, { withFileTypes: true });
    for (const item of items) {
        const srcPath = path.join(src, item.name);
        const relPath = relBase ? relBase + '/' + item.name : item.name;
        // 硬编码跳过大目录（不依赖 glob 匹配）
        // 注：scripts/ 下有 ml_compare.py 等运行时依赖文件，不能整体跳过
        const skipDirs = ['node_modules', 'data', '.git', '.vscode', '.vscode-test', '_vsix_tmp'];
        if (!relBase && skipDirs.indexOf(item.name) !== -1) continue;
        // 硬编码跳过 .vsix 文件
        if (item.name.endsWith('.vsix')) continue;
        if (item.name === 'package-lock.json') continue;
        if (matchIgnore(relPath)) continue;
        const destPath = path.join(dest, item.name);
        if (item.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyDir(srcPath, destPath, relPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDir(PROJECT_DIR, path.join(tmpDir, 'extension'), '');
console.log('  文件复制完成');

// 创建 [Content_Types].xml
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="vsixmanifest" ContentType="text/xml"/>
    <Default Extension="json" ContentType="application/json"/>
    <Default Extension="js" ContentType="text/javascript"/>
    <Default Extension="md" ContentType="text/markdown"/>
    <Default Extension="png" ContentType="image/png"/>
    <Default Extension="txt" ContentType="text/plain"/>
    <Default Extension="ps1" ContentType="text/plain"/>
    <Default Extension="toml" ContentType="text/plain"/>
    <Default Extension="jsonc" ContentType="application/json"/>
</Types>`;
fs.writeFileSync(path.join(tmpDir, '[Content_Types].xml'), contentTypes);

// 创建 extension.vsixmanifest
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
    <Metadata>
        <Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}" />
        <DisplayName>${displayName}</DisplayName>
        <Description xml:space="preserve">${description}</Description>
        <Tags>lottery,trend,chart,dlt,ssq,pl3,pl5</Tags>
        <Categories>Other</Categories>
        <GalleryFlags>Public</GalleryFlags>
        <Properties>
            <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${packageJson.engines.vscode}" />
            <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
            <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
            <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
            <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
        </Properties>
        <Icon>extension/images/icon.png</Icon>
    </Metadata>
    <Installation>
        <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
    </Installation>
    <Dependencies/>
    <Assets>
        <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
        <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true" />
    </Assets>
</PackageManifest>`;
fs.writeFileSync(path.join(tmpDir, 'extension.vsixmanifest'), manifest);

// 打成 zip（用 PowerShell 的 Compress-Archive）
console.log('  压缩中...');
// 先把 tmpDir 内容打成 zip
const zipTmp = path.join(PROJECT_DIR, '_vsix_tmp.zip');
if (fs.existsSync(zipTmp)) fs.unlinkSync(zipTmp);

// PowerShell Compress-Archive
execSync(`powershell -Command "Compress-Archive -Path '${tmpDir}/*' -DestinationPath '${zipTmp}' -Force"`, { stdio: 'inherit' });

// 重命名为 .vsix
if (fs.existsSync(outputVsix)) fs.unlinkSync(outputVsix);
fs.renameSync(zipTmp, outputVsix);

// 清理临时目录
fs.rmSync(tmpDir, { recursive: true });

console.log('');
console.log('✅ 打包完成！');
console.log('  输出文件:', outputVsix);
console.log('');
console.log('安装方法:');
console.log('  方式1（命令行）: code --install-extension "' + outputVsix + '"');
console.log('  方式2（VSCode）: Ctrl+Shift+P → Extensions: Install from VSIX → 选择该文件');
