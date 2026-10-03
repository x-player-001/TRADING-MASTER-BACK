/**
 * 币安 U 本位用户数据流（listenKey）
 *
 * 只负责「唤醒」：收到 ORDER_TRADE_UPDATE / ALGO_UPDATE / ACCOUNT_UPDATE 等事件时回调涉及的币种，
 * 由执行器去 REST 查询真实状态。丢事件不影响正确性（还有定时对账），只影响反应速度。
 *
 * - listenKey 每 30 分钟续期；收到 listenKeyExpired 或续期失败则重建
 * - 断线 5 秒后重连；每次（重）连上回调 on_connected，调用方据此做一次全量对账
 * - 地址：wss://fstream.binance.com/private/stream?listenKey=...（新版路由），连续失败时回退 /ws/{listenKey}
 */

import WebSocket from 'ws';
import { BinanceLiveClient } from '@/api/binance_live_client';

const WS_BASE = 'wss://fstream.binance.com';
const KEEPALIVE_MS = 30 * 60_000;

export interface UserStreamHandlers {
  on_symbols: (symbols: string[], event_type: string, raw: any) => void;
  on_connected: () => void;
  on_error: (msg: string) => void;
}

export class UserDataStream {
  private ws: WebSocket | null = null;
  private listen_key = '';
  private keepalive_timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private fail_count = 0;
  connected = false;

  constructor(private readonly client: BinanceLiveClient, private readonly h: UserStreamHandlers) {}

  /** 启动 */
  async start(): Promise<void> {
    this.stopped = false;
    await this.renew_key();
    this.connect();
    this.keepalive_timer = setInterval(() => { void this.keepalive(); }, KEEPALIVE_MS);
  }

  /** 停止 */
  stop(): void {
    this.stopped = true;
    if (this.keepalive_timer) clearInterval(this.keepalive_timer);
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.connected = false;
  }

  private async renew_key(): Promise<void> {
    this.listen_key = await this.client.create_listen_key();
  }

  private async keepalive(): Promise<void> {
    try {
      await this.client.keepalive_listen_key();
    } catch (err: any) {
      this.h.on_error(`listenKey 续期失败，重建: ${err.message}`);
      await this.reconnect_with_new_key();
    }
  }

  private async reconnect_with_new_key(): Promise<void> {
    try {
      await this.renew_key();
    } catch (err: any) {
      this.h.on_error(`listenKey 创建失败: ${err.message}`);
    }
    this.ws?.terminate();   // close 回调里重连
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.fail_count >= 3 ? `${WS_BASE}/ws/${this.listen_key}` : `${WS_BASE}/private/stream?listenKey=${this.listen_key}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.fail_count = 0;
      this.h.on_connected();
    });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.dispatch(msg.data ?? msg);
      } catch (err: any) {
        this.h.on_error(`用户数据流消息解析失败: ${err.message}`);
      }
    });
    ws.on('error', err => {
      this.fail_count++;
      this.h.on_error(`用户数据流错误: ${err.message}`);
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.stopped) return;
      setTimeout(() => this.connect(), 5000);
    });
  }

  /** 解析事件涉及的币种 */
  private dispatch(ev: any): void {
    const type: string = ev?.e;
    if (!type) return;
    if (type === 'listenKeyExpired') {
      this.h.on_error('listenKey 过期，重建');
      void this.reconnect_with_new_key();
      return;
    }
    const symbols = new Set<string>();
    if (type === 'ORDER_TRADE_UPDATE' || type === 'ALGO_UPDATE') {
      if (ev.o?.s) symbols.add(ev.o.s);
    } else if (type === 'ACCOUNT_UPDATE') {
      for (const p of ev.a?.P ?? []) if (p.s) symbols.add(p.s);
    } else if (type === 'CONDITIONAL_ORDER_TRIGGER_REJECT') {
      if (ev.or?.s) symbols.add(ev.or.s);
    } else if (type === 'TRADE_LITE') {
      if (ev.s) symbols.add(ev.s);
    }
    if (symbols.size) this.h.on_symbols([...symbols], type, ev);
  }
}
