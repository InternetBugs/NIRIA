# NIRIA 开发交接

## 2026 年 11 月 15 日：上传 main 后的交接

本节为最新接续入口。酥鱼要求“先把目前的进度上传到 github 仓库的 main 分支，然后写交接日志”。已先提交并推送源码，再写本节；以下较早各节中的“未提交、推送”均描述当时的历史状态。

- 仓库：`InternetBugs/NIRIA`，分支：`main`。
- 源码检查点：`e16d8402a1aafd021b498d4f6540c56a396e2372`，标题为 `Advance NIRIA development preview to 0.31.0`，提交时间为 2026-11-15 00:28:06（Asia/Taipei）。推送后已用远端 `refs/heads/main` 读回核对。
- 该检查点承接原 `a8b5bcb`，共 74 个文件变更，包含 0.21 至 0.31 的源码、测试、构建脚本及文档进度。本节随后随独立文档提交上传，继续保留源码检查点便于定位。
- 当前源码：**0.31.0 开发预览**。最近实际安装验收的本机包：**0.30.0**。0.31.0 尚未打包，也未完成完整桌面与安装验收；完整首版继续以 [需求基线](requirements.md) 为准。
- SQLite schema 仍为 **3**，加密备份和同步 envelope 仍为 **v1**。新回复的记忆引用增加可选 `contentHash`；旧客户端不执行本轮引用保护，参与设备应统一升级到包含修复的版本。

### 已上传的主要进度

记忆检索已使用进程内话题索引和按需候选选取；形象采用、图片、朗读、聊天、同步及备份补齐取消、故障和过时结果保护；凭据损坏时独立降级，保存失败保留原会话和恢复信息。另补齐 Windows 唤醒及显示器变化恢复、离线构建与 NSIS 完整性核对。

0.31.0 修复了较晚助手回复及其衍生记忆重新带入已纠正、失效、删除、遗忘或撤权正文的问题。依据明确记忆引用、来源和回复关系处理；模型与同步权限独立，同一原消息中其他直接整理的事实仍保留各自权限。没有扩大已经确认的物理删除清单。

### 当前证据及适用范围

| 检查 | 结果与边界 |
| --- | --- |
| Node 与语法 | 410 项测试通过，139 个 JavaScript 文件语法通过；检查时本机具有可选 SDK。上传前再次核对运行文件及证据哈希，本次 Git 操作没有重跑整套测试。 |
| 本机 Magpie 网关 | 0.1.4174，`http://127.0.0.1:3425/v1`；累计七次合成资料请求，覆盖连接、聊天、整理、独立重开后换路由回忆、纠正及撤权。首次标注合成来源的整理返回合法空数组，未达预期，失败记录保留。没有自动重试；上游身份、费用、语音和图片尚未验证。 |
| 已连接的 Magpie 浏览器 | 六个未修改的共享检查器共 91 项结果通过：画布 10、记忆浏览 16、发送范围/草稿 20、重生成 10、主动关心 14、Live2D 导入及降级 21。纯内存合成资料，未增加真实网关请求；不含窄屏、原生下载及其他完整浏览器流程。 |
| 真实旧库的核心检查 | 真实 0.7.0/0.14.0 资料的迁移、旧加密备份恢复、真实旧代码拒绝新库、独立 Node 进程重开共六阶段通过；原始输入哈希未变。没有在本轮启动 Electron，不能替代完整桌面升级验收。 |
| 完整浏览器与原生桌面 | 0.31.0 完整浏览器回归在 Edge `CDP timeout: Runtime.enable` 失败；沙箱外重跑被自动审批拒绝，理由是当前策略不允许该执行方式，未执行。0.31 的完整 Electron、原生窗口、升级显示、包及安装验收仍待允许的执行环境。 |
| 最近安装包 | 本机 `release/NIRIA Setup 0.30.0.exe`，121,635,651 字节，SHA-256：`EAB03174DF4821E3B675B80E91F794BA4E89D908A349911EFFBFC7BC92A47498`。此前实际安装验收 11 阶段通过，测试安装已清理；不含 0.31 的修复。 |
| 无 SDK 的干净源码 | 最近完整隔离副本为 0.30.0，独立缓存安装依赖后 389 项通过、2 项 SDK 专属检查跳过，136 文件语法、完整浏览器及 Electron 通过。不能记作 0.31.0 已重跑。 |

