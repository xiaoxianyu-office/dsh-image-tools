import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * dsh-image-tools: chat-image bridge + recognition for text-only main models.
 *
 * A text-only model (deepseek-v4-pro/flash) cannot receive an image block: the
 * web upload admission would reject it, and the adapter would too. The main
 * route therefore declares image input only to pass admission, and this plugin
 * enforces, for the configured routes (`stripProviders`):
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
 * Agents on other routes (vision subagents, native multimodal models) are
 * never blocked or stripped.
 */

export const name = "dsh-image-tools";
export const inject = ["attachments", "subagents", "tools"];

const Config = z.object({
  stripProviders: z.array(z.string()).default(["main"]),
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

export function apply(ctx, config) {
  const stripProviders = new Set(config.stripProviders);

  // ── 1. hard-disable native read_image on stripped providers ──────────────
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "read_image") return next();
    const agent = exec.agent;
    if (agent === undefined || !stripProviders.has(agent.options.provider)) return next();
    return {
      kind: "deny",
      reason:
        "read_image 已禁用：当前模型路由为纯文本模型，无法直接查看图片。请改用 image_recognize 工具识图。",
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
          } catch {
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
    if (!stripProviders.has(agent.options.provider)) return decision;
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

        const lines = [`使用 read_image 工具读取图片文件：${target}。`, `任务：${args.question}`];
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
            "You are an image-recognition specialist. 你是识图专家：使用 read_image 工具读取任务中给出的图片文件路径，严格按照任务要求输出详细、准确的中文回答。若任务包含此前的问答记录，请基于它们回答新问题，不要重复已有信息。只做识图与描述，不修改任何文件，不做无关操作。",
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
        } finally {
          await run.dispose();
        }
      },
    }),
  );
}

export { Config };
