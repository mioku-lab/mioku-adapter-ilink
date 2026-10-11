# mioku-adapter-ilink

[mioku](https://github.com/mioku-lab/mioku) 的微信 ClawBot（iLink 协议）适配器：扫码接入个人微信，收发**私聊**消息。

> iLink 是微信 ClawBot 使用的 bot 接口，通过 HTTP 长轮询收消息，不需要公网地址。它只提供私聊，bot 收不到群消息，群相关能力一律不可用。

## 特性

- **扫码登录**：配置向导或启动日志中输出终端二维码，凭据保存在本地，重启免扫码
- **长轮询收消息**：同步游标持久化，重启从断点继续；网络异常自动退避重试
- **凭据失效自愈**：收到 errcode -14 时下线并重新发起扫码，扫码后自动恢复
- **context_token 托管**：iLink 回复必须带回用户最近一条消息的 context_token，适配器自动维护并持久化，重启后仍可主动发消息
- **媒体收发**：图片、语音、视频、文件，CDN 的 AES-128-ECB 加解密由适配器完成
- **长文本分段**：超过 4000 字自动拆分；合并转发拍平为普通消息
- **多账号**：每个实例一个 bot；支持「对方正在输入」状态

## 安装

```bash
bun add mioku-adapter-ilink
```

需要 mioku ≥ 1.2.0、Node.js ≥ 22.18 或 Bun。

## 登录

### 配置向导（推荐）

在机器人项目根目录运行：

```bash
bunx mioku-adapter-ilink
```

用手机微信扫描终端里的二维码并确认。向导会：

- 把凭据写入 `data/ilink/<实例名>/account.json`
- 在 `package.json` 的 `mioku.adapters.ilink.instances` 中登记实例
- 询问是否把扫码的微信用户加入 `mioku.owners`

服务端要求二次校验时，按提示输入手机上显示的数字。再次运行向导并输入已有实例名，即可为该实例重新登录。

### 启动时扫码

也可以直接启用适配器并启动机器人。未登录的实例会在日志中输出二维码（`autoLogin` 默认开启），扫码后自动开始收消息。运行时登录无法输入二次校验的数字，遇到这种情况请改用配置向导，向导写入的凭据会被运行中的实例自动读取。

## 配置

配置位于机器人 `package.json` 的 `mioku.adapters.ilink`：

```json
{
  "mioku": {
    "adapters": {
      "ilink": {
        "instances": [{ "name": "bot1" }]
      }
    }
  }
}
```

单实例可以省略 `instances` 直接写字段，空对象 `{}` 即一个名为 `bot1` 的默认实例。也可以在 WebUI 中按 [config.md](./config.md) 的表单编辑。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | string | `bot1`、`bot2`… | 实例名，决定凭据目录 `data/ilink/<name>`，只能包含字母、数字、`-`、`_` |
| `nickname` | string | 同 `name` | `.status` 等处展示的昵称 |
| `autoLogin` | boolean | `true` | 未登录或凭据失效时在日志输出二维码并等待扫码 |
| `autoDownload` | string[] | `["image", "record"]` | 收到消息时自动下载的媒体：`image` / `record` / `video` / `file`；`true` 为全部，`false` 为不下载 |
| `mediaMaxMB` | number | `20` | 自动下载的单个媒体大小上限 |
| `baseUrl` | string | 登录时下发 | iLink API 地址，一般不用填 |
| `cdnBaseUrl` | string | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN 地址 |
| `routeTag` | string | — | 透传为 `SKRouteTag` 请求头 |

## 主人与权限

iLink 的用户 id 形如 `xxxx@im.wechat`。把主人的 id 加入 `mioku.owners` 才能使用主人指令；配置向导会提示添加扫码者，其他用户的 id 可以从日志 `[私:(xxxx@im.wechat)]` 中获取。

## 能力支持

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| message.send | ✅ | 私聊文本 / markdown / 图片 / 视频 / 文件，语音以文件发送 |
| message.get | ⚠️ | 仅限最近收发的 1000 条消息，以及引用中携带的内容 |
| message.forwardsend | ⚠️ | 拍平为普通消息，昵称不全相同时逐条标注发送者 |
| conversation.gethistory | ⚠️ | 来自最近消息缓存，不下载媒体 |
| friend.getlist / friend.getinfo | ⚠️ | 与 bot 有过会话的用户，没有昵称 |
| group.getlist | ⬜ | 恒为空列表 |
| profile.getavatar | ⬜ | 返回 `null` |
| bot.status | ✅ | |
| message.recall / message.getforward | ❌ | 抛 `UnsupportedCapabilityError` |
| 其余 group.\* / member.\* | ❌ | 抛 `UnsupportedCapabilityError` |
| friend.delete / profile.set / profile.setavatar | ❌ | 抛 `UnsupportedCapabilityError` |

✅ 支持 · ⚠️ 降级实现 · ⬜ 空值 · ❌ 不支持

向 `{ type: "group" }` 目标发送会直接报错「iLink 仅支持私聊」。

## 消息转换

### 接收

事件路由为 `ilink:message.private.friend` 及其上层路由，`is_to_me` 恒为 `true`。

| iLink | 消息段 | 说明 |
| --- | --- | --- |
| 文本 | `text` | |
| 引用 | `reply` | 同时写入 `event.quote_id`，可用 `bot.getMessage()` 查询 |
| 图片 | `image` | 自动下载后 `data.url` 为 `data:image/*;base64,…` |
| 语音 | `record` | `data.url` 为 SILK 音频，`data.text` 为微信语音转文字，`data.duration` 为秒数 |
| 视频 | `video` | 默认不下载 |
| 文件 | `file` | `data.name` / `data.size`，默认不下载 |

未下载的媒体段在 `data.media` 中保留 CDN 引用，调用 `bot.downloadMedia(seg)` 即可得到解密后的 Buffer。`raw_message` 为文本拼接，媒体以 `[图片]`、`[语音]`、`[视频]`、`[文件]文件名` 占位。

### 发送

- `text` / `markdown` 合并为文本，超过 4000 字自动分段，尽量在换行处切开
- `image` / `video` / `file` 上传后单独发送，`record` 以文件形式发送
- 媒体来源支持 Buffer（`base64://`）、data URL、http(s) 链接、`file://` 与本地路径
- `reply` / `at` 直接忽略，`face` 等不支持的段忽略并打印警告
- iLink 一次只能发送一项内容，混合消息会按顺序拆成多条，返回最后一条的 `message_id`

## 平台特有方法

```ts
ctx.handle("ilink:message", async (e) => {
  await e.bot.sendTyping(e.user_id!);

  const file = e.message.find((seg) => seg.type === "file");
  if (file) {
    const data = await e.bot.downloadMedia(file);
  }

  await e.bot.sendApi("getconfig", { ilink_user_id: e.user_id });
});
```

| 方法 | 说明 |
| --- | --- |
| `sendTyping(userId, typing = true)` | 显示或取消「对方正在输入」 |
| `downloadMedia(seg)` | 下载并解密入站媒体段 |
| `sendApi(action, params)` | 调用 iLink 原生接口，`action` 可写 `getconfig` 或 `ilink/bot/getconfig` |
| `client` | 底层 `IlinkClient` |
| `owner_id` | 扫码登录该 bot 的微信用户 |

## 本地数据

每个实例的状态保存在 `data/ilink/<实例名>/`：

| 文件 | 内容 |
| --- | --- |
| `account.json` | bot 凭据（token、账号 id、API 地址、X-WECHAT-UIN），**等同密码，切勿提交或外传** |
| `sync.json` | getupdates 同步游标 |
| `peers.json` | 每个用户最近的 context_token 与活跃时间 |

删除 `account.json` 即可强制重新扫码。

## 已知限制

- 只能私聊：bot 收不到群消息，也没有加好友、撤回、编辑、头像、昵称等接口
- 主动消息依赖 context_token：从未给 bot 发过消息的用户无法主动推送
- 同一凭据同一时间只应有一个进程在长轮询，重新扫码后旧凭据可能失效
- mioku 默认把 15 秒内同一用户的相同内容视为重复消息，可通过 `mioku.dedup.cross_adapter` 调整
- iLink 不是公开的开发者产品，接口可能变化，个人号接入存在被限制的风险，重要业务建议使用企业微信

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 日志出现 errcode -14 | 凭据失效，扫描日志中的新二维码，或运行配置向导重新登录 |
| 主动消息发送失败 | 该用户需要先给 bot 发过消息 |
| 提示需要输入手机上显示的数字 | 运行 `bunx mioku-adapter-ilink` 在向导中完成登录 |
| 收不到群消息 | iLink 只支持私聊，属正常现象 |

## 致谢

协议细节参考腾讯官方的 [@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（MIT）。

## License

[MIT](./LICENSE)