### 仅在本机保留的材料

`artifacts/`、`release/`、`.niria/`、依赖、数据库、备份、凭据、SDK 和模型均未加入本次提交。163 个 Git 索引文件的路径检查及凭据模式扫描未发现待处理问题；一处 `example.com` 的带密码 URL 为与原远端提交完全相同的接口拒绝测试夹具。这是提交范围核对，不等同独立安全审查。

以下证据都被 Git 忽略，新克隆仓库不包含它们：

- 当前汇总：`artifacts/source-0.31.json`；Node/语法日志：`artifacts/node-tests-memory-context.log`、`artifacts/check-memory-context.log`。
- Magpie 网关：`artifacts/magpie-chat-acceptance-1794668570091/`、`artifacts/magpie-memory-context-0.31/`；发送范围观察为后者的 `preview-ui.json`。
- 六组共享界面结果及清理观察：`artifacts/connected-browser-0.31-1794671814581/`。
- 当前核心旧库检查：`artifacts/legacy-storage-0.31-mMPkSP/`；原始入口仍为 `artifacts/storage-upgrade-fixture.json`、`artifacts/storage-v2-upgrade-fixture.json`。不要用当前代码重新生成“旧版”夹具。
- 最近包及安装验收：`artifacts/release-0.30.json`、`artifacts/installer-smoke-ea747214030c457fb458a3f46257e592/`。官方 SDK、Haru 和本机开发包只供此前本机验证，发行条件未解决。

所有本轮临时浏览器标签和服务均已结束，没有为交接保留后台进程。

### 下一次接续

1. 先读取本节及 [开发状态](development-status.md)、[配置与兼容清单](compatibility.md)，确认源码与受测版本。当前开发目标因执行环境及真实验收条件受阻，本次上传不表示首版完成。
2. 在允许原生桌面测试的环境补齐 0.31.0 的完整浏览器、Electron、真实旧库桌面显示/重开，再构建与核对新包、执行实际安装验收。保留现有失败记录，不重试已被拒绝的沙箱外执行方式。
3. 用户已将真实立绘与付费图片验收后移，保留对应首版目标，不自动提交图片请求。实际语音、表情选择、长期模型行为与费用仍需分别验收，不能由文本接口成功推定。
4. 实际 Nextcloud、两台实体 Windows、网络切换、休眠、多屏/DPI/GPU 和长期使用仍需真实条件。不要擅自部署服务器、搜索账号或更改设备。
5. 项目许可证、Live2D 发行许可、独立安全审查、签名和正式发布仍未完成；本次只上传开发源码与交接，不创建安装包发行、标签或 Releases。

下面保留开发过程的原始记录；发生冲突时，以本节的源码位置、版本区分和验收边界为接续依据。

## 2026 年 11 月 14 日源码 0.31.0：历史引用保护

当前源码为 **0.31.0**，最近实际安装验收的包仍是 **0.30.0**，不含本轮修复。先用本机 Magpie 另一条 `auto/gpt-5.6-sol` 路由实际回忆两条已有记忆，预览与实际引用、身份和记忆摘要一致。接着在该真实回复上复现缺口：记忆撤权、纠正或遗忘后，较晚助手回复仍可能引用旧事实并进入后续请求。

已沿显式记忆引用、来源与回复关系补齐排除和衍生停用。模型与同步权限独立；同一原消息中其他直接整理的事实继续保留单条权限。新引用增加正文 `contentHash`，元数据修改不误停用正文未变的引用；旧引用保守核对原摘要/修订。数据库仍 v3，备份/同步仍 v1，所有参与设备需统一升级。模型上下文排除没有扩大用户已确认的物理删除清单。

新增 **19 项**，最初 14 项在旧实现全部失败，证据为 `artifacts/memory-context-before-final.log`；源码全套 **410 项通过**、**139 文件语法通过**。修复后经 Magpie 两次实际请求验证纠正与撤权，连同换路由和前轮累计七次，均为合成资料且没有自动重试。证据为 `artifacts/magpie-chat-acceptance-1794668570091/model-switch.json`、`artifacts/magpie-memory-context-0.31/correction.json` 和 `permission.json`。

