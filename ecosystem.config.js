module.exports = {
  apps: [
    {
      // API 服务：跑 build 后的 dist 产物（node，非 ts-node）
      name: "api",
      script: "dist/index_api_only.js",
      node_args: "-r tsconfig-paths/register",
      env: { TS_NODE_PROJECT: "tsconfig.runtime.json", NODE_ENV: "production" },
      max_memory_restart: "600M",
      autorestart: true,
      out_file: "/root/.pm2/logs/api-out.log",
      error_file: "/root/.pm2/logs/api-err.log"
    },
    {
      // 趋势跟随监控：入口在 scripts/，用 ts-node transpile-only（跳过类型检查）
      name: "trend",
      script: "scripts/run_trend_follow_monitor.ts",
      interpreter: "node",
      interpreter_args: "-r ts-node/register -r tsconfig-paths/register",
      env: { TS_NODE_TRANSPILE_ONLY: "true", NODE_ENV: "production" },
      max_memory_restart: "700M",
      autorestart: true
    },
    {
      // 报警事后评估器（常驻 --loop）
      name: "alerts",
      script: "scripts/evaluate_alert_outcomes.ts",
      args: "--loop",
      interpreter: "node",
      interpreter_args: "-r ts-node/register -r tsconfig-paths/register",
      env: { TS_NODE_TRANSPILE_ONLY: "true", NODE_ENV: "production" },
      max_memory_restart: "500M",
      autorestart: true
    }
  ]
};
