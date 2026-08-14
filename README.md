# dsh-image-tools

让纯文本主模型（deepseek-v4-pro / flash，main 路由）具备识图能力的 DSH 插件包：
聊天发图自动落盘 + 原生 `read_image` 禁用 + 对话式 `image_recognize` 识图工具（委派视觉子 agent，如 xiaomi/mimo-v2.5）。

宿主层全局生效，四个 preset（standard / code / minimal / cordis）的会话通用。

## 安装

前置条件：

1. `dsh plugin` 需要 pnpm：`npm i -g pnpm`
2. 模型路由（插件只挂载插件行，路由在设置层，需已存在）：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    xiaomi:
      apiKeyEnv: XIAOMI_API_KEY   # 识图模型路由（目录原生多模态）
    main:                          # 主模型桥接路由：声明图片输入仅用于通过上传准入
      displayName: DeepSeek 主模型（图片桥接）
      apiKeyEnv: OPENCODE_GO_API_KEY
      api: openai-completions
      baseURL: https://opencode.ai/zen/go/v1
      compat: { thinkingFormat: deepseek }
      defaultInput: [ text, image ]
      models: [ ...deepseek-v4-pro / deepseek-v4-flash... ]
agent-default-model:
  provider: main
  model: deepseek-v4-pro
```

3. 识图 token：`~/.dsh/.credentials.yaml` 中 `XIAOMI_API_KEY`

安装：

```bash
dsh plugin --profile web add github:xiaoxianyu-office/dsh-image-tools#v0.1.0
```

安装后**重启 dsh web 服务**生效（插件代码在进程内）。

## 升级（切换到其他 tag）

重复 add 并指定新 tag，不要用 update 选择 Git 引用：

```bash
dsh plugin --profile web add github:xiaoxianyu-office/dsh-image-tools#v0.1.1
```

## 卸载

```bash
dsh plugin --profile web remove @dsh-external/dsh-image-tools
```

卸载后重启服务。插件层（依赖、node_modules、组合行）无残留；
`settings.yaml` 里的 `main` / `xiaomi` 路由与默认模型属于设置层，需手动还原（见上「前置条件」反向操作）。

## 行为

- **read_image 禁用**：main 路由下调用原生 `read_image` 直接返回「已禁用，请改用 image_recognize」——防止图片块进入纯文本端点请求导致 400；
- **发图桥接**：上传图片自动落盘 `<工作区>/uploads/`，消息中显示 `[图片] 文件名`；
- **image_recognize**：必须传针对性读取任务（想从图中获得什么）；同一图片路径再次调用自动衔接此前问答，可持续追问；
- 视觉子 agent（xiaomi 等）不受 read_image 禁用影响。

## 配置

`cordis.patch.yml` 中 `config` 字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `stripProviders` | `[main]` | 禁用 read_image / 剥离上传图片的路由 |
| `uploadsDir` | `uploads` | 图片落盘目录（相对工作区） |
| `provider` | `xiaomi` | 识图子 agent 模型路由 |
| `model` | `mimo-v2.5` | 识图子 agent 模型 |

## 常见问题

- 安装时 pnpm 提示 git 依赖构建脚本被拦（allowBuilds）：本包无构建脚本，正常不会出现；如出现按提示在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 中加入对应 key 后重跑。
- 旧会话历史里已残留含图片消息导致 400：新开会话。
- 会话模型切到非 main 的文本路由：发图会被准入拒绝，保持默认 main 分组。

## License

MIT