完整自动浏览器回归在 Edge `Runtime.enable` 超时；请求沙箱外重跑被自动审批拒绝，未执行。已连接的 Magpie 浏览器先完成纯内存合成资料的发送范围检查，旧偏好被排除、独立书店事实保留；随后复用六个未修改的共享检查器，画布、记忆浏览、发送范围/草稿、重生成、主动关心及 Live2D 导入共 **91 项结果通过**。结果为 `artifacts/connected-browser-0.31-1794671814581/result.json`，同目录保存工具观察、清理结果及受测时原源码汇总；没有增加真实网关请求。自建标签及临时服务均已结束。

2026 年 11 月 15 日再以独立 Node 进程检查保留的真实 0.7.0/0.14.0 旧库，核心迁移、旧加密备份恢复、真实旧代码拒绝新库和再次重开共六阶段通过，完整状态、同步元数据、权限及删除均保留，原始输入哈希不变，见 `artifacts/legacy-storage-0.31-mMPkSP/result.json`。没有重建旧夹具或启动 Electron。

六组界面检查没有覆盖窄屏、原生下载等完整浏览器流程，核心迁移检查也不能代替 Electron 中的旧库显示、窗口及安装验收。0.31.0 尚未打包；下一步需在允许的环境完成这些检查，之后再构建和实际验收新包。源码汇总 `artifacts/source-0.31.json`；没有提交、推送或发布。真实立绘与付费图片继续后移，首版其他真实服务、设备与发行许可待办仍保留。

## 2026 年 11 月 14 日本机 Magpie 对话检查

用户提出使用本机 Magpie。运行中网关为 0.1.4174，对话根地址 `http://127.0.0.1:3425/v1`，本次未提供额外 API 密钥。生产适配器使用 `auto/gpt-6.1-sol` 共提交四次请求：连接、短聊天、两次整理。连接及中文聊天通过；标注“合成资料”的首次整理返回合法空数组，未达到测试预期，失败保留。普通事实陈述的新整理产生两条带来源修订和哈希的待确认记忆。

确认后另一个 Node 进程重开隔离 SQLite，完整状态、身份和记忆一致；原消息移出最近上下文后，本地召回仍包含两条事实。本节与原四次请求汇总记录的是当时只配置、尚未调用 `auto/gpt-5.6-sol` 的阶段；后续真实换路由回复和修复后的检查见上方 0.31.0 节，不倒填原始结果。汇总 `artifacts/magpie-chat-acceptance-1794668570091/result.json`；独立连接记录 `artifacts/magpie-chat-smoke-1794668570091/result.json`。数据全部合成，这四次检查期间没有更改运行代码、重建安装包、提交或推送。没有验证上游模型身份、费用、朗读、图片或长期行为；真实立绘与付费图片继续后移。

## 2026 年 11 月 14 日继续本地开发至 0.30.0

当前源码及最近构建且实际安装验收的本机包均为 **0.30.0 开发预览**，位置为 `release/NIRIA Setup 0.30.0.exe`，目录版为 `release/win-unpacked/NIRIA.exe`。真实立绘和付费图片服务验收按用户选择后移，继续本地开发，首版目标不删除。

本轮把完整排序全部记忆改为按优先堆取出所需候选。相关性和词频、确认/时间/ID 排序、同序 ID 的原位置、空正文、字数与权限规则保持原结果；长度计数让剩余预算放不下任何条目时直接结束。新增两项差分检查覆盖 2,048 个候选与条数/字数边界；定向 21 项、全套 **391 项测试**及 **138 文件语法检查**通过。完整浏览器与源码 Electron 回归、真实 0.7.0/0.14.0 旧库升级、降级阻止和重启通过，渲染错误为空。

`npm run test:recall` 另保留 0.29.0 索引完整排序的参考。20,000 条消息、4,000 条有来源记忆的单次本机合成诊断中，25 个预热样本整体中位数为旧完整排序 12.45 ms、当前 7.79 ms；每次选取相符，分词次数仍为 4,001。个别查询仍可能更慢，冷启动顺序不可比，不代表所有查询、真实用户历史或端到端聊天。来源、候选及完整内存状态仍有全量处理。

