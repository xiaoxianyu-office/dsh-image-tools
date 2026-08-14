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
    // 定位：宿主 shell.overlay 容器为 absolute inset:0（.overlayLayer），
    // 此处不再套 fixed/flex 层，直接在该容器内绝对定位居中，避免定位叠加偏移。
    // 配色：全部使用官方主题 token（--dsw-alias-*），深浅主题自动适配。
    const css =
      ".ito-overlay{position:absolute;top:72px;left:50%;transform:translateX(-50%);width:min(600px,calc(100vw - 32px))}" +
      ".ito-card{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 44px rgba(0,0,0,.24);width:100%;padding:18px 22px;box-sizing:border-box;font-size:14px;line-height:1.6}" +
      ".ito-title{font-size:16px;font-weight:600;margin:0 0 4px;color:var(--dsw-alias-label-primary)}" +
      ".ito-sub{color:var(--dsw-alias-label-secondary);margin:0 0 12px}" +
      ".ito-row{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}" +
      ".ito-badge{flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:3px;color:#fff}" +
      ".ito-badge-ok{background:var(--dsw-alias-state-success-primary)}" +
      ".ito-badge-bad{background:var(--dsw-alias-state-error-primary)}" +
      ".ito-detail{color:var(--dsw-alias-label-secondary);word-break:break-all}" +
      ".ito-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font-size:14px;cursor:pointer;margin-right:8px}" +
      ".ito-btn:disabled{opacity:.55;cursor:default}" +
      ".ito-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}" +
      ".ito-actions{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}" +
      ".ito-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;margin-top:10px;word-break:break-all}" +
      ".ito-ok{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;padding:8px 12px;margin-top:10px;word-break:break-all}";
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
            const res = await fetch("/image-tools/test", { method: "POST" });
            setTestResult(await res.json());
          } catch (e) {
            setTestResult({ ok: false, error: String((e && e.message) || e) });
          } finally {
            setTesting(false);
          }
        };

        const runSelfcheck = async () => {
          try {
            const res = await fetch("/image-tools/selfcheck");
            setSelfcheck(await res.json());
          } catch (e) {
            setSelfcheck({ checks: [{ name: "自检请求失败", ok: false, detail: String((e && e.message) || e) }] });
          }
        };

        useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const res = await fetch("/image-tools/status");
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
              const res = await fetch("/image-tools/diag");
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
              const res = await fetch("/image-tools/diag");
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

        if (mode === "none") return null;
        let body = null;
        if (mode === "wizard") {
          body = react.createElement(WizardCard, {
            status,
            testing,
            testResult,
            onTest: runTest,
            onFinish: async () => {
              try {
                await fetch("/image-tools/finish", { method: "POST" });
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
        return react.createElement("div", { className: "ito-overlay" }, body);
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
