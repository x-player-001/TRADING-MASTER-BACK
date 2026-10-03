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
    },
    {
      // 模拟盘：独立订阅全市场 5m，MACD 顶背离 + 反转K线信号 → 条件单 → 模拟撮合入库
      name: "paper",
      script: "scripts/run_paper_trading.ts",
      interpreter: "node",
      interpreter_args: "-r ts-node/register -r tsconfig-paths/register",
      env: { TS_NODE_TRANSPILE_ONLY: "true", NODE_ENV: "production" },
      max_memory_restart: "500M",
      autorestart: true
    },
    {
      // 实盘：MACD 顶背离 S1/S2（LIVE_TRADING_MODE=live 才真实下单，否则影子模式）
      // 密钥 LIVE_BINANCE_API_KEY / LIVE_BINANCE_API_SECRET；控制开关见 scripts/live_control.ts
      name: "live",
      script: "scripts/run_live_trader.ts",
      interpreter: "node",
      interpreter_args: "-r ts-node/register -r tsconfig-paths/register",
      env: { TS_NODE_TRANSPILE_ONLY: "true", NODE_ENV: "production" },
      max_memory_restart: "500M",
      kill_timeout: 5000,
      autorestart: true
    },
    {
      // 日线趋势线突破每日任务：回填日线 + 扫描入库，跑完即退出
      // 币安日线 00:00 UTC 收盘，服务器为北京时间 → 每天 08:10 拉起
      name: "daily-breakout",
      script: "scripts/run_daily_breakout_job.ts",
      interpreter: "node",
      interpreter_args: "-r ts-node/register -r tsconfig-paths/register",
      env: { TS_NODE_TRANSPILE_ONLY: "true", NODE_ENV: "production" },
      cron_restart: "10 8 * * *",
      autorestart: false,
      max_memory_restart: "500M"
    }
  ]
};
