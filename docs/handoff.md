# NIRIA 停工交接

交接日期：2026-11-14（Asia/Taipei）。用户要求完成当前工作后停止开发，将代码上传公开仓库，其余留待以后继续。本次不继续扩展首版范围，不安排后台任务或自动续工。

## 交接状态

- 当前源码：**0.20.0 开发预览**。新增本机二次元人脸检查，完成公开源码缺少可选 SDK 时的启动处理。
- 最近构建且验证过的安装包：**0.19.0**，与当前源码不同。本轮没有重建安装包，没有运行安装器或卸载器。
- 当前存储 schema：**3**；完整加密备份和远端同步 envelope：**v1**。
- 完整首版尚未完成验收。公开仓库是开发源码交接，不是正式发行。
- 项目整体许可证仍待用户选择，未擅自采用 MIT 等许可证。第三方范围见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 产品方向

第一批用户是开发者本人和愿意配置服务的虚拟伴侣爱好者。Windows 优先，手机以后再做；默认一位长期日常伴侣，聊天、适度关心，不增加角色库、虚构剧情或角色扮演系统。

核心验收是跨设备持续的人格、共同经历和关系发展。角色设定与记忆由 NIRIA 管理，更换模型仍保留同一伴侣。本地保存是基础；同步可选，通过用户自己选择或搭建的第三方 WebDAV 服务，不由项目托管。

对话、图片、朗读、同步独立配置。用户提供模型连接。图片生成逐次确认付费请求，失败不自动重试。主动关心默认关闭，仅在应用运行期间执行，受静默时间、间隔和每日额度限制。更正、删除、遗忘和权限限制优先，不能从旧来源、备份或同步复活不应使用的资料。

## 已有实现

| 模块 | 当前能力 |
| --- | --- |
| Windows | Electron 主窗口、透明伴侣小窗、位置/大小/折叠偏好、减少动态效果 |
| 对话 | 用户配置 Chat Completions、发送范围预览、引用追溯、草稿保护、取消、成功后替换的重生成 |
| 记忆 | 本地保存、自动整理待确认、来源/期限/权限、纠正、遗忘、分页、文字检索 |
| 形象 | 单图、四种动作目标、逐次生成确认、人工采用、位置对齐、透明背景本机预览/恢复、聊天驱动表情 |
| Live2D | 用户模型目录导入、路径/资源检查、映射、真实预览后采用、主窗口/小窗播放、保存/备份/同步 |
| 同步 | 加密 WebDAV、条件更新、修订图、冲突选择、删除传播、换钥与中断恢复 |
| 本机安全 | 加密导出、凭据独立保存、可选 Windows 系统加密；普通伴侣 SQLite 仍未加密 |

Live2D 的真实播放已在 0.19.0 用官方 SDK 5 R5 和 Haru 本机验证，含动作像素、表情切回、减少动态效果、双窗口、重启、加密备份和本机 HTTP WebDAV 恢复。测试不证明所有用户模型兼容，不等同于实际 Nextcloud 或两台实体设备验收。

## 本轮收尾的改动

本机 animeface LBP 模型固定在 `4433ab1ae1166ea75acfe99eb0f18709dac329a0`，原 MIT 版权声明保留。最长边缩至 640，Worker 检查有 8 秒超时，最多 1000 原始候选，避免分组失控。单图与新生成素材检测到多张脸时拒绝；未检出、脸部过小或检查不可用时明确提示。

处理了快速换图、离开页面取消、旧素材包读取晚返回的情况。坏图、取消和旧结果不替换当前已采用形象。没有添加外部模型请求、付费自动重试或额外建模服务。

这只是二次元人脸检测，不是身体/人数/身份/遮挡识别，不能证明生成图像质量。没有 Worker 时有本机同步降级，CPU 扫描有输入和候选上限，但同步扫描无法中途抢占。更全面的语义检查留到以后。

公开源码排除 `prototype/public/vendor/live2d/` 整个生成目录。缺库或文件不完整时不阻止启动；模型检查仍可用，播放和采用明确禁用，采用 API 保留原形象。不会自动下载 SDK、模型或 CDN 脚本。

## 验证与证据

本轮验证命令、结果和环境记录见 [开发状态](development-status.md) 的 0.20.0 段。所有模型接口测试均使用本机替身，未使用用户服务凭据，未调用真实外部模型。

最终源码有 112 个 JavaScript 文件通过语法检查，263 项 Node 测试全部通过（明确限定仓库 `tests/`，避免重复发现隔离副本）。无 SDK 的干净公开源码副本有 261 项通过、2 项 SDK 专属测试明确跳过，无失败；其完整伴侣浏览器流程也通过。当前源码的真实 Worker 人脸检查、图片浏览器、完整伴侣浏览器和 Electron 全套回归均通过。两次桌面折叠失败已定位并修正，最终 `desktop-source-handoff-final.log` 通过，未运行 0.20.0 包内、旧库升级或真实 Live2D 模型专用回归。

重要本机记录（`artifacts/` 被 Git 忽略，云端没有这些文件）：

