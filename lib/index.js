import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * dsh-image-tools: chat-image bridge + recognition for text-only models.
 *
 * A text-only model (deepseek-v4-pro/flash) cannot receive an image block: the
 * web upload admission would reject it, and the adapter would too. The route
 * therefore declares image input only to pass admission, and this plugin
 * enforces the bridge dynamically per agent (`isBridged`), with NO hardcoded
 * provider list:
 *
 * - A model is bridged iff it RESOLVES as image-capable AND that capability
 *   comes from an explicit USER declaration (route `defaultInput`, model entry
 *   `input`, or `modelOverrides[].input` in settings.yaml). Declaring image
 *   input by hand is only ever needed for the admission pass-through, so the
 *   declaration IS the bridge intent.
 * - Catalog-provided image capability (qwen/grok/mimo-v2.5 etc.) needs no user
 *   declaration → native multimodal path, never stripped, read_image allowed.
 *
 * For bridged agents this plugin:
 *
 * 1. `tools/pre-execute` DENIES the native `read_image` tool. A successful
 *    read renders an image block into a `tool/result` message, and tool
 *    results bypass the pre-step inbox (they are appended straight to the
 *    session log), so no message scrub can ever see them — blocking the tool
 *    at dispatch is the only reliable gate, and the model is forced to use
 *    `image_recognize` instead.
 * 2. `agent/pre-step` strips image blocks from the claimed user messages (chat
 *    uploads): each image is resolved through the durable attachment service,
 *    written as a file under `<cwd>/<uploadsDir>/`, and replaced by a short
 *    text note (`[图片] <filename>`) so the main agent can delegate
 *    recognition to the vision subagent. A failed save degrades to a text
 *    note instead of keeping the image block.
 * 3. Registers the `image_recognize` tool: the model passes an image path plus
 *    a TARGETED reading task, and the tool delegates to a vision subagent
 *    (`provider`/`model`, e.g. xiaomi/mimo-v2.5) that reads the file with its
 *    own `read_image` and returns a plain-text answer. Calling it again with
 *    the SAME path is treated as a follow-up question on the same image: the
 *    accumulated Q&A is fed back into the subagent prompt, so the main model
 *    can keep asking for missing details instead of guessing image content.
 *
 * Convention (documented in README): never hand-declare image input for a REAL
 * multimodal model — the catalog supplies it. A hand declaration marks the
 * route as bridged and would strip that model too.
 */

export const name = "dsh-image-tools";
export const inject = ["attachments", "subagents", "tools", "llm", "settings"];

const Config = z.object({
  uploadsDir: z.string().default("uploads"),
  provider: z.string().default("xiaomi"),
  model: z.string().default("mimo-v2.5"),
  batchSize: z.number().default(10),
});

// 识图子 agent 的系统级人格（严格输出规范）。
const RECOGNIZE_PERSONA =
  "You are a rigorous image-analysis specialist. 你是严格的图像识别专家，只依据图片中的实际内容回答，绝不推测、绝不编造、绝不自行发挥。使用 read_image 工具读取任务给出的图片文件路径。硬性规范：1) 只回答任务提出的问题，不输出额外内容；2) 描述必须精确——涉及位置时给像素坐标或明确方位（如「左上角」「距顶边 30px」「水平居中」），涉及颜色时给具体色值（#RRGGBB 或 rgb()），涉及尺寸时用「宽x高」数字格式（如 1920x1080），尺寸/数量给具体数字；3) 禁止使用任何模糊词：偏上、偏下、大概、大约、差不多、一些、部分、看起来、应该、可能等一律不得使用；4) 图片中没有的内容必须明确回答「图中未出现」，不得编造或脑补；5) 无法确认时明确回答「无法从图中确认」并给出原因（模糊/遮挡/截断/分辨率不足）；6) 若任务包含此前的问答记录，基于它们回答新问题，不重复已有信息；7) 只做识图与描述，不修改任何文件，不做无关操作。";

