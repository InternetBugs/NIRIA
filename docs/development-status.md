# NIRIA 开发状态

记录时间：2026 年 11 月 15 日。当前源码为 **0.31.0 开发预览**，最近实际安装验收的本机包仍为 **0.30.0**，未包含本次引用保护。用户已明确要求从交接处恢复开发。首版仍以 [需求基线](requirements.md) 为准，以下进展不表示需求全部完成。接续入口为 [交接文档](handoff.md)。

## 0.31.0 源码：历史回复的记忆引用保护

续验本机 Magpie 的 `auto/gpt-5.6-sol` 路由，实际回复正确回忆了上一轮两条记忆，身份和记忆摘要保持一致，预览与实际引用相同；原消息未进入近期请求历史。证据为 `artifacts/magpie-chat-acceptance-1794668570091/model-switch.json`，这是额外一次实际请求。随后在这份真实回复上本地复现缺口：记忆纠正、撤权或遗忘后，记忆自身虽已排除，明确引用过它的较晚回复仍可能携带旧正文进入请求。

`memory-provenance.mjs` 现在沿记忆引用、显式来源与 `replyTo` 计算受影响记录，排除旧回复及其衍生记忆。模型和同步权限分别传播；隐藏完整原消息不取消同一原消息中其他直接整理事实的单条权限。已失效、删除、缺失、冲突或到期的记忆同样不能经旧引用重新进入请求，正在生成的旧结果在提交前重新核对。发送范围期限计入历史引用链上依赖的记忆。

新引用增加正文 `contentHash`，只改类型、期限或确认状态而正文未变时，不误停用历史引用。旧引用没有该字段时保守核对完整摘要或修订。该字段按原 JSON 存储，SQLite 仍为 v3，备份/同步仍为 v1；旧客户端不会执行此保护，参与设备需统一升级。模型上下文排除与本地历史删除分开：本轮不扩大用户已经确认的物理删除清单，也不按文字相似性推断关联。

新增 `tests/memory-context.test.mjs` **19 项**；最初 14 项在旧实现全部失败，见 `artifacts/memory-context-before-final.log`。全套 **410 项通过**，**139 文件语法检查通过**，见 `artifacts/node-tests-memory-context.log` 和 `artifacts/check-memory-context.log`。定向检查包含权限独立、同来源其他事实、引用/来源交替及循环、迟到结果、历史引用期限、加密恢复和实际本机 HTTP WebDAV 撤权后空白客户端恢复。

修复后经 Magpie 再提交两次合成请求：纠正后实际请求与回复使用茉莉绿茶；撤回模型权限后，旧偏好与旧引用回复不在实际请求内，回复明确没有记录，独立书店记忆仍可引用。见 `artifacts/magpie-memory-context-0.31/correction.json`、`permission.json`。连同前轮和换路由，共七次实际请求，没有自动重试。

完整自动浏览器回归在 `Runtime.enable` 超时，见 `artifacts/companion-browser-memory-context.log`；沙箱外重跑被自动审批拒绝，未执行。随后用已连接的 Magpie 浏览器在纯内存合成资料页检查发送范围，显示一条仍允许的书店记忆，不含旧茶偏好，服务端捕获的实际预览也一致，零模型请求，见 `artifacts/magpie-memory-context-0.31/preview-ui.json`。

继续通过同一已连接浏览器，在独立临时页面运行六个未修改的共享检查器：画布帧混合 10 项、记忆分页/筛选/引用 16 项、发送范围及草稿 20 项、重生成 10 项、主动关心 14 项、Live2D 导入及失败降级 21 项，合计 **91 项结果全部通过**。同源临时模块传递检查命令，不启动另一浏览器、不改浏览器设置；资料全部在内存，聊天和关心使用合成完成函数，真实网关请求数仍为七次。实际视口为 1474 × 909，运行时错误/未处理拒绝记录为空，Magpie 控制台未报告错误条目；临时服务正常退出、端口无监听、自建标签已关闭。结果为 `artifacts/connected-browser-0.31-1794671814581/result.json`，工具观察与清理证据为同目录 `observation.json`，检查时的原源码汇总已留存并核对哈希。

2026 年 11 月 15 日另在沙箱内用保留的真实 0.7.0/0.14.0 旧资料完成核心旧库检查：复制原 SQLite、期望状态和旧加密备份，不用当前代码重新生成旧格式；分别用独立 Node 进程升级、恢复旧备份并追加消息、运行真实旧代码确认拒绝新库、再次独立进程重开，共六阶段通过。完整身份/资料和同步元数据一致，权限及删除保留，SQLite 完整性正常，旧程序拒绝前后新库哈希一致，六份原始输入哈希未变。结果为 `artifacts/legacy-storage-0.31-mMPkSP/result.json`，同目录保存各阶段日志和检查前源码汇总。这不包含 Electron 渲染、原生窗口或安装程序。

六组浏览器检查没有运行可选截图回调、窄屏模拟、原生下载和其他完整伴侣流程；核心迁移检查也不能代替完整桌面旧库验收。整套浏览器、Electron 及安装验收仍待完成。源码汇总为 `artifacts/source-0.31.json`。0.31.0 尚未打包，0.30.0 历史包及其证据保持原版本；没有提交、推送或发布。

## 0.30.0 本机 Magpie 真实对话检查

用户提出使用本机 Magpie 后，确认运行中的 0.1.4174 网关在 `http://127.0.0.1:3425/v1` 提供 Chat Completions。经当前生产适配器和隔离 SQLite，以 `auto/gpt-6.1-sol` 共提交 **4 次请求**：连接测试、短聊天及两次记忆整理；本次无需额外 API 密钥。连接返回 `OK`，聊天成功保存中文回复，没有自动重试，未调用图片、朗读或主动关心。

首条消息明确标注“合成资料”，整理返回合法空数组，原检查未通过，证据 `write.json` 与请求记录保留。之后改为普通事实陈述，新整理得到两条带当前来源修订及哈希的待确认记忆。测试内确认后，用另一 Node 进程重新打开资料库，身份、完整状态与记忆摘要一致；原消息移出最近上下文后，两条记忆仍可本地召回。此阶段只配置了另一条路由；后续的真实换路由回复证据见上方 0.31.0 续验。

汇总为 `artifacts/magpie-chat-acceptance-1794668570091/result.json`，连接记录为 `artifacts/magpie-chat-smoke-1794668570091/result.json`。全部内容为隔离合成资料，没有更改运行代码、重建安装包或提交推送。网关报告的模型与用量不构成上游身份或计费证明；长期行为、更多路由、表情选择、语音、实际费用和其他首版待办仍需验收。真实立绘与付费图片继续按用户选择后移。

## 0.30.0 源码：按需选取记忆候选

长期历史的诊断发现，每次最多引用 30 条记忆，但原实现会完整排序全部有效候选。现在按既有比较规则建立优先堆，并按需要取出下一条；保留话题频率权重、确认状态、更新时间、ID 及本机比较等价时的原顺序。初始字数预算放不下的条目仍参与词频计算，只从选取候选中排除；按长度计数在剩余预算容不下任何正文时结束。没有修改权限、期限、来源、纠正、遗忘或引用规则，存储 v3 与备份/同步 v1 不变。

新增两项差分检查，覆盖 2,048 个混合候选、不同条数/字数上限、空正文、Unicode 与等价 ID 次序，结果与独立完整排序逐项一致。检索定向 **21 项通过**，全套 **391 项测试通过**、**138 文件语法检查通过**；证据为 `artifacts/memory-ranking-targeted.log`、`artifacts/node-tests-memory-ranking.log`、`artifacts/check-memory-ranking.log`。完整伴侣浏览器和源码 Electron 回归、0.7.0/0.14.0 旧库升级/降级阻止/重启均通过，渲染错误为空，见 `artifacts/companion-browser-memory-ranking.log`、`artifacts/desktop-memory-ranking.log`。

`npm run test:recall` 增加保留 0.29.0 索引完整排序的参考。20,000 条消息与 4,000 条有来源记忆的本机合成诊断中，25 个预热样本整体中位数从 12.45 ms 变为 7.79 ms，选取结果和分词次数保持相符；见 `artifacts/recall-benchmark-1794665493494/result.json` 和 `artifacts/recall-ranking-final.json`。个别查询仍有波动，冷启动执行顺序不可比，不据此声称实际聊天或所有查询都加速。有效性、候选构建及状态载入/复制/比较仍有全量工作。

汇总为 `artifacts/source-0.30.json`。随后完成 0.30.0 本机包和实际安装验收，见下节；未连接真实服务、提交或推送。0.29.0 包及其验收证据保留，真实立绘与付费图片服务验收仍按用户选择后移，不取消首版对应目标。

## 0.30.0 本机包与实际安装验收

使用四个已校验的本机缓存离线构建 `release/NIRIA Setup 0.30.0.exe`，121,635,651 字节，SHA-256 为 `EAB03174DF4821E3B675B80E91F794BA4E89D908A349911EFFBFC7BC92A47498`，旁附 `.sha256`。111 个运行文件与当前受测源码逐字节一致，归档共 112 文件且集合相符，归档 SHA-256 为 `9BE5D665501B824E79516AD18FF6279B87431058A518D2EE5A3A81BDE36D7A20`。安装器载荷与受测目录版的应用、可执行文件及运行时许可完全相同。构建阶段仅在项目 `artifacts/` 中运行原生 NSIS 卸载器生成辅助程序，未安装应用或下载工具；安装器和原生卸载器 CRC 通过。

包内 Haru 真实播放、动作/表情、双窗口、加密备份、本机 HTTP WebDAV 恢复及 SQLite 重启通过，见 `artifacts/desktop-live2d-real-0.30.log`，无真实模型服务调用或渲染错误。实际安装验收按既有授权从真实 0.14.0 安装开始，覆盖到 0.30.0，完成旧资料迁移/重启、已安装程序完整回归、卸载保留、重装恢复与最终卸载，全 **11 阶段通过**。完整回归核对发送范围与实际选取一致、权限/纠正/删除后排除旧内容、旧回复及衍生记忆的重生成规则，并运行此前窗口、凭据、备份及真实 0.7.0/0.14.0 旧库升级检查，渲染错误为空。

两次卸载期间隔离资料库哈希不变，测试注册、进程、快捷方式、目录、哨兵及默认资料文件均清理完毕。结果为 `artifacts/installer-smoke-ea747214030c457fb458a3f46257e592/result.json`，同目录下 `installed-regression.log` 为完整桌面回归；独立复核为 `artifacts/installer-postflight-0.30.json`。汇总为 `artifacts/release-0.30.json`，另见 `artifacts/build-offline-0.30.log`、`artifacts/offline-build-0.30.0.json`、`artifacts/package-audit-0.30.json`、`artifacts/installer-payload-0.30.json` 和 `artifacts/installer-acceptance-0.30.log`。

本机包继续包含仅供本机开发验证的 SDK，Haru 模型未打包。安装验收只覆盖本机当前用户、中文及空格路径；未执行实体双 Windows、真实 Nextcloud、实际系统休眠、多屏长期或外部服务验收。SDK 发行许可、项目许可、安全审查、签名与发布仍待完成；本轮没有提交、推送或公开发布。该次包构建时无 SDK 的隔离源码证据仍属于 0.28.0，随后更新见下节。

## 0.30.0 干净源码与独立依赖安装

从当前已跟踪及未忽略的工作区建立无 SDK、模型、用户资料、凭据及依赖的隔离副本，共 162 个源码文件。首次离线安装在默认 npm 缓存缺包处停止；改用项目已有缓存后，进一步复现 npm 12 的 `EALLOWREMOTE`：锁文件中 esbuild 的镜像 tarball 主机与默认仓库不一致，安装被拒绝。失败日志及副本均保留。锁文件仅将 **27 个** esbuild 下载地址统一到 npm 官方仓库，逐项断言版本、完整性摘要和依赖关系不变；证据为 `artifacts/lock-registry-normalization-0.30.json`。未改运行代码或版本号。

从既有项目及用户 npm 缓存中，仅按锁文件摘要读取并核验包内容，组成任务缓存，不复制缓存请求头或注册表元数据。最终副本 `artifacts/public-source-0.30-OgGdGJ` 使用 `npm ci --offline` 新装 **285 个包**，Electron、electron-builder 与 esbuild 均从本副本依赖目录解析，未复用主工作区 `node_modules`。Electron 自身安装代码从已核验并复制到任务缓存的原包准备运行库，esbuild 实际转换通过。npm 12 默认策略跳过两项生命周期脚本，本轮未解除该策略或声称验证新依赖目录的打包能力。Node 安装网络拒绝器拦截一次 npm 自身更新检查，没有外部下载。

无 SDK 副本全套 **391 项测试中 389 通过、2 项官方 SDK 专属检查跳过、0 失败**，**136 文件语法检查通过**。完整伴侣浏览器通过，缺组件提示及禁止未播放模型采用均符合预期。首次 Electron 回归在 `layout-read.widgetPreservesFocus` 失败，保留 `artifacts/public-source-0.30-desktop-first-failed.log`；未改源码或降低断言，原样完整重跑 **14 阶段通过**，含窗口/布局、凭据与损坏降级、换钥及重启，渲染错误为空。不能据此宣称焦点或实体桌面的长期稳定性已经完成验收。

146 个代码/配置文件在测试后与当前源码逐字节核对。汇总为 `artifacts/public-source-0.30.json`，依赖证据为 `artifacts/public-source-0.30-install.json`；原始日志为 `artifacts/public-source-0.30-node-tests.log`、`artifacts/public-source-0.30-syntax.log`、`artifacts/public-source-0.30-browser.log`、`artifacts/public-source-0.30-desktop.log`。既有 0.30.0 包在锁文件修正后再次只读核对，111 个运行文件、归档集合和哈希仍相符，见 `artifacts/package-audit-0.30-after-lock.json`；包未重建，原安装验收仍证明相同运行内容。源码/包汇总已增加本轮证据，原锁文件测试摘要作为历史字段保留。

本轮只验证本机 Node 26.13.0/npm 12.2.2 和已有完整缓存，没有空缓存在线安装、其他 Node/npm、该副本新包构建、真实 SDK 播放、旧库升级、外部服务或实体双设备验收；对应既有证据和首版待办保持各自范围。未提交、推送或发布。

## 0.29.0 源码：窗口唤醒与显示器变化恢复

