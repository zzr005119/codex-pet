# 构建与维护

## 构建与安装

需要 Windows x64、Codex 桌面版和 Node.js 24。以下命令从仓库根目录运行。若已经有本地 `install/`，请保留它，并在另一份检出中执行首次安装。

1. 从 [Electron v43.3.0](https://github.com/electron/electron/releases/tag/v43.3.0) 下载 `electron-v43.3.0-win32-x64.zip` 到仓库根目录。可用 `Get-FileHash .\electron-v43.3.0-win32-x64.zip` 对照同页的 `SHASUMS256.txt` 验证完整性。
2. 在 PowerShell 中运行：

```powershell
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath 'install') { throw 'install 已存在，请使用一份新的检出。' }
$node = (Get-Command node.exe -CommandType Application).Source
npm.cmd ci --prefix asar-tools --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw '安装打包工具失败。' }
New-Item -ItemType Directory -Path 'build' -Force | Out-Null
node asar-tools/node_modules/@electron/asar/bin/asar.mjs pack pet-app build/app.asar
if ($LASTEXITCODE -ne 0) { throw '打包失败。' }

Expand-Archive -LiteralPath 'electron-v43.3.0-win32-x64.zip' -DestinationPath 'install/app'
Rename-Item -LiteralPath 'install/app/electron.exe' -NewName 'dsh-pet.exe'
New-Item -ItemType Directory -Path 'install/bridge/runtime','install/data/dsh-pet' -Force | Out-Null
Copy-Item -LiteralPath 'build/app.asar' -Destination 'install/app/resources/app.asar'
Copy-Item -LiteralPath 'LICENSE','THIRD_PARTY_NOTICES.md' -Destination 'install/app'
Copy-Item -LiteralPath $node -Destination 'install/bridge/runtime/node.exe'
Copy-Item -LiteralPath 'codex-bridge/watch.mjs','codex-bridge/lifecycle.mjs','codex-bridge/probe.ps1','codex-bridge/start.vbs','codex-bridge/stop.vbs' -Destination 'install/bridge'
Copy-Item -LiteralPath 'codex-bridge/conversation.json' -Destination 'install/data'
Copy-Item -LiteralPath 'codex-bridge/main-config.jsonc' -Destination 'install/data/dsh-pet'
```

3. 双击 `install/bridge/start.vbs`，再启动 Codex 桌面版。双击 `install/bridge/stop.vbs` 可停止联动。若需要随 Windows 登录启动，可把 `start.vbs` 的快捷方式放进当前用户的启动目录（`Win+R` → `shell:startup`）。

## 目录与来源

| 路径 | 用途 |
| --- | --- |
| `pet-app/` | 解包的 Electron 应用、渲染器和素材，可直接重打包成 ASAR |
| `codex-bridge/` | 联动源码、配置样例和回归测试 |
| `asar-tools/` | ASAR 打包工具及锁文件 |
| `install/` | 本机安装及运行数据，包含日志、缓存和会话状态 |

上游为 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。本适配的底包来自 Windows 测试版 `v0.3.8-test.2`；上游 [v0.3.8 源码标签](https://github.com/PC2005-cloud/dsh-pet/tree/v0.3.8) 可供对照。桌面端另移植了[拖拽起手与松手偏移修复](https://github.com/PC2005-cloud/dsh-pet/commit/92521b74a13f7e480f7ec0fdc2fc1403eb9fb8e3)和[切屏后恢复角落位置修复](https://github.com/PC2005-cloud/dsh-pet/commit/29a5af50f60a63caeeace66a514f47ed3198d0fa)。

公开仓库不包含本机安装、备份、上游随包字体与表情包。缺少原字体时界面使用系统字体；缺少表情包不影响会话联动。代码与角色素材的许可见 [README](../README.md#来源与许可)。

## 接入原理

`watch.mjs` 跟踪 Windows 上的 Codex 桌面主进程，忽略渲染器、CLI 和其他子进程。它用当前 Codex 进程的启动时间筛选会话，由 `codex-integration.cjs` 从本机 JSONL 读取回合的生命周期标记和会话索引标题。

- `task_started` 表示运行，`task_complete` 表示完成（明确的结构化轮次错误表示失败），`turn_aborted` 表示停止。
- 原动画仍从本机的 `/work-status` 接口读取首条状态。活动列表经 Electron IPC 更新；点击列表项，通过 `codex://threads/<id>` 打开对应会话。
- 已读按会话和轮次保存。只有目标仍匹配且终态跳转请求已派发，才将该条标记为已读。

本项目依赖 Codex 桌面日志格式，未接入 Codex Hooks；仅在远端存在的会话可能不可见。

## 修改与验证

`codex-bridge/codex-integration.cjs` 是维护主本。修改后需先同步到 `pet-app/runtime/electron-helper/codex-integration.cjs` 再重打包。从仓库根目录运行：

```powershell
node --test 'codex-bridge/*.test.cjs' codex-bridge/lifecycle.test.mjs
```

本地安装组装好后，可以加上 `codex-bridge/installed-app.test.mjs` 运行 Electron 集成测试。用 `DSH_PET_TEST_APP` 指定候选 EXE 时，测试会用模拟宿主及独立的运行目录。

更新现有安装前，先运行停止脚本并备份 `install/app/resources/app.asar`，再替换为新的 ASAR。若改动联动器或启停脚本，同时更新 `install/bridge/` 中对应的文件。配置保存在 `install/data/`。遇到问题可恢复备份并重新启动。

- 没有条目：查看 `install/data/bridge.log`，确认已识别 Codex 主进程；再查看 `integration.log`、`session-status.json` 和 `conversation.json`。
- 完成后未清除：确认点击的是该终态对应的条目，再看 `integration.log`。删除 `acknowledged-status.json` 可能让旧提示重现。