源码汇总为 `artifacts/source-0.30.json`；原始证据为 `artifacts/memory-ranking-targeted.log`、`artifacts/node-tests-memory-ranking.log`、`artifacts/check-memory-ranking.log`、`artifacts/companion-browser-memory-ranking.log`、`artifacts/desktop-memory-ranking.log`、`artifacts/recall-benchmark-1794665493494/result.json`。

随后使用四个已校验缓存离线构建 0.30.0，121,635,651 字节，SHA-256 为 `EAB03174DF4821E3B675B80E91F794BA4E89D908A349911EFFBFC7BC92A47498`，旁附 `.sha256`；111 个运行文件与当前受测源码完全一致，归档总 112 文件且集合相同，安装器载荷与目录版相符。安装器及原生卸载器 CRC 通过；包内 Haru 双窗口、备份/本机 WebDAV 恢复和 SQLite 重启通过。按既有授权完成实际 0.14→0.30 覆盖、资料迁移、安装后完整桌面回归、卸载保留、重装恢复和最终卸载，全 11 阶段通过。已安装程序核对发送范围与实际记忆选取、权限/纠正/删除排除以及重生成，渲染错误为空。独立复核确认测试系统状态已清理，卸载期间隔离资料库哈希不变。

包汇总为 `artifacts/release-0.30.json`，实际结果为 `artifacts/installer-smoke-ea747214030c457fb458a3f46257e592/result.json`，同目录 `installed-regression.log` 为完整回归；另见 `artifacts/installer-acceptance-0.30.log`、`artifacts/installer-postflight-0.30.json`、`artifacts/desktop-live2d-real-0.30.log`、`artifacts/package-audit-0.30.json`、`artifacts/installer-payload-0.30.json`。未提交、推送或发布；SDK 仅供本机验证，模型未打包，发行许可仍未取得。0.29.0 等历史包及其证据保留，各自只证明受测版本；该次包构建时未重跑无 SDK 隔离副本，后续更新见下文，外部服务或实体设备验收仍待执行。

随后完成 0.30.0 无 SDK 隔离源码及独立依赖安装。先复现默认 npm 缓存缺包和 npm 12 拒绝 esbuild 跨仓库主机 tarball，再将锁文件 27 个镜像地址统一到 npm 官方仓库，版本、摘要和依赖关系不变。最终副本 `artifacts/public-source-0.30-OgGdGJ` 从既有摘要核验缓存以 `npm ci --offline` 新装 285 个包，不复用主工作区依赖；Electron 自身代码从校验缓存准备运行库，esbuild 实际转换通过。保留 npm 12 默认的两项脚本跳过策略；安装时拦截一次 npm 自身更新检查，没有外部下载。

该副本 Node 测试 389 通过、2 项 SDK 专属检查跳过，136 文件语法通过，完整伴侣浏览器通过。首次桌面焦点保持检查失败，原样完整重跑 14 阶段通过，渲染错误为空；原失败证据保留。162 个源码文件中 146 个代码/配置文件与工作区核对哈希。汇总 `artifacts/public-source-0.30.json`、安装证据 `artifacts/public-source-0.30-install.json`、锁文件修正 `artifacts/lock-registry-normalization-0.30.json`，原始日志为 `artifacts/public-source-0.30-*.log`。源码和包汇总已更新，包在锁文件修正后重新核对相符且未重建，见 `artifacts/package-audit-0.30-after-lock.json`。空缓存在线安装、其他 Node/npm、从新依赖目录构建包和真实服务/实体设备未验证，首版待办继续保留。

## 2026 年 11 月 14 日继续本地开发至 0.29.0

用户选择将真实立绘和付费图片服务验收后移，继续本地开发；这不删除首版对应验收要求，也不代表真实质量和费用已经通过。当前源码及最近安装验收过的本机包均为 **0.29.0 开发预览**，位置为 `release/NIRIA Setup 0.29.0.exe`，目录版为 `release/win-unpacked/NIRIA.exe`。