用户选择将真实立绘与付费图片服务验收后移，继续可在本地推进的开发；单图生成的质量与费用验收仍属于首版目标，不记为通过。

原窗口恢复逻辑在每次显示器参数变化时都先还原再最大化主窗口，即使正常位置无需变化；还原事件还可能重入恢复并保存中间状态。现在仅在边界确需修正时移动窗口，忽略一个逻辑像素内的原生舍入差；恢复期间抑制重入及中间布局写入，最终保留最大化状态。系统 `resume` 与显示器变化共用延迟合并的恢复入口，最小化和全屏窗口暂不移动，恢复或退出全屏后再检查。隐藏的小窗可在后台移回可见范围，不自动显示、抢焦点或改变收起/置顶设置；退出时移除唤醒监听及待执行恢复。

新增 `tests/window-layout.test.mjs` **8 项**，旧实现有 4 项失败，证据为 `artifacts/window-layout-before.log`；修复后连同原布局检查 **18 项通过**，见 `artifacts/window-layout-targeted.log`。全套 **389 项测试通过**、**138 文件语法检查通过**，见 `artifacts/node-tests-window-recovery.log`、`artifacts/check-window-recovery.log`。完整源码 Electron 回归及真实 0.7.0/0.14.0 旧库升级、降级阻止和重启通过，见 `artifacts/desktop-window-recovery.log`。其中在真实窗口上发送模拟唤醒事件，确认最大化窗口无还原/最大化切换、隐藏的屏幕外小窗恢复位置且标志不变，渲染错误为空。

汇总为 `artifacts/source-0.29.json`。本次没有执行实际系统休眠、实体多屏切换或外部服务验收，不能替代长期设备体验。随后完成 0.29.0 本机包及实际安装验收，见下节；0.28.0 包及其证据保持原样。未提交、推送或发布。

## 0.29.0 本机包与实际安装验收

使用四个已校验的本机缓存离线构建 `release/NIRIA Setup 0.29.0.exe`，121,635,314 字节，SHA-256 为 `0E95BEE6593AE1EBC57EE68EA78E99AF403404A6B10F4D79D77F7D4B133B893C`，旁附 `.sha256`。111 个运行文件与源码逐字节一致，归档共 112 文件且集合完全相符；归档 SHA-256 为 `12CD101378F617880A3D2D0F84630272600C9A0437C899A54A9A97252513228F`。安装器中应用归档、可执行文件及两份运行时许可与目录版哈希一致。构建运行原生 NSIS 卸载器生成辅助程序，范围限制在 `artifacts/`，安装器与卸载器 CRC 均通过；构建阶段没有安装应用或下载工具。

包内 Haru 真实播放、动作/表情、双窗口、加密备份、本机 HTTP WebDAV 恢复及 SQLite 重启通过，见 `artifacts/desktop-live2d-real-0.29.log`，无外部模型请求或渲染错误。按既有安装验收授权，从真实 0.14.0 安装开始执行当前用户中文/空格路径的覆盖、资料迁移/重启、包内容及原生卸载器核对、安装后完整桌面回归、卸载保留、重装恢复与最终卸载，全 **11 阶段通过**。完整回归包含新增的窗口唤醒检查、凭据故障降级、备份以及 0.7.0/0.14.0 旧库升级和降级阻止，渲染错误为空。两次卸载期间隔离资料库哈希不变。

实际验收结果为 `artifacts/installer-smoke-3cf03f91b8584fb0b8d1f22b27a404f7/result.json`，其中 `installed-regression.log` 为已安装程序完整回归；总日志为 `artifacts/installer-acceptance-0.29.log`。独立复核 `artifacts/installer-postflight-0.29.json` 确认注册、进程、安装目录、快捷方式、哨兵和默认资料文件均无残留。汇总为 `artifacts/release-0.29.json`，构建及只读核对为 `artifacts/build-offline-0.29.log`、`artifacts/offline-build-0.29.0.json`、`artifacts/package-audit-0.29.json`、`artifacts/installer-payload-0.29.json`。

本机包包含仅供本机验证的 SDK，Haru 模型未打包；未取得发行许可，未签名、上传、发布、提交或推送。安装验收仍只覆盖本机当前用户；实际休眠、多屏、Nextcloud、实体双 Windows 和外部服务质量继续待验收。无 SDK 的隔离源码证据仍属于 0.28.0，未写成本轮重跑。

## 0.28.0 源码：凭据故障独立降级与配置提交

凭据库无法打开、文件损坏、结构不兼容或运行时 SQL 读取失败时，原实现会阻断桌面启动或整个状态接口；现在保留原文件、停用本次进程的凭据持久化，继续读取本机伴侣并允许显式配置仅本次会话的四类服务。状态增加 `savedKnown`，无法核对已存内容时不宣称空库；界面提醒原配置尚未清除，重启可能仍使用。保存及清除故障返回脱敏存储错误，清除失败不报告成功，没有明文回退。原本仅 Windows 保护不可用而凭据 SQLite 健康的情形，仍可删除已有密文。

配置先校验、等待系统加密与写入，再切换当前连接和配置版本；失败时原会话保持可用。修复失败的同步配置保存会提前清零待确认换钥密钥、丢弃准备方案的问题，等待及失败期间均保留原连接与恢复信息。对话和朗读校验复用适配器规则，未改变外部接口、凭据表结构、存储 v3 或备份/同步 v1。

新增 `tests/credential-lifecycle.test.mjs` **9 项**，旧实现 9 项均未通过，见 `artifacts/credential-lifecycle-before.log`；修复后与凭据、同步、备份相关 **53 项**定向检查通过，见 `artifacts/credential-lifecycle-targeted.log`。全套 **373 项测试通过**、**135 文件语法检查通过**，证据为 `artifacts/node-tests-credential-safety-final.log`、`artifacts/check-credential-safety-final.log`。完整伴侣浏览器回归通过，见 `artifacts/companion-browser-credential-safety.log`。

新增浏览器 `--credential-safety` 与原生故障启动共用 **14 项**检查，覆盖可读本机历史、停用记住开关、已存状态未知提示、四类会话连接、保存拒绝、清除失败、身份与记忆保留、秘密不返回和零模型请求。浏览器检查使用独立纯内存资料库与凭据库，强制检查均无文件，见 `artifacts/credential-safety-browser.log`。Electron 另在 `artifacts/` 新建坏凭据文件及伴侣资料，实际启动和重启后逐字节核对坏文件原样保留，身份、长期记忆及调用记录保持不变；原有系统加密正常保存/读取/清除、完整窗口回归与两种旧库升级继续通过，见 `artifacts/desktop-credential-safety.log`。

## 0.28.0 本机预览包

最终 `release/NIRIA Setup 0.28.0.exe` 为 121,634,875 字节，SHA-256 为 `4F9F9348A61B8FB5B7C0E0F3C0D94A420B01D742129089ED1EC0C604392121C6`，旁附 `.sha256`。四个已有缓存校验后离线构建，没有下载；构建时运行原生 NSIS 卸载器生成辅助程序，工作目录限制在 `artifacts/`，仅生成卸载器。111 个运行文件与源码逐字节一致，归档共 112 文件且集合相符。安装器中应用归档、可执行文件及两份运行时许可与受测目录版相同。

首次包内完整回归通过，Haru 专项中固定等待 700 毫秒的两个像素采样相同，只有 `realIdleMotionChangesPixels` 失败，保留 `artifacts/desktop-live2d-real-0.28.log` 和初次构建/包核对证据。检查改为最多 6 秒观察实际像素变化，未更改播放器或用静态画面替代动作判断；源码通过，见 `artifacts/desktop-live2d-real-0.28-source-observation.log`。随后重新离线构建，最终包内完整回归、坏凭据文件启动/重启、两种旧库升级，以及 Haru 动作/表情、双窗口、加密备份、本机 WebDAV 恢复和 SQLite 重启均通过，渲染错误为空，见 `artifacts/desktop-packaged-0.28-verified.log`、`artifacts/desktop-live2d-real-0.28-verified.log`。

汇总为 `artifacts/source-0.28.json`、`artifacts/release-0.28.json`；最终构建与比较为 `artifacts/build-offline-0.28-uninstaller-final.log`、`artifacts/offline-build-0.28.0.json`、`artifacts/package-audit-0.28.json`、`artifacts/installer-payload-0.28.json`。应用归档哈希仍为 `66FAEA6717C96964F8E89A2D964DE75CF0C78D388B610635E081ACA43FE86AEE`，此前 Haru 播放验收仍对应相同运行内容。实际安装与卸载验收见下节。未签名、发布、提交或推送；0.25.0/0.27.0 包保留为历史证据，它们尚未通过实际安装/卸载验收。SDK 仅供本机验证，Haru 模型未打包，发行许可未取得。

## 0.28.0 安装器修复与实际验收

用户于 2026 年 11 月 14 日明确授权继续实际安装验收。首次运行通过真实 0.14.0 安装、0.28.0 覆盖、旧库迁移/重启和已安装程序完整回归，但卸载器退出码为 2。诊断确认旧离线构建使用的 `UninstallerReader` 直接提取方式复制了不匹配的可执行文件头：卸载器存储 CRC 为 `C83A24C5`，实际计算为 `916756FE`。原失败包 SHA-256 为 `3952AED67EC13C57C7C3866E40BFB54625B64FBE079B6322C649B1E6EC645DC0`，保存在 `artifacts/installer-0.28-uninstaller-crc-failed/`；原失败结果与坏卸载器也保留。

`scripts/build-offline.mjs` 改用原生 `BUILD_UNINSTALLER` 辅助程序，在项目内生成并保留卸载器副本。新增 `scripts/nsis-integrity.mjs`，核对 NSIS 类型、长度与 CRC，并拒绝关闭 CRC 检查的文件。构建检查安装器与卸载器；`verify-package.mjs --directory` 再核对实际已安装卸载器与原生输出的哈希。原生卸载器 CRC 正确，NSIS 脚本数据与原坏文件相同；用它成功清理首次失败的隔离安装，数据库哈希保持不变，见 `artifacts/uninstaller-crc-0.28.json`、`artifacts/installer-cleanup-0.28-crc.log`。

新增 **8 项**测试，覆盖标准 CRC 独立向量、安装器/卸载器类型、文件头和载荷损坏、CRC 范围、关闭校验、截断与错误签名。全套现为 **381 项通过**、**137 文件语法检查通过**，见 `artifacts/node-tests-uninstaller-fixed.log`、`artifacts/check-uninstaller-fixed.log`。

修复后重新从真实 0.14.0 安装起执行，全 **11 阶段通过**：当前用户下中文及空格路径安装、读回 schema 2 旧资料、覆盖 0.28.0、包内容及原生卸载器核对、迁移至 schema 3 和重启、安装后完整桌面回归、卸载保留、重装恢复、最终卸载。两次卸载期间隔离数据库哈希不变，默认目录哨兵保留；最后哨兵清除。完整结果为 `artifacts/installer-smoke-5d7af2aa43a3416cb9ee4d0677eda484/result.json`，运行日志为 `artifacts/installer-acceptance-0.28-verified.log`。另在实际用户环境只读复核，注册及进程数均为 0，安装目录、快捷方式、哨兵和默认伴侣文件均无残留，见 `artifacts/installer-postflight-0.28.json`。项目内隔离资料及失败证据保留。

## 0.28.0 无可选 SDK 的源码验证

从当前已跟踪及未忽略的工作区文件建立项目内隔离副本，共 161 文件；跳过已删除的旧源码，排除 SDK、真实模型、用户资料、凭据、依赖和构建产物。145 个代码/配置文件在测试前后与当前源码哈希相同。未提交、上传或创建新的公开发布。

无 SDK 副本执行全部 381 项 Node 测试，**379 通过、2 项官方 SDK 专属检查明确跳过、0 失败**；**135 文件语法检查通过**，与含 SDK 环境相比少了两个生成的 SDK JavaScript 文件。完整伴侣浏览器流程通过，缺组件状态明确、无法实际播放的模型不能采用，原单图与聊天继续工作。Electron 源码完整 **14 阶段通过**，含主窗口/伴侣小窗、凭据保存与损坏降级、布局重启和换钥恢复，渲染错误为空。

汇总为 `artifacts/public-source-0.28.json`，逐文件清单为 `artifacts/public-source-0.28-preparation.json`，原始日志为 `artifacts/public-source-0.28-node-tests.log`、`artifacts/public-source-0.28-syntax.log`、`artifacts/public-source-0.28-browser.log`、`artifacts/public-source-0.28-desktop.log`；源码与发行证据汇总也已更新。本次复用父工作区已有开发依赖，没有重新安装依赖或联网下载；未运行真实 SDK 播放、旧库升级、实际 Nextcloud、外部模型或实体双设备。这些范围继续使用各自的既有证据和待验收项。

## 首版验收对照

以下按 `docs/requirements.md` 的六项正式验收核对。自动化通过只证明相应测试的范围，当前尚不能标记完整首版完成。

| 要求 | 当前证据 | 尚缺的直接验收 |
| --- | --- | --- |
| 1. 单图生成可动形象、一致性及单独重做 | 合成图片请求、动作采用/重做、帧混合与本机播放已通过；已有 Live2D 的 Haru 真实播放另行验证 | 经用户授权的真实单张立绘与图片服务；实际生成质量、自然循环和费用。Haru 是已有模型，不能代替单图生成验收 |
| 2. 重启及换模型延续同一伴侣 | `tests/companion.test.mjs` 检查重开及换模型后来源/记忆保留；0.30.0 Electron 升级重启与重装恢复通过；Magpie 真实整理后，独立 Node 重开并用另一条路由实际回忆两条记忆，身份与记忆摘要相同 | 当前 0.31.0 的完整桌面/升级回归、模型日常使用与长期稳定性；两条网关路由的短检查不代表所有模型 |
| 3. 编辑、删除、遗忘不复活旧内容 | 生命周期/纠正/同步/重生成及旧备份检查；0.31.0 追加历史引用保护 19 项、真实 Magpie 纠正/撤权请求及发送范围界面检查 | 0.31.0 整套浏览器与桌面回归、真实长期复核；模型上下文排除不等于磁盘、历史聊天、服务端或其他设备副本已擦除 |
| 4. 两台 Windows 的新增、冲突和删除 | 独立客户端及真实本机 HTTP WebDAV 测试覆盖合并、冲突、删除、取消、换钥和恢复 | 实际 Nextcloud 与两台实体 Windows；2026-11-14 只读复核本机 Debian 为 Stopped，未启动发行版或部署服务 |
| 5. 完整加密备份恢复人格、记忆和形象 | 真实备份密码学、事务与生命周期检查；浏览器/Electron 恢复操作及 Haru 模型字节/播放恢复 | 独立密码学审查与真实用户完整资料/新电脑演练；不能把同机多进程当成实体新电脑 |
| 6. 故障、发送范围及后台上限可理解 | 发送范围与引用核对、调用上限、默认关心关闭、失败保留和取消测试；本轮追加凭据故障独立降级及真实窗口提示 | 真实模型/图片/语音服务的兼容性、实际计费和用户理解验证 |