// 每次任务都附带的输出规范（与 persona 双保险）。
const RECOGNIZE_OUTPUT_RULE =
  "输出规范（必须严格遵守）：只回答任务提出的问题，不输出额外内容；涉及位置/颜色/尺寸/数量时必须给出精确值（位置用像素坐标或明确方位如「左上角」「距顶边 30px」「水平居中」，颜色给 #RRGGBB 或 rgb()，尺寸用「宽x高」数字格式如 1920x1080）；禁止使用任何模糊词（偏上、偏下、大概、大约、差不多、一些、部分、看起来、应该、可能等）；图片中没有的内容必须回答「图中未出现」，不得编造或脑补；无法确认时回答「无法从图中确认」并说明原因（模糊/遮挡/截断/分辨率不足）。";

// 连通性测试用的内置测试图：16x16 纯红色 PNG（#E53E3E）。
const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4amdHEmIY1TCqYfhqAABRw2EQVs9UCQAAAABJRU5ErkJggg==";

const MEDIA_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/**
 * 动态桥接判定（无硬编码路由列表）。
 * 模型解析出 image 能力、且该能力来自用户显式声明（路由 defaultInput /
 * 模型条目 input / modelOverrides input）→ 桥接路由，拦截图片。
 * catalog 自带 image 能力（qwen/grok/mimo 等）无用户声明 → 原生，不拦截。
 */
async function isBridged(ctx, agent) {
  const routed = agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? agent?.options?.provider;
  const model = routed?.model ?? agent?.options?.model;
  if (provider === undefined || model === undefined) return false;
  let resolved;
  try {
    resolved = await ctx.llm.resolveModelInfo(provider, model);
  } catch {
    return false;
  }
  if (!resolved.inputModalities?.includes("image")) return false;
  const profile = ctx.settings.get("llm-pi-ai")?.providers?.[provider];
  if (!profile) return false;
  return (
    profile.defaultInput?.includes("image") === true ||
    profile.modelOverrides?.[model]?.input?.includes("image") === true ||
    (Array.isArray(profile.models) &&
      profile.models.some((m) => m?.id === model && m?.input?.includes("image")))
  );
}

