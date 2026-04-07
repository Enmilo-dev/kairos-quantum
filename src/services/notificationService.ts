import "dotenv/config";
import { Context, InlineKeyboard } from "grammy";
import { alertService } from "./alertService.js";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { redisClient } from "../lib/redisClient.js";
import { validateSymbol } from "../controllers/inputController.js";
import { logger } from "../utils/logger.js";

const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FREE_TIER_LIMIT = 3;
const SESSION_TTL = 5 * 60;

interface wizardSession {
  step: 'Waiting for Price';
  symbol: string;
  msgId: number;
  createdAt: number;
}

function parseFriendlyNumber(input: string): number {
  let clean = input.toLowerCase().replace(/[^0-9.km]/g, '');
  let multiplier = 1;
  if (clean.endsWith('k')) {
    multiplier = 1000;
    clean = clean.slice(0, -1);
  } else if (clean.endsWith('m')) {
    multiplier = 1000000;
    clean = clean.slice(0, -1);
  }
  return parseFloat(clean) * multiplier;
}

const wizardSession = new Map<bigint, wizardSession>();
const SESSION_TIMEOUT = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 30_000;

setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;

  for (const [userId, session] of wizardSession.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      logger.warn(`Wizard session expired for user ${userId}`);
      wizardSession.delete(userId);
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    logger.info(`Cleaned up ${deletedCount} expired wizard sessions`);
  }
}, CLEANUP_INTERVAL);

const fetchCurrentPrice = async (symbol: string): Promise<number | null>=> {
  for (let i = 0; i < 3; i++) { 
    const priceKey = `price:${symbol}`;
    const priceStr = await redisClient.get(priceKey);
    return priceStr ? parseFloat(priceStr) : null;
    //await new Promise(resolve => setTimeout(resolve, 250)); 
  }
  return null;
};

const PRICE_VALIDATION = {
  MIN: 0.00000001,
  MAX: 1000000,
  DECIMALS: 8,
};

function validatePrice(price: number): { valid: boolean; error?: string } {
  if (typeof price !== 'number' || isNaN(price) || !isFinite(price)) {
    return { valid: false, error: 'Price must be a valid number' };
  }

  if (price <= 0) {
    return { valid: false, error: 'Price must be greater than 0' };
  }

  if (price < PRICE_VALIDATION.MIN) {
    return { valid: false, error: `Price must be at least $${PRICE_VALIDATION.MIN}` };
  }

  if (price > PRICE_VALIDATION.MAX) {
    return { valid: false, error: `Price cannot exceed $${PRICE_VALIDATION.MAX}` };
  }

  // Check decimal places
  const decimalPlaces = (price.toString().split('.')[1] || '').length;
  if (decimalPlaces > PRICE_VALIDATION.DECIMALS) {
    return { valid: false, error: `Maximum ${PRICE_VALIDATION.DECIMALS} decimal places allowed` };
  }

  return { valid: true };
}

function premiumUserValidate (user: any): boolean {
  if (!user.isPremium || !user.premiumUntil) {
    return false;
  }

  const now = new Date();
  const expiryDate = new Date(user.premiumUntil);

  return expiryDate > now;
}

const addAlertBot = async (ctx: Context, symbol: string, targetPrice: number) => {
  if (!ctx.from) return;

  const priceValidation = validatePrice(targetPrice);
  if (!priceValidation.valid) {
    return ctx.reply(`❌ ${priceValidation.error}`);
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    include: { _count: { select: { alerts: { where: { isActive: true } } } } }
  });

  if (!user) {
    return ctx.reply('User not registered. Please run /start first.');
  }

  const FREE_TIER = 3;
  const activeCount = user._count.alerts;
  const isValidPremium = premiumUserValidate(user);

  if (!isValidPremium && activeCount >= FREE_TIER && ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Limit Reached! \n\nPlease Update your account.');
  }

  const currentPrice = await fetchCurrentPrice(symbol);

  if (!currentPrice) {
    return ctx.reply('Something went wrong. Please try again later');
  }

  let direction: 'UP' | 'DOWN';

  if (currentPrice > targetPrice) {
    direction = 'DOWN';
  } else {
    direction = 'UP';
  }

  await ctx.reply(`Setting alert for ${symbol} at ${targetPrice}.`);

  try {
    const alert = await alertService.createAlert({
      userId: user.id,
      symbol: symbol,
      targetPrice: new Prisma.Decimal(String(targetPrice)),
      direction: direction,
      alertType: 'TOUCH',
      isActive: true,
    });

    await ctx.reply(
      `✅ <b>Trap Set!</b>\n\n` +
      `🪙 Symbol: <b>${symbol}</b>\n` +
      `🎯 Target: <b>$${targetPrice}</b>\n` +
      `📉 Current: $${currentPrice}\n` +
      `🧭 Direction: <b>${direction}</b> (Auto-detected)`,
      { parse_mode: "HTML" }
    );
  } catch (error: any){
    logger.error('Failed to create alert', { error: error.message });
    await ctx.reply('System Error: Could not create alert.');
  }
};

