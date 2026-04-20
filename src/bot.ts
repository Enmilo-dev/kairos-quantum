import "dotenv/config";
import { Bot } from "grammy";
import { logger } from "./utils/logger.js";
import {
  addAlertCommand,
  broadCastCommand,
  deleteAlertCallBack,
  getDevInfo,
  globalMessageCommand,
  listCommand,
  selectCoinCallBack,
  startCommand
} from "./services/notificationService.js";
import {
  upgradeCommand,
  paymentCallbacks, 
  preCheckout, 
  handleSuccessfulPayment 
} from "./controllers/paymentServiceController.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not defined");

const tokenPattern = /^\d+:[A-Za-z0-9_-]+$/;
if (!tokenPattern.test(token)) {
  throw new Error(`Invalid TELEGRAM_BOT_TOKEN format. Got: "${token.substring(0, 10)}..."`);
}

export const bot = new Bot(token);

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

const rateLimitStore = new Map<number, { count: number; resetTime: number }>();
function checkRateLimit(userId: number, maxRequests: number = 5, windowMs: number = 5000): boolean {
  const now = Date.now();
  const userLimit = rateLimitStore.get(userId);

  if (userLimit && now < userLimit.resetTime) {
    rateLimitStore.delete(userId);
  }

  if (!userLimit || now > userLimit.resetTime) {
    rateLimitStore.set(userId, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (userLimit.count < maxRequests) {
    userLimit.count++;
    return true;
  }

  return false;
}

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (error: any) {
    const isTransient = error instanceof TransientError ||
                       error.message?.includes('ECONNREFUSED') ||
                       error.message?.includes('ETIMEDOUT');
    logger.error('Handler error', { 
      userId: ctx.from?.id, 
      error: error.message,
      stack: error.stack,
      transient: isTransient 
    });
    
    const message = isTransient 
      ? "⚠️ Temporary system issue. Please try again in a moment."
      : "❌ An error occurred. Please try again later or contact support.";
    
    await ctx.reply(message).catch(console.error);
  }
});

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  const isAdmin = process.env.ADMIN_USER_IDS?.split(",").includes(String(ctx.from.id));
  const maxRequests = isAdmin ? 100 : 5;

  if (!checkRateLimit(ctx.from.id, maxRequests, 5000)) {
    logger.warn(`Rate limit exceeded for user ${ctx.from.id}`);
    return ctx.reply("⏱️ Too many requests. Please wait a moment before trying again.");
  }

  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.message?.text && ctx.message.text.length > 4096) {
    logger.warn(`Message exceeds max length from user ${ctx.from?.id}`);
    return ctx.reply("Message is too long. Please keep it under 4096 characters.");
  }
  return next();
});

bot.command('start', startCommand);
bot.command('add', addAlertCommand);
bot.command('list', listCommand);

bot.callbackQuery(/^delete_alert:([a-zA-Z0-9-]{20,40})$/, deleteAlertCallBack);
bot.callbackQuery(/^select_coin:([A-Z]{3,10}USDT|CUSTOM)$/, selectCoinCallBack);

bot.command('broadcast', broadCastCommand);
bot.command('update', upgradeCommand);
bot.on("callback_query:data", paymentCallbacks);
bot.on("pre_checkout_query", preCheckout);
bot.on("message:successful_payment", handleSuccessfulPayment);
bot.command('dev', getDevInfo);
bot.on('message:text', globalMessageCommand);

bot.catch((err) => {
  console.error('Telegram error: ', err);
});