export function apply(ctx, config) {
  // ── 0. onboarding 状态 + 诊断记录（供 webServer 路由与自检浮层使用） ────
  const statePath = join(homedir(), ".dsh", "image-tools-state.json");
  const diagnostics = { at: 0, code: null, message: null };

  // 最近一次子 agent（识图）底层错误详情：image_recognize 的 stopReason=error 只给
  // 一个笼统标记，底层真因靠 agent/error 事件带出（model/transport/tool 失败）。
  let lastAgentError = null; // { at, message, stack }

  ctx.on("agent/error", (payload) => {
    if (!payload || !payload.agent) return;
    const err = payload.error;
    const message = err && (err && err.message ? String(err.message) : String(err));
    const stack = err && err.stack ? String(err.stack).split("\n").slice(0, 6).join(" | ") : "";
    lastAgentError = { at: Date.now(), message, stack };
  });

  function recordDiag(code, message) {
    diagnostics.at = Date.now();
    diagnostics.code = code;
    diagnostics.message = message;
  }

  function readState() {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return { onboarded: false };
    }
  }

  function writeState(patch) {
    try {
      mkdirSync(join(homedir(), ".dsh"), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch }, null, 2));
    } catch {
      // 状态文件不可写不阻塞主功能
    }
  }

  // ── 1. hard-disable native read_image on bridged agents ──────────────────
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "read_image") return next();
    if (!(await isBridged(ctx, exec.agent))) return next();
    recordDiag(
      "READ_IMAGE_DENIED",
      "主模型为纯文本能力，read_image 已被拦截，请改用 image_recognize 工具识图。",
    );
    return {
      kind: "deny",
      reason:
        "read_image 已禁用：当前模型为纯文本能力（image 输入仅由桥接声明放行），无法直接查看图片。请改用 image_recognize 工具识图。",
    };
  });

  // ── 2. strip chat-upload images at pre-step ───────────────────────────────
  function refName(ref) {
    if (typeof ref !== "object" || ref === null) return "图片";
    if (typeof ref.name === "string" && ref.name.trim().length > 0) return ref.name;
    if (ref.attachmentId !== undefined) return String(ref.attachmentId).slice(0, 12);
    return "图片";
  }

  async function saveImage(agent, block) {
    const ref = block.attachment;
    if (typeof ref !== "object" || ref === null) return null;
    const stored = await ctx.attachments.readImage(ref);
    const cwd = agent.session.header.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    const dir = join(cwd, config.uploadsDir);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = MEDIA_EXT[stored.ref.mediaType] ?? ".img";
    const base =
      typeof ref.name === "string" && ref.name.trim().length > 0
        ? basename(ref.name)
        : `${String(ref.attachmentId).slice(0, 12)}${ext}`;
    const target = join(dir, `${stamp}-${String(ref.attachmentId).slice(0, 8)}-${base}`);
    writeFileSync(target, stored.data);
    return target;
  }

  async function scrubBlocks(agent, blocks, depth) {
    const out = [];
    for (const block of blocks) {
      if (block && typeof block === "object" && block.type === "image") {
        if (depth === 0) {
          let target = null;
          try {
            target = await saveImage(agent, block);
          } catch (error) {
            recordDiag("UPLOAD_SAVE_FAILED", `图片落盘失败：${String((error && error.message) || error)}`);
            target = null;
          }
          out.push({
            type: "text",
            text:
              target === null
                ? `[图片: ${refName(block.attachment)}（保存失败，图片不可用）]`
                : `[图片] ${basename(target)}`,
          });
        } else {
          out.push({
            type: "text",
            text: `[图片: ${refName(block.attachment)} 已省略；主模型无法直接查看图片，如需识别请调用 image_recognize 工具]`,
          });
        }
        continue;
      }
      if (block && typeof block === "object" && block.type === "tool-result" && Array.isArray(block.content)) {
        out.push({ ...block, content: await scrubBlocks(agent, block.content, depth + 1) });
        continue;
      }
      out.push(block);
    }
    return out;
  }

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    if (!(await isBridged(ctx, agent))) return decision;
    const messages = [];
    for (const message of decision.messages) {
      const content = message.content;
      const touchesMedia =
        Array.isArray(content) &&
        content.some(
          (block) =>
            block &&
            typeof block === "object" &&
            (block.type === "image" || block.type === "tool-result"),
        );
      if (!touchesMedia) {
        messages.push(message);
        continue;
      }
      messages.push({ ...message, content: await scrubBlocks(agent, content, 0) });
    }
    return { ...decision, messages };
  });

  // ── 3. image_recognize tool ───────────────────────────────────────────────
  // Per-session conversation state: sessionId -> { path, turns: [{ q, a }] }.
  // 会话关闭时释放（见下方 session/disposed 监听），避免长期运行无限增长。
  const sessions = new Map();

  function sessionState(sessionId) {
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      entry = { path: null, turns: [] };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  ctx.on("session/disposed", (session) => {
    sessions.delete(session.id);
  });

  function outputText(output) {
    return output
      .map((block) =>
        typeof block === "string"
          ? block
          : block && typeof block === "object" && "text" in block
            ? String(block.text)
            : JSON.stringify(block),
      )
      .join("\n")
      .trim();
  }

  function resolveImagePath(cwd, input) {
    if (typeof input !== "string" || input.trim().length === 0) return input;
    if (input.startsWith("/")) return input;
    const relative = resolve(cwd, input);
    if (existsSync(relative)) return relative;
    // 文件名兜底：在配置的 uploadsDir 下查找（与图片落盘目录一致，支持自定义目录）。
    const inUploads = join(cwd, config.uploadsDir, basename(input));
    if (existsSync(inUploads)) return inUploads;
    return relative;
  }

  ctx.tools.register(
    defineTool({
      name: "image_recognize",
      description:
        "识别图片（支持单张或批量多张）并与识图子 agent 对话：传入图片文件路径（绝对路径/相对路径/文件名均可，文件名会自动到工作区 uploads/ 目录查找）。path 传单个字符串识别一张，或传字符串数组批量识别多张——批量时每批最多 10 张（自动分批），对每张图分别输出「文件名：介绍」，某张读取失败会自动另开识图 agent 重读剩余。必须给出针对性的读取任务（说明你想从图片中获得什么，例如：完整读出图中文字、提取报错信息、描述页面布局、核对某个数值）。当用户发送图片（消息中会以「[图片] 文件名」形式给出）、或你需要理解某张图片/截图的内容时调用。单张场景再次调用同一路径可继续追问（自动衔接之前的问答记录）。不要自己调用 read_image，也不要自己猜测图片内容。",
      parameters: {
        path: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          required: true,
          description: "图片文件路径：单个字符串，或字符串数组（批量识别，每批最多 10 张）。",
        },
        question: {
          type: "string",
          required: true,
          description:
            "针对性的读取任务：说明你想从这些图片中获得什么信息（例如读出全部文字、提取报错、描述布局、核对数值）。必须提供。",
        },
      },
      output: {
        schema: { type: "string" },
        render(_args, value) {
          return [{ type: "text", text: value }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent;
        if (!parent) throw new Error("image_recognize requires a calling agent (exec.agent was undefined)");
        const cwd = parent.session.header.cwd;
        const base = typeof cwd === "string" ? cwd : process.cwd();
        const targets = (Array.isArray(args.path) ? args.path : [args.path])
          .map((p) => (typeof p === "string" ? resolveImagePath(base, p) : null))
          .filter((p) => p !== null);
        if (targets.length === 0) throw new Error("image_recognize 需要至少一个图片路径");

        // 单张：保留追问机制（同路径续问）
        if (targets.length === 1) {
          const target = targets[0];
          const state = sessionState(parent.session.id);
          if (state.path !== target) {
            state.path = target;
            state.turns = [];
          }
          const lines = [`使用 read_image 工具读取图片文件：${target}。`, `任务：${args.question}`, RECOGNIZE_OUTPUT_RULE];
          if (state.turns.length > 0) {
            lines.push("这是对同一张图片的追问。此前问答记录：");
            for (const turn of state.turns) {
              lines.push(`问：${turn.q}`);
              lines.push(`答：${turn.a}`);
            }
            lines.push("请基于上述问答回答新问题，不要重复已经提供过的信息。");
          }
          lines.push("请直接给出完整、准确的中文回答。");
          const text = await runRecognizeSubagent(parent, exec, lines.join("\n"));
          state.turns.push({ q: args.question, a: text });
          // 只保留最近 8 轮问答，避免长对话让子 agent 提示词无限膨胀。
          if (state.turns.length > 8) state.turns = state.turns.slice(-8);
          return text;
        }

        // 批量：分批识别；每张图最多尝试 3 次（含首次），失败的图自动另开
        // agent 重读；最终结果按输入顺序输出每张图的最后一次结果，缺失序号
        // 明确标记「未返回结果」，绝不静默丢弃。
        const finalResults = new Map(); // 原图全局序号 -> { ok, text }
        const attempts = new Map(); // 图片路径 -> 已尝试次数
        let pending = targets.slice();
        const giveUp = [];
        while (pending.length > 0) {
          const batch = pending.slice(0, config.batchSize);
          // 清单序号 = 每张图在原始输入中的全局序号（重读批次也保持一致）。
          const list = batch.map((t) => `${targets.indexOf(t) + 1}. ${t}（文件名：${basename(t)}）`).join("\n");
          const prompt = [
            `使用 read_image 工具逐张读取以下 ${batch.length} 张图片，每张读取后给出该图的中文介绍。`,
            `图片清单：\n${list}`,
            `任务：${args.question}`,
            "输出格式：每张图片一行，行首必须带清单序号，格式为「<序号>.<文件名>：<介绍>；尺寸：<宽>x<高>；主色调：#RRGGBB；副色调：#RRGGBB」。尺寸必须为「宽x高」数字格式（如 1920x1080），主/副色调必须为十六进制颜色代码（如 #2B2B2B），三者都是必填项，不得省略。某张图读取失败时该行写「<序号>.<文件名>：读取失败：<原因>」，不得跳过，必须覆盖清单中的每一张图片。",
            RECOGNIZE_OUTPUT_RULE,
            "请直接输出结果，不需要其他内容。",
          ].join("\n");
          const text = await runRecognizeSubagent(parent, exec, prompt);
          // 解析本轮所有行（成功/失败），后写覆盖 → 每张图保留最后一次结果。
          const failedPaths = [];
          const seenIdx = new Set();
          for (const line of String(text).split("\n")) {
            const idx = parseBatchLine(line, targets.length);
            if (idx === null || seenIdx.has(idx)) continue;
            seenIdx.add(idx);
            const ok = !parseBatchLineStatus(line);
            finalResults.set(idx, { ok, text: line });
            if (!ok) failedPaths.push(targets[idx]);
          }
          // 漏行（本轮清单中存在但未返回任何结果）视为失败，一并重读。
          for (const t of batch) {
            if (!seenIdx.has(targets.indexOf(t))) failedPaths.push(t);
          }
          for (const t of failedPaths) {
            const n = (attempts.get(t) ?? 0) + 1;
            attempts.set(t, n);
            if (n >= 3) giveUp.push(t);
          }
          if (failedPaths.length > 0) {
            recordDiag("RECOGNIZE_BATCH_RETRY", `批量识图中 ${failedPaths.length} 张图片读取失败，自动重读`);
          }
          // 待处理 = 尚未处理过的剩余图片 + 可重试的失败图片（原顺序）。
          pending = [
            ...failedPaths.filter((t) => attempts.get(t) < 3),
            ...pending.slice(config.batchSize),
          ];
        }
        // 按输入顺序组装最终结果；从未返回任何行的图标记为失败。
        const linesOut = [];
        for (let idx = 0; idx < targets.length; idx++) {
          const entry = finalResults.get(idx);
          if (entry === undefined) {
            linesOut.push(`${idx + 1}. ${basename(targets[idx])}：未返回结果（识图子 agent 未覆盖该图片）`);
          } else {
            linesOut.push(entry.text);
          }
        }
        if (giveUp.length > 0) {
          recordDiag("RECOGNIZE_BATCH_FAILED", `${giveUp.length} 张图片多次读取仍失败：${giveUp.map((t) => basename(t)).join("、")}`);
        }
        return linesOut.join("\n");
      },
    }),
  );

  // 解析清单行首序号（全局序号 = 行内序号 - 1）；非法/越界行返回 null。
  function parseBatchLine(line, total) {
    const m = String(line).match(/^\s*(\d+)[.、]\s*[^：:]+：/);
    if (!m) return null;
    const global = Number(m[1]) - 1;
    if (global < 0 || global >= total) return null;
    return global;
  }

  // 判断解析出的行是否为失败行（成功行返回 false）。
  function parseBatchLineStatus(line) {
    return /：(读取失败|无法读取|失败)[：:]/.test(String(line));
  }

  // 公共：spawn 识图子 agent（xiaomi/mimo-v2.5，仅 read_image 工具），前台返回文本。
  async function runRecognizeSubagent(parent, exec, prompt) {
    const run = await ctx.subagents.start("spawn", {
      label: "识图",
      prompt: [{ type: "text", text: prompt }],
      parent,
      agentOptions: { provider: config.provider, model: config.model },
      persona: RECOGNIZE_PERSONA,
      toolFilter: { allow: ["read_image"] },
      signal: exec.signal,
    });
    try {
      const result = await run.result;
      if (result.stopReason !== "completed") {
        const extra =
          result.stopReason === "error" && lastAgentError
            ? `；底层错误：${lastAgentError.message || "（无消息）"}`
            : "";
        throw new Error(`识图子任务未完成：${result.stopReason}${extra}`);
      }
      const text = outputText(result.output);
      if (text.length === 0) throw new Error("识图子任务没有产出描述");
      return text;
    } catch (error) {
      recordDiag("RECOGNIZE_FAILED", `识图失败：${String((error && error.message) || error)}`);
      throw error;
    } finally {
      await run.dispose();
    }
  }

  // ── 4. onboarding 向导 + 故障自检的 host 接口（webServer 路由） ─────────
  async function selfcheck() {
    const checks = [];
    const section = ctx.settings.get("llm-pi-ai");
    const profile = section?.providers?.[config.provider];
    checks.push({
      name: "识图路由",
      ok: Boolean(profile),
      detail: profile ? `${config.provider}/${config.model}` : `settings.yaml 中缺少路由 ${config.provider}`,
    });
    const keyEnv = profile?.apiKeyEnv;
    let keyOk = false;
    let keyDetail = "未配置";
    if (keyEnv) {
      try {
        const credentials = ctx.get("credentials");
        const hit = credentials ? (await credentials.resolve(keyEnv))?.value : undefined;
        keyOk = Boolean(hit && hit.length > 0);
        keyDetail = keyOk ? `已配置（${keyEnv}）` : `未找到 ${keyEnv} 的值，请在模型设置页填写`;
      } catch (error) {
        keyDetail = `解析失败：${String((error && error.message) || error)}`;
      }
    } else {
      keyDetail = `路由 ${config.provider} 未声明 apiKeyEnv`;
    }
    checks.push({ name: "API Key", ok: keyOk, detail: keyDetail });
    let modelOk = false;
    let modelDetail = "未解析";
    try {
      const llm = ctx.get("llm");
      const info = await llm.resolveModelInfo(config.provider, config.model);
      modelOk = info.inputModalities?.includes("image") === true;
      modelDetail = `${config.model} input=${JSON.stringify(info.inputModalities)}`;
    } catch (error) {
      modelDetail = String((error && error.message) || error);
    }
    checks.push({ name: "模型图片能力", ok: modelOk, detail: modelDetail });
    return checks;
  }

  // 真实识图链路测试：内置红色测试图注册为 attachment → 直接 llm 调用带
  // image 块 → 校验模型确实读到图片并返回红色。纯文本调用通过不算通过。
  async function testVisionChain() {
    const llm = ctx.get("llm");
    const attachments = ctx.get("attachments");
    if (!llm) throw new Error("llm 服务不可用");
    if (!attachments) throw new Error("attachments 服务不可用");
    const bytes = Buffer.from(TEST_PNG_BASE64, "base64");
    const ref = await attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: "image/png",
      name: "ito-vision-test.png",
    });
    const prepared = await llm.prepareCall({ provider: config.provider, model: config.model, maxTokens: 64 });
    let text = "";
    try {
      for await (const chunk of prepared.stream({
        provider: config.provider,
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "这是一张纯色测试图。只回答一个颜色名称（中文），不要输出其他内容。" },
              { type: "image", attachment: ref },
            ],
          },
        ],
        maxTokens: 64,
        signal: AbortSignal.timeout(30000),
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "finish" && chunk.reason === "error") throw new Error("模型返回错误 finish");
      }
    } catch (error) {
      throw new Error(String((error && error.message) || error));
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error("模型无输出");
    if (!/红|red/i.test(trimmed)) {
      throw new Error(`识图链路异常：测试图为红色，模型回复「${trimmed.slice(0, 50)}」`);
    }
    return trimmed;
  }

  // 请求信任校验：回环地址 + Host 精确匹配 + 每次启动随机生成的页面令牌
  // （token 经 tapIndex 注入 index.html，浏览器页面读取后随请求附带；
  // 令牌每次重启变化，本机其他进程无法预知）。
  function trusted(req) {
    const addr = req.socket && req.socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
    const raw = String((req.headers && req.headers.host) || "").toLowerCase();
    const name = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
    if (name !== "127.0.0.1" && name !== "localhost" && name !== "::1") return false;
    return (req.headers && req.headers["x-image-tools-token"]) === token;
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  }

  // 每次启动生成页面令牌：注入 index.html 的 meta，浏览器页面读取后随请求附带。
  const token = randomBytes(24).toString("hex");
  const webServer = ctx.get("webServer");
  if (webServer) {
    ctx.effect(() =>
      webServer.tapIndex((html) => html.replace("</head>", `<meta name="image-tools-token" content="${token}"></head>`)),
    );
    const route = (path, method, handler) =>
      ctx.effect(() =>
        webServer.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            if (req.method !== method) return json(res, 405, { error: "method not allowed" });
            if (!trusted(req)) return json(res, 403, { error: "forbidden" });
            return handler(req, res);
          },
        }),
      );
    route("/image-tools/status", "GET", async (req, res) => {
      const checks = await selfcheck().catch((error) => [
        { name: "自检", ok: false, detail: String((error && error.message) || error) },
      ]);
      json(res, 200, { onboarded: readState().onboarded === true, checks });
    });
    route("/image-tools/selfcheck", "GET", async (req, res) => {
      json(res, 200, { checks: await selfcheck().catch(() => []) });
    });
    route("/image-tools/test", "POST", async (req, res) => {
      try {
        const text = await testVisionChain();
        json(res, 200, { ok: true, text });
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
    });
    route("/image-tools/finish", "POST", async (req, res) => {
      writeState({ onboarded: true });
      json(res, 200, { ok: true });
    });
    route("/image-tools/diag", "GET", async (req, res) => {
      json(res, 200, {
        at: diagnostics.at,
        code: diagnostics.code,
        message: diagnostics.message,
        agentError: lastAgentError,
      });
    });
  }
}

export { Config };
