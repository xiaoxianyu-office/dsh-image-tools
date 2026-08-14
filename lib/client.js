// dsh-image-tools client: onboarding wizard + failure self-check overlay.
// 挂载在 shell.overlay 浮层槽位：
// - 首次安装（host 状态文件 onboarded=false）→ 自动弹出配置向导
// - 识图链路故障（host 记录诊断）→ 自动弹出故障自检面板
// host 接口（同源 fetch，均做回环+Host 校验）：
//   GET  /image-tools/status    { onboarded, checks }
//   GET  /image-tools/selfcheck { checks }
//   POST /image-tools/test      { ok, text | error }
//   POST /image-tools/finish    { ok }
//   GET  /image-tools/diag      { at, code, message }
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-image-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const { useState, useEffect, useRef } = react;

    // CSS（注入一次，随插件生命周期移除）。
    // 定位：卡片中心 = 对话列（中间列）中心，由 useCenterRect 动态测量给出
    // （侧栏宽度是内联样式，CSS 无法感知，故不用纯 CSS 居中）。
    // 配色：优先官方主题 token（--dsw-alias-*）；同时提供 body[data-ds-dark-theme]
    // 兜底覆写，保证深色主题下即使 token 失效也有正确配色。
    // 注意：深色主题下 --dsw-alias-brand-primary 是浅色，主按钮文字必须改深色。
    const css =
      ".ito-overlay{position:absolute}" +
      ".ito-card{background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,rgba(31,35,40,.16));border-radius:12px;box-shadow:0 12px 44px rgba(0,0,0,.24);width:100%;padding:18px 22px;box-sizing:border-box;font-size:14px;line-height:1.6}" +
      "body[data-ds-dark-theme] .ito-card{background:var(--dsw-alias-bg-overlay,#1f2328);color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.18))}" +
      ".ito-title{font-size:16px;font-weight:600;margin:0 0 4px;color:var(--dsw-alias-label-primary,#1f2328)}" +
      "body[data-ds-dark-theme] .ito-title{color:var(--dsw-alias-label-primary,#e6e6e6)}" +
      ".ito-sub{color:var(--dsw-alias-label-secondary,#57606a);margin:0 0 12px}" +
      "body[data-ds-dark-theme] .ito-sub{color:var(--dsw-alias-label-secondary,#9ea7ad)}" +
      ".ito-row{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(31,35,40,.1))}" +
      "body[data-ds-dark-theme] .ito-row{border-top-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}" +
      ".ito-badge{flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:3px;color:#fff}" +
      ".ito-badge-ok{background:var(--dsw-alias-state-success-primary,#1a7f37)}" +
      ".ito-badge-bad{background:var(--dsw-alias-state-error-primary,#cf222e)}" +
      ".ito-detail{color:var(--dsw-alias-label-secondary,#57606a);word-break:break-all}" +
      "body[data-ds-dark-theme] .ito-detail{color:var(--dsw-alias-label-secondary,#9ea7ad)}" +
      ".ito-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(31,35,40,.2));background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 14px;font-size:14px;cursor:pointer;margin-right:8px}" +
      "body[data-ds-dark-theme] .ito-btn{background:var(--dsw-alias-bg-layer-2,#262b30);color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.2))}" +
      ".ito-btn:disabled{opacity:.55;cursor:default}" +
      ".ito-btn-primary{background:var(--dsw-alias-brand-primary,#1f883d);border-color:transparent;color:#fff}" +
      "body[data-ds-dark-theme] .ito-btn-primary{background:var(--dsw-alias-brand-primary,#d8dee4);color:#1f2328}" +
      ".ito-actions{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}" +
      ".ito-err{color:var(--dsw-alias-state-error-primary,#cf222e);border:1px solid var(--dsw-alias-state-error-primary,#cf222e);border-radius:8px;padding:8px 12px;margin-top:10px;word-break:break-all}" +
      "body[data-ds-dark-theme] .ito-err{color:var(--dsw-alias-state-error-primary,#ff8182);border-color:var(--dsw-alias-state-error-primary,#ff8182)}" +
      ".ito-ok{color:var(--dsw-alias-state-success-primary,#1a7f37);border:1px solid var(--dsw-alias-state-success-primary,#1a7f37);border-radius:8px;padding:8px 12px;margin-top:10px;word-break:break-all}" +
      "body[data-ds-dark-theme] .ito-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:var(--dsw-alias-state-success-primary,#3fb950)}";
    const tagId = "@dsh-external/dsh-image-tools/panel-" + css.length + ".css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-external/dsh-image-tools";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function CheckList({ checks }) {
      const rows = (checks || []).map((c, i) =>
        react.createElement("div", { key: i, className: "ito-row" },
          react.createElement("span", { className: "ito-badge " + (c.ok ? "ito-badge-ok" : "ito-badge-bad") }, c.ok ? "✓" : "✗"),
          react.createElement("div", null,
            react.createElement("div", null, c.name),
            react.createElement("div", { className: "ito-detail" }, String(c.detail || ""))),
        ),
      );
      return react.createElement("div", null, rows);
    }

    function WizardCard({ status, testing, testResult, onTest, onFinish }) {
      return react.createElement("div", { className: "ito-card" },
        react.createElement("h2", { className: "ito-title" }, "dsh-image-tools 配置向导"),
        react.createElement("p", { className: "ito-sub" },
          "首次安装需要确认识图链路可用。以下检查为只读检测，不修改任何配置。"),
        react.createElement(CheckList, { checks: status && status.checks }),
        testResult !== null &&
          react.createElement("div", { className: testResult.ok ? "ito-ok" : "ito-err" },
            testResult.ok ? "连通性测试通过，模型回复：" + testResult.text : "连通性测试失败：" + testResult.error),
        react.createElement("div", { className: "ito-actions" },
          react.createElement("button", { className: "ito-btn", disabled: testing, onClick: onTest },
            testing ? "测试中…" : "测试识图连通性"),
          react.createElement("button", { className: "ito-btn ito-btn-primary", onClick: onFinish }, "完成，开始使用")),
      );
    }

    function DiagCard({ diag, selfcheck, testing, testResult, onSelfcheck, onTest, onClose }) {
      return react.createElement("div", { className: "ito-card" },
        react.createElement("h2", { className: "ito-title" }, "识图功能异常自检"),
        react.createElement("p", { className: "ito-sub" },
          "检测到识图链路出现问题：" + String((diag && diag.message) || "")),
        react.createElement("div", { className: "ito-actions" },
          react.createElement("button", { className: "ito-btn", onClick: onSelfcheck }, "运行自检"),
          react.createElement("button", { className: "ito-btn", disabled: testing, onClick: onTest },
            testing ? "测试中…" : "重新测试连通性"),
          react.createElement("button", { className: "ito-btn", onClick: onClose }, "关闭")),
        selfcheck !== null && react.createElement(CheckList, { checks: selfcheck.checks }),
        testResult !== null &&
          react.createElement("div", { className: testResult.ok ? "ito-ok" : "ito-err" },
            testResult.ok ? "连通性测试通过，模型回复：" + testResult.text : "连通性测试失败：" + testResult.error),
      );
    }

    const inject = ["slots"];

    // 同源请求封装：附带 host 注入到 index.html meta 的随机令牌
    // （host 侧 trusted() 校验，配合回环 + Host 匹配）。
    function itoFetch(path, opts) {
      const headers = { ...((opts && opts.headers) || {}) };
      const meta = document.querySelector('meta[name="image-tools-token"]');
      if (meta) headers["x-image-tools-token"] = meta.content;
      return fetch(path, { ...(opts || {}), headers });
    }

    // 测量对话列（中间列）几何：AppFrame grid 子项顺序为
    // [sidebarCol, centerCol, detailsCol, overlayLayer, ...]，
    // overlayLayer 带 data-shell-overlay 标记，其父级的第 2 个子元素即中间列。
    // 侧栏可拖拽/折叠、宽度为内联样式，故用 ResizeObserver 实时跟随。
    function useCenterRect() {
      const [rect, setRect] = useState(null);
      useEffect(() => {
        const layer = document.querySelector("[data-shell-overlay]");
        const frame = layer && layer.parentElement;
        const center = frame && frame.children[1];
        if (!center) return;
        const update = () => {
          const r = center.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
          }
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(center);
        window.addEventListener("resize", update);
        return () => {
          observer.disconnect();
          window.removeEventListener("resize", update);
        };
      }, []);
      return rect;
    }

    function apply(ctx) {
      function Overlay() {
        const [mode, setMode] = useState("none"); // none | wizard | diag
        const [status, setStatus] = useState(null);
        const [diag, setDiag] = useState(null);
        const [selfcheck, setSelfcheck] = useState(null);
        const [testing, setTesting] = useState(false);
        const [testResult, setTestResult] = useState(null);
        const lastSeenDiag = useRef(0);

        const runTest = async () => {
          setTesting(true);
          setTestResult(null);
          try {
            const res = await itoFetch("/image-tools/test", { method: "POST" });
            setTestResult(await res.json());
          } catch (e) {
            setTestResult({ ok: false, error: String((e && e.message) || e) });
          } finally {
            setTesting(false);
          }
        };

        const runSelfcheck = async () => {
          try {
            const res = await itoFetch("/image-tools/selfcheck");
            setSelfcheck(await res.json());
          } catch (e) {
            setSelfcheck({ checks: [{ name: "自检请求失败", ok: false, detail: String((e && e.message) || e) }] });
          }
        };

        useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const res = await itoFetch("/image-tools/status");
              const data = await res.json();
              if (!alive) return;
              if (data.onboarded !== true) {
                setStatus(data);
                setMode("wizard");
              }
            } catch {
              // 路由尚未就绪时静默，下一轮轮询再试
            }
            try {
              const res = await itoFetch("/image-tools/diag");
              const data = await res.json();
              if (alive && data && typeof data.at === "number" && data.at > 0) {
                lastSeenDiag.current = data.at; // 初始静默，不弹历史故障
              }
            } catch {
              // 忽略
            }
          })();
          const timer = setInterval(async () => {
            try {
              const res = await itoFetch("/image-tools/diag");
              const data = await res.json();
              if (data && typeof data.at === "number" && data.at > lastSeenDiag.current && data.code) {
                lastSeenDiag.current = data.at;
                setDiag(data);
                setSelfcheck(null);
                setTestResult(null);
                setMode("diag");
              }
            } catch {
              // 忽略
            }
          }, 5000);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        const center = useCenterRect();
        if (mode === "none" || center === null) return null;
        let body = null;
        if (mode === "wizard") {
          body = react.createElement(WizardCard, {
            status,
            testing,
            testResult,
            onTest: runTest,
            onFinish: async () => {
              try {
                await itoFetch("/image-tools/finish", { method: "POST" });
              } catch {
                // 标记失败不阻塞关闭
              }
              setMode("none");
            },
          });
        } else {
          body = react.createElement(DiagCard, {
            diag,
            selfcheck,
            testing,
            testResult,
            onSelfcheck: runSelfcheck,
            onTest: runTest,
            onClose: () => {
              setDiag(null);
              setMode("none");
            },
          });
        }
        const overlayStyle = {
          position: "absolute",
          left: center.left + center.width / 2,
          top: center.top + center.height / 2,
          transform: "translate(-50%,-50%)",
          width: "min(600px, " + Math.max(280, center.width - 32) + "px)",
        };
        return react.createElement("div", { className: "ito-overlay", style: overlayStyle }, body);
      }

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({
          name: "shell.overlay",
          id: "image-tools-wizard",
          order: 50,
          inject: () => ({}),
        }, Overlay),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