本机当前用户的安装/覆盖/卸载/重装已完成。发行仍需实体多显示器/DPI/GPU/休眠长期检查、确定项目许可证与 Live2D 可扩展应用发行许可。真实素材、外部服务和实体设备也尚未获得本轮可执行的验收输入；当前安装验收不覆盖所有用户安装、其他 Windows 环境或实体双设备。

## 0.27.0 源码：备份停止、恢复确认与提交后故障

新增 `BackupService`，导出和恢复使用同一串行锁及 90 秒超时。停止或 HTTP 断开使未提交操作失效，忽略取消的本机加密/解密必须结束后才释放忙碌状态。导出捕获起始快照；重复或拒绝的请求不会取消原任务。

恢复必须提供从当前状态读取的 `expectedBasis`，在解密前后核对进程内资料版本、恢复版本和同步状态。设置、用量、调用日志、形象和实体变化都会使确认失效，无改动或失败事务保持原标记。确认后另一窗口新增资料时拒绝恢复，保留新资料。恢复事务失败保留原同步会话；只有提交成功后才清除旧连接和密钥。配对码正在异步保存时拒绝恢复，恢复期间拒绝新的同步/配对写入。

已提交后清除配对码失败返回 `{ok:true, credentialWarning}`，明确说明已经恢复，重启仍可能自动解锁；不暴露底层存储异常。页面刷新失败同样提示已经恢复与重新载入核对，避免重复恢复。界面展示读取、解密、加密及清理状态，提供停止；读取中重选文件、关闭设置或离开页面会使旧读取失效。使用选择时的口令，仅在输入仍相同时清空。

新增 `tests/backup-lifecycle.test.mjs` **18 项**。最初 5 项均在旧实现复现失败（`artifacts/backup-lifecycle-before.log`），扩充后全部通过（`artifacts/backup-lifecycle-final.log`）。全套 **364 项测试通过**，**133 文件语法检查通过**，证据为 `artifacts/node-tests-backup-safety.log`、`artifacts/check-backup-safety.log`。

新增浏览器 `--backup-safety` 与 Electron 共用 **20 项**检查，包含真实加密导出/恢复、文件与解密等待期间资料变化、取消与页面生命周期、口令捕获、已提交后清理和刷新失败。初版界面检查发现刷新失败后旧忙碌状态未清除，保留 `artifacts/backup-safety-browser.log`；修复后通过，见 `artifacts/backup-safety-browser-verified.log`。新增检查使用独立纯内存服务，强制检查数据库无文件、未接入凭据库；自动审批曾因应用状态改写及异常清理证据不足拒绝运行，隔离后补齐语法与嵌套 finally，再获准运行。

完整伴侣浏览器和源码 Electron `--upgrade --upgrade-v2` 均通过，含新增 20 项、双窗口、凭据、布局、换钥及实际 0.7.0/0.14.0 旧库/备份升级与重启，渲染错误为空，见 `artifacts/companion-browser-backup-safety.log`、`artifacts/desktop-backup-safety.log`。没有调用真实模型或 Nextcloud。

## 0.27.0 本机预览包

已使用四个已校验的本机缓存离线构建 `release/NIRIA Setup 0.27.0.exe`，121,632,710 字节，SHA-256 为 `893E694FD33F8BEA073D84C9ACF7477897A166C5AC1D3987872F376C06155E82`，旁附 `.sha256`。目录版 `release/win-unpacked/NIRIA.exe` 已更新为 0.27.0；原 0.25.0 安装包与证据保留。没有下载工具，构建时只解析卸载器数据，没有运行安装器或卸载器。

110 个运行文件与当前源码逐字节一致，完整归档共 111 文件且集合相符。只读解包安装器，`resources/app.asar`、`NIRIA.exe` 及两份运行时许可文件与受测目录版完全相同。包内完整回归和实际 0.7.0/0.14.0 旧库/备份升级、降级读取阻止、重启均通过，新增 20 项备份检查全部通过。真实 Haru 模型的双窗口、动作/表情、减少动态效果、加密备份、本机 HTTP WebDAV 恢复与 SQLite 重启播放通过，未调用模型服务。只读安装预检通过；没有实际安装、卸载、签名、发布、提交或推送。

证据为 `artifacts/build-offline-0.27.log`、`artifacts/offline-build-0.27.0.json`、`artifacts/package-audit-0.27.json`、`artifacts/installer-payload-0.27.json`、`artifacts/desktop-packaged-0.27.log`、`artifacts/desktop-live2d-real-0.27.log`、`artifacts/installer-inspect-0.27.json`；源码与包汇总为 `artifacts/source-0.27.json`、`artifacts/release-0.27.json`。SDK 仅用于本机验证，Haru 模型未打包；仍未取得可扩展应用发行许可。真实服务、实体双 Windows、长期体验与安装器验收等首版待办保留。

## 0.26.0 源码：同步停止、锁定与记录故障

修复同步忽略取消的迟到 GET 仍会进入上传、迟到能力检查可恢复成功状态的问题。`WebDAV` 在发起前、收到响应后及读取正文时检查中止，丢弃迟到响应并释放正文；独立 AbortError/TimeoutError 统一为已停止或超时，普通正文读取失败返回脱敏错误。已发送 PUT 后收到迟到成功不当作确认，也不因取消自动重试。服务在能力检查、状态读取及返回结果前再次检查，串行锁一直保留到本机适配器真正结束；停止后不新增状态上传，本机消息保留，下一次显式同步重新核对已发送写入。

加入恢复同样在读取后拒绝已取消任务，不替换空白设备的伴侣。换钥在异步凭据处理、能力探测和远端读取后重新检查；远端可能已写入时仍保留“结果待核对”的专用提示与标记，不能被通用停止错误覆盖。初始换钥标记无法保存时回滚内存元数据，不提交远端；清除停止标记失败时保留与数据库一致的待核对状态。解锁先保存元数据，再替换配对码或丢弃待确认换钥，保存失败保留原密钥、计划和元数据。

`/api/sync/lock` 现在先立即中止任务、清零会话密钥、断开会话连接，再清除已保存配对码。系统安全存储清除等待或失败不会延后会话锁定；失败返回独立 503，明确说明已锁定，但重启可能因未清除的已存配对码而自动解锁。界面补充停止、已发送上传及锁定的实际行为说明。存储 schema 3、同步/备份 v1、配对码与远端文件格式均未变化。

新增 `tests/sync-lifecycle.test.mjs` **17 项**，覆盖预先取消不发请求、忽略取消的 GET/PUT、正文中止/超时与普通故障脱敏、停止期间互斥、锁定、能力检查超时、取消加入、换钥凭据等待/迟到能力、初始记录失败、解锁失败、停止标记清除失败及只读恢复，以及实际 HTTP PUT 已成功后的取消与再次手动核对、HTTP 锁定与安全存储清除失败。最初 12 项全部复现失败（`artifacts/sync-lifecycle-baseline.log`）；首版定向修复覆盖了换钥待核对提示，被原测试发现后修正，保留 `artifacts/sync-lifecycle-targeted.log`。扩充测试后的定向回归通过，最终 `npm test` **346 项通过**，证据为 `artifacts/node-tests-sync-safety.log`。

新增共享 `desktop/sync-safety-smoke.mjs`，Edge 专用入口 `node scripts/browser-smoke.mjs --sync-safety`。14 项实际界面检查经本机认证 API 和父进程的真实 HTTP WebDAV 服务运行，仅控制响应返回时序；包括停止读取不上传、忙碌锁、本机保留、成功状态不复活、明确手动重试、实际 PUT 已完成后的未知结果、再次核对无重复，以及锁定清零和迟到能力失效，无模型请求。Edge 首次和最终全部通过，页面错误为空，证据为 `artifacts/sync-safety-browser.log`、`artifacts/sync-safety-browser-verified.log`；完整伴侣浏览器回归通过，见 `artifacts/companion-browser-sync-safety.log`。

Electron 首次回归在新增同步检查之前，因旧记忆检查在列表已载入但状态请求尚未记入时序日志时过早断言而失败，见 `artifacts/desktop-sync-safety.log`。脚本已先等待实际窗口状态请求出现，仍严格核对所有请求为 `memories=none` 且不含完整记忆。第二轮在新同步检查中，因仅等待页面静态元素、初始资料尚未实际渲染便点击设置而失败，见 `artifacts/desktop-sync-safety-final.log`；已改为等待调用列表实际完成渲染，再操作设置与同步。最终全套 `--upgrade --upgrade-v2` **通过**，包括新增 14 项、前轮所有共享检查、双窗口、凭据、布局、换钥，以及实际 0.7.0/0.14.0 旧库/旧备份升级、降级读取阻止和重启；渲染错误为空，见 `artifacts/desktop-sync-safety-verified.log`。最终语法检查 **129 个文件通过**，见 `artifacts/check-sync-safety-final.log`，汇总为 `artifacts/source-0.26.json`。

本轮没有构建 0.26.0、实际安装/卸载、连接真实 Nextcloud/模型、提交或推送。0.25.0 本机包和其证据保留；首版真实服务、实体双 Windows、长期体验与发行验收继续进行。

## 0.25.0 本机包：离线构建与包内验证

将恢复开发以来的 0.20–0.25 改动整理进本机 Windows x64 预览包。`release/NIRIA Setup 0.25.0.exe` 为 121,626,914 字节，构建于 2026 年 11 月 14 日 19:02（Asia/Taipei），SHA-256：

```text
7DBD443AD25F0AE87BE659CD96D2D32A5D5C155DD3968C537D9A8A0242911334
```

常规 `npm run dist:win` 在沙箱内因联网 EACCES 失败（`artifacts/build-0.25.log`）。联网提权重跑被自动审批拒绝，理由是外部依赖来源与下载目的地尚未核验。随后仅使用本机已有缓存：Electron 45.3.1、7zip 1.0.0、NSIS 3.0.4.1 及 resources 3.4.1 四个原始压缩包均与已安装锁定依赖中的 SHA-256 一致，工具重新解压到项目 `artifacts/`，全程沙箱内离线构建成功，没有新增下载或修改全局缓存。

新增 `scripts/build-offline.mjs`，固定当前构建器版本，显式指定本地运行时、7zip 和 NSIS 路径，关闭依赖重建与发布，下载入口遇到调用即拒绝。electron-builder 默认会运行 BUILD_UNINSTALLER 临时程序；此入口在本进程中将该步骤改为内置 `UninstallerReader` 的静态提取，不运行安装器或卸载器，不修改已安装的构建器源码。首次构建后发现自定义 Electron ZIP 会保留示例应用，最终构建已清除 `default_app.asar` 和 stock `version`；运行时许可文件保留。构建证据为 `artifacts/build-offline-0.25-final.log`、`artifacts/offline-build-0.25.0.json`。

增强 `scripts/verify-package.mjs`：除了版本和内容，核对归档完整文件集合，拒绝额外、过时、链接或 unpacked 的运行文件，并输出归档和安装器 SHA-256。首次审计暴露 Windows `statFile` 需要本机路径分隔符的问题，已修正；保留 `artifacts/package-audit-0.25-first.json`。最终审计 **106 个运行文件逐字节一致、共 107 个归档文件，集合完全一致**，见 `artifacts/package-audit-0.25.json`。新增 `scripts/verify-installer-payload.mjs`，只读提取安装器中的 `resources/app.asar`、`NIRIA.exe` 和两份运行时许可文件，四项哈希均与受测目录版一致，见 `artifacts/installer-payload-0.25.json`。

实际打包程序的 `--packaged --upgrade --upgrade-v2` 全部通过，覆盖新增图片/朗读/聊天故障检查、双窗口、记忆与历史、凭据、布局、换钥，以及实际 0.7.0/0.14.0 旧库、旧备份升级、降级读取阻止和重启；渲染错误为空。`--packaged --live2d-real` 使用本机 SDK 5 R5 和 Haru，通过真实动作/表情/减少动态效果、主窗口与小窗、加密备份、本机 HTTP WebDAV 恢复及新进程再次播放，未发起外部模型调用。证据为 `artifacts/desktop-packaged-0.25.log`、`artifacts/live2d-real-packaged-0.25.log`。

只读安装预检通过（`artifacts/installer-preflight-0.25-final.log`），仅在项目中写验收计划，没有安装或卸载。首次与桌面测试并行，因受测 NIRIA 尚在运行而被预检正常拒绝，保留 `artifacts/installer-preflight-0.25.log`；待测试退出后重跑通过。源码阶段 **329 项 Node 测试通过**的结果继续适用，本轮仅修改构建/审计工具及文档，最终 **127 个 JavaScript 文件语法通过**（`artifacts/check-package-0.25.log`）。汇总为 `artifacts/release-0.25.json`，安装包旁附 `.sha256`。

本机包包含单独取得的 SDK，不包含官方 Haru 模型；仅本机验证，没有签名、上传、发布、提交或推送。实际安装/覆盖升级/卸载/重装、真实服务质量与计费、实际 Nextcloud、实体双 Windows、长期体验、项目许可证、独立安全审计及 Live2D 发行许可等首版待办继续保留。

## 0.25.0 源码：聊天调用、取消与记录故障

补齐聊天、连接测试、记忆整理及主动关心的调用记录故障区分。初始 pending 与每日计数先原子落盘，失败时明确提示未提交服务，保留用户消息且不发起上游请求。返回后先检查取消和进程内恢复标记，再保存 completed；停止或适配器独立超时统一 unknown，忽略取消的迟到结果不写入聊天。完成记录无法保存时尽可能转为 unknown，持续写入故障保留 pending 等重启修复，不当作普通提供商失败。失败消息状态本身写不下时返回简短本机存储错误，不泄露数据库异常，仍释放忙碌状态。

