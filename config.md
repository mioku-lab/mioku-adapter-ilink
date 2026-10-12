---
title: ilink 适配器配置
description: 通过 iLink 协议接入微信 ClawBot，仅支持私聊
fields:
  - key: ilink.instances
    label: 机器人实例
    type: array
    description: 每个实例对应一个扫码登录的微信 ClawBot。登录凭据保存在 data/ilink/<实例名>/，未登录的实例启动后会在日志中输出二维码。
    itemFields:
      - key: name
        label: 实例名
        type: text
        description: 用于区分登录凭据目录，只能包含字母、数字、- 和 _。留空时按顺序命名为 bot1、bot2…
        placeholder: bot1

      - key: nickname
        label: Bot 昵称
        type: text
        description: 在 .status 等处展示的名称，默认与实例名相同。

      - key: autoLogin
        label: 自动扫码登录
        type: switch
        description: 未登录或凭据失效时，在日志中输出登录二维码并等待扫码；关闭后需运行 bunx mioku-adapter-ilink 登录。
        defaultValue: true

      - key: master
        label: 扫码者即主人
        type: switch
        description: 开启后，每次启动会把扫码登录的微信用户写入 mioku.owners（master 权限）；关闭时会移除本适配器写入的那个 id。手动加进 owners 的 id 不受影响。
        defaultValue: false

      - key: allowFrom
        label: 允许的用户
        type: text
        description: 只处理这些微信用户的消息，多个 id 用逗号分隔（形如 xxx@im.wechat）。留空表示不限制——iLink 没有好友门槛，建议填写或配合 access-control.json 使用。
        placeholder: 留空 = 所有人

      - key: autoDownload
        label: 自动下载的媒体
        type: multi-select
        description: 收到消息时自动下载并解密的媒体，以 data URL 形式放在消息段的 url 字段；未勾选的类型可调用 bot.downloadMedia() 按需下载。
        defaultValue: ["image", "record"]
        options:
          - value: image
            label: 图片
          - value: record
            label: 语音
          - value: video
            label: 视频
          - value: file
            label: 文件

      - key: mediaMaxMB
        label: 自动下载大小上限（MB）
        type: number
        description: 超过该大小的媒体不会自动下载。
        defaultValue: 20

      - key: baseUrl
        label: API 地址
        type: text
        description: 一般留空，使用登录时下发的地址。
        placeholder: https://ilinkai.weixin.qq.com

      - key: cdnBaseUrl
        label: CDN 地址
        type: text
        description: 媒体上传下载使用的 CDN 地址，一般无需修改。
        placeholder: https://novac2c.cdn.weixin.qq.com/c2c
---

# ilink 适配器配置

通过微信 ClawBot 的 iLink 协议接入个人微信，**仅支持私聊**，收不到群消息。

首次使用推荐在项目目录运行 `bunx mioku-adapter-ilink` 扫码登录；也可以直接启动机器人，按日志中输出的二维码扫码。

## 主人与访问控制

- `master` 打开时，每次启动都会把扫码用户的 id 写进 `mioku.owners`，这个微信用户即拥有 master 权限；改成关闭后，适配器会把自己写入的那个 id 移除。
- `allowFrom` 留空时任何能给这个微信 bot 发消息的人都会进入框架；只想让特定的人使用时，填上允许的 id（或配合 `config/core/access-control.json`）。

```mioku-field
key: ilink.instances
```
