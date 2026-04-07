import 'dotenv/config'
import { redisClient } from '../lib/redisClient.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';


const lastPriceUpdate = Date.now();

export const healthCheck = async (req: any, res: any) => {
  const status = {
    uptime: process.uptime(),
    timeStamp: new Date().toISOString(),
    service: {
      redis: 'UNKNOWN',
      db: 'UNKNOWN',
      ws: 'UNKNOWN',
    }
  }

  let statusCode = 200;

  try {
    if (redisClient.isOpen) {
      status.service.redis = 'OK';
    } else {
      statusCode = 503;
      status.service.redis = 'ERROR';
    }
  } catch (error) {
    status.service.redis = 'ERROR';
    statusCode = 503;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    status.service.db = 'OK';
  } catch (error) {
    status.service.db = 'ERROR';
    statusCode = 503;
  }

  const timeScienceLastUpdate = Date.now() - lastPriceUpdate;
  if (timeScienceLastUpdate < 60000) {
    status.service.ws = 'OK';
  } else {
    status.service.ws = `ERROR: Last update: ${Math.floor(timeScienceLastUpdate / 1000)}`;
    statusCode = 503;
  }

  if (statusCode !== 200) {
    logger.warn(`Health check failed: ${JSON.stringify(status)}`);
  }

  res.status(statusCode).json(status);
};