实际调用捕获本次确认的连接、伙伴及恢复标记，处理期间不允许直接切换对话配置。同身份恢复、跨身份恢复后都拒绝旧结果，不把旧调用状态或失败写入恢复后的资料。聊天和连接测试的响应断开只中断各自创建的 controller，重复请求被拒绝不会取消原请求；本机适配器尚未结束时继续保持串行锁。连接测试不再在忽略取消的结果返回时报告成功。生产文本适配器保留独立 AbortError/TimeoutError 的结果不确定状态，不暴露异常文本。

原有成功后替换回复的事务继续生效；首次记录失败、完成记录失败、取消或超时均保留可用原回复及未发送草稿。后台整理的服务调用或结果记录失败不撤销已完成聊天，不自动重试、不采用未能确认保存的整理结果。存储 schema 3、备份/同步 v1、记录数量和预算规则均不变，没有新增持久字段。页脚与元数据更新为 0.25。

新增 14 项 Node 测试，覆盖预先取消、初始和完成记录故障、持续故障、忽略取消与串行锁、取消连接测试、自行超时与生产适配器、活动连接不变、同/跨身份恢复、失败状态无法落盘、后台整理不影响已完成聊天，以及真实 HTTP 的断开和重复请求隔离。最初 12 项复现 11 项失败，保留 `artifacts/chat-lifecycle-before.log`；首次实现的恢复依据变量放错方法，在定向测试中暴露后修正，保留 `artifacts/chat-lifecycle-targeted.log`，最终定向记录为 `artifacts/chat-lifecycle-targeted-final.log`。最终全部 `npm test` **329 项通过**、`npm run check` **125 文件通过**，证据为 `artifacts/node-tests-chat-faults-final.log`、`artifacts/check-chat-faults-final.log`。

新增共享 `desktop/chat-fault-smoke.mjs` 的 15 项实际界面检查，Edge 入口为 `node scripts/browser-smoke.mjs --chat-faults`。页面经真实本机认证 API，completion 与持久化故障采用受控替身；共七次合成 completion，没有外部模型请求。覆盖初始记录失败不调用模型、原回复/草稿保留、完成状态失败解释不确定、手动重试成功且不新增用户消息、忽略取消后未知、不交付迟到正文、整理失败保留文字、连接测试离开页面中断、记录跨导航和脱敏。专用 Edge 通过，证据为 `artifacts/chat-faults-browser.log`，页面异常为空。

完整伴侣浏览器回归通过（`artifacts/companion-browser-chat-faults-verified.log`）。初次回归仍期待主动关心取消经过旧条件检查后抛错，新的调用层会先以 504 明确拒绝已取消结果，已将断言改为状态码并继续检查中断信号、调用数及迟到正文不显示；失败证据保留为 `artifacts/companion-browser-chat-faults-final.log`。Electron 全套 `--upgrade --upgrade-v2` 通过（`artifacts/desktop-chat-faults-final.log`），含新 15 项与前轮图片/朗读保护、双窗口、历史/记忆、发送范围、凭据、布局、换钥，以及实际 0.7.0/0.14.0 旧库与旧备份升级、降级读取阻止和重启，渲染错误为空。

以上源码阶段没有真实模型或计费结果验收，没有构建/安装/卸载程序，没有提交或推送；当时最近验证安装包为 0.19.0。后续 0.25.0 离线构建与包内验证见上节，首版的真实立绘与声音、Nextcloud、实体双 Windows、长期体验、安装器与许可/发行待办继续保留。

## 0.24.0 源码：朗读等待、停止与恢复边界

修复等待音频时没有可用停止按钮、停止后完整响应仍可能被页面播放，以及初次调用记录写入失败后服务永远忙碌的问题。页面在等待时显示请求数量及可能计费提示，并提供“停止等待朗读”；停止、离开页面、源消息/伙伴/恢复标记改变均取消页面请求。播放前刷新资料并再次检查取消，已缓冲的迟到响应也不能播放；播放后的“停止朗读”释放音频和 Blob URL。试听沿用相同失效检查，文本聊天不依赖朗读状态。

服务先保存 pending 与每日计数，成功写入后才标记自动尝试及调用合成。初始记录失败不会提交上游，也不消耗自动尝试标记，返回本机存储提示；所有结束路径清理定时器并释放忙碌状态。完成记录写入失败尝试保存 unknown，不交付音频，持续写入故障保留 pending 等下次启动核对。停止和适配器自行超时统一 unknown，不泄露上游异常正文，不自动重试；仍未结束的本机适配器继续保持串行锁。使用量保留最多 40 天，调用最多 500 条。

`/api/speech/speak` 的连接关闭只中断该请求自己创建的 controller，被拒绝的重复请求不能取消原请求。合成返回后检查 AbortSignal、来源消息 hash/完成状态、伙伴身份及恢复标记；同 ID/正文被带入另一个伙伴或同身份恢复也不能接受旧音频。`restoreVersion` 仅驻留进程，成功恢复更新、事务失败回滚，朗读状态以 `historyId` 返回；不落盘、不进备份/同步，不改 schema 3/v1。页面首次载入或身份/恢复标记改变时重置已见回复基线，不把恢复的旧历史自动朗读；平常新回复仍按开关尝试。页脚同步更新为 0.24。

新增 13 项 Node 测试，包含非法开关、初始及完成落盘失败、持续落盘故障、取消后迟到拒绝和串行锁、自行超时、跨身份/同身份恢复、失败恢复标记回滚、实际 HTTP 断开/鉴权/Origin/重复请求隔离、独立文字聊天、日志隐私与保留上限。先运行新测试复现了 8 项失败、3 项通过，记录为 `artifacts/speech-lifecycle-before.log`；修复后原有朗读和服务测试一并通过。最终 `npm test` **315 项全部通过**，`npm run check` **123 文件通过**，证据为 `artifacts/node-tests-speech-safety-complete.log`、`artifacts/check-speech-safety-complete.log`。

新增共享 `desktop/speech-safety-smoke.mjs` 的 17 项检查，Edge 入口为 `node scripts/browser-smoke.mjs --speech-safety`，使用真实 localhost HTTP、生产 WAV 适配器与合成静音音频，恰好六次明确请求，无真实模型。验证等待按钮、重复点击、实际中断上游、结果未知、已缓冲响应停止后不播放、正常音频与释放、失败保留文字、来源变化/离开页面中断、记录保留，以及同身份/不同身份恢复不自动朗读。最终 Edge 证据为 `artifacts/speech-safety-browser-verified.log`，页面错误为空。

完整图片与伴侣浏览器回归通过，证据为 `artifacts/image-browser-speech-safety.log`、`artifacts/companion-browser-speech-safety-final.log`。首次伴侣回归在记忆列表重载间隙读取空标签失败，改为等待标签实际出现后通过，保留 `artifacts/companion-browser-speech-safety.log`。Electron 全套 `--upgrade --upgrade-v2` 通过，含新 17 项、前轮图片检查、双窗口、凭据、布局、换钥及实际 0.7.0/0.14.0 旧库与备份升级、降级阻止和重启，渲染错误为空；证据为 `artifacts/desktop-speech-safety-final.log`。等待界面截图为 `artifacts/speech-waiting-browser.png` 和 `artifacts/speech-waiting-desktop.png`，均已查看；最初桌面截图捕获前一帧，增加双帧等待后，标准 Electron 全套再次通过（`artifacts/desktop-speech-safety-visual.log`），截图显示等待文案和可用停止按钮。

没有真实声音或服务计费验收，没有重建安装包、实际安装/卸载、提交或推送。最近验证安装包继续为 0.19.0。原首版的真实形象/模型、Nextcloud、实体双 Windows、长期体验、安装器、许可和发布待办保留。

## 0.23.0 源码：图片调用持久记录与停止等待

补齐实验台刷新后丢失图片调用记录的问题。`core/image-generation.mjs` 在校验参考图、动作与连接后，先原子保存本机 pending 记录及每日图片尝试计数，再调用生产图片适配器。成功为 completed，服务错误为 failed，停止或超时为 unknown；记录已返回不表示通过外观检查或采用。记录只保存动作、模型、服务 origin、时间和状态，不含图片、提示词、密钥、私有 URL 路径或提供商异常正文。初始记录写入失败不会调用上游；完成记录写入失败报告结果不确定，尽可能保存 unknown，持续故障保留 pending 并由下次重启改为 unknown。

实验台新增“停止等待本次生成”，离开页面也中断；本机响应连接关闭及 180 秒超时将信号传给图片适配器。忽略取消的迟到结果不交付，串行锁在本机适配器结束后释放，停止和失败均不自动重试。加入伙伴、恢复备份与图片请求互斥，异步恢复期间也不能启动新图片请求，避免清除进行中的调用记录。

首页设置“备份与调用”现在显示图片动作的中文名称及状态，刷新后仍保留。界面说明失败、停止或未知均可能已计费，已返回仍须人工检查/采用。底层最多 500 条调用记录，首页展示最近 30 条，图片使用量按原规则保留 40 天。调用记录不进入完整备份或同步；每日使用量仍随原有备份规则保留。schema 3、备份/同步 v1 未变化；0.22.0 及更早应用不能读取含新图片调用类型的本机数据库，应先升级应用。

新增 16 项 Node 测试，覆盖调用前落盘、非法输入/认证/旧连接不计次、失败不泄密/不重试、预先取消、迟到结果、HTTP 超时与串行锁、断开请求、适配器自行超时、两类落盘故障、身份替换、恢复互斥、保留上限、同步投影不变，以及实际 SQLite 重启和中断修复。最终 `npm test` **302 项通过**，`npm run check` **121 文件通过**；证据为 `artifacts/node-tests-image-calls-final.log` 和 `artifacts/check-image-calls-final.log`。

新增共享 `desktop/image-generation-smoke.mjs` 的 15 项界面检查，Edge 专用入口为 `node scripts/browser-smoke.mjs --image-calls`。使用生产适配器与真实 localhost HTTP，三次合成像素请求分别挂起后停止、回显返回后放弃、以及提供商失败；验证实际断开上游、unknown、迟到拒绝、返回不自动采用、放弃保留记录、中文状态、刷新恢复、脱敏及没有额外请求。Edge 最终通过，证据为 `artifacts/image-calls-browser-verified.log`。首次和第二次脚本在首页尚未载入服务状态时过早点击设置，等待首页实际渲染后通过；失败记录保留为 `artifacts/image-calls-browser.log`、`artifacts/image-calls-browser-final.log`。定向测试初次的 SQLite 行查询误用调用 UUID，已按 JSON 中的实际调用 ID 查询修正；后续定向与全套 Node 测试通过。

完整图片、伴侣浏览器回归通过，证据为 `artifacts/image-browser-image-calls.log`、`artifacts/companion-browser-image-calls.log`。Electron 全套 `--upgrade --upgrade-v2` 通过，含新增 15 项、前轮 13 项保存/取消、双窗口、历史/记忆、发送范围、背景、凭据、布局、换钥及实际 0.7.0/0.14.0 旧库与旧备份升级、旧版本读取阻止和重启，渲染异常为空；证据为 `artifacts/desktop-image-calls-final.log`。

没有真实外部模型或服务计费验收，没有重建/安装/卸载程序，没有提交或推送本轮源码。最近验证安装包继续为 0.19.0。首版原有的真实立绘/服务质量、实体双 Windows、Nextcloud、长期体验、安装器、许可证和正式发行验收继续保留。

## 0.22.0 源码：图片保存并发保护与可取消预览

修复图片采用接口直接覆盖形象的问题。首页单图、素材包和实验台保存现在绑定选择/打开页面时的伴侣 ID 与形象摘要，服务端验证素材及提交时分别核对。其他窗口、同步或恢复已改变依据时返回 409，原编辑可导出，实验台持续提示并禁用保存。成功后推进当前编辑的依据；快速连续导入仍按最新选择排队，只接受本窗口刚完成且依据匹配的写入，不自动跟随外部版本覆盖。摘要缓存随 SQLite 检测到的形象内容变化失效，原对象内修改动作也能更新摘要。

`/api/avatar` 改为 `{ avatar, identityId, expectedAvatarKey }`，成功返回提交后的身份和摘要。缺少依据的旧页面需重新载入；图片接口继续拒绝 Live2D，不能绕过其预览、SDK 就绪和 moc 检查。存储版本 3、形象素材包及备份/同步 v1 不变。

动作预览在准备期间即可关闭，采用按钮等待检查完成。人脸检查、背景处理与位置比较共用该预览的取消信号；关闭、换图及离开页面会释放 Worker，迟到结果不重新打开、解锁旧采用按钮或替换素材。位置 Worker 的取消、超时、错误及发送失败只清理一次。没有 Worker 时仍为有界同步比较，不能中途抢占；取消本机预览不撤销上游已处理或已计费的请求，也不自动重试。

新增 10 项 Node 测试覆盖成功后的依据、畸形或缺失依据、跨身份/跨窗口/背景和原对象内变化、提交前再次核对、SQLite 与同步监听器失败回滚、实际 HTTP 认证/Origin/并发、SQLite 重启和加密备份。最终 `npm test` 286 项全部通过，`npm run check` 118 个 JavaScript 文件通过，证据为 `artifacts/node-tests-avatar-safety-final.log`、`artifacts/check-avatar-safety-final.log`。

新增 `node scripts/browser-smoke.mjs --avatar-safety` 的 13 项检查，通过隔离 Edge 和实际 Electron 的同一组验证：改动后保存及继续保存、重复点击、过时拒绝但仍可导出、关闭人脸与位置比较后的迟到结果、无自动重试、取消/发送失败终止 Worker、预先取消不启动 Worker。专用模式用页面内替身返回一张合成动作，真实上游请求为 0，不证明图像生成质量。Edge 证据为 `artifacts/avatar-safety-browser-final.log`。

完整图片和伴侣浏览器回归分别通过，包含原有真实本机 Worker、人工采用、位置叠加、背景与连续导入顺序，证据为 `artifacts/image-avatar-safety.log`、`artifacts/companion-avatar-safety.log`。Electron 全套源码加 `--upgrade --upgrade-v2` 通过，包含新 13 项检查、双窗口、凭据、布局、换钥，以及实际 0.7.0/0.14.0 旧库和备份迁移、降级阻止与重启；证据为 `artifacts/desktop-avatar-safety-final.log`，渲染异常为空。首次桌面运行因新增测试把函数对象返回到主进程而失败，修正返回值后重跑通过，原失败记录保留在 `artifacts/desktop-avatar-safety.log`。

