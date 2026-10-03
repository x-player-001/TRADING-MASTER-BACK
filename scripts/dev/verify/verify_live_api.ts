/**
 * 实盘接口验证（零风险：不会开仓）—— 拿到新 API key 后、启动 live 进程前在服务器跑一次
 *
 * 验证项:
 *   1. 签名 / 校时 / 账户模式（单向持仓、单币保证金）/ 余额
 *   2. 杠杆分层、逐仓、杠杆设置
 *   3. 挂 STOP 卖出 + IOC 限价条件单（触发价 = 现价 50%，不会触发）→ 按 clientAlgoId 查询 → 撤单 → 撤单后再查询
 *      （确认 IOC 被接受、已撤条件单仍可按 client id 查到）
 *   4. 用户数据流连接并收到 ALGO_UPDATE 事件
 *
 *   npx ts-node -r tsconfig-paths/register scripts/dev/verify/verify_live_api.ts [--symbol=DOGEUSDT]
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import axios from 'axios';
import { BinanceLiveClient, fetch_exchange_rules } from '@/api/binance_live_client';
import { UserDataStream } from '@/services/live_trading/user_data_stream';
import { format_step, round_to_step } from '@/services/live_trading/exchange_rules';
import { err_text } from '@/services/live_trading/live_executor';

const symbol = (process.argv.find(a => a.startsWith('--symbol=')) ?? '--symbol=DOGEUSDT').slice(9);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const c = BinanceLiveClient.from_env();
  const ok = (msg: string) => console.log(`✅ ${msg}`);

  await c.sync_time();
  ok('签名与校时');
  const hedge = await c.is_hedge_mode(), multi = await c.is_multi_assets_mode();
  console.log(`${hedge ? '❌' : '✅'} 持仓模式：${hedge ? '双向（需改为单向）' : '单向'}`);
  console.log(`${multi ? '❌' : '✅'} 保证金模式：${multi ? '联合保证金（需改为单币）' : '单币'}`);
  const bal = await c.get_usdt_balance();
  ok(`USDT 余额 ${bal.balance}，可用 ${bal.available}`);

  const rules = (await fetch_exchange_rules()).get(symbol);
  if (!rules) throw new Error(`${symbol} 不存在`);
  const px = Number((await axios.get('https://fapi.binance.com/fapi/v2/ticker/price', { params: { symbol } })).data.price);
  const bracket = await c.get_leverage_bracket(symbol, 150);
  ok(`${symbol} 现价 ${px}，tick ${rules.tick_size} step ${rules.step_size} 最小名义 ${rules.min_notional}，分层最大杠杆 ${bracket.max_leverage} mmr ${bracket.maint_margin_ratio}`);

  const pos = await c.get_position(symbol);
  if (pos.amount !== 0) throw new Error(`${symbol} 已有持仓 ${pos.amount}，换个币验证`);
  await c.set_isolated_margin(symbol);
  await c.set_leverage(symbol, 2);
  const after = await c.get_position(symbol);
  ok(`逐仓 + 杠杆设置（当前 ${after.margin_type} ${after.leverage}x）`);

  // 用户数据流
  const events: string[] = [];
  const stream = new UserDataStream(c, {
    on_symbols: (syms, type, raw) => { events.push(type); console.log(`   📨 ${type} ${syms.join(',')} ${type === 'ALGO_UPDATE' ? raw.o?.X : ''}`); },
    on_connected: () => ok('用户数据流已连接'),
    on_error: msg => console.warn(`   ⚠️ ${msg}`),
  });
  await stream.start();
  await sleep(3000);

  // 不会触发的 STOP 卖出条件单：触发价 = 现价 80%，限价贴着价格带下限（与实盘计划同一口径）
  // 若挂单被拒且提示价格超限，说明 PERCENT_PRICE 在挂单时即按现价检查，需要反馈调整
  const trigger = round_to_step(px * 0.8, rules.tick_size, 'round');
  const limit = round_to_step(trigger * (rules.percent_down + 0.01), rules.tick_size, 'ceil');
  console.log(`   PERCENT_PRICE 下限 ${rules.percent_down}`);
  const qty = round_to_step((rules.min_notional * 1.5) / limit, rules.step_size, 'ceil');
  const client_id = `LVTEST${Date.now() % 1e8}E`;
  try {
    const placed = await c.new_algo_order({
      symbol, side: 'SELL', type: 'STOP', client_algo_id: client_id,
      trigger_price: format_step(trigger, rules.tick_size), price: format_step(limit, rules.tick_size),
      quantity: format_step(qty, rules.step_size), time_in_force: 'IOC',
    });
    ok(`STOP + IOC 条件单已挂：algoId ${placed.algo_id} 状态 ${placed.status} 触发 ${trigger} 限价 ${limit} 数量 ${qty}`);
    const q1 = await c.get_algo_order(client_id);
    console.log(`${q1?.status === 'NEW' ? '✅' : '❌'} 按 clientAlgoId 查询：${q1?.status}`);
    const open = await c.get_open_algo_orders(symbol);
    console.log(`${open.some(a => a.client_algo_id === client_id) ? '✅' : '❌'} 当前条件单列表包含该单`);
    await c.cancel_algo_order(client_id);
    await sleep(1500);
    const q2 = await c.get_algo_order(client_id);
    console.log(`${q2?.status === 'CANCELED' ? '✅' : '⚠️'} 撤单后按 clientAlgoId 查询：${q2 ? q2.status : '查询不到（执行器会走持仓兜底）'}`);
  } catch (err) {
    console.error(`❌ 条件单验证失败：${err_text(err)}`);
    try { await c.cancel_algo_order(client_id); } catch { /* 清理 */ }
  }

  await sleep(3000);
  console.log(`${events.includes('ALGO_UPDATE') ? '✅' : '⚠️'} 用户数据流事件：${events.join(', ') || '未收到'}`);
  const left = await c.get_open_algo_orders(symbol);
  console.log(`${left.length === 0 ? '✅' : '❌'} 收尾：${symbol} 剩余条件单 ${left.length}`);
  stream.stop();
  process.exit(0);
}

main().catch(err => { console.error('❌', err_text(err)); process.exit(1); });
