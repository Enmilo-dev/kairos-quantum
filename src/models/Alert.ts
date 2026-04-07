import { redisClient } from "../lib/redisClient.js";
import { AlertDirection } from '../generated/prisma/client.js'
import { logger } from "../utils/logger.js";
import { prisma } from "../lib/prisma.js";

const ALERT_KEY_TTL = 30 * 24 * 60 * 60;
const DAILY_DELETE = 24 * 60 * 60 * 1000;
const BTACH_SIZE = 1000;

type AlertRedisInfo = {
  symbol: string,
  direction: AlertDirection,
  targetPrice: number,
}

export class AlertModel {
  /*
    This function will add actice allert to redis as cache
    This redis work on ram 
    We are creating a zSets to get near value
      the key is target price
      the value is alert id
    The we store it in sorted way
  */
  static async addActiveAlert(alert: {id: string} & AlertRedisInfo ): Promise<void> {
    const key = `alerts:${alert.symbol}:${alert.direction}`;
    try {
      await redisClient.zAdd(key, {
        score: Number(alert.targetPrice),
        value: alert.id,
      });
      await redisClient.expire(key, ALERT_KEY_TTL);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  /*
    In this function we get alert with symbol:direction
    This use +inf to range from positive as upAlerts
    This use -inf to range from negative as downAlerts
  */
  static async triggeredAlert(symbol: string, currentPrice: number): Promise<string[]> {
    try {
      const upAlerts = await redisClient.zRange(
        `alerts:${symbol}:UP`,
        '-inf',
        currentPrice,
        {BY: 'SCORE'}
      );

      const downAlerts = await redisClient.zRange(
        `alerts:${symbol}:DOWN`,
        currentPrice,
        '+inf',
        {BY: 'SCORE'}
      );
      /*
        This return two alerts as array
      */
      return [...upAlerts, ...downAlerts];
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  /*
    We remove alert using zRem
    This remove alert using the key as symbol and direction
    We pass alertId as value
  */
  static async removeAlerts(alertId: string, symbol: string, direction?: AlertDirection): Promise<void> {
    try {
      if (!direction) {
        await Promise.all([
          redisClient.zRem(`alerts:${symbol}:UP`, alertId),
          redisClient.zRem(`alerts:${symbol}:DOWN`, alertId),
        ]);
      } else {
        await redisClient.zRem(`alerts:${symbol}:${direction}`, alertId);
      }
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  /*
    This funciton will sync the DB with Redis
    This will use the scanKeys to get the alerts
  */
  static async activeAlertSync(): Promise<void> {
    try {
      let cursor = '0';
      do {
        /*
          This will scan the redis cache for 
          This will use cursor which is the starting value
          The count is how many of them
          Patern will match the alert:symbol:direct.
        */
        const result = await redisClient.scan(cursor, {MATCH: 'alerts:*', COUNT: 500});
        cursor = result.cursor;
        if (result.keys.length > 0) {
          await redisClient.del(result.keys);
        }
      } while(cursor !== '0');

      /*
        Now let's repopulate the redis with alerts
      */
      const acticeAlerts = await prisma.alert.findMany({
        where: {isActive: true},
        select: {
          id: true,
          symbol: true,
          targetPrice: true,
          direction: true,
        }
      });

      if (acticeAlerts.length === 0) return;

      let pipeline = redisClient.multi();
      let counter = 0;

      for (const alert of acticeAlerts) {
        const key = `alerts:${alert.symbol}:${alert.direction}`;
        pipeline.zAdd(key, {
          score: Number(alert.targetPrice),
          value: alert.id,
        });
        pipeline.expire(key, ALERT_KEY_TTL);
        if (counter % BTACH_SIZE === 0) {
          await pipeline.exec();
          pipeline = redisClient.multi();
        }
        counter++;
      }

      if (counter % BTACH_SIZE !== 0) {
        await pipeline.exec(); //leftovers
      }

      logger.info(`Synced ${acticeAlerts.length} alerts to Redis`);
    } catch (error: any) {
      logger.error('Alert sync failed:', { message: error.message });
    }
  }

  /*
    This function will validate the sync among redis and db
    This will help to log the sucess and unsucessful alerts
  */
 static async validateSync(): Promise<{
    isSync: boolean;
    dbCount: number;
    redisCount: number;
    discrepancies: number;
  }> {
    try {
      const dbAlertsCount = await prisma.alert.count({
        where: { isActive: true },
        //select: { id: true }
      });

      /*
        we get the redis keys from scan so that we can zCard
        we also have alerts from db at the top
      */
      let redisCount = 0;
      let cursor = '0';
      do {
        const result = await redisClient.scan(cursor, {MATCH: 'alerts:*', COUNT: 500});
        cursor = result.cursor;
        
        if (result.keys.length > 0) {
          const pipeline = redisClient.multi();
          for (const key of result.keys) {
             pipeline.zCard(key);
          }
          const counts = await pipeline.exec();
          // Sum up the counts from this batch
          const batchTotal = counts?.reduce((sum, c) => sum + (Number(c) || 0), 0) || 0;
          redisCount += Number(batchTotal);
        }
      } while(cursor !== '0');

      /*
        We see if it is sync or not
      */
      const isSync = dbAlertsCount === redisCount;
      const discrepancies = Math.abs(dbAlertsCount - redisCount);

      logger.info('Alert sync validation', {
        dbCount: dbAlertsCount,
        redisCount: redisCount,
        isSync,
        discrepancies
      });

      return {
        isSync,
        dbCount: dbAlertsCount,
        redisCount: redisCount,
        discrepancies
      };
    } catch (error) {
      logger.error(error);
      throw error;
    }
 }

  static async cleanUpAlerts(): Promise<void> {
    setInterval(async () => {
      try {
        const validIds = new Set(
          (await prisma.alert.findMany({
            where: { isActive: true },
            select: {id: true }
          })).map(alert => alert.id)
        );

        let cursor = '0';
        do {
          const result = await redisClient.scan(cursor, {MATCH: 'alerts:*', COUNT: 100});
          cursor = result.cursor;

          if (result.keys.length > 0) {
            for (const key of result.keys) {
              const alertIds = await redisClient.zRange(key, 0, -1);
              const stale = alertIds.filter(id => !validIds.has(id));
              
              if (stale.length > 0) {
                await redisClient.zRem(key, stale);
              }
            }
          }
        } while (cursor !== '0');
        logger.info('Cleaned up stale alerts');
      } catch (error) {
        logger.error(error);
        throw error;
      }
    }, DAILY_DELETE);
  }
}
