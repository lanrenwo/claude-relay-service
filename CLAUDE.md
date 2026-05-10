# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Claude Relay Service — 多平台 AI API 中转服务，作为客户端与上游 AI API 之间的中间件。
支持 Claude (官方/Console)、Gemini、OpenAI Responses、AWS Bedrock、Azure OpenAI、Droid、CCR 等账户类型。
核心能力：多账户管理、API Key 认证、统一调度、代理配置、限流、成本统计。

## 架构原则

### Clean Architecture 分层映射

| 层级 | 目录 | 职责 |
|------|------|------|
| **框架层** | `src/routes/`, `src/middleware/` | HTTP 路由、请求验证、响应格式化 |
| **接口适配层** | `src/handlers/`, `src/services/openaiToClaude.js` | 请求/响应格式转换 |
| **用例层** | `src/services/*Scheduler.js`, `*RelayService.js` | 调度逻辑、转发编排 |
| **实体层** | `src/services/*AccountService.js`, `src/models/` | 账户管理、数据模型 |
| **基础设施层** | `src/utils/`, `config/` | 日志、缓存、加密、代理 |

### 开发原则

- **依赖方向**: 外层 → 内层，内层不知道外层存在
- **新增路由**: 只做参数提取和响应格式化，业务逻辑放 service
- **新增服务**: 先确定属于哪一层，遵循该层职责边界
- **格式转换**: 不同 API 格式的转换放 handlers 或专用转换服务
- **数据访问**: 通过 `src/models/redis.js` 统一访问

### 安全约束

- 敏感数据（OAuth token、refreshToken、credentials）必须 AES 加密存储（参考 `claudeAccountService.js`）
- API Key 使用 SHA-256 哈希存储，禁止明文
- 每个请求必须经过完整认证链（API Key → 权限 → 客户端限制 → 模型黑名单）
- 客户端断开时必须通过 AbortController 清理资源和并发计数
- 日志中禁止输出完整 token，使用 `tokenMask.js` 脱敏

## 项目结构

```
src/
├── routes/              # HTTP 路由
│   ├── api.js           # Claude API 主路由
│   ├── admin/           # 管理后台路由（24个子文件）
│   ├── geminiRoutes.js, standardGeminiRoutes.js
│   ├── openaiRoutes.js, openaiClaudeRoutes.js, openaiGeminiRoutes.js
│   ├── azureOpenaiRoutes.js, droidRoutes.js
│   ├── userRoutes.js, webhook.js, unified.js, apiStats.js, web.js
├── middleware/           # auth.js(认证/权限/限流), browserFallback.js
├── handlers/             # geminiHandlers.js
├── services/             # 业务服务
│   ├── relay/                 # 各平台转发服务（9个）
│   ├── account/               # 各平台账户管理（11个）
│   ├── scheduler/             # 统一调度器（4个）
│   ├── apiKeyService.js       # API Key 管理
│   ├── pricingService.js      # 定价和成本
│   └── ...                    # 其余 ~30 个业务服务
├── models/redis.js       # Redis 数据模型
├── utils/                # 35+ 工具文件（logger, proxy, oauth, cache, stream...）
config/config.js          # 主配置
scripts/                  # 运维脚本
cli/                      # CLI 工具
web/admin-spa/            # Vue SPA 管理界面
data/init.json            # 管理员凭据
```

## 核心请求流程

```
客户端(cr_前缀Key) → 路由 → auth中间件(验证/权限/限流/模型黑名单)
  → 统一调度器(选账户/粘性会话) → Token检查/刷新
  → 转发服务(通过代理发送) → 上游API
  → 流式/非流式响应 → Usage捕获 → 成本计算 → 返回客户端
```

关键机制：
- **粘性会话**: 基于请求内容 hash 绑定账户，同一会话用同一账户
- **并发控制**: API Key 级（`concurrencyLimit` 字段，`auth.js` 执行，带排队等待）；OpenAI 账户级待实现（对齐 sub2api `account.Concurrency`）；无 per-image 槽
- **529 处理**: 自动标记过载账户，配置时长内排除
- **加密存储**: 敏感数据（OAuth token、credentials）AES 加密存于 Redis
- **流式响应**: SSE 传输，实时捕获 usage，`req.on('close')` 时先记录已采集用量再销毁上游流

