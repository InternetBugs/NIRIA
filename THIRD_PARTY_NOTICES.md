# 第三方组件与源码公开范围

NIRIA 整体许可证尚未选择。本仓库公开自有源码供查看，未以此授予任意使用、修改或再分发许可。第三方文件按各自原始许可证处理，不能套用尚未确定的项目许可证。

## animeface LBP 分类器

- 来源：<https://github.com/nagadomi/lbpcascade_animeface>
- 固定提交：`4433ab1ae1166ea75acfe99eb0f18709dac329a0`
- 原 XML SHA-256：`9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30`
- 许可：MIT，完整版权与许可见 `prototype/public/vendor/animeface/LICENSE.txt`。
- 分发的是按 `scripts/vendor-animeface.py` 转换的 `model.json`，供本机二次元人脸检查使用。JavaScript 检测器不依赖 OpenCV；OpenCV 只用于独立本机参考验证，不随应用分发。

## Live2D Cubism

本仓库不分发 Cubism Core、编译 Framework、shader、SDK 压缩包或官方模型。`prototype/public/vendor/live2d/` 是被 Git 忽略的本机生成目录。导入、播放适配代码及离线准备脚本仍保留。

本机集成固定使用 Cubism SDK for Web 5 R5，Core 采用 Live2D Proprietary Software License，Framework 采用 Live2D Open Software License。两者不是 NIRIA 自有组件，模型另有素材使用条件。取得 SDK 后应核对官方条款，再按 [Live2D 文档](docs/live2d.md) 在本机准备。

允许用户添加模型的应用涉及官方可扩展应用发行许可；目前未取得许可，未提交申请或接受发行合同。源码公开不表示获准发布包含 SDK 的应用。本机构建的 0.25.0 预览包与此前安装包仅供本机开发验证，不上传到仓库或 Releases。详见 [Live2D 许可说明](docs/live2d-license-notice.md)。

## npm 开发与打包依赖

Electron、electron-builder、esbuild 及传递依赖通过 `package-lock.json` 固定，安装时各自附带版权和许可。`node_modules/` 不进入 Git。自行分发二进制前仍需审查打包依赖及第三方通知。
