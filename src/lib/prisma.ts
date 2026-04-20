import "dotenv/config";
import { logger } from "../utils/logger.js";
import { PrismaClient } from '../generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString || connectionString.trim() === '') {
  throw new Error('DATABASE_URL environment variable is not defined or empty.');
}

const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
    { level: 'info', emit: 'event' },
  ],
});

prisma.$on('error', (e) => {
  logger.error('[Prisma Error]',{ message: e.message });
});

prisma.$on('warn', (e) => {
  logger.warn('[Prisma Warning]', { message: e.message });
});

prisma.$on('info', (e) => {
  logger.info('[Prisma Info]', { message: e.message });
});

prisma.$connect()
  .then(async () => {
    logger.info('Prisma connected to database successfully');
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Database health check passed');
  })
  .catch((error) => {
    logger.error('Failed to connect to database:', error.message);
    process.exit(1);
  });

export { prisma };