本轮未构建新安装包、实际安装/卸载、连接真实外部模型或 Nextcloud。首版的真实立绘与模型质量、实体双设备、长期体验和发行条件继续保留。

## 0.21.0 源码：持续维护本机记忆检索索引

从停工记录中的长期记忆检索扩展项继续，实现进程内倒排索引。保留中文分词、英文归一化、相关性权重、确认/近期兜底、30 条和字数预算；查询词通过 posting 集合找到匹配记忆，不再为每个查询词逐条扫描文档。

保存普通聊天、调用记录或记忆元数据时复用未变正文的词条。纠正、撤权、删除、来源失效和冲突会移除旧词条，新增或改写的正文按需重新分词。每次召回仍先检查来源哈希、纠正、期限与权限；过期或时钟回拨不能借缓存绕过检查。恢复与同步替换快照时释放原索引，内外层事务失败也清理临时词条；关闭一个伴侣不清空其他实例。索引不落盘、不进入备份或同步，存储版本 3、备份/远端 v1 格式不变。

新增 13 项自动测试，覆盖与原扫描算法相同的排序/原因/预算、增量分词、权限和来源变化、到期及回拨、纠正/遗忘与旧加密备份、写入失败/晚阶段监听器/外层同步事务回滚、快照替换、真实 HTTP WebDAV 的双方冲突和删除，以及实际 SQLite 重开。草稿预览、真实发送和重生成投影继续共用当前资料规则。`npm test` 现在由 `scripts/test.mjs` 明确只选仓库 `tests/*.test.mjs`，避免发现 `artifacts/` 中的隔离源码副本。

`npm run test:recall` 使用 20,000 条合成消息、4,000 条有来源记忆，逐次断言新旧选取结果相同。在一次本机诊断中，新增聊天后召回约 49.33 / 12.68 ms，修改一条记忆后约 48.23 / 18.74 ms（原扫描 / 倒排索引）。三轮冷启动/修改后的正文分词共 12,000 / 4,001 次；新增聊天不重新分词，改写仅重分该条。热查询存在波动，部分短查询未改善；不是整体聊天耗时或通用性能保证。证据：`artifacts/recall-benchmark-1794647307963/result.json`。核心全量载入/比较、来源校验、最终排序、资产和远端整包传输等限制保留。

最终验证：`npm test` 276 项全部通过，`npm run check` 115 个 JavaScript 文件通过。Edge 完整伴侣浏览器回归通过；Electron 全套源码回归含窗口、凭据、布局、换钥，以及复用真实 0.7.0、0.14.0 夹具的旧库迁移、备份恢复、降级阻止和再次重启通过。没有用当前代码重新生成旧夹具。证据分别为 `artifacts/node-tests-recall-index-final.log`、`artifacts/check-recall-index-final.log`、`artifacts/browser-recall-index-unrestricted.log` 和 `artifacts/desktop-recall-index-final.log`。浏览器流程运行后补充了异常清理与测试入口，最终 Node 和 Electron 已覆盖这些改动。

沙箱内的 Edge CDP 初始化超时、Electron AppContainer ACL 启动失败保留在 `browser-recall-index.log`、`desktop-recall-index.log`；批准后使用同样的隔离测试在沙箱外通过，没有修改系统 ACL 或关闭应用沙箱。未调用真实外部模型、连接实际 Nextcloud、安装/卸载或构建新安装包；最近 0.19.0 包不包含本轮改动。真实服务、实体设备、长期体验和发行条件继续按下方待办验收。

## 0.20.0 源码收尾与公开仓库准备

新增本机二次元人脸检测，固定 MIT animeface LBP 分类器（20 stages / 642 features / 771 weak classifiers），保留完整许可和来源。最长边 640、一次性 Worker、8 秒超时，候选上限 1000；无 Worker 时本机降级。多张脸阻止新单图/新生成图采用；未检出、细节不足或失败明确提示。不是人数、遮挡或身份识别，不替代真实生成验收。

图像和素材包操作使用各自取消信号；页面离开、换图或旧 file.text 晚返回不会覆盖新形象。独立 OpenCV 4.9.0 对照通过单脸、双脸、遮挡、模糊、空白的灰度检测；真实 PNG/RGBA/Worker 流程通过单脸、双脸、未检出、无 Worker 降级、失败提示、取消终止、拒绝坏图保留原形象及旧包竞态，外部请求为 0。证据分别为 `artifacts/animeface-validation.log`、`artifacts/animeface-browser-handoff.log`。

公开源码排除 Cubism SDK、官方测试模型、资料库、凭据、依赖缓存、测试产物与安装包，保留自有导入和播放适配代码、离线 SDK 准备脚本。缺少/不完整 SDK 时聊天和单图仍可运行，Live2D 检查保留，播放/采用禁用，API 返回 503 且不修改形象；不自动下载组件。新启动配置由服务提供静态模块，避免等待异步探测后才注册窗口事件。

本轮图片浏览器与完整伴侣浏览器回归通过，分别记录在 `artifacts/image-browser-handoff.log`、`artifacts/companion-browser-handoff.log`。最终 Node/源码和干净公开源码验证结果见交接记录。此前两次桌面回归在 `layout-write` 折叠检查失败；定位为本轮新增异步状态探测推迟事件绑定，已经修正，保留原日志，不把失败记为通过。

最终验证：112 个 JavaScript 文件通过语法检查；只执行仓库 tests 中的 263 项 Node 测试，全部通过。干净公开源码副本（无 SDK、数据或构建产物）261 项通过、2 项官方 SDK 专属测试跳过，无失败，其完整伴侣浏览器回归也通过。修正后的 Electron 全套源码回归通过（`artifacts/desktop-source-handoff-final.log`），含窗口/凭据/布局/换钥等进程重启。此次没有执行 `--upgrade`、`--upgrade-v2` 或真实模型专用回归。SDK 已接入本机分支与缺 SDK 的公开副本均可正常运行；不把默认跳过当作 SDK 验证。

没有构建 0.20.0 包、实际安装/卸载、调用真实模型或连接实际 Nextcloud。0.19.0 下述包内/旧库升级/真实 Live2D 结果只属于当时版本。没有提交第三方发行申请或接受合同。项目整体许可证仍未选定；公开源码不包含 SDK。

## 已构建：0.19.0 官方 Live2D 播放

新增用户自行导入 Live2D 的实际播放链路。官方 Cubism SDK for Web 5 R5 已固定在项目内，Core 与 shader 保留原字节，Framework 使用 esbuild 0.28.2 编译；组件、来源、SHA-256 和许可在 `prototype/public/vendor/live2d/` 保存。不会在用户预览时从 CDN 下载，也不会执行模型目录中的脚本或音频。选择完整文件夹、映射待机/表情、完成本机可见预览后可采用；主窗口和伴侣小窗共用同一模型，原有人格、聊天、记忆和单图功能保留。

安装包为 `release/NIRIA Setup 0.19.0.exe`，121,565,470 字节，构建于 2026 年 11 月 14 日 01:18（Asia/Taipei）。SHA-256 为 `710C3CC00E8CF22F1C2DD591704866C29968C5C77E53D9B3AE01942429BB1FDF`，同目录保存 `.sha256` 文件，验收汇总为 `artifacts/release-0.19.json`。未签名、实际安装或发布。

`node scripts/verify-package.mjs` 核对 94 个运行文件与源码逐字节一致，清单、锁文件与包内版本均为 0.19.0。只读解包安装器中的 `resources/app.asar`，确认与实际测试的目录版相同；归档 SHA-256 为 `443AA3ADFC02AC5F1301DC81E6D7DF22DBE8189E619ACA794D957C8F74E88859`，证据 `artifacts/installer-payload-0.19.json`。没有运行安装器或修改注册表/快捷方式；这不替代实际安装、覆盖和卸载验收。

使用官方 SDK 中的 Haru 模型完成真实 WebGL 验证，素材不进入安装包和默认伴侣。Edge 真实模型流程的 13 项结果全部通过：透明且可见的首帧、待机像素变化、真实表情映射、减少动态效果下表情立即出现及切回基础画面、采用保留同一伴侣、实际主画布、加密备份恢复、本机 HTTP WebDAV 配对恢复后的字节与播放、页面重载，以及损坏 moc 拒绝替换。证据为 `artifacts/live2d-real-browser.log`，外部模型服务请求为 0，渲染异常为空。

0.19.0 包内程序的 `--packaged --live2d-real` 同样通过：首次进程 13 项结果包括主窗口/小窗真实播放、加密恢复与 WebDAV 恢复，退出后第二进程的 5 项结果核对 SQLite 中同一身份与模型、两个窗口重新绘制且无服务调用；证据 `artifacts/live2d-real-packaged.log`。该 WebDAV 是本机真实 HTTP 测试服务，不是 Nextcloud 或第二台实体 Windows。`artifacts/live2d-real-desktop.png` 已查看，显示官方测试素材。

完整包内回归 `--packaged --upgrade --upgrade-v2` 全部通过，包含原先聊天、记忆、关怀、图片、形象切换、凭据、布局和换钥，复用真实 0.7.0、0.14.0 的旧库夹具，完成迁移、旧备份、降级阻止及再次重启，渲染异常为空。证据为 `artifacts/desktop-0.19-packaged.log`。Edge 完整伴侣流程也通过，证据为 `artifacts/companion-live2d-runtime.log`；形象生成专用浏览器回归最近一次仍为 0.18.0，未将其写成本轮重跑。

最终源码检查：106 个 JavaScript 文件、260 项 Node 测试通过，证据分别为 `artifacts/check-live2d-runtime.log` 与 `artifacts/node-tests-live2d-runtime.log`。新增官方 Core 拒绝损坏 moc、组件清单/字节/摘要核对；采用接口仍检查令牌、Origin、伴侣与形象依据，并在固定组件的受限 VM 内检查 moc。结构夹具不再能通过实际采用接口；低层存储测试继续明确使用不可播放夹具。

实际验证修正了 WebAssembly 就绪与 Framework 求值顺序、SDK R5 预留未使用 shader 槽位，以及零时间下重复淡入混合导致姿态漂移的问题。减少动态效果时不推进待机/物理，表情仍能一次显示并回到基础画面。旧预览取消、换图、上下文丢失等生命周期仍保留，真实异常和第三方模型兼容继续按实际结果验收。

SDK 许可说明已核对并随组件保存。官网将用户可添加模型的应用列为可扩展应用，需专项审核和许可，免费发布不自动豁免；NIRIA 尚未取得该项发行许可，没有提交申请或接受发行合同。Core 是专有组件，项目开源许可尚未确定。README、兼容清单、架构、同步与 [Live2D 操作说明](live2d.md) 已对齐当前实现。完整首版的真实素材/服务、实体设备、长期运行、安装器与正式发布验收继续保留。

## 历史版本：0.18.0 主动关怀与 Live2D 本地检查

已将下述源码改动合入 Windows 开发预览包 `release/NIRIA Setup 0.18.0.exe`，大小 121,438,747 字节，构建于 2026 年 11 月 14 日 00:26（Asia/Taipei）。SHA-256 为 `75D75E3D2FBEFD7C9EBACE41440EBA0BE060FA771242ADB103758AEE36C2C87A`，校验文件为 `release/NIRIA Setup 0.18.0.exe.sha256`，验收摘要为 `artifacts/release-0.18.json`。未签名、安装或发布。

`node scripts/verify-package.mjs` 验证清单、锁文件与包内版本均为 0.18.0，71 个运行文件与源码逐字节一致。使用已有构建工具只解包安装器内的 `resources/app.asar`，其 SHA-256 与已验证的目录版相同，证据为 `artifacts/installer-payload-0.18.json`；没有执行安装器、注册应用或创建快捷方式，这不替代实际安装验收。

0.18.0 包内 `--packaged --upgrade --upgrade-v2` 全部通过，完整输出在 `artifacts/desktop-0.18-packaged.log`。包含 22 项 Live2D 文件/界面/替身生命周期检查、14 项主动关怀检查、原先的双窗口、历史、记忆、发送范围、重生成、背景、凭据、布局与换钥，以及真实 0.7.0、0.14.0 旧库升级、旧备份恢复、较早版本读取阻止和再次重启。渲染错误为空。代码的 99 文件语法及 258 项 Node 测试沿用下方源码验证记录，本轮只变更版本元数据与页脚，未重复运行未改变的单元测试。

重新运行形象专用隔离 Edge 回归通过，证据为 `artifacts/browser-image-0.18.log`；3 次图片替身请求，覆盖单图导入、明确确认、重复点击、单独采用、位置对照、原字节保存、纯色背景处理、390px 及减少动态效果。没有调用真实模型。伴侣浏览器回归已在前一轮源码验证，0.18.0 实际程序再次覆盖该轮新增能力。

安装器只读预检更新为 `artifacts/installer-plan-d43f874e99c14468af165b60738d02ff.json`，执行摘要为 `artifacts/installer-inspect-0.18.json`。检查当时没有既有 NIRIA 注册、目标快捷方式、运行实例及默认伴侣数据库；0.14.0/0.18.0 安装包与旧库夹具可用。未执行计划中的安装、覆盖、卸载或重装；实际系统操作仍等待原先明确授权。

构建最初被沙箱网络阻止；经批准后 electron-builder 获取现有 Electron 构建依赖并完成项目内打包。该批准不涵盖此前被拒绝的 Live2D SDK 请求；没有下载官方 Live2D 库或绕过拒绝。包内导入窗口仅检查文件和设置映射，官方预览/采用继续禁用，服务端缺库采用仍以 503 拒绝。真实 Live2D 播放尚未交付。

README、兼容清单、架构、同步及 Live2D 文档已对齐新包。检查时本机 4217 没有监听进程，本轮没有重启或另建常驻预览进程，未修改 `.niria` 伴侣资料。完整首版保持进行，下方实际素材、服务、实体设备、安装与发布验收均未取消。

## 11 月 14 日源码：Live2D 资料与导入窗口

继续在 SDK 联网授权未得到明确答复时推进本地链路，没有重试或绕过网络审批。新增模型形象结构、待机与表情映射、本地资源解析与 Blob URL 释放、独立播放器和导入窗口。播放器的实际运行库工厂当前明确不可用，预览与采用按钮禁用；服务端采用接口再次检查运行库就绪状态并以 503 拒绝缺库请求。模型检查不代表预览成功，也不会自动替换当前形象。