| 记录 | 用途 |
| --- | --- |
| `node-tests-handoff.log`、`check-handoff.log` | 本轮 Node 测试和语法检查 |
| `animeface-validation.log` | JavaScript 与独立 OpenCV 4.9.0 灰度结果比较 |
| `animeface-browser-handoff.log` | RGBA/PNG/真实 Worker、单脸/双脸/未检出、降级、取消、原图保留、旧包竞态 |
| `image-browser-handoff.log` | 图片完整浏览器回归 |
| `companion-browser-handoff.log` | 伴侣完整浏览器回归 |
| `desktop-source-handoff.log`、`desktop-source-handoff-retry.log`、`desktop-source-handoff-final.log` | 两次折叠失败、初始化修正后的最终整套通过 |
| `public-source-node-tests.log`、`public-source-browser.log` | 不含 SDK 和数据的干净公开源码副本验证 |
| `release-0.19.json`、`installer-payload-0.19.json` | 之前安装包与包内实际归档证据 |

0.19.0 安装包位于本机 `release/NIRIA Setup 0.19.0.exe`，121,565,470 字节，构建于 2026-11-14 01:18（Asia/Taipei），SHA-256：

```text
710C3CC00E8CF22F1C2DD591704866C29968C5C77E53D9B3AE01942429BB1FDF
```

当时验证 94 个运行文件与 0.19.0 源码一致、106 个 JavaScript 文件语法、260 项 Node 测试，以及包内完整回归、两种真实旧库升级、真实 Live2D 浏览器与包内重启。这些结果只属于该版本；0.20.0 没有包内验证结果。

## 从公开源码运行

需要 Node.js ≥22.13；本机实际验证版本为 26.13.0，尚未遍测全部支持版本。Windows 开发版固定 Electron 45.3.1、electron-builder 26.18.0、esbuild 0.28.2。首次安装依赖可能联网，不会自动发布应用。

```powershell
npm ci
npm run check
npm test
npm start
```

`npm start` 在本机启动浏览器预览服务，终端显示地址；使用 `npm run desktop` 启动 Electron。启动/配置本身不调用模型，主动“测试连接”才会请求服务。服务格式和配置步骤见 [兼容清单](compatibility.md)。

默认 Node 测试不需要真实模型、WebDAV 账号或用户数据。未安装 SDK 时，两个仅适用于官方 Core 的测试明确跳过；其余文件、资料、采用保护和缺库 API 行为继续检查。

可选回归：

```powershell
node scripts/browser-smoke.mjs
node scripts/browser-smoke.mjs --companion
node scripts/desktop-smoke.mjs
```

浏览器测试需要本机 Edge/Chromium，可用 `NIRIA_BROWSER` 指定可执行文件。测试启动隔离资料目录，产物写入 `artifacts/`。桌面回归会启动和退出独立 Electron 进程，窗口布局结果依赖实际桌面环境。

## 恢复 Live2D 本机开发环境

从 Live2D 官方自行取得 Cubism SDK for Web 5 R5，核对原包 SHA-256：

```text
67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0
```

不要把下载的 SDK 或测试模型提交到仓库。解压后准备本地组件并重启：

```powershell
node scripts/vendor-live2d.mjs "D:\SDK\CubismSdkForWeb-5-r.5"
npm test
node scripts/browser-smoke.mjs --live2d-real
node scripts/desktop-smoke.mjs --live2d-real
```

真实模型默认从本机 `artifacts/cubism-sdk-5-r5/CubismSdkForWeb-5-r.5/Samples/Resources/Haru` 读取，也可设置 `NIRIA_LIVE2D_MODEL_DIR`。离线脚本和许可边界见 [Live2D 文档](live2d.md)。Core 专有许可和可扩展应用发行许可未解决前，不发布含 SDK 的安装包。

人脸独立验证的 `artifacts/animeface-validation/` 含渲染测试灰度素材和 OpenCV 结果，不在公开仓库。若后续需要 `--faces` 和 `validate-animeface.mjs`，应使用有权使用的本机素材重新建立对照，不能把当前本机测试材料视为已随 Git 备份。

## 后续待办，当前停止执行

1. 用真实有权使用的立绘与用户选择的图片服务检查四种动作，验收身份、服装、位置及循环质量；真实聊天、语音表现也待验证。
2. 实际 Nextcloud 与两台实体 Windows 的配对、冲突、纠正、遗忘、恢复和长时间同步。
3. 长期陪伴体验、关心频率、多显示器、DPI、休眠恢复与不同 GPU/模型；持续观察窗口生命周期，本轮初始化时序回归已经修正并通过。
4. 安装、覆盖升级、卸载和重装。此前自动审批拒绝了注册表、快捷方式和安装目录的系统操作；尚未执行，需未来单独授权，不要因本次公开上传推定获准。
5. 大历史扩展：目前核心仍全量载入/比较内存状态，实体修订图整条保存，远端加密对象整包上传。尚无资产分块/增量、深层语义检索或分段管理。
6. 独立密码学/安全审查、真实兼容清单、正式项目许可证、Live2D 发行条件、代码签名与发布准备。
7. 手机端、多端真实体验及其他尚未验收的首版需求；以 [需求基线](requirements.md) 为准，不因本次停工缩小最终目标。

不要从当前代码重新生成“旧版本”升级夹具。本机保留的 `artifacts/storage-upgrade-fixture.json` 来自真实 0.7.0，`artifacts/storage-v2-upgrade-fixture.json` 来自真实 0.14.0/schema 2；相应旧运行代码、资料库和期望文件均留在本机，未上传。

没有创建定时任务，没有安装/卸载应用，没有替用户连接付费模型或申请第三方发行合同。下一次应从本文件和最新验证结果继续，由用户明确恢复开发。
