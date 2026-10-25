# hello.extension

最小可用的仪表板扩展。

本示例是仪表板加载器直接导入的浏览器模块，因此刻意保留普通 JavaScript；它只存在于源码仓库，不随 npm 包发布。

安装（不改 DSH 配置）：

```bash
mkdir -p ~/.dsh/profiles/web/data/session-dashboard/extensions
cp -r examples/hello-extension ~/.dsh/profiles/web/data/session-dashboard/extensions/hello.extension
```

然后在仪表板里：更多操作 → 仪表板扩展… → 重新加载扩展。每行应出现一个 `✦ hello` 徽标，点开是两行说明。

删除该目录（或在那里面停用它）即可卸载。契约与能力表见仓库根目录的 `EXTENSIONS.md`。