### Codex CLI 生图流程（`openaiRoutes.js` `/responses` 路由）

```
请求到达 → 检测是否 Codex CLI UA → 检查 allowImageGeneration 权限
  → 无权限：移除 tools[] 里的 image_generation 工具
  → 有权限：无条件调用 ensureImageGenerationTool() 注入工具
           + applyCodexImageGenerationBridgeInstructions() 注入 bridge 指令
           + 若 input[] 含图片内容，自动在注入工具上设置 action:"edit"
  → 显式生图意图（gpt-image-* 模型/tool_choice/image_generation 参数）时才预占并发槽
  → 转发上游 → SSE 流中解析 image_generation_call / image_generation.completed 事件
  → imgTracker 去重计数（SHA-256） → response.completed 捕获 tool_usage.image_gen tokens
  → 客户端断开时立即在 cleanup() 中记录用量（不等上游 end/error 事件）
```

**生图权限前提**：API Key 必须设置 `allowImageGeneration: true`，否则工具不注入、bridge 指令不添加，模型会回退到本地 CLI 技能（imagegen skill）。

**Codex UA 区分**：`codexCliPattern = /^(codex_vscode|codex_cli_rs|codex_exec)\//i`。只有匹配此模式的 UA（`isCodexCLI = true`）才跳过 `applyCodexCliAdaptation`（保留客户端原始 instructions）。`Codex Desktop/x.x.x` 不匹配，会触发 adaptation 用 `CODEX_CLI_INSTRUCTIONS` 覆盖原始 instructions，bridge 指令随后追加。

**图片 token 计费原则**（对齐 sub2api）：`tool_usage.image_gen.output_tokens` 是 `output_tokens` 的明细子集，不是额外 token。计费时：`textOutputTokens = outputTokens - imageOutputTokens`，文字按主模型计费，图片按图片模型单独计费，不重叠。

**`src/utils/imageGenerationParser.js`** — 每请求一个 tracker 实例（`createImageGenerationTracker()`），暴露 `{ recordItem, recordCompletedEvent, recordResponseMeta, build }`。`build(reqBody)` 按优先级解析 `toolModel`：`response.tools[].model` → `item.model` → `reqBody` 工具配置 → `'gpt-image-2'`（默认）。过滤 partial image 帧（`partial_image_index` 字段或类型名含 `partial_image`）。

**请求明细元数据**：统一通过 `src/utils/requestDetailHelper.js` 的 `createRequestDetailMeta(req, overrides)` 创建，在 `apiKeyService.recordUsage()` 内部调用 `finalizeRequestDetailMeta()` 补充 `durationMs`（基于 `req.requestStartedAt`）和 `clientIp`（由 `auth.js` 的 `requestLogger` 写入 `req.clientIp`）。

## 开发规范

### 代码风格

- **无分号**、**单引号**、**100字符行宽**、**尾逗号 none**、**箭头函数始终加括号**
- 强制 `const`（`no-var`、`prefer-const`），严格相等（`eqeqeq`）
- 下划线前缀变量 `_var` 可豁免 unused 检查
- **必须使用 Prettier**: `npx prettier --write <file>`
- 前端额外安装了 `prettier-plugin-tailwindcss`

### 开发工作流

1. **理解现有代码** → 读相关文件，了解现有模式
2. **编写代码** → 重用已有服务和工具函数
3. **格式化** → `npx prettier --write <修改的文件>`
4. **检查** → `npm run lint`
5. **测试** → `npm test`
6. **验证** → `npm run cli status` 确认服务正常

### Commit 规范

提交信息使用中文描述，格式：`type(scope): 中文说明`。type 仍用英文（feat/fix/docs/refactor/remove 等），scope 和描述用中文或拼音均可，正文用中文。

### Push 前必做

**每次 push 代码前，必须完成编译验证，确保代码可运行：**

- 修改了后端（`src/`、`config/`）→ `npm run lint:check`
- 修改了前端（`web/admin-spa/src/`）→ `npm run build:web`（dist 不会自动更新，push 旧 dist 会导致线上 UI 停留在旧版本）
- 两者都改了 → 两步都跑