新形象可由现有 SQLite、加密备份和 WebDAV 版本图承载，保留原文件字节。结构夹具已验证实际重开、存储失败回滚、完整加密恢复、配对恢复、图片/模型双方冲突与明确选择后的收敛。采用检查当前伴侣 ID 与形象哈希，旧预览不能覆盖另一窗口的新形象；备份里的形象冲突候选同样校验。模型原生表情名、文件名和二进制不进入聊天请求。图片实验台遇到模型形象时明确说明，避免按图片数据读取出错。

Edge 伴侣回归已通过新增的 21 项 Live2D 结果，源码 Electron 含双窗口缺库提示共 22 项通过；完整结果分别来自终端输出与 `artifacts/desktop-live2d-source.log`。覆盖多模型选择、本地摘要、资源路径拒绝、关闭/换文件后的迟到读取、另一窗口修改、缺库保留资料与切回图片，以及二维替身下的表情、透明像素、过期回原表情、context 丢失、首次绘制失败、无重试和一次释放。没有运行真实 SDK 或真实可播放模型，不能据此声称 Live2D 播放已交付。

原先的发送范围、重生成、关怀、图片背景、朗读替身、凭据、布局、换钥与两种实际旧库升级回归继续通过。旧库夹具来自真实 0.7.0、0.14.0，未重新生成；存储为 3，备份/同步 envelope 为 v1。较早客户端不认识新形象类型，后续正式开放前需所有设备统一升级。390px 导入检查截图为 `artifacts/companion-live2d-import-mobile.png`，已查看，内容为明确的合成夹具。

本轮没有构建安装包；0.17.0 保持原内容，当前源码与之不同。完整首版仍待官方库与真实模型、真实服务、实体双 Windows、安装器、长期体验和发布许可验收。

最终检查为 99 个 JavaScript 文件通过语法检查、258 项 Node 测试全部通过，完整输出为 `artifacts/node-tests-live2d-state.log`。其中 Live2D 资源导入 15 项、资料/采用/存储/备份/同步 11 项；加密和同步使用本机替身，模型仍为不可播放的结构夹具。

## 11 月 13 日源码：主动关怀修正与 Live2D 导入准备

本轮尚未重新构建安装包，`release/NIRIA Setup 0.17.0.exe` 保持原内容；当前源码与原安装包已有差异，旧的 59 文件逐字节核对仅证明当时的 0.17.0。

主动关怀在发起前和落盘前检查设置与静默时段，用户在输入框输入/聚焦会重置本机活动间隔并取消等待中的问候。即使服务忽略取消，晚到内容也不能加入聊天；新用户消息或关怀设置变化同样拒绝旧结果。普通聊天与记忆整理不因继续打字而被取消。活动接口只接收空对象，受本机会话与 Origin 检查保护；不保存活动、草稿或增加模型调用。界面将连续输入合并为至多每秒一次本机通知，停止页面后取消通知，不在空闲页面自动重试。

新增 `tests/care.test.mjs` 的 14 项测试；当时全部 232 项 Node 测试通过。Edge 伴侣流程与源码 Electron 全套回归通过，新增共享 `desktop/care-smoke.mjs` 的 14 项结果，覆盖输入取消、迟到拒绝、无草稿发送、通知节流、间隔、静默边界、额度、可用问候、普通聊天及草稿保留。关怀流程单列 4 次合成 completion 调用；此前范围与重生成流程仍为 4、3 次，其余伴侣流程为 6 次模型/图片替身及 1 次朗读，无真实外部模型调用。源码真实 0.7.0、0.14.0 旧库升级、重启和较早版本读取阻止均通过。沙箱内 Edge 两次无法启用 CDP，Electron 报 AppContainer ACL 读取阻止；经单独批准在沙箱外执行隔离测试后通过，未改变 ACL、沙箱选项或系统安装。390px 合成截图为 `artifacts/companion-care-mobile.png`。

用户随后新增“允许自行导入 Live2D”。已加入需求基线及 [Live2D 开发记录](live2d.md)，实现独立的本地资源收集与检查模块、只读 CLI 和合成测试；当前未加入应用导入按钮、播放器、持久化、备份与同步。官方运行库版本和随附许可的读取/下载被自动审批拒绝，需要范围明确的用户授权；没有下载依赖或绕过拒绝。此项是待完成工作，不是 Live2D 已交付。

最终本机检查：88 个 JavaScript 文件通过语法检查，247 项 Node 测试全部通过（完整输出 `artifacts/node-tests-live2d-import.log`）。其中 Live2D 导入准备有 15 项测试，包含实际中文/空格目录的只读 CLI、2 MB 合成二进制往返、整组纹理像素和字节预算、读取期间文件改变、取消与未声明字段拒绝。合成 MOC3 仅具有文件头，不可播放；没有真实模型、运行库或渲染兼容性验收。

## 交付验收准备：安装器与兼容清单

本节为 0.17.0 时的历史准备记录；其中未授权及待执行状态，已由上文 0.28.0 的用户明确授权、卸载器修复和实际验收结果更新。

0.17.0 的应用运行代码与安装包保持不变。本轮新增 [配置与兼容清单](compatibility.md)，从当前适配器列出对话、图片、朗读和 WebDAV 的请求/返回要求、限制、配置顺序、实际环境与尚未验证的外部服务；补充 Nextcloud 官方配置入口。没有将本机替身通过写成真实服务兼容。

新增 PowerShell 7 的 `scripts/installer-smoke.ps1`，准备运行实际 0.14.0 安装器、旧库启动、覆盖当前版本、旧资料迁移/重启、包内比较、已安装程序回归、卸载保留、重装恢复与最后卸载。安装路径使用 `artifacts/` 下含中文及空格的目录；资料复用真实 0.14.0 夹具副本。拒绝已有正式注册、快捷方式、运行进程和默认伴侣数据库；只在默认资料目录创建一个独立测试哨兵，清理只处理本次安装及测试文件。

`scripts/desktop-smoke.mjs --executable <NIRIA.exe>` 和 `scripts/verify-package.mjs --directory <目录>` 可指向安装后的程序与归档。语法检查已通过；实际安装后的运行仍待执行。

只读 `-InspectOnly` 已成功，证据为 `artifacts/installer-plan-e044b391edcb4e2ab6dd2781339b628d.json`。当前无 NIRIA 安装注册、目标快捷方式、运行进程及默认伴侣数据库。现有 0.14.0、0.17.0 安装包和旧库夹具可用，分别记录 SHA-256；没有创建计划安装目录、默认资料测试文件或系统注册。

实际安装/覆盖/卸载命令被自动审批拒绝，理由是会修改 Windows 注册表、快捷方式和安装目录，存在清理失败及误删数据的风险；审批认为原“继续实现”授权未明确涵盖这些系统副作用。没有运行等效安装绕过，仍需用户明确授权。此项没有通过验收，完整首版目标继续进行。

另只读检查现有 WSL Debian：Docker 客户端为 20.10.24，但无法连接 `/var/run/docker.sock` 的 daemon；未启动 Docker 服务、安装软件或部署 Nextcloud。因此真实 Nextcloud 与实体双设备验收继续保留。

## 已完成：0.17.0 重生成与配对备份

本轮修正重新回复时提前删除原回复的问题，并修复刚配对后立即备份的恢复边界。安装包 `release/NIRIA Setup 0.17.0.exe` 为 121,426,403 字节，构建于 2026 年 11 月 13 日 15:51（Asia/Taipei）；59 个运行文件与源码逐字节一致。安装包未签名、安装或发布，完整首版目标保持进行。

重新回复现在先用临时状态排除旧回复及其衍生记忆，再发送新请求，原内容继续在本机可读。成功后才在同一资料/同步事务完成新回复、删除旧回复并停用衍生记忆；失败、停止、超时、空正文或本机提交失败保留原内容，仍不自动重试。提交时再次检查来源、完整原回复与最近用户消息，避免覆盖等待期间的编辑、删除、其他版本或新消息；遗忘优先，不恢复旧副本。界面在等待时说明“成功后替换原回复”，失败记录注明原回复保留。所有结果继续保留未发送草稿，重试不增加用户消息。

此前创建配对仅保存空同步图，首次后续修改才生成身份版本，因此刚配对就导出的备份可能无法恢复。现在先完整观察当前资料，原子保存同步版本图与指纹，再交付配对码；保存失败回滚并清理新密钥，允许重新创建。空白及已有消息/记忆的伴侣均可立即导出和恢复，无需额外模型请求或先上传。该修复适用于新导出；此前已经导出的不完整版本图仍可能被校验拒绝，有原资料的设备应升级后重新导出。

本轮验证：

- 82 个 JavaScript 文件通过语法检查，218 项 Node 自动测试通过。新增 15 项重生成测试，覆盖请求排除、等待/失败保留、取消/超时、同事务替换、资料及同步回滚、并发编辑/删除/新版本/新消息、遗忘、空正文、实际 SQLite 重开、旧备份删除优先及两个本机 HTTP WebDAV 客户端的失败保留/成功收敛。
- 新增 3 项配对测试，验证空白/已有资料的立即加密备份在新设备状态中恢复并用原配对码解锁，以及 SQL 写入失败无半完成配对、无伴侣修改并可重试。原纠正回滚测试改为在实际会变化的 `sync_records` 行注入失败，同时检查落盘同步元数据；初次配对图完整后，不应假设每次纠正都更新同步表头。
- 隔离 Edge 的伴侣流程通过，新增共享 `desktop/regeneration-smoke.mjs` 十项结果；源码 Electron 和 0.17.0 包内程序也全部通过。检查原回复等待时可见、原回复/衍生不进入新请求、失败/停止保留、成功替换/停用衍生/清理旧失败、单条用户消息及草稿保留。390px 截图 `artifacts/companion-regeneration-mobile.png` 已查看，均为明确标识的合成资料。
- 新的重生成流程单独记录 3 次受控合成 completion 调用，`regenerationSyntheticCalls: 3`；此前发送范围仍为 `contextSyntheticCalls: 4`。伴侣流程其余为 6 次模型/图片替身请求及 1 次朗读，未调用真实外部服务。形象专用浏览器流程最近一次通过记录仍为 0.16.0，未将其冒充本轮重新验收。
- 源码及 0.17.0 的 `--packaged --upgrade --upgrade-v2` 全部通过，包含双窗口、背景、历史、记忆、发送范围、凭据、布局、换钥与重启；继续复用真实 0.7.0、0.14.0 运行代码生成的旧库，核对旧加密备份、同步版本、降级阻止及完整性。包内渲染错误为空。
- `node scripts/verify-package.mjs` 核对源码、锁文件、包内版本均为 0.17.0，59 个运行文件逐字节一致。存储仍为版本 3，备份与 WebDAV 仍为 v1，无新增迁移。
- 本机预览已重启到 0.17.0；保留原资料，核对新等待文案和现有接口。内容摘要仍为 `c0fdf543a676283fa0c20ae3271fa91c7715dcc44d6f45a54064b81786412222`，当前零条消息、零条记忆，不能作为真实聊天验收。

真实素材/服务、实体设备、长期运行、安装器实际安装与发布等验收继续保留，未安排定时或无人值守任务。

## 已完成：0.16.0 发送范围与草稿

用户已发出“继续”，开发目标保持进行。本轮修正了发送范围没有预留草稿条数/字数、预览可能显示旧记忆，以及回复成功清空等待期间新草稿的问题。安装包 `release/NIRIA Setup 0.16.0.exe` 为 121,425,280 字节，构建于 2026 年 11 月 13 日 15:37（Asia/Taipei）；58 个运行文件与源码逐字节一致。安装包未签名、安装或发布。

`core/chat-service.mjs` 的只读 `previewContext` 将非空草稿放入临时消息投影，再使用实际发送共用的选择逻辑；草稿占用一条消息与相应字符预算，临时来源不落盘。空输入明确说明尚未加入新消息。真正发送仍按当时资料重新选取，预览不会锁定资料或调用模型。

`prototype/public/context-review.js` 统一发送范围与回复引用的核对。修改输入立即清空旧内容，160ms 后重新读取；身份、连接、权限、消息和记忆变化后重新核对。服务端 `previewBasis` 绑定生成结果时的窗口依据，防止另一窗口修改先于通知到达时显示旧正文。两种响应携带实际记忆的 `validUntil`，过期响应直接丢弃；期限到达先清空，再刷新。关闭按钮、Escape 和页面离开取消请求，序号校验拒绝晚到结果，原生关闭事件延迟和快速重开均已覆盖。用户也可以手动“重新核对”。

聊天输入维护修改序号。成功只清除发送后完全没有修改的草稿，等待时新写或改回相同文字仍保留；失败与手动重新回复均保留输入，重试不新增用户消息。本轮保持存储版本 3、加密备份及 WebDAV v1，无需新增迁移。

本轮验证：

- `npm run check` 检查 80 个 JavaScript 文件；200 项 Node 自动测试通过。新增 7 项预览测试，覆盖 24 条消息/字符预算与实际请求一致、空与无效输入、无写入、纠正/权限/期限/遗忘排除、独立窗口依据、引用有效期以及 HTTP 令牌/Origin/路由。
- 两套隔离 Edge 流程通过。新增共享 `desktop/context-smoke.mjs` 的 20 项结果，在 Edge、源码 Electron 及 0.16.0 包内程序均通过，覆盖更改后刷新、关闭及快速重开、错误依据/已过期响应丢弃、到期先清空、无旧正文闪现、预览不调用模型，以及新草稿/重试/成功/失败行为。
- 新的草稿保护流程使用 4 次受控合成 completion 调用，单独记录为 `contextSyntheticCalls: 4`；其余伴侣流程仍为 6 次模型/图片替身请求、1 次朗读，形象流程为 3 次图片替身请求，没有调用真实外部服务。390px 核对对话框截图为 `artifacts/companion-context-mobile.png`，已查看布局，使用明确标识的合成资料。
- 源码 `--upgrade --upgrade-v2` 与 0.16.0 的 `--packaged --upgrade --upgrade-v2` 全部通过，包含双窗口、形象、历史、记忆、凭据、布局、换钥与重启。继续复用真实 0.7.0 和 0.14.0 运行代码产生的旧库，核对完整资料、同步元数据、旧加密备份恢复、旧程序拒绝新库及再次重启；SQLite 完整性检查通过，渲染错误为空。这不代表安装器覆盖安装已验收。
- `node scripts/verify-package.mjs` 核对源码、锁文件与包内版本为 0.16.0，58 个运行文件一致。
- 预览已重启到 0.16.0，`artifacts/verify-preview-history.mjs` 核对新的核对按钮、模块、草稿接口及现有功能可用。伴侣内容摘要仍为 `c0fdf543a676283fa0c20ae3271fa91c7715dcc44d6f45a54064b81786412222`，当前零条消息、零条记忆，不能作为真实聊天验收。

