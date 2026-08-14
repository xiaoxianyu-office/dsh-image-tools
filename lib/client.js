// dsh-image-tools client stub：本包为纯 host 插件（图片桥接与识图工具），
// 无需浏览器端 UI。此 stub 仅保持标准 host+client 双面 bundle 形态，
// 供 dsh plugin 发布流水线与 validate-bundle.sh 校验使用。
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-image-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    exports.name = "dsh-image-tools-client";
    exports.inject = [];
    exports.apply = function apply() {};
    return module.exports;
  },
});
