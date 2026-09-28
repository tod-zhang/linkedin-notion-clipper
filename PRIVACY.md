# 隐私政策 · Privacy Policy

**LinkedIn → Notion 剪藏** · 更新日期 / Last updated: 2026-09-27

## 中文

「LinkedIn → Notion 剪藏」是一个浏览器扩展，用于把你正在浏览的 LinkedIn 动态或文章（文字和图片）保存到你自己的 Notion 数据库。

### 处理哪些数据

- **Notion 集成令牌**：你在设置页填写的令牌，用于调用 Notion 官方 API。
- **你选择剪藏的内容**：仅在你点击剪藏按钮时，读取该条动态或文章的文字、图片、作者、发布时间和链接。
- **扩展设置**：你选择的数据库和字段对应关系。

扩展不会读取你的浏览记录，不会读取其他网站，也不会在你没有点击时读取任何内容。

### 数据去向

- 剪藏内容只发送到 Notion 官方 API（`api.notion.com`），写入你自己选择的数据库。
- 图片从 LinkedIn 图片服务器（`media.licdn.com`）下载，然后上传到你的 Notion。
- 开发者没有任何服务器，不接收、不存储、也无法查看你的令牌或剪藏内容。
- 不出售、不出租、不与任何第三方共享数据，不用于广告、分析或任何与剪藏无关的用途。

### 存储与同步

令牌和设置保存在浏览器的扩展存储（`chrome.storage.sync`）中。如果你开启了浏览器同步，它们会通过你自己的浏览器账号同步到你的其他设备。

### 删除数据

- 卸载扩展即会删除保存在浏览器中的令牌和设置。
- 在 Notion 的「集成」页面删除或撤销该集成，令牌将立即失效。
- 已剪藏到 Notion 的页面属于你，可以随时在 Notion 中删除。

### 联系方式

如有问题，请在本项目的 GitHub 仓库提交 Issue，或通过 Chrome 应用商店页面上的开发者联系方式联系。

## English

"LinkedIn → Notion Clipper" is a browser extension that saves LinkedIn posts or articles you are viewing (text and images) into your own Notion database.

### Data handled

- **Notion integration token** — the token you enter in the settings page, used to call the official Notion API.
- **Content you choose to clip** — only when you click the clip button, the extension reads that post's or article's text, images, author, publish date and link.
- **Settings** — the database you selected and the field mapping.

The extension does not read your browsing history or any other website, and reads nothing unless you click.

### Where data goes

- Clipped content is sent only to the official Notion API (`api.notion.com`), into the database you selected.
- Images are downloaded from LinkedIn's image CDN (`media.licdn.com`) and uploaded to your Notion.
- The developer operates no servers and never receives, stores or sees your token or clipped content.
- Data is never sold, rented or shared with third parties, and is not used for advertising, analytics or any purpose unrelated to clipping.

### Storage and sync

The token and settings are stored in the browser's extension storage (`chrome.storage.sync`). If you enable browser sync, they are synced to your other devices through your own browser account.

### Deleting data

- Uninstalling the extension removes the token and settings stored in the browser.
- Removing or revoking the integration in Notion immediately invalidates the token.
- Pages clipped into Notion belong to you and can be deleted in Notion at any time.

### Contact

Please open an issue in this project's GitHub repository, or use the developer contact information on the extension's Chrome Web Store page.
