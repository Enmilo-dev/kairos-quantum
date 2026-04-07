import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { AlertModel } from '../models/Alert.js';
import { redisClient } from '../lib/redisClient.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bot, PermanentError, TransientError } from '../bot.js';

const REDIS_CHANNEL = process.env.REDIS_CHANNEL_SOURCE || 'priceUpdates';
const PERIODIC_CLEANUP = 5 * 60 * 1000;
const MAX_ALERTS_SYMBOL = 30;

class AlertService {
  private subscriber;
  private isShutdown = false;
  private recentlyProcessed: Map<string, number> = new Map();
  /*
    This will prevent duplicate notification
    Also this will help with tg rate limit
  */
  private telegramQueue: Array<() => Promise<void>> = [];
  private telegramRateLimitInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.subscriber = redisClient.duplicate();
    this.subscriber.on('error', (err: Error) => {
      logger.error('Alert service Redis error', { error: err.message });
    });
  }

  /*
    This public function will connect the redis
    This subscribe to the redis channel
  */
  public async start() {
    try {
      await this.subscriber.connect();
      this.subscriber.subscribe(REDIS_CHANNEL, this.handleNewPrice.bind(this));
      
      this.startTelegramRateLimiter();
      this.startCleanUp();

      logger.info('Alert service started');
    } catch (error) {
      logger.error('Failed to start alert service', { error });
      process.exit(1);
    }
  }

  /*
    This public function will disconnect the redis
  */
  public async stop() {
    this.isShutdown = true;
    if (this.telegramRateLimitInterval) {
      clearInterval(this.telegramRateLimitInterval);
    }

    if (this.subscriber.isOpen) {
      await this.subscriber.unsubscribe(REDIS_CHANNEL);
      await this.subscriber.quit();
    }

    logger.info('Alert service stopped');
  }

  /*
    This private function will handle the new price update
    This price will be from Binance WS
    It parse Symbol and price
  */
  private async handleNewPrice(message: string) {
    if (this.isShutdown) return;
    try {
      const { symbol, price } = JSON.parse(message);
      if (!symbol || typeof price !== 'number') {
        logger.warn('Malformed price update', { message });
        return;
      }

      const triggeredAlertIds = await AlertModel.triggeredAlert(symbol, price);
      if (triggeredAlertIds.length === 0) return;

      const now = Date.now();
      const newAlertIds = triggeredAlertIds.filter(id=> {
        const lastProcessed = this.recentlyProcessed.get(id);
        return !lastProcessed || (now - lastProcessed > 60000);
      })

      if (newAlertIds.length === 0) return;

      newAlertIds.forEach(id=> this.recentlyProcessed.set(id, now));
      newAlertIds.forEach(alertId=> {
        this.processTriggeredAlert(alertId, symbol, price);
      });
    } catch (error) {
      logger.error('Failed to handle price update', { message, error });
    }
  }

  /*
    This private function will process all alerts
    It will mark them as inactive 
    It will also remove the alert from redis.
  */
  private async processTriggeredAlert(alertId: string, symbol: string, currentPrice: number) {
    try {
      const alert = await prisma.alert.update({
        where: { id: alertId, isActive: true },
        data: {
          isActive: false,
          isTriggered: true,
          triggeredAt: new Date(),
        },
        include: { user: true }
      });

      /*
        This will remove the alert from redis
      */
      await AlertModel.removeAlerts(alertId, symbol)
        .catch(err => logger.warn('Failed to remove alert from Redis', { alertId, error: err.message }));
      
      await this.sendTelegramNotification(
        alert.user.telegramId,
        { symbol: alert.symbol,
        targetPrice: alert.targetPrice.toNumber(),
        currentPrice,
        direction: alert.direction as 'UP' | 'DOWN', }
      );
      logger.info('Alert triggered successfully', { alertId, symbol, userId: alert.userId });
    } catch (error: any) {
      if (error.code === 'P2025') {
        logger.debug('Alert already processed', { alertId });
        return;
      }
      if (error.code === 'P1001' || error.code === 'P1002' || error.code === 'P1017') {
        throw new TransientError('Database connection failed');
      }
      if (error.error_code === 429) {
        throw new TransientError('Telegram rate limited');
      }
      
      if (error.error_code === 403) {
        throw new PermanentError('User blocked bot');
      }
      
      throw new PermanentError(error.message);
    }
  }

  /*
    This will send notifation for alert triggered
    All the notification will use the queue to prevent rate limit
  */
  private sendTelegramNotification = async(
    telegramId: bigint,
    alert: { symbol: string, targetPrice: number, currentPrice: number, direction: 'UP' | 'DOWN' }
  )=> {
    const message = 
        `🎯 <b>TARGET REACHED</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 <b>${alert.symbol}</b>\n\n` +
        `💰 <b>Target Price</b>\n` +
        `<code>$${alert.targetPrice}</code>\n\n` +
        `📈 <b>Direction</b>\n` +
        `${alert.direction === 'UP' ? '🟢 LONG' : '🔴 SHORT'}\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `💵 <b>Current Price</b>\n` +
        `<code>$${alert.currentPrice}</code>`;
  
    return new Promise<void>(async (resolve, reject)=> {
      this.telegramQueue.push(async ()=> {
        try {
          await bot.api.sendMessage(telegramId.toString(), message, { parse_mode: 'HTML' });
          resolve();
        } catch (error: any) {
          if (error?.error_code === 403 || error?.error_code === 400) {
            logger.warn('User blocked bot or deleted account', { telegramId });
            resolve();
          } else {
            logger.error('Telegram send failed', { telegramId, error: error.message });
            reject(error);
          }
        }
      });
    })
  }

  /*
    This function will clean the queue 
    This queue is to prevent duplicate noti
  */
  private startCleanUp() {
    setInterval(() => {
      if (this.isShutdown) return;
      
      const now = Date.now();
      const TTL = 5 * 60 * 1000;
      let cleaned = 0;

      for (const [alertId, timestamp] of this.recentlyProcessed.entries()) {
        if (now - timestamp > TTL) {
          this.recentlyProcessed.delete(alertId);
          cleaned++;
        }
        if (cleaned > 0) {
          logger.info('Cleaned up processed alerts', { count: cleaned });
        }
      }
    }, PERIODIC_CLEANUP);
  }

  private startTelegramRateLimiter() {
    const messagesPerInterval = 3;
    const intervalMs = 100;

    this.telegramRateLimitInterval = setInterval(() => {
      const batch = this.telegramQueue.splice(0, messagesPerInterval);
      batch.forEach(fn => fn().catch(err =>
        logger.error('Queued Telegram message failed', { error: err.message })
      ));
    }, intervalMs);
  }

  /*
    This function will create new alerts
    This will also check for DOS
  */
  public async createAlert(alertData: Prisma.AlertUncheckedCreateInput) {
    try {
      const existingAlertCount = await prisma.alert.count({
        where: {
          userId: alertData.userId,
          symbol: alertData.symbol,
          isActive: true,
        },
      });

      if (existingAlertCount >= MAX_ALERTS_SYMBOL) {
        throw new Error(
          `Maximum ${MAX_ALERTS_SYMBOL} active alerts for ${alertData.symbol} reached`
        );
      }

      const newAlert = await prisma.alert.create({ data: alertData });
      await AlertModel.addActiveAlert({
        id: newAlert.id,
        symbol: newAlert.symbol,
        direction: newAlert.direction,
        targetPrice: newAlert.targetPrice.toNumber()
      });

      logger.info('Alert created', { alertId: newAlert.id, symbol: newAlert.symbol });
      return newAlert;
    } catch (error) {
      logger.error('Failed to create alert', { error });
      throw error;
    }
  }

  /*
    This will cancel the alert or you can say delete
    We will update the db alert to inactive
    We need to verify if it is user's alert
    Just of edge case
  */
  public async cancelAlert(alertId: string, telegramId: bigint) {
    try {
      const alert = await prisma.alert.findUnique({
        where: { id: alertId },
        include: { user: true },
      });

      if (!alert) {
        throw new Error('Alert not found');
      }

      if (alert.user.telegramId !== telegramId) {
        throw new Error('Unauthorized');
      }

      await AlertModel.removeAlerts(alert.id, alert.symbol);
      await prisma.alert.update({
        where: { id: alertId },
        data: { isActive: false },
      });

      logger.info('Alert cancelled', { alertId });
      return alert;
    } catch (error) {
      logger.error('Failed to cancel alert', { error });
      throw error;
    }
  }
}

/*
  Exporting the call as alert service
*/
export const alertService = new AlertService();
