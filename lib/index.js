import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
});

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
  const sessions = new Map();

  function sessionState(sessionId) {
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      entry = { path: null, turns: [] };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

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
    const inUploads = join(cwd, "uploads", basename(input));
    if (existsSync(inUploads)) return inUploads;
    return relative;
  }

  ctx.tools.register(
    defineTool({
      name: "image_recognize",
      description:
        "直接识别一张图片并与识图子 agent 对话：传入图片文件路径（绝对路径/相对路径/文件名均可，文件名会自动到工作区 uploads/ 目录查找），并必须给出针对性的读取任务（说明你想从图片中获得什么，例如：完整读出图中文字、提取报错信息、描述页面布局、核对某个数值）。返回详细的中文回答。当用户发送图片（消息中会以「[图片] 文件名」形式给出）、或你需要理解某张图片/截图的内容时调用。若回答不满足需求，再次调用本工具并传入同一图片路径即可继续同一图片的问答（自动衔接之前的问答记录），不要自己调用 read_image，也不要自己猜测图片内容。",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "图片文件路径：绝对路径、相对路径或文件名。",
        },
        question: {
          type: "string",
          required: true,
          description:
            "针对性的读取任务：说明你想从这张图片中获得什么信息（例如读出全部文字、提取报错、描述布局）。必须提供。",
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
        const target = resolveImagePath(typeof cwd === "string" ? cwd : process.cwd(), args.path);

        const state = sessionState(parent.session.id);
        if (state.path !== target) {
          state.path = target;
          state.turns = [];
        }

        const lines = [
          `使用 read_image 工具读取图片文件：${target}。`,
          `任务：${args.question}`,
          "输出规范（必须严格遵守）：只回答任务提出的问题，不输出额外内容；涉及位置/颜色/尺寸/数量时必须给出精确值（位置用像素坐标或明确方位如「左上角」「距顶边 30px」「水平居中」，颜色给 #RRGGBB 或 rgb()，尺寸数量给具体数字）；禁止使用任何模糊词（偏上、偏下、大概、大约、差不多、一些、部分、看起来、应该、可能等）；图片中没有的内容必须回答「图中未出现」，不得编造或脑补；无法确认时回答「无法从图中确认」并说明原因（模糊/遮挡/截断/分辨率不足）。",
        ];
        if (state.turns.length > 0) {
          lines.push("这是对同一张图片的追问。此前问答记录：");
          for (const turn of state.turns) {
            lines.push(`问：${turn.q}`);
            lines.push(`答：${turn.a}`);
          }
          lines.push("请基于上述问答回答新问题，不要重复已经提供过的信息。");
        }
        lines.push("请直接给出完整、准确的中文回答。");
        const prompt = lines.join("\n");

        const run = await ctx.subagents.start("spawn", {
          label: "识图",
          prompt: [{ type: "text", text: prompt }],
          parent,
          agentOptions: { provider: config.provider, model: config.model },
          persona:
            "You are a rigorous image-analysis specialist. 你是严格的图像识别专家，只依据图片中的实际内容回答，绝不推测、绝不编造、绝不自行发挥。使用 read_image 工具读取任务给出的图片文件路径。硬性规范：1) 只回答任务提出的问题，不输出额外内容；2) 描述必须精确——涉及位置时给像素坐标或明确方位（如「左上角」「距顶边 30px」「水平居中」），涉及颜色时给具体色值（#RRGGBB 或 rgb()），尺寸/数量给具体数字；3) 禁止使用任何模糊词：偏上、偏下、大概、大约、差不多、一些、部分、看起来、应该、可能等一律不得使用；4) 图片中没有的内容必须明确回答「图中未出现」，不得编造或脑补；5) 无法确认时明确回答「无法从图中确认」并给出原因（模糊/遮挡/截断/分辨率不足）；6) 若任务包含此前的问答记录，基于它们回答新问题，不重复已有信息；7) 只做识图与描述，不修改任何文件，不做无关操作。",
          toolFilter: { allow: ["read_image"] },
          signal: exec.signal,
        });
        try {
          const result = await run.result;
          if (result.stopReason !== "completed") {
            throw new Error(`识图子任务未完成：${result.stopReason}`);
          }
          const text = outputText(result.output);
          if (text.length === 0) throw new Error("识图子任务没有产出描述");
          state.turns.push({ q: args.question, a: text });
          // 只保留最近 8 轮问答，避免长对话让子 agent 提示词无限膨胀。
          if (state.turns.length > 8) state.turns = state.turns.slice(-8);
          return text;
        } catch (error) {
          recordDiag("RECOGNIZE_FAILED", `识图失败：${String((error && error.message) || error)}`);
          throw error;
        } finally {
          await run.dispose();
        }
      },
    }),
  );

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

  async function testConnectivity() {
    const llm = ctx.get("llm");
    const prepared = await llm.prepareCall({ provider: config.provider, model: config.model, maxTokens: 8 });
    let text = "";
    try {
      for await (const chunk of prepared.stream({
        provider: config.provider,
        model: config.model,
        messages: [{ role: "user", content: [{ type: "text", text: "只回复两个字母：OK" }] }],
        maxTokens: 8,
        signal: AbortSignal.timeout(20000),
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "finish" && chunk.reason === "error") throw new Error("模型返回错误 finish");
      }
    } catch (error) {
      throw new Error(String((error && error.message) || error));
    }
    if (text.trim().length === 0) throw new Error("模型无输出");
    return text.trim();
  }

  function trusted(req) {
    const addr = req.socket && req.socket.remoteAddress;
    if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
    const raw = String((req.headers && req.headers.host) || "").toLowerCase();
    const name = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  }

  const webServer = ctx.get("webServer");
  if (webServer) {
    const route = (path, handler) => ctx.effect(() => webServer.register({ kind: "exact", path, handler }));
    route("/image-tools/status", async (req, res) => {
      if (!trusted(req)) return json(res, 403, { error: "forbidden" });
      const checks = await selfcheck().catch((error) => [
        { name: "自检", ok: false, detail: String((error && error.message) || error) },
      ]);
      json(res, 200, { onboarded: readState().onboarded === true, checks });
    });
    route("/image-tools/selfcheck", async (req, res) => {
      if (!trusted(req)) return json(res, 403, { error: "forbidden" });
      json(res, 200, { checks: await selfcheck().catch(() => []) });
    });
    route("/image-tools/test", async (req, res) => {
      if (!trusted(req)) return json(res, 403, { error: "forbidden" });
      try {
        const text = await testConnectivity();
        json(res, 200, { ok: true, text });
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
    });
    route("/image-tools/finish", async (req, res) => {
      if (!trusted(req)) return json(res, 403, { error: "forbidden" });
      writeState({ onboarded: true });
      json(res, 200, { ok: true });
    });
    route("/image-tools/diag", async (req, res) => {
      if (!trusted(req)) return json(res, 403, { error: "forbidden" });
      json(res, 200, { at: diagnostics.at, code: diagnostics.code, message: diagnostics.message });
    });
  }
}

export { Config };
