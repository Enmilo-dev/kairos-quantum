import { createClient } from "redis";
import { logger } from "../utils/logger.js";

const redisHost = process.env.REDIS_HOST;
const redisPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;
const redisPassword = process.env.REDIS_PASSWORD;
const redisUsername = process.env.REDIS_USERNAME || 'default';

if (!redisHost || redisHost.trim() === '') {
  throw new Error('REDIS_HOST environment variable is not defined or empty.');
}

if (isNaN(redisPort) || redisPort < 1 || redisPort > 65535) {
  throw new Error(`Invalid REDIS_PORT: ${process.env.REDIS_PORT}. Must be a number between 1 and 65535.`);
}

if (!redisPassword || redisPassword.trim() === '') {
  throw new Error('REDIS_PASSWORD environment variable is not defined or empty.');
}

export const redisClient = createClient({
  username: redisUsername,
  password: redisPassword,
  socket: {
    reconnectStrategy: (retries) => {
      const baseDelay = 100;
      const maxDelay = 30000;
      const delay = Math.min(baseDelay * Math.pow(2, retries), maxDelay);
      
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      const finalDelay = Math.floor(delay + jitter);
      
      logger.warn('Redis reconnecting', { 
        attempt: retries + 1, 
        delayMs: finalDelay 
      });
      return delay;
    },
    host: redisHost,
    port: redisPort,
  }
});

redisClient.on('error', (err) => {
  logger.error('Redis error', { error: err.message, stack: err.stack });
});

redisClient.on('connect', () => {
  logger.info('Redis connected', { host: redisHost, port: redisPort });
});

redisClient.on('reconnecting', () => {
  logger.warn('Redis reconnecting...');
});

redisClient.on('ready', () => {
  logger.info('Redis ready for commands');
});