//Export commonads ->

export const startCommand = async (ctx: Context)=> {
  if (!ctx.from) return;
  
  try {
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(ctx.from.id) },
      update: { username: ctx.from.username || 'Unknown'},
      create: {
        telegramId: BigInt(ctx.from.id),
        username: ctx.from.username || 'Unknown',
        isPremium: false,
      }
    });

    console.log(user);

    await ctx.reply(
      `Welcome to <b>Kairos Quantum</b>\n\n` +
      `Hello ${ctx.from.first_name}, you are now connected to a high-frequency market data and alerting system. Stay ahead of the market with real-time precision alerts.\n\n` +
      `<b>Available Commands</b>\n` +
      `/add — Create a new price alert\n` +
      `/update — Upgrade your account for higher limits\n` +
      `/list — View all active alerts`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    logger.error(error);
    await ctx.reply("System Error: Could not register user.");
  }
};

export const addAlertCommand = async (ctx: Context)=> {
  if (!ctx.from) return;

  const args = ctx.match;
  if (!args || typeof(args) !== 'string' || !args.trim()) {
    const keyboard = new InlineKeyboard()
      .text("₿ BTC", "select_coin:BTCUSDT").text("💎 ETH", "select_coin:ETHUSDT").row()
      .text("☀️ SOL", "select_coin:SOLUSDT").text("🐶 DOGE", "select_coin:DOGEUSDT").row()
      .text("🐸 PEPE", "select_coin:PEPEUSDT").text("Ripple (XRP)", "select_coin:XRPUSDT").row()
      .text("✏️ Custom Coin", "select_coin:CUSTOM");
    
    return ctx.reply(
      `<b>📢 New Alert</b>\n\n` + 
      `Select a standard asset or choose Custom.`, 
      {
        parse_mode: "HTML",
        reply_markup: keyboard
      }
    );
  }

  const [rawSymbol, rawPrice] = args.split(' ');
  if (!rawSymbol || !rawPrice) {
    return ctx.reply('Usage: /add COIN PRICE\nExample: /add BTC 85000');
  }

  const symbolValidation = validateSymbol(rawSymbol);
  if (!symbolValidation.valid) {
    return ctx.reply(`❌ ${symbolValidation.error}`);
  }

  const symbol = symbolValidation.symbol!;
  const targetPrice = parseFloat(rawPrice);


  // const symbol = rawSymbol.toUpperCase().includes('USDT')
  //   ? rawSymbol.toUpperCase()
  //   : rawSymbol.toUpperCase() + 'USDT';
  // const targetPrice = parseFloat(rawPrice);

  if (isNaN(targetPrice)) {
    return ctx.reply('Invalid number, please use a number.');
  }


  try {
    await addAlertBot (ctx, symbol, targetPrice);
  } catch (error) {
    logger.error(error);
    await ctx.reply("System Error: Could not add alert.");
  }
};