完整首版目标继续进行，真实素材/服务、实体设备、长期运行和发布验收仍列在下方；没有安排定时或无人值守任务。

## 已完成：0.15.0 同步存储拆分

完成下述 0.14.0 背景处理后，进一步消除了已配对设备每次修改时重写整段同步 JSON 的问题。安装包 `release/NIRIA Setup 0.15.0.exe` 为 121,422,270 字节，构建于 2026 年 11 月 13 日 15:09（Asia/Taipei）；当时核对 56 个运行文件与 0.15.0 源码逐字节一致。安装包未签名、安装或发布。

`core/sync-storage.mjs` 将同步表头、实体修订正文、记录顺序、删除标记及本机指纹分表保存。只写变化的行，排序变动不重写未变化的形象和聊天正文，无变化的同步元数据零写入；所有表与伴侣状态保持同一事务，晚阶段失败也一起回滚。没有跨事务基线缓存，避免回滚后漏写。远端仍传输完整加密对象，配对码、备份与 WebDAV v1 格式不变。

本机存储版本升至 3。旧单行快照和 v2 实体表均支持原子升级，保留来源、权限、遗忘、冲突修订与换钥待核对标记，补齐位置索引；失败恢复全部旧表、元数据和版本。较早程序拒绝直接读取新库，不能原地降级。升级前可保留完整加密备份和配对码。

本轮验证：

- 77 个 JavaScript 文件通过语法检查，193 项自动测试通过，新增 14 项同步存储测试。覆盖单条写入、无变化、重排、落盘隐私清理、独立事务/本机编辑/远端提交失败回滚、v2 迁移/重试/索引补齐、未配对状态、损坏保护及实际重开。
- 两种隔离 Edge 流程通过，形象流程 3 次图片替身请求，伴侣流程 6 次模型/图片替身请求及 1 次朗读；真实服务未调用。浏览器脚本改为在同一次检查中定位并点击可用记忆按钮，换钥准备后等待下载按钮可用，避免列表重绘或禁用期间误点；超时诊断不输出配对码。
- 源码和 0.15.0 包内程序的 `--upgrade --upgrade-v2` 均通过，覆盖全部双窗口、背景、记忆、凭据、布局、换钥和重启检查。真实 0.7.0 与 0.14.0 运行代码生成的旧库分别升级至 v3，完整状态/同步元数据与旧加密备份保留，旧程序拒绝新库，再次重启与 SQLite 完整性检查通过。
- `node scripts/verify-package.mjs` 核对源码、锁文件与包内版本均为 0.15.0，56 个运行文件一致。
- 配对诊断使用 2,000 条合成消息与 400 条记忆。旧版追加一条聊天重写 2,099,806 字节同步 JSON；新实现只新增 500 字节记录正文、64 字节指纹及 427 字节表头，另更新 2,376 字节顺序字段，其他正文未改写。这是逻辑字段量，不是磁盘或 WAL 写入量；耗时和顺序移动数量不是通用保证，详见 [本机存储](storage.md)。
- 预览已重新运行于 `127.0.0.1:4217`，实际升级至 v3，完整性检查通过，原有内容摘要仍为 `c0fdf543a676283fa0c20ae3271fa91c7715dcc44d6f45a54064b81786412222`。当前为零条消息、零条记忆，不能作为真实聊天验收。升级前先完成 WAL checkpoint，再保存并核对 `artifacts/preview-before-sync-storage-v3.sqlite`；它是本机开发副本，不是加密伴侣导出。

后续保留下方真实素材、真实服务、实体设备与发布验收，以及核心全量内存处理、单实体版本图整条保存和资产分块的限制。完整首版目标尚未完成；没有安排定时或无人值守任务。旧库升级应继续复用 `artifacts/storage-upgrade-fixture.json` 与 `artifacts/storage-v2-upgrade-fixture.json`，不能用新源码重新生成旧库。

## 已完成：0.14.0 背景处理

此前暂停时未验证的背景异常回退和重开检查已完成，README、图像、架构与存储文档同步更新。安装包 `release/NIRIA Setup 0.14.0.exe` 为 121,420,858 字节，构建于 2026 年 11 月 13 日 14:50（Asia/Taipei）；当时核对 55 个运行文件与 0.14.0 源码逐字节一致。该安装包保留为较早版本，后续拆分同步存储的改动由 0.15.0 提供。

新增实现使用 `image-background.js`、`background-editor.js` 和图像 Worker，在实验台逐张比较原图与已有动作，确认后应用透明显示，可恢复原背景。原始图片字节保留，仅新增可选的 `background: { version: 1, mode: "edge-connected" }` 显示设置；导出、保存、完整加密备份与 WebDAV 同步保留该设置。主窗口及小窗按同一规则显示。开启后，生成动作使用预览过的透明参考图，仍须单独确认一次请求；已采用动作保存经过等比适配及所选对齐的原始素材，以便恢复显示。

该方法只处理与边缘连通的近似纯色背景，不提供语义人物分割。复杂背景、处理后画面过少或不兼容的动作阻止整组采用；已有透明轮廓保守保留。与背景相连的浅色衣服或头发可能受到影响，必须预览后采用。当前素材和像素验证均为合成夹具，没有使用真实用户立绘或真实图片服务。

可读取帧中任一处理失败时，整组恢复原素材显示；播放器按素材标识提示一次，不对同一标识自动重试。实验台保留失败提示并暂停生成，恢复原背景后解除限制。同步发送失败、取消和换图会清理 Worker；晚到结果不能恢复已经移除的形象。没有 Worker 时使用同一算法同步处理。旧客户端可能不应用或在再次保存时丢弃显示设置，使用该功能的设备应统一升级。

本轮验证：

- `npm run check`：74 个 JavaScript 文件通过；`node --test`：179 项通过，包含 13 项背景处理测试。
- 两种隔离 Edge 流程通过，包含实际 Worker 像素、整组回退、原图导出、恢复后解除生成限制，以及同一素材不重复处理、新标识恢复和迟到结果。异常断言同时要求三张素材存在，避免空数组导致误通过。
- 形象流程为 3 次图片替身请求，伴侣流程为 6 次模型/图片替身请求及 1 次朗读。背景预览、采用和恢复不调用模型。390px 截图为 `artifacts/prototype-background-mobile.png`。修正一处浏览器测试的等待条件：新增记忆保存后，先等列表出现再点击编辑。
- 源码 `--upgrade` 与 0.14.0 的 `--packaged --upgrade` 均通过，覆盖实际两个窗口的透明/恢复像素、内部同色细节、保存后两次重开实验台、恢复后再次重开，以及凭据、布局、换钥和真实 0.7.0 旧库迁移/重启。
- `node scripts/verify-package.mjs` 核对源码、锁文件、包内版本为 0.14.0，55 个运行文件一致。
- 预览已重新运行于 `127.0.0.1:4217`，`artifacts/verify-preview-history.mjs` 核对新模块路由与背景界面可用，伴侣内容摘要仍为 `c0fdf543a676283fa0c20ae3271fa91c7715dcc44d6f45a54064b81786412222`。当前为零条消息、零条记忆，不能作为真实聊天验收。

随后已在 0.15.0 检查并改进同步元数据写入开销，见上方记录。下方真实素材、真实服务、实体设备与发布验收继续保留。

## 已落地

- Electron Windows 主窗口、固定 IPC 白名单、独立的透明伴侣小窗、可拖动标题区、收起/展开与托盘菜单。
- 设备独立的窗口位置、大小、最大化、显示、收起和置顶偏好；屏幕外恢复、托盘找回、最小化后打开聊天、小窗显示保留聊天焦点及 Alt+F4 隐藏。
- 窗口偏好格式校验、读取上限、临时文件与重命名保存、损坏回退及未知较新格式只读保护；高 DPI 下原生边界修正及取整误差防累积。
- 一个稳定的伴侣身份，名字、性格、称呼、说话方式和关系设定可保存，自动整理不会改写核心资料。
- SQLite 持久化聊天、记忆与来源、修订和遗忘标记、采用的形象及每日请求计数。
- SQLite 实体表和来源索引，只写入改变的记录；旧快照事务迁移、失败回滚、未知/损坏格式停止打开，以及旧版读取保护标记。
- 存储 v3 的同步表头、修订正文、顺序、删除标记与指纹分表写入，无变化跳过；原子升级 v2，保留同步版本和换钥状态，失败全部回滚。
- 主窗口及小窗只读取最近 120 条消息；聊天回顾每页 60 条双向浏览、本地字串搜索、年份显示及前后聊天定位。
- 聊天版本绑定分页位置，编辑、删除、同步与恢复后重新定位，事务失败恢复版本；取消旧搜索并拒绝晚到响应，关闭回顾时清空结果。
- 主窗口及小窗只读取记忆版本/数量摘要；记忆页每页 60 条双向浏览，本机字串、种类和实际有效状态组合筛选，期限到达时刷新。
- 记忆游标绑定来源、纠正、冲突和到期状态；较早页编辑后按锚点重载，删除或筛选不匹配时回到最近页，取消搜索及离开页面拒绝晚到结果。
- 实际引用记忆按需核对回复上下文和记忆修订/哈希，支持较早记录；改变、过期或删除后不显示旧正文，关闭引用弹窗后清空结果。
- 发送范围计入草稿条数和字数；资料、权限、连接和输入变化后重新核对，到期先清空，传输期间过期及依据改变的结果不展示，关闭后的响应不重新打开。
- 等待回复期间的新草稿保留；成功仅清空未改动的原输入，失败与重试保留草稿，重试不新增用户消息。
- 重新回复成功后才原子替换原回复及停用衍生记忆，失败/停止保留原内容；临时请求排除旧回复，等待期间的编辑/删除/遗忘优先。
- 记忆来源展开时单独读取与校验修订/正文哈希，可查看早于最近消息范围的来源；改变或删除后不显示旧正文。
- 每轮记忆来源检查复用消息索引与哈希，同一状态复用分词；保存修改后清空缓存。事务失败同时回滚资料、来源索引和同步元数据的内存状态。
- 基础 Chat Completions 对话，用户自行配置服务；配置、测试、实际聊天分别执行，不自动调用未授权服务。
- 自动记忆每日上限、来源修订核对、待确认状态、过期规则、纠正和两类独立权限。
- 用户可独立编辑记忆类型与到期时间，长期保留可选；未改动日期保留精确秒数，只改元数据保留来源及确认状态，旧表单不能覆盖已变化条目。
- 正文纠正保留原关联的 ID、修订及哈希，旧来源版本与回复链退出上下文，旧衍生记忆保守停用；整理前和提交前检查阻止状态，元数据或相同正文不改变来源。
- 纠正不依赖原聊天继续有效，保留原关联的独立权限和显式遗忘；过期/删除后保留阻止标记，旧备份恢复保留本机纠正及相同同步空间的对应版本关系。
- 纠正后的原关联可按需展开查看，遗忘清单继续覆盖；快速关闭后重开清单不被延迟关闭事件清除。
- 遗忘前展示分页影响清单，列出记忆、来源和关联回复；预览无写入、可取消，相关变化使旧确认失效。
- 本机、重启、恢复与同步共用删除传播，清除回复衍生记忆正文；逆序/循环关系、此前已删除的关联回复、冲突来源及缺失来源均保留必要标记。
- 最近用户消息编辑、重生成、消息删除、记忆删除和连同来源一起遗忘；旧异步回复和整理不能越过新的来源状态。
- 主动关心默认关闭；运行期间根据本机时间、间隔、每日上限与免打扰控制请求。
- 完整身份、聊天、记忆、删除标记与保存形象的加密备份及恢复；新设备重新配置服务。
- 形象实验台保存到伴侣，首页单图/动作包导入；主界面及小窗可播放呼吸和眨眼。
- 主窗口、小窗和实验台共用透明帧混合，动作帧替换旧轮廓，保留半透明边缘；实验台隐藏后暂停绘制，返回后恢复，不新增模型请求或改写素材。
- 本地 Windows NSIS 构建流程，没有发布或上传。
- 客户端 AES-256-GCM 加密的 WebDAV 状态同步、配对码与空白设备恢复；条件写入能力检查、离线新增合并、版本图冲突选择与删除传播。
- 创建配对即完整保存同步图和指纹，可立即加密备份与恢复；保存失败不留下半完成配对。
- 同一空间的共享密钥轮换：先保存新旧配对码恢复文件，明确确认后有条件重加密当前远端状态，其他设备换码后继续合并；暂停自动同步、退役旧密钥标识及凭据安全保存。
- 换钥结果未知时持久保留不含秘密的标记并暂停上传，重启后使用新码或原码只读核对；远端完成与本机配对码保存失败分别显示。
- 单条记忆撤回同步权限及相关消息撤除；同整数修订的不同正文通过来源哈希区分；上传响应丢失后重启可继续核对。
- 独立 `/audio/speech` 朗读适配、WAV 播放、默认关闭的自动朗读、每日请求上限与过时音频丢弃。
- Windows 系统加密保存对话、图片、朗读和 WebDAV 配置，配对码独立选择保存；默认关闭，不可用时不降级为明文。
- 同地址显式保留原密钥、跨地址拒绝复用、生成请求绑定确认过的图片服务配置；页面不回显已存密钥，支持清除已保存配置。
- 按当前草稿的本地词语相关性记忆检索，可召回更早的相关资料；展示召回原因，不额外调用模型。
- 形象素材变化标识与按需刷新，修复原图相同但动作更新时主窗口及小窗沿用旧素材的问题。
- 聊天及主动关心的同次回复选择已采用表情，主窗口与小窗共用播放器；表情八秒到期、素材绑定、缺失回退、正文与朗读去除有效标记及减少动态效果。
- 经令牌验证的本机状态通知，两个窗口及时更新，事件不携带资料正文；断线重连和定时刷新作为补充。
- 同步时同一毫秒及回复端时钟回拨情况下的消息顺序修复，保持对应用户消息排在回复前。
- 单图导入的空白与纯色拦截、原始尺寸及像素基础提示；PNG 文件头尺寸校验覆盖上传、返回、保存与恢复。
- 等比素材适配、Worker 内小幅平移与缩放建议、取消对齐与叠加对照；采用不保存对照叠加图，坏图保留已有动作。
- 形象实验台自动恢复已保存素材，避免反复导入；异步导入按最后一次选择生效，换图使旧生成确认失效。

