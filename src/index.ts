import 'dotenv/config';
import express from 'express';
import { bot } from './bot.js';
import { prisma } from './lib/prisma.js';
import { logger } from './utils/logger.js';
import { AlertModel } from './models/Alert.js';
import { redisClient } from './lib/redisClient.js';
import { healthCheck } from './router/dashboard.js';
import { alertService } from './services/alertService.js';
import { priceService } from './services/priceService.js';
import { fetchValidCryptoSymbols } from './config/cryptoSym.js';

const SHUTDOWN_TIMEOUT = 30000;
const REDIS_RETRY_ATTEMPTS = 5;
const REDIS_BASE_DELAY = 1000;

const app = express();
const PORT = process.env.ROUTER_PORT || 3000;

class StartupError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'StartupError';
  }
}

async function redisConnectWithRetry(
  retries: number = REDIS_RETRY_ATTEMPTS,
  baseDelay: number = REDIS_BASE_DELAY
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
        logger.info("Redis connected successfully", { attempt });
        return;
      }
      logger.debug("Redis already connected");
      return;
    } catch (error) {
      logger.warn("Redis connection failed", { attempt, error });
      
      if (attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
        logger.info("Retrying Redis connection", { delay });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new StartupError("Failed to connect to Redis after all retries");
}

async function verifyServicesHealth(): Promise<void> {
  const healthChecks = [
    { name: 'Redis', check: () => redisClient.ping() },
    { name: 'Database', check: () => prisma.$queryRaw`SELECT 1` },
  ];

  await Promise.all(healthChecks.map(async ({ name, check }) => {
    try {
      await check();
      logger.info("Service health check passed", { service: name });
    } catch (error) {
      throw new StartupError(`${name} health check failed`, error as Error);
    }
  }));
}

async function main(): Promise<void> {
  logger.info("Booting up Kairos Quantum...");

  try {
    await redisConnectWithRetry();
    
    logger.info("Loading and validating crypto symbols...");
    await fetchValidCryptoSymbols();
    logger.info("Crypto symbols loaded");

    logger.info("Syncing active alerts from database...");
    await AlertModel.activeAlertSync();

    logger.info("Starting alert service...");
    await alertService.start();

    logger.info("Starting price stream service...");
    await priceService.start();

    logger.info("Running startup health verification...");
    await verifyServicesHealth();

    logger.info("All systems operational. Starting bot...");
    await bot.start();

    logger.info('Kairos Q is online and ready');
  } catch (error) {
    logger.error("Fatal startup error", { error });
    process.exitCode = 1;
    throw error;
  }
}

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress, ignoring signal", { signal });
    return;
  }
  
  isShuttingDown = true;
  logger.info("Initiating graceful shutdown", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout exceeded. Forcing exit.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    logger.info("Stopping bot...");
    await bot.stop();

    logger.info("Stopping price service...");
    await priceService.stop();

    logger.info("Stopping alert service...");
    await alertService.stop();

    logger.info("Closing database connections...");
    await prisma.$disconnect();

    logger.info("Closing Redis connection...");
    try {
      await redisClient.quit();
    } catch (error) {
      logger.warn("Redis quit failed, forcing disconnect", { error });
      await redisClient.disconnect();
    }

    clearTimeout(shutdownTimeout);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error("Error during graceful shutdown", { error });
    process.exit(1);
  }
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err: Error) => {
  logger.error('UNCAUGHT EXCEPTION', err);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  logger.error('UNHANDLED REJECTION', { reason, promise });
  process.exitCode = 1;
  gracefulShutdown('unhandledRejection').catch(() => process.exit(1));
});

main().catch((error) => {
  logger.error("Application crashed during startup", { error });
  process.exit(1);
});

app.get('/health', healthCheck);

app.listen(PORT, ()=> {
  logger.info(`Server is running on http://localhost:${PORT}/health`);
});
