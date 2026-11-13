# NIRIA 使用的 Live2D 组件

Copyright(c) Live2D Inc. All rights reserved.

本地开发预览采用 Cubism SDK for Web 5 R5。组件来源：
https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip

SDK ZIP SHA-256：67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0。

Core 的 `live2dcubismcore.min.js` 按官方原始字节提供，适用 Live2D Proprietary Software License：
https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html

Framework 与着色器适用 Live2D Open Software License：
https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html

Framework 由官方 TypeScript 源码使用 esbuild 0.28.2 编译为本地 ES 模块；着色器保留原始字节。NIRIA 的适配代码另行编写。Core 不是开源组件，不能将 NIRIA 将来的开源许可套用于它。SDK 原附的 sdk-LICENSE.md、core-LICENSE.md、framework-LICENSE.md 同目录保留；manifest.json 记录各分发文件的大小与 SHA-256。

截至 2026 年 11 月 14 日，官网将允许用户添加模型的应用列为可扩展应用，需要专项审核和许可，免费发布也不自动豁免。NIRIA 应沿此路径向官方确认发行条件。目前只进行了本地开发验证，没有取得该项发行许可，也没有提交申请、接受发行合同或公开发布：
https://www.live2d.com/en/sdk/license/

用户导入模型的素材权利另行适用。官方 Haru 模型仅作为 SDK 本机测试素材，不包含在 NIRIA 安装包或默认伴侣中。
