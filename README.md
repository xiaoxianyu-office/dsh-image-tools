# dsh-image-tools

让纯文本模型（deepseek-v4-pro / flash）具备识图能力的 DSH 插件包：
聊天发图自动落盘 + 原生 `read_image` 动态禁用 + 对话式 `image_recognize` 识图工具（委派视觉子 agent，如 xiaomi/mimo-v2.5）。

宿主层全局生效，四个 preset（standard / code / minimal / cordis）的会话通用。

## 动态桥接原理（v0.2.0）

不再配置任何路由列表。插件按**会话当前模型的真实声明**动态判定是否拦截：

- **桥接条件**：模型解析出 image 能力，且该能力来自你在 `settings.yaml` 里的显式声明
  （路由 `defaultInput`、模型条目 `input`、或 `modelOverrides` 的 `input` 含 `image`）。
  手写 image 声明的唯一用途就是放行上传准入，所以**声明即桥接意图**。
- **原生条件**：模型能力来自目录（catalog，如 qwen3.6-plus / grok-4.5 / mimo-v2.5），
  无需任何声明 → 原生多模态链路，不转存、不拦截 `read_image`。

规则：**真多模态模型不要手写 `input` 声明**（目录已提供）；移除声明即关闭该模型的桥接
（恢复纯文本，上传会被准入拒绝）。

## 安装

前置条件：

1. `dsh plugin` 需要 pnpm：`npm i -g pnpm`
2. 模型路由（插件只挂载插件行，路由在设置层，需已存在）：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    xiaomi:
      displayName: 识图模型（MiMo）   # 识图模型分组（目录原生多模态）
      apiKeyEnv: XIAOMI_API_KEY      # key 可自由更换
      baseURL: https://opencode.ai/zen/go/v1
      models:
        - id: mimo-v2.5
          name: MiMo-V2.5
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      modelOverrides:               # 只覆写这两个模型，其余目录模型（qwen/grok）保持原生
        deepseek-v4-pro:
          input: [ text, image ]    # 桥接声明：仅用于放行上传准入
        deepseek-v4-flash:
          input: [ text, image ]
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-flash
```

3. 识图 token：`~/.dsh/.credentials.yaml` 中 `XIAOMI_API_KEY`

安装（**始终使用最新发布 tag**，见仓库 Releases；示例为当前最新 v0.3.7）：

```bash
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-image-tools#v0.3.7
```

安装后**重启 dsh web 服务**生效（插件代码在进程内）。

## 升级（始终切到最新 tag）

升级 = 重复 `add` 并指定**最新的 tag**，不要用 update 选择 Git 引用：

```bash
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-image-tools#v0.3.7
```

## 卸载

```bash
dsh plugin --profile web remove @dsh-external/dsh-image-tools
```

卸载后重启服务。插件层（依赖、node_modules、组合行）无残留；
`settings.yaml` 里的路由与默认模型属于设置层，需手动还原（见上「前置条件」反向操作）。
另外 `~/.dsh/image-tools-state.json`（向导完成标记）为可选清理项。

## 行为

- **read_image 动态禁用**：桥接模型（如 deepseek）调用原生 `read_image` 直接返回
  「已禁用，请改用 image_recognize」——防止图片块进入纯文本端点请求导致 400；
  目录原生多模态模型（qwen/grok/mimo）不受影响，可正常使用 read_image；
- **发图桥接**：桥接模型会话上传图片自动落盘 `<工作区>/uploads/`，消息中显示 `[图片] 文件名`；
  原生多模态会话的图片直接进入模型，不做任何处理；
- **image_recognize**：必须传针对性读取任务（想从图中获得什么）；同一图片路径再次调用
  自动衔接此前问答，可持续追问；
- 视觉子 agent（xiaomi/mimo-v2.5，无声明）不受 read_image 禁用影响；
- **识图输出严格规范**（v0.3.2）：识图子 agent 只回答任务问题，位置给像素坐标或明确方位、颜色给 #RRGGBB 色值，禁止模糊词（偏上/大概/差不多/看起来等），图中没有的内容回答「图中未出现」，不确定回答「无法从图中确认」并说明原因。

## 安装向导与故障自检（v0.3.0）

- **首次安装向导**：升级到 v0.3.0 后重启，页面自动弹出配置向导（shell.overlay 浮层）：
  只读检查识图路由 / API Key / 模型图片能力，可一键「测试识图连通性」
  （真实调用一次识图模型），点「完成，开始使用」后不再弹出（状态存 `~/.dsh/image-tools-state.json`）；
- **故障自动自检**：`read_image` 被拦截、`image_recognize` 失败、图片落盘失败时，
  页面自动弹出自检面板：显示错误原因 + 一键运行自检（路由 / Key / 模型能力）+
  重新测试连通性（真实识图链路：内置测试图 → attachment → 模型读取校验）；
- 以上 host 接口均做**回环地址 + Host 精确校验 + 随机页面令牌**（token 经
  index.html 注入，每次重启变化，请求必须附带）三重校验，并限制请求方法
  （GET 只读 / POST 才执行），本机其他进程无法预知令牌调用接口。

## 配置

`cordis.patch.yml` 中 `config` 字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `uploadsDir` | `uploads` | 图片落盘目录（相对工作区） |
| `provider` | `xiaomi` | 识图子 agent 模型路由 |
| `model` | `mimo-v2.5` | 识图子 agent 模型 |

（v0.2.0 起无 `stripProviders`——桥接路由完全由设置层声明动态决定。）

## 常见问题

- 安装时 pnpm 提示 git 依赖构建脚本被拦（allowBuilds）：本包无构建脚本，正常不会出现；如出现按提示在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 中加入对应 key 后重跑。
- 旧会话历史里已残留含图片消息导致 400：新开会话。
- 会话模型切换：桥接模型（deepseek）走转存 + image_recognize；目录多模态模型走原生。
- 删掉 deepseek 的 `input` 覆写后上传会被准入拒绝（这就是"关闭桥接"的开关）。

## License

MIT