export const listCommand = async (ctx: Context)=> {
  if (!ctx.from) return;

  try {
    const alerts = await prisma.alert.findMany({
      where: {
        user: { telegramId: BigInt(ctx.from.id) },
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (alerts.length === 0) {
      return ctx.reply('No active alerts found.');
    }

    const keyboard = new InlineKeyboard();

    alerts.forEach((alert)=> {
      const incon = alert.direction === 'UP' ? '🟢' : '🔴';
      const label = `${incon} ${alert.symbol} at $${alert.targetPrice}(${alert.alertType})`;
      keyboard.text(`🗑️ ${label}`, `delete_alert:${alert.id}`).row();
    });

    await ctx.reply(`📋 <b>Tap to Delete</b>`, { 
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch (error) {
    logger.error(error);
    await ctx.reply("System Error: Could not list alerts.");
  }
};

export const deleteAlertCallBack = async (ctx: Context)=> {
  if (!ctx.from || !ctx.match) return
  const alertId = ctx.match[1];
  if (!alertId) return;

  try {
    const deleted = await alertService.cancelAlert(alertId, BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({
      text: `✅ Deleted: ${deleted.symbol} @ ${deleted.targetPrice}`,
    });

    const remindingAlerts = await prisma.alert.findMany({
      where: {
        user: { telegramId: BigInt(ctx.from.id) },
        isActive: true,
      },
      orderBy: { createdAt: 'desc' }
    });

    if (remindingAlerts.length === 0) {
      await ctx.editMessageText("📭 <b>No active traps.</b>", { parse_mode: "HTML" });
    } else {
      const newKeyboard = new InlineKeyboard();
      remindingAlerts.forEach((alert)=> {
        const incon = alert.direction === 'UP' ? '🟢' : '🔴';
        const label = `${incon} ${alert.symbol} at $${alert.targetPrice}(${alert.alertType})`;
        newKeyboard.text(`🗑️ ${label}`, `delete_alert:${alert.id}`).row();
      });
      await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard });
    }
  } catch (error) {
    logger.error(error);
    await ctx.answerCallbackQuery({
      text: "System Error: Could not delete alert.",
    });
  }
};

export const selectCoinCallBack = async (ctx: Context)=> {
  if (!ctx.from || !ctx.callbackQuery || !ctx.match) return;
  const symbol = ctx.match[1];
  if (!symbol) return;

  if (symbol === 'CUSTOM') {
    return ctx.reply("📝 Usage: Type <code>/add COIN PRICE</code>", {parse_mode: "HTML"});
  }

  wizardSession.set(BigInt(ctx.from.id), {
    step: 'Waiting for Price',
    symbol: symbol,
    msgId: ctx.callbackQuery.message?.message_id || 0,
    createdAt: Date.now(),
  });

  const currentPrice = await fetchCurrentPrice(symbol);
  const priceText = currentPrice ? `${currentPrice}`: "Unknown";

  await ctx.reply(
    `📉 <b>Selected: ${symbol}</b>\n` + 
    `Current Price: <b>${priceText}</b>\n\n` + 
    `🔢 <b>Reply with your target price:</b>\n` + 
    `<i>(Example: 95390.93 or 95k)</i>`, 
    { 
      parse_mode: "HTML", 
      reply_markup: { force_reply: true }
    }
  );

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup();
};

export const globalMessageCommand = async (ctx: Context)=> {
  if (!ctx.from) return;

  const userId = BigInt(ctx.from.id);
  const session = wizardSession.get(userId);

  if (!session) {
    return ctx.reply('No active session. Please use /add to start a new alert.');
  }

  if (session.step !== 'Waiting for Price' || !ctx.message || !ctx.message.text) {
    return;
  }

  session.createdAt = Date.now();

  const targetPrice = parseFriendlyNumber(ctx.message.text);

  if (isNaN(targetPrice)) {
    return ctx.reply('Invalid number, please use a number.');
  }

  try {
    await addAlertBot (ctx, session.symbol, targetPrice);
  } catch (error) {
    logger.error(error);
    await ctx.reply("System Error: Could not add alert.");
  } finally {
    wizardSession.delete(userId);
  }
};

export const broadCastCommand = async (ctx: Context)=> {
  if (!ctx.from) return;
  if (!ADMIN_ID) return;

  if (ctx.from.id !== ADMIN_ID) {
    return;
  }

  const message = ctx.match;
  if (!message || typeof(message) !== 'string') {
    return ctx.reply('Usage: /broadcast [MESSAGE]');
  }

  if (message.length > 4000) {
    return ctx.reply('Message too long. Please keep it under 4000 characters.');
  }

  try {
    const user = await prisma.user.findMany();
    await ctx.reply(`Starting broadcast to ${user.length} users...`);

    let success = 0;
    let failed = 0;

    const BATCH_SIZE = 30;
    const DELAY_MS = 1000;

    for (let i = 0; i < user.length; i += BATCH_SIZE) {
      const batch = user.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (u)=> {
          try {
            await ctx.api.sendMessage(u.telegramId.toString(), `📢 <b>ANNOUNCEMENT</b>\n\n${message}`, {
              parse_mode: 'HTML'
            });
            success++;
          } catch (error: any) {
            if (error.error_code === 429) {
              logger.warn(`Rate limited. Retry-After: ${error.parameters?.retry_after}s`);
            } else if (error.error_code === 403) {
              logger.debug(`User ${u.telegramId} blocked bot`);
            } else {
              logger.error(`Failed to send message to ${u.telegramId}:`, error.message);
            }
            failed++;
          }
        })
      );

      if (i + BATCH_SIZE < user.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    await ctx.reply(
      `✅ <b>Broadcast Complete</b>\n\n` +
      `Sent: ${success}\n` +
      `Failed: ${failed} (Users likely blocked the bot)`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    logger.error(error);
    await ctx.reply("System Error: Could not broadcast message.");
  }
};

export const getDevInfo = async (ctx: Context)=> {
  if (!ctx.from) return;
  try {
    await ctx.reply(`Built by <a href="https://github.com/Enmilo-dev">Enmilo</a>`, { parse_mode: "HTML" })
  } catch (error) {
    await ctx.reply('Something went wrong.');
  }
};