本轮修复显示器参数变化时无必要的还原/最大化切换、恢复事件重入和中间布局写入，接入系统唤醒后的延迟位置检查。隐藏小窗恢复位置但不显示或抢焦点；收起、置顶、最小化和全屏状态保留，恢复或退出全屏后再检查边界。新增 8 项窗口生命周期测试，旧实现 4 项失败，修复后全套 **389 项测试通过**、**138 文件语法检查通过**。真实 Electron 全套源码回归、0.7.0/0.14.0 旧库升级、降级阻止和重启通过；新增模拟唤醒事件在真实窗口上检查最大化无切换及隐藏小窗恢复，渲染错误为空。没有让系统实际休眠，也没有完成实体多屏长期验收。

源码证据为 `artifacts/window-layout-before.log`、`artifacts/window-layout-targeted.log`、`artifacts/node-tests-window-recovery.log`、`artifacts/check-window-recovery.log`、`artifacts/desktop-window-recovery.log`，汇总为 `artifacts/source-0.29.json`。

随后用四个已校验缓存离线构建 0.29.0，121,635,314 字节，SHA-256 为 `0E95BEE6593AE1EBC57EE68EA78E99AF403404A6B10F4D79D77F7D4B133B893C`，旁附 `.sha256`；111 个运行文件与源码完全一致，归档总 112 文件且集合相同，安装器载荷与目录版相符。原生卸载器及 CRC 校验通过，包内 Haru 双窗口、备份/本机 WebDAV 恢复和重启通过。按既有授权完成实际 0.14→0.29 覆盖、资料迁移、安装后完整回归、卸载保留、重装恢复和最终卸载，全 11 阶段通过。独立复核确认测试注册、进程、快捷方式、目录及哨兵清理完毕，资料库在两次卸载期间哈希不变。

包汇总为 `artifacts/release-0.29.json`，实际结果为 `artifacts/installer-smoke-3cf03f91b8584fb0b8d1f22b27a404f7/result.json`，该目录下 `installed-regression.log` 为完整桌面回归；另见 `artifacts/installer-acceptance-0.29.log`、`artifacts/installer-postflight-0.29.json`、`artifacts/desktop-live2d-real-0.29.log`、`artifacts/package-audit-0.29.json` 和 `artifacts/installer-payload-0.29.json`。未提交、推送或发布；SDK 仅供本机验证，模型未打包，发行许可仍未取得。以下 0.28.0 包、安装验收和无 SDK 副本的证据属于各自受测版本，不能当成 0.29.0 包内验证；0.29.0 的无 SDK 隔离副本本轮未重跑。

## 2026 年 11 月 14 日恢复开发至 0.28.0

用户已明确要求“继续之前收工的地方接着写”。恢复开发先推进至 **0.28.0 开发预览**。该轮补齐凭据库损坏/不可用时的独立降级，以及配置安全保存成功后再切换连接，失败时保留原会话和待确认换钥信息。此前的检索索引、图片跨窗口采用保护、可取消动作预览、图片/朗读/聊天/同步的调用生命周期，以及备份导出/恢复的确认与取消继续保留。`npm test` 限定仓库测试；浏览器入口包含 `--avatar-safety`、`--image-calls`、`--speech-safety`、`--chat-faults`、`--sync-safety`、`--backup-safety`、`--credential-safety`，另有 `npm run test:recall`。权限/遗忘规则继续生效；索引和恢复标记不进入数据库，调用日志不进入备份或同步，存储版本仍为 3，备份/同步 envelope 仍为 v1。旧应用不能读取含新图片调用类型的本机数据库，使用前需升级。

源码 `npm test` **381 项通过**，**137 文件语法检查通过**。新增 9 项凭据生命周期测试、14 项共用故障界面检查，以及 Electron 中实际损坏凭据文件的启动/重启，均通过；原坏文件逐字节保留，伴侣、历史和记忆不变。安装器修复另增 8 项 NSIS 完整性测试。最新 Node/语法证据为 `artifacts/node-tests-uninstaller-fixed.log`、`artifacts/check-uninstaller-fixed.log`。源码及包内完整回归、实际 0.7.0/0.14.0 旧库升级与重启通过，渲染错误为空，证据为 `artifacts/desktop-credential-safety.log`、`artifacts/desktop-packaged-0.28-verified.log`，汇总为 `artifacts/source-0.28.json`。真实 Haru 检查首次固定 700 毫秒采样失败，改为有界观察实际像素变化后，源码及重建包均通过，原失败和初次包证据保留。新恢复 HTTP 请求仍需当前 `backup.basis` 作为 `expectedBasis`；v1 备份文件不变。此前的故障检查均继续运行，未调用真实模型或 Nextcloud。

