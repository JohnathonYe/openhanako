/**
 * boot.cjs — ESM 启动包装器
 *
 * 用 CJS 包装 ESM 入口，捕获模块加载阶段的错误（如 native module 缺失/ABI 不匹配）。
 * ESM 的 static import 失败时进程直接崩溃，无法输出任何诊断信息。
 * CJS 的 dynamic import() 可以 catch，让错误信息通过 stderr 传回 main 进程。
 */
(async () => {
  try {
    await import("./index.js");
  } catch (err) {
    console.error(`[server] 启动失败: ${err.message}`);
    if (err.code) console.error(`[server] 错误码: ${err.code}`);
    console.error(err.stack);

    // 诊断信息
    console.error(
      `[server] 诊断: platform=${process.platform} arch=${process.arch} ` +
      `node=${process.version} abi=${process.versions.modules}`
    );

    // better-sqlite3：require() 只加载 JS，.node 在首次 new Database() 时才 dlopen —— 必须打开内存库才是真诊断
    try {
      const Database = require("better-sqlite3");
      const db = new Database(":memory:");
      db.prepare("SELECT 1").get();
      db.close();
      console.error("[server] better-sqlite3: 原生绑定可加载（:memory: 探测通过）");
    } catch (e) {
      console.error(`[server] better-sqlite3: 原生绑定失败 - ${e.message}`);
      if (process.platform === "darwin") {
        console.error(
          "[server] 提示: 若本机为 Intel Mac (arch=x64) 或 Rosetta，请在项目根执行: npx electron-rebuild -f -w better-sqlite3 --arch=x64",
        );
        console.error(
          "[server] 若为 Apple 芯片 (arm64)，请执行: npm run rebuild",
        );
      } else {
        console.error("[server] 提示: 请在项目根执行 npm run rebuild 以匹配当前 Electron / Node ABI");
      }
    }

    process.exit(1);
  }
})();
