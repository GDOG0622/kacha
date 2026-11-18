# 咔嚓

SillyTavern 楼层生图扩展。点击消息旁的相机，输入提示词或选择预设，按需贴参考图、勾选本楼层或 Char / User 样貌，再点生成。

## 安装

需要同时安装前端扩展和服务端插件，两者来自同一份源码。前端可以在酒馆的「安装扩展」中填入 `https://github.com/GDOG0622/kacha`，服务端插件按下面的步骤安装。

1. 在酒馆服务器上，把仓库的 `plugin` 目录复制为 `SillyTavern/plugins/kacha`，确认该目录里有 `index.cjs`。
2. 在酒馆的 `config.yaml` 打开 `enableServerPlugins: true`，重启酒馆。
3. 在酒馆安装前端，或手动将源码根目录的 `manifest.json`、`index.js`、`style.css` 放进该酒馆账号的第三方扩展目录，例如 `SillyTavern/data/default-user/extensions/kacha`。刷新页面，在消息右上角打开相机。

## 设置

- **自定义**：填 API 基础地址（例如 `https://example.com/v1`）和 Key，点「连接」。下拉显示 `GET /models` 返回的全部模型 ID，选中即保存。此服务由酒馆管理员账号使用。
- **NovelAI**：填 Key 并保存。首版默认用 Anime V3，参考图通过 Vibe Transfer 影响画面。同次使用多张样貌图时，效果取决于模型。
- 自定义服务走 `/images/generations`；加入参考图时走 `/images/edits`。模型和中转需要支持对应接口。
- 「参考本楼层」会用当前酒馆的聊天接口，把按钮所对应的消息提炼为生图提示词。

## 保存与分享

- 出图存于当前浏览器的 `localStorage`。在「记录」点开或删除。空间不足时优先淘汰旧图，单张超出容量时可在当次面板里预览。
- 预设、Char / User 样貌、参考图和服务配置存于该酒馆账号的 `kacha` 数据目录。样貌按角色卡或 Persona 保存。
- 在「预设」可导入或导出 `.kacha.json`。分享文件包含预设名、提示词和参考图。
