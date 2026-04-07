import WebSocket from "ws";
import { logger } from "../utils/logger.js";
import { redisClient } from "../lib/redisClient.js";
import { validSymbol } from "../config/cryptoSym.js";

const BINANCE_WSS_URL = process.env.BINANCE_WSS_URL;
const REDIS_CHANNEL = process.env.REDIS_CHANNEL_SOURCE || 'priceUpdates';
const PRICE_TTL = 300;

if (!BINANCE_WSS_URL) {
  logger.error("Binance WSS URL error");
  process.exit(1);
}

class PriceService {
  private publisher;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private dataFlowTimeout: NodeJS.Timeout | null = null;
  private isShutDonw = false;

  constructor() {
    this.publisher = redisClient.duplicate();
    this.publisher.on('error', (err) => {
      logger.error('Redis Publisher Error:', err);
    });
    this.publisher.on('connect', () => {
      logger.info('Redis Publisher connected');
    });
    this.publisher.on('reconnecting', () => {
      logger.warn('Redis Publisher reconnecting...');
    });
  }

  async start() {
    try {
      await this.publisher.connect();
      await this.publisher.ping();
      logger.info('Connected to Redis successfully');
      this.connect();
    } catch (error) {
      logger.error('Failed to connect to Redis',error);
      process.exit(1);
    }

    // this.publisher.on('disconnect', ()=> {
    //   logger.error('Redis publisher disconnected!');
    //   process.exit(1);
    // });
  }

  async stop() {
    this.isShutDonw = true;
    logger.info("Stopping price service...");
    if (this.dataFlowTimeout) {
      clearTimeout(this.dataFlowTimeout);
    }
    if (this.ws) {
      this.ws.close();
    }
    if (this.publisher.isOpen) {
      await this.publisher.quit();
    }
    logger.info("Price service stopped.");
  }

  private connect() {
    if (this.isShutDonw) return;

    this.ws = new WebSocket(BINANCE_WSS_URL!);

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", (error) => this.handleError(error));
  }

  private handleOpen() {
    this.reconnectAttempts = 0;
    // const streams = cryptoMap.map((s) => `${s}@ticker`);

    this.ws?.send(
      JSON.stringify({
        method: "SUBSCRIBE",
        params: ["!miniTicker@arr"],
        id: 1,
      })
    );

    if (this.dataFlowTimeout) {
      clearTimeout(this.dataFlowTimeout);
    }

    this.dataFlowTimeout = setTimeout(() => {
      logger.warn('WebSocket connected but no data received in 10s, reconnecting...');
      this.ws?.close();
    }, 10000);
  }

  private async handleMessage(data: WebSocket.Data) {
    if (this.dataFlowTimeout) {
      clearTimeout(this.dataFlowTimeout);
    }
    this.dataFlowTimeout = setTimeout(() => {
      logger.warn('Data flow stopped, reconnecting...');
      this.ws?.close();
    }, 10000);
    try {
      const message = JSON.parse(data.toString());
      if (!Array.isArray(message)) {
        return;
      }

      // for (const item of message) {
      //   const symbol = item.s;
      //   const price = parseFloat(item.c);

      //   if (!validSymbol.has(symbol.toUpperCase())) continue;
      //   const priceUpdate = { symbol, price };
      //   this.publisher.publish(REDIS_CHANNEL, JSON.stringify(priceUpdate));
      //   this.publisher.set(`price:${symbol}`, price.toString(), { EX: 60 * 5 })
      //     .catch(err => console.error(err));
      // }

      // if (message.stream && message.data?.s && message.data?.c) {
      //   const priceUpdate = {
      //     symbol: message.data.s,
      //     price: parseFloat(message.data.c),
      //   };
      //   this.publisher.publish(REDIS_CHANNEL, JSON.stringify(priceUpdate));
      //   this.publisher.set(`price:${priceUpdate.symbol}`, priceUpdate.price.toString(), { EX: 60 * 5 })
      //     .catch(err => console.error(err));
      // }

      for (const item of message) {
        try {
          const symbol = item.s;
          const price = parseFloat(item.c);
          
          if (!symbol || price <= 0 || isNaN(price)) {
            logger.warn('Malformed price update item', { item });
            continue;
          }
          
          if (!validSymbol.has(symbol.toUpperCase())) continue;
          
          const priceUpdate = { symbol, price };

          this.publisher.publish(REDIS_CHANNEL, JSON.stringify(priceUpdate))
            .catch(err => logger.error('Publish failed', { symbol, error: err.message }));
          
          this.publisher.set(`price:${symbol}`, price.toString(), { EX: PRICE_TTL })
            .catch(err => logger.error('Set price failed', { symbol, error: err.message }));
          
          // await Promise.all([
          //   this.publisher.publish(REDIS_CHANNEL, JSON.stringify(priceUpdate)),
          //   this.publisher.set(`price:${symbol}`, price.toString(), { EX: 60 * 5 })
          // ]);
        
        } catch (itemError) {
          logger.error('Failed to process price update', { item, error: itemError });
        }
      }
    } catch (error: any) {
      logger.error(`Error parsing message: ${error.message}`);
    }
  }

  private handleClose() {
    if (this.isShutDonw) return;

    this.reconnectAttempts++;
    const delay = Math.min(Math.pow(2, this.reconnectAttempts) * 1000, 32000);
    
    logger.warn('WebSocket closed, reconnecting', { 
      attempt: this.reconnectAttempts, 
      delayMs: delay 
    });
    
    setTimeout(() => this.connect(), delay);

    // if (this.reconnectAttempts < MAX_WS_RECONNECT_ATTEMPTS) {
    //   this.reconnectAttempts++;
    //   const delay = this.reconnectAttempts * 2000;
    //   logger.info(`WebSocket closed. Reconnecting in ${delay / 1000}s...`);
    //   setTimeout(() => this.connect(), delay);
    // } else {
    //   logger.error("Maximum WebSocket reconnect attempts reached. Giving up.");
    // }
  }

  private handleError(error: Error) {
    logger.error(`WebSocket error: ${error.message}`);
  }
}

export const priceService = new PriceService();