## 验证证据

`npm run check` 检查 82 个 JavaScript 文件，`npm test` 共 218 项通过。除了聊天、重新回复、同步、朗读、凭据、本地召回、发送范围、表情、本机通知和图像检查，窗口测试覆盖负坐标、显示器移除、显示器间隙、任务栏偏移、小工作区、锚点缩放、坐标校验、偏好重启、损坏与较新格式、保存失败及高 DPI 取整误差防累积。接口测试不调用真实模型。

0.13.0 新增十二项记忆分页测试：247 条双向遍历无缺漏/重复、索引查询计划、字串/种类/状态组合、来源哈希/纠正/冲突/期限的实际停用判定、输入与游标绑定、较早锚点编辑/删除/恢复、期限跨越与时钟回拨不写入、精简快照和完整备份、监听器与同步提交回滚、较早引用与旧上下文拒绝、本机 HTTP WebDAV 冲突/删除、SQLite 实际重开，以及接口令牌和 Origin。

共享的 `desktop/memory-browser-smoke.mjs` 在隔离 Edge 与实际 Electron 上验证十六项结果：每页上限、窗口精简读取、双向分页、较早页编辑保留位置、删除锚点回到最近页、纯文字显示、组合筛选、停用筛选、晚到搜索、离开清空、关闭引用后清空、较早引用读取、旧引用拒绝、引用及列表到期刷新、无模型请求。Edge 另检查 390px 布局，截图为 `artifacts/companion-memory-browser.png` 与 `artifacts/companion-memory-browser-mobile.png`，使用明确标识的合成资料。原生桌面同时检查主窗口及小窗的状态请求均省略完整记忆。

记忆纠正新增十四项测试：原关联保留、重复纠正、相同正文不解除来源、同修订不同哈希、新来源、旧回复链和旧衍生停用、整理前/过程中纠正或撤权、未召回纠正记忆时的旧回复拒绝、权限独立、纠正后的遗忘和从另一同源条目发起的关联清除、加密恢复和实际 SQLite 重开、旧备份恢复后同步不产生自身冲突、离线整理、已知冲突候选、过期/删除后的阻止及输入校验。无法恢复 0.10.0 及更早客户端已经丢弃的纠正来源，不判断独立消息的语义矛盾。

记忆生命周期新增十四项测试：遗忘清单数量/分页与无写入、相关新衍生或同修订正文变化使旧确认失效、冲突来源合并、缺失来源、普通删除保留聊天、无关来源保留、逆序/循环关系、较强遗忘标记与来源阻止集合、旧加密备份中的未知关联记录、旧不完整标记的重启修复及同步正文清理、离线端已删除回复的衍生清除、事务回滚、类型/期限独立编辑、无效日期与过期表单拒绝、正在生成期间引用期限到达、期限随备份/同步保留，以及接口确认/令牌/Origin。修正此前本机遗忘对回复衍生记忆只停用仍保留正文的问题。

历史新增九项自动测试，覆盖 247 条消息双向遍历无缺漏/重复、中文及英文 ASCII 字串、特殊符号、搜索条件绑定游标、锚点、删除后失效、编辑/恢复、精简快照和全局最近用户消息、事务回滚、较早来源及同修订不同哈希、同步冲突选择/远端删除、接口令牌和 Origin。历史搜索没有全文分词索引，也不做语义召回。

存储测试覆盖旧状态、隐私、删除标记、素材与同步元数据迁移，迁移失败后的结构/数据回滚与重试，中断请求修正，重复打开无写入，单条追加不改写其他表，来源索引更新，事务监听器失败时恢复同步版本关系，旧备份恢复，带冲突修订图的迁移与收敛，损坏/未知/缺表保护，以及重复 ID 修改被原子拒绝。热缓存检索测试覆盖正文纠正、权限撤回、过期和同修订不同正文的来源失效。

较早的合成存储诊断使用 20,000 条消息与 4,000 条记忆，未启用同步，旧快照正文约 12.3 MB；新增消息只插入一行、正文 224 字节，未改写形象。这个数字不含 SQLite 页、索引和 WAL 的开销。首次/再次词语召回在一次本机测量约 54/22 ms；不是通用性能保证，仍会全量载入和比较内存状态。0.15.0 另增加配对诊断，并按记录保存本机同步元数据，见上方 0.15.0 记录及 [本机存储](storage.md)。

新增换钥测试覆盖准备阶段无网络、重复准备保持同一码、未确认拒绝执行、强条件重写、旧码不能解密当前文件、另一端换码后保留离线资料、412 合并重试、上传期间本机修改、PUT 成功/未成功但结果未知、实际数据库重开、只读恢复、停止与任务互斥、本地提交失败、遗忘/隐私不复活及 HTTP 令牌保护。凭据测试验证已存自动开关关闭、换钥后保存新码、本机加密保存失败单独提示，以及安全存储不可用时在远端写入前拒绝保存请求。

`scripts/browser-smoke.mjs --companion` 在隔离 Edge 中覆盖配置时不调用模型、聊天与整理、重复提交、记忆确认、独立朗读与音频控件、配对后上传、另一客户端恢复、冲突选择后收敛、编辑停用、草稿发送范围、加密导出和恢复、刷新后记录、旧记忆召回不增加模型请求、浏览器禁止持久化密钥及 390px 布局。原始形象流程另由默认浏览器测试覆盖。

聊天回顾的浏览器流程还验证窗口只取最近 120 条、分页到较早记录时不出现错误的编辑按钮、搜索与前后定位、延迟旧请求不覆盖新搜索、嵌套编辑后结果清除、删除后无旧正文、来源按需读取、恶意标记作为纯文字显示、关闭时清空结果和 390px 对话框布局。这一流程没有增加模型调用；截图为隔离的合成聊天。

记忆编辑与遗忘的浏览器流程验证元数据保存后来源及待确认状态不变、原 UTC 秒数保留、调整/清除期限、过去时间拒绝、新建临时记忆、同修订正文变化拒绝旧表单、37 条影响清单分页、取消不写入、打开清单期间新衍生记录触发重算、关闭后晚返回结果不显示、清除全部已知衍生正文并保留独立资料，以及 390px 清单布局。该段无模型请求，整套替身调用数不增加。

0.11.0 的浏览器流程还验证真正改动正文后保留可读的原关联、旧消息与衍生记忆不进入上下文、纠正后仍可查看遗忘影响，以及同一 JavaScript 任务内关闭并立刻重开清单。原生 Electron 也实际操作纠正表单、展开来源、取消和执行清单。新截图为 `artifacts/companion-memory-correction.png`；全部来自隔离的合成资料，不代表真实伴侣内容。

浏览器换钥流程验证准备时无 WebDAV 请求、刷新后重新显示同一码、实际下载新旧码恢复文件、保存确认前禁止执行、旧端拒绝解密、新端继续消息合并，以及模拟远端成功但响应丢失后的只读 GET 核对。配对码不出现在普通状态或截图中；恢复文件仅用本机隔离测试空间生成。换钥不调用模型，当前整套替身与合成调用数量见上方 0.17.0 记录。

新增浏览器检查用明确标识为测试的色块帧验证实际画布像素、同次聊天选择表情、小窗无需页面操作接收主动问候、减少动态效果下静止与八秒到期、删除和重载不重放旧表情，以及重新回复使用更新动作素材且不新增用户消息。这些帧只验证播放与刷新，不代表人物或模型生成质量。

0.12.0 的 `desktop/render-smoke.mjs` 在真实 Chromium Canvas 上检查十项结果：完整目标清除旧轮廓、半程透明度与颜色、四分之一透明目标、画面外透明、零/缺失/无效权重回退、绘制状态保留、播放器表情、完整眨眼及返回原图。合成帧的轮廓刻意不同，能够复现旧版本的覆盖重影；不是人物素材或生成质量验证。浏览器同时验证实际主窗口与小窗在表情期间旧轮廓消失，以及实际实验台完成一次闭眼与恢复；隐藏页的绘制次数保持不变，返回后继续增加。原生桌面检查也读取两个实际窗口的画布像素，验证表情替换及来源删除后恢复原图。

图像浏览器流程还验证空白输入拦截、位置偏移测试图的真实 Worker 修正与切换、叠加图不保存为动作、保留原图及其他已采用动作、等比适配、坏替换图不破坏素材、换图作废旧确认。伴侣流程验证首页连续两次导入时，故意延迟的旧保存不会覆盖后选图片；还验证重开实验台自动载入全部素材，保存后的图像字节不变，且没有额外模型调用。

`scripts/desktop-smoke.mjs` 在隔离的实际 Electron 进程中验证主窗口渲染、原生小窗句柄、透明角像素、收起/展开和渲染进程无 Node 权限。还验证实际两个 Windows 窗口经本机通知同时显示表情、正文不含标记、只记一次聊天调用，以及删除来源后同时恢复原图，并检查实际桌面的图片 Worker 位置比较和宽图比例。覆盖实际桌面历史分页、搜索、删除刷新、旧来源展开、主窗口/小窗精简请求；另验证类型/期限表单保留来源、正文纠正后的来源追溯和上下文排除、遗忘数量、取消及执行后衍生正文清除，无额外模型调用。源码运行及 `--packaged --upgrade` 的 0.13.0 包内程序均已通过，包含记忆分页/筛选/引用十六项检查、透明帧十项检查和两个原生窗口的轮廓替换/恢复，未出现渲染异常；源码、锁文件与包内版本均为 0.13.0，全部 52 个运行文件由 `node scripts/verify-package.mjs` 核对与源码逐字节一致。安装包 `release/NIRIA Setup 0.13.0.exe` 为 121,413,552 字节，构建于 2026 年 11 月 13 日 02:55（Asia/Taipei），未签名、安装或发布。

该脚本还会在同一隔离资料目录中启动三次独立 Windows 进程，使用真实 `safeStorage` 保存五类配置、重启恢复、清除后再次重启确认不再恢复；0.13.0 包内程序的三个阶段均已通过。测试只使用固定测试密钥，检查密文不含该明文、伴侣备份不含密钥、启动恢复不产生模型请求。保存服务配置期间，定时主动关心和同步会暂缓，避免使用尚未成功保存的配置。

另有三次独立 Windows 进程验证窗口偏好：保存主窗口和小窗位置、收起与取消置顶，重启核对实际原生边界及小窗按钮状态，再验证最小化不覆盖偏好、打开聊天恢复、显示小窗不抢焦点、屏幕外找回、Alt+F4 隐藏和最大化保存；第三次启动核对隐藏时不创建小窗、最大化恢复及其他偏好保留。三个阶段均无模型请求，源码及 0.13.0 包内程序通过。这些测试运行于同一台 Windows；多显示器几何测试使用合成工作区，不替代实体多屏验收。

换钥另用五次独立 Windows 进程验证实际 `safeStorage`：更换密钥后保存新码、重启恢复并拒绝退役旧码、模拟远端写入成功但响应丢失并清除旧的已存配对码、重启保留待核对状态后只读恢复并安全保存新码、再次重启继续同一伴侣。源码与 0.13.0 包内程序均通过，核对阶段只有 GET，无模型请求。服务端是父测试进程中的本机 WebDAV 替身，不是 Nextcloud 或第二台实体电脑。

升级夹具来自已验证 0.7.0 包中提取的实际运行代码，使用该代码生成旧格式资料库和加密备份。最终 0.13.0 包内 Windows 进程完成迁移后核对完整状态与同步元数据、恢复旧备份并追加消息；另一进程验证 0.7.0 运行代码拒绝新库，再次启动 0.13.0 核对消息、权限和删除仍正确，SQLite 完整性检查通过。升级检查等待首个资料渲染后再判断界面，避免以页面初始文字误报。该流程不等于安装器覆盖安装。现有浏览器预览已重启到新后端，前后伴侣内容摘要一致，记忆精简状态/分页、期限字段、遗忘预览、纠正关联界面及透明帧模块已核对可用；该预览当前为零条消息、零条记忆，不能据此声称已验证真实聊天。

自动截图位于 `artifacts/`，普通空界面不含虚构角色，浏览器替身回复不代表真实模型质量。

## 仍未完成的首版工作

1. 用用户实际参考图和图片编辑服务验证形象一致性、自然循环、动作及对齐质量，并验证真实对话模型的表情选择。现有检查仅针对基础像素；自动单人/遮挡/真实清晰度识别、前景分割与局部配准仍待实现。
2. 用真实语音服务验证模型、声音与音频效果；当前适配接口并完成替身测试。
3. 用真实 Nextcloud 与两台实体 Windows 验证同步兼容性、网络切换及长期并发；当前协议、配对与合并已实现并用本机独立客户端验证。
4. 共享密钥轮换已落地，仍需真实服务与实体设备验收；按设备发放/封装密钥及单独撤销协议尚未实现，失去信任设备的 WebDAV 登录权限需在服务端撤销。本地伴侣 SQLite 未加密；远端对象与导出备份已加密，服务配置可选择用 Windows 系统加密落盘。
5. 实体表迁移、旧库升级、聊天窗口有限读取、历史及记忆分页/搜索、本机同步元数据按记录保存，以及 0.21.0 的进程内检索索引维护已完成；核心仍全量载入/复制/比较状态与修订图，来源校验和最终排序仍遍历资料，快照替换会重建词条，单实体图仍整条保存，资产分块与远端增量处理待完成。当前按词语相关性召回，尚无深层语义检索。
6. 实体多显示器切换、跨屏拖动及不同 DPI 的长期焦点/置顶体验、长期运行、安装/卸载/覆盖安装实测，以及独立加密实现复核。
7. 开源许可证、依赖/素材许可说明与发布准备。
8. Live2D 官方运行库已接入，官方 Haru 已完成真实预览采用、双窗口、加密备份与本机 HTTP WebDAV 恢复后的播放及 SQLite 重启；仍需用户实际模型、其他 GPU/实体设备、真实 Nextcloud 和长期体验验收。官网可扩展应用发行许可尚未取得，不能将开发预览当作已获准正式发布。

Windows 安装包是开发预览，构建成功不等于安装、升级和两端同步验收完成。手机端仍按已确认计划延期。