前端 dist 已纳入版本控制，build 产物必须随源码一起提交。

### 测试规范

- 测试文件在 `tests/` 目录，命名 `*.test.js` 或 `*.spec.js`
- 使用 `jest.mock()` 模拟依赖（logger、redis、services）
- `beforeEach` 中 `jest.resetModules()`，`afterEach` 中 `jest.clearAllMocks()`

### 前端要求

- 技术栈：Vue 3 Composition API + Pinia + Element Plus + Tailwind CSS
- 响应式设计：Tailwind CSS 响应式前缀（sm:、md:、lg:、xl:）
- 暗黑模式：所有组件必须兼容，使用 `dark:` 前缀
- 主题切换：`web/admin-spa/src/stores/theme.js` 的 `useThemeStore()`
- 保持现有玻璃态设计风格

暗黑模式配色对照：

| 元素 | 明亮模式 | 暗黑模式 |
|------|----------|----------|
| 文本 | `text-gray-700` | `dark:text-gray-200` |
| 背景 | `bg-white` | `dark:bg-gray-800` |
| 边框 | `border-gray-200` | `dark:border-gray-700` |
| 状态色 | `text-blue-500` / `text-green-600` / `text-red-500` | 保持一致 |

### 代码修改原则

- 先检查现有模式和风格，重用已有服务和工具函数
- 敏感数据必须加密存储（参考 claudeAccountService.js）
- 遵循现有的错误处理和日志记录模式

## 常用命令

```bash
npm install && npm run setup    # 初始化
npm run dev                     # 开发模式（nodemon 热重载，自动 lint）
npm start                       # 生产模式（先 lint 再启动）
npm run lint                    # ESLint 检查并自动修复
npm run lint:check              # ESLint 仅检查不修复
npm run format                  # Prettier 格式化所有后端文件
npm run format:check            # Prettier 仅检查格式
npm test                        # Jest 运行所有测试（tests/ 目录）
npm test -- <文件名>             # 运行单个测试，如: npm test -- pricingService
npm test -- --coverage          # 运行测试并生成覆盖率报告
npm run cli status              # 系统状态
npm run data:export             # 导出 Redis 数据
npm run data:debug              # 调试 Redis 键
```

### 前端命令

```bash
npm run install:web             # 安装前端依赖
npm run build:web               # 构建前端（生成 dist）
cd web/admin-spa && npm run dev # 前端开发模式（Vite HMR）
```

## 环境变量（必须）

- `JWT_SECRET` — JWT 密钥（32字符+）
- `ENCRYPTION_KEY` — AES 加密密钥（32字符固定）
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — Redis 连接

其他可选环境变量见 `.env.example`。

## 故障排除

| 问题 | 排查方向 |
|------|----------|
| Redis 连接失败 | 检查 REDIS_HOST/PORT/PASSWORD |
| 管理员登录失败 | 检查 data/init.json，运行 `npm run setup` |
| API Key 格式错误 | 确保使用 `cr_` 前缀格式（可通过 API_KEY_PREFIX 配置） |
| Token 刷新失败 | 检查 refreshToken 有效性和代理配置，查看 `logs/token-refresh-error.log` |
| 调度器选账户失败 | 检查账户 status:'active'，确认类型与路由匹配，查看粘性会话绑定 |
| 并发计数泄漏 | 系统每分钟自动清理，重启也会清理 |
| 粘性会话失效 | 检查 Redis 中 session 数据，Nginx 代理需添加 `underscores_in_headers on` |
| LDAP 认证失败 | 检查 LDAP_URL/BIND_DN/BIND_PASSWORD，自签名证书设 `LDAP_TLS_REJECT_UNAUTHORIZED=false` |
| Webhook 通知失败 | 确认 WEBHOOK_ENABLED=true，检查 WEBHOOK_URLS 格式，查看 `logs/webhook-*.log` |
| 成本统计不准确 | 运行 `npm run init:costs`，检查 pricingService 模型价格 |

日志：`logs/` 目录。Web 界面 `/admin-next/` 可实时查看。

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.