最近本机包为 **0.28.0**，位置 `release/NIRIA Setup 0.28.0.exe`（121,634,875 字节），目录版 `release/win-unpacked/NIRIA.exe`。仅使用四个已校验的本机缓存离线构建，未下载工具；构建时运行原生 NSIS 辅助程序，在 `artifacts/` 中生成并保存卸载器，核对安装器与卸载器 CRC。111 个运行文件与当前源码逐字节一致、归档共 112 文件且集合相符，安装包内归档、可执行文件及运行时许可与受测目录版哈希一致；应用归档与此前真实 Haru 验收时相同。实际安装后完整桌面回归、覆盖迁移、卸载保留、重装恢复和最终清理通过。SDK 仅用于本机验证，Haru 模型未打包，没有签名、上传、发布、提交或推送；公开仓库中的原提交也不自动代表当前本机改动已上传。原 0.25.0/0.27.0 安装包保留为尚未实际安装验收的历史证据。

当前 0.28.0 的无 SDK 隔离源码副本也已验证，共 161 文件，不含真实模型、用户资料、凭据、依赖和构建产物；145 个代码/配置文件核对哈希一致。Node 测试 379 通过、2 项官方 SDK 专属检查跳过，135 文件语法通过；完整伴侣浏览器及 Electron 14 阶段通过，渲染错误为空。汇总为 `artifacts/public-source-0.28.json`，原始日志为 `artifacts/public-source-0.28-*.log`，更新了此前仅属于 0.20.0 的无 SDK 证据。本次复用已有开发依赖，没有重新安装依赖，不包含真实 SDK、旧库升级或真实服务/实体双设备验收。

重建可用 `node scripts/build-offline.mjs`，依赖当前固定构建器内部 API，缓存缺失或校验失败即停止；随后运行 `node scripts/verify-package.mjs`、`node scripts/verify-installer-payload.mjs` 及包内回归。最新证据为 `artifacts/release-0.28.json`，SHA-256 为 `4F9F9348A61B8FB5B7C0E0F3C0D94A420B01D742129089ED1EC0C604392121C6`，安装包旁附 `.sha256`。

用户于 2026-11-14 明确授权继续实际安装验收。首次运行发现旧离线脚本直接提取的卸载器 CRC 不匹配，卸载退出码 2；原失败包与诊断保存在 `artifacts/installer-0.28-uninstaller-crc-failed/`、`artifacts/uninstaller-crc-0.28.json`。用同版本原生卸载器成功清理失败安装，数据库未变。修复后从 0.14.0 安装重新开始，全 11 阶段通过，结果为 `artifacts/installer-smoke-5d7af2aa43a3416cb9ee4d0677eda484/result.json`，日志为 `artifacts/installer-acceptance-0.28-verified.log`。独立复核见 `artifacts/installer-postflight-0.28.json`：测试安装目录、注册、快捷方式、哨兵及 NIRIA 进程已清理；项目内隔离资料和失败证据保留。此项仅覆盖本机当前用户、中文及空格路径，不覆盖所有用户安装或其他 Windows 环境。

完整首版继续进行，六项验收对照见 [开发状态](development-status.md)。真实模型与立绘质量、实际 Nextcloud、实体双 Windows、长期体验与许可/发行未完成。2026-11-14 只读确认 Debian 为 Stopped，未启动发行版或部署 Nextcloud；后续真实服务与实体设备验收仍缺输入。以下为 **0.20.0 停工时的原始交接记录**，其中“当前停止”“以后明确恢复”等描述属于停工时的历史状态，已由本节的恢复要求更新。

## 0.20.0 原始停工记录

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
