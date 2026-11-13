# Live2D 导入与播放

更新于 2026 年 11 月 14 日。用户已授权读取官方资料并将播放依赖下载到项目。0.19.0 源码已接入官方 Cubism SDK for Web 5 R5，开放本机预览及确认采用；保留单图和已有动作包功能。当前构建与验收证据见 [开发状态](development-status.md)。

## 使用方法

1. 在主窗口形象区点击“导入 Live2D”，选择完整的导出模型文件夹。
2. 如果包含多个 `.model3.json`，先选择一个。原有相对路径必须完整，不能只提供模型描述文件。
3. 选择待机动作分组，以及微笑、疑惑、害羞各自对应的模型表情。可以不映射；不会根据名字擅自猜测。
4. 点击“本机预览”，检查可见形象、动作与表情。文件检查通过不足以采用；必须完成运行库载入、纹理解码、着色器编译与可见首帧。
5. 确认后“采用这个模型”。主窗口和伴侣小窗共用模型及映射，聊天、人格和记忆保留。模型和映射随本地保存、完整加密备份与可选同步延续。

导入、预览和日常播放不调用模型或生成服务。动作中的音频引用忽略，不会自动播放。模型的原生表情名、路径和二进制不进入聊天请求，沿用已有聊天回复中的一次表情标签。

## 处理范围与边界

支持 Version 3 的 `.model3.json`、`.moc3`、PNG 纹理、动作、表情、物理和姿态资料。官方 Core 继续检查 moc 完整性与其支持的版本；实际测试模型为 SDK 自带 Haru，不表示所有第三方模型都已兼容。旧 `.model.json` / `.moc` 不支持。

用户选择目录后，只收集被所选模型声明的资源，保留原始字节；无关脚本、配置和音频不导入。拒绝 URL、绝对/越界/编码路径、缺文件、大小写或 Unicode 规范化冲突。最多 2000 个选中文件、512 个引用资源、32 MiB 总大小；单文件 16 MiB，JSON 2 MiB；PNG 单边 8192，单张最多 32×1024² 像素，整组最多 64×1024² 像素。显卡更小的纹理上限也会生效。

没有 WebGL、moc 损坏、不支持的版本、纹理解码失败、着色器失败或空白首帧都会阻止采用，原形象保留。同步/恢复得到无法播放的模型时保留资料并说明原因，聊天继续可用；可换回图片。丢失显示上下文后释放实例，不自动反复重载或请求服务，需手动重新预览。

减少动态效果时暂停待机、眨眼、呼吸和物理，保留可立即切换的表情；零时间重绘不再次混合待机动作，避免冻结时间下姿态仍漂移。表情结束或切回原始表情后恢复保存的基础姿态。后台页面暂停连续绘制。

## 实现与复现

公开仓库不附带 SDK；直接克隆时单图与聊天可运行，模型文件检查可用，Live2D 播放及采用明确禁用。缺少或不完整的 SDK 不会阻止应用启动，也不会自动下载。此前本机 0.19.0 构建包含已获准下载的开发组件，但该安装包不公开上传。

要启用本机开发播放，先自行从官方取得 Cubism SDK for Web 5 R5，核对原包 SHA-256：

```text
67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0
```

执行 `npm ci` 后，用下方脚本指向完整解压目录（包含 Core、Framework 和 LICENSE.md），再重启应用。输出全部写入被 Git 忽略的 `prototype/public/vendor/live2d/`，不要强制加入版本控制。该脚本只读取本地 SDK，不代为接受条款或申请发行许可。缺库时默认测试明确跳过两个官方 SDK 专属测试，其余文件/存储/采用保护继续运行。

`live2d-import.js` 收集与检查资源，`live2d-avatar.js` 校验 `niria-live2d-avatar` v1 的包及映射，`live2d-assets.js` 只解析内部资源并释放 Blob URL。`live2d-dialog.js` 管理多模型选择、映射、预览与采用。另一窗口改变伴侣或形象后，旧预览失效。

`AvatarPlayer` 将模型交给 `Live2DPlayer`；`live2d-adapter.js` 先载入本地 Core、等待内嵌 WebAssembly 就绪，再载入 Framework。每个实例使用独立 WebGL 表面、纹理和 shader，映射动作/表情、处理物理与姿态；取消、换图和销毁释放 Core 实例、GPU 资源与本地 URL。SDK 5 R5 缺少单 context 释放接口，因此适配层在固定版本的 shader manager 中移除对应项，不影响其他预览。

服务端采用前核对伴侣 ID 和形象摘要，再在受限 VM 中使用同一官方 Core 检查 moc。VM 只执行固定组件，没有 require、process、文件或网络接口，不执行用户脚本。CSP 仅增加 WebAssembly 编译所需的 `wasm-unsafe-eval`，未开放 JavaScript `unsafe-eval` 或外部脚本。播放依赖与 shader 通过明确的本机静态路径提供，没有 CDN 回退。

官方库固定在 `prototype/public/vendor/live2d/`。Core 与 shader 保留原字节，Framework 由官方 TypeScript 源码编译；manifest 记录 SDK ZIP 来源、SHA-256、编译器及每个输出文件摘要。已下载 SDK 位于项目 artifacts，模型测试素材不进入安装包。重新编译不联网：

```powershell
node scripts/vendor-live2d.mjs "artifacts/cubism-sdk-5-r5/CubismSdkForWeb-5-r.5"
```

只读检查目录，不保存到伴侣：

```powershell
node scripts/inspect-live2d.mjs "D:\Models\角色"
node scripts/inspect-live2d.mjs "D:\Models" "角色/角色.model3.json"
```

CLI 仍只做文件检查，不创建 WebGL 播放实例。真实模型回归需要已下载的官方 Haru 素材：

```powershell
node scripts/browser-smoke.mjs --live2d-real
node scripts/desktop-smoke.mjs --live2d-real
node scripts/desktop-smoke.mjs --packaged --live2d-real
```

测试运行在隔离目录，检查透明首帧、实际动作像素、表情与基础姿态恢复、采用保留伴侣、加密备份及本机 HTTP WebDAV 恢复后的播放。桌面测试另外退出程序再打开同一 SQLite，检查主窗口和小窗。它不代替真实 Nextcloud、实体双 Windows、不同 GPU/DPI 或用户自己的模型验收。

存储 schema 仍为 3，备份和远端 envelope 仍为 v1。0.17.0 及更早版本不认识模型形象；0.18.0 只能保留结构资料，没有官方播放器。使用 Live2D 的设备应升级到 0.19.0 或更新版本。

## 许可与发布

Core 使用专有许可，Framework 使用 Live2D Open Software License，均不是 NIRIA 自有代码。详见随组件保存的 [许可说明](live2d-license-notice.md)。

官网将用户可添加模型的产品列为可扩展应用，需专项审核与许可。NIRIA 的正式发行条件仍需向官方确认；本地集成、测试和构建不表示获得发行许可。没有公开发布、提交申请或接受发行合同。
