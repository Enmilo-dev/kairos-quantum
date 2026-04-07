import { Context } from "grammy";
import { logger } from "../utils/logger.js";
import { prisma } from "../lib/prisma.js";
import { 
  handleStarsInvoice,
  handleCryptoInstruction,
  sendUpgradeOptions
} from "../services/paymentService.js";

export const paymentCallbacks = async (ctx: Context) => {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === "buy_stars_1m") return handleStarsInvoice(ctx, '1m');
  if (data === "buy_stars_6m") return handleStarsInvoice(ctx, '6m');
  if (data === "buy_stars_1y") return handleStarsInvoice(ctx, '1y');

  if (data === "buy_crypto_1m") return handleCryptoInstruction(ctx, '1m');
  if (data === "buy_crypto_6m") return handleCryptoInstruction(ctx, '6m');
  if (data === "buy_crypto_1y") return handleCryptoInstruction(ctx, '1y');
};

export const preCheckout = async (ctx: Context) => {
  await ctx.answerPreCheckoutQuery(true);
};

export const handleSuccessfulPayment = async (ctx: Context) => {
  if (!ctx.from || !ctx.message?.successful_payment) return;

  const payment = ctx.message.successful_payment;
  const payload = payment.invoice_payload;
  const telegramId = BigInt(ctx.from.id);

  let durationDays = 30;
  let tierName = '1_MONTH';
  
  if (payload === 'sub_6_months') { durationDays = 180; tierName = '6_MONTHS'; }
  if (payload === 'sub_1_year') { durationDays = 365; tierName = '1_YEAR'; }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingPayment = await tx.payment.findUnique({
        where: { providerId: payment.provider_payment_charge_id }
      });

      if (existingPayment) {
        throw new Error('DUPLICATE_PAYMENT');
      }

      const user = await tx.user.findUnique({
        where: { telegramId }
      });

      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      const currentExpiry = user.premiumUntil && user.premiumUntil > new Date()
        ? user.premiumUntil
        : new Date();

      const newExpiry = new Date(currentExpiry);
      newExpiry.setDate(newExpiry.getDate() + durationDays);

      const updatedUser = await tx.user.update({
        where: { telegramId },
        data: { isPremium: true, premiumUntil: newExpiry },
      });

      const paymentRecord = await tx.payment.create({
        data: {
          userId: user.id,
          amount: payment.total_amount,
          currency: payment.currency,
          providerId: payment.provider_payment_charge_id,
          tier: tierName,
          status: 'COMPLETED',
        },
      });

      return { updatedUser, paymentRecord, newExpiry };
    });

    await ctx.reply(
      `✅ <b>Payment Successful!</b>\n\n` +
      `💎 Tier: <b>Premium</b>\n` +
      `📅 Expires: <b>${result.newExpiry.toLocaleDateString()}</b>\n\n` +
      `Go catch those wicks! 🕯️`,
      { parse_mode: 'HTML' }
    );

    logger.info(`Payment processed for user ${telegramId}. New expiry: ${result.newExpiry.toISOString()}`);
  } catch (error: any) {
    if (error.message === 'DUPLICATE_PAYMENT') {
      logger.warn(`Duplicate payment detected: ${payment.provider_payment_charge_id}`);
      return ctx.reply('⚠️ This payment has already been processed. Your premium is already active.');
    }
    if (error.message === 'USER_NOT_FOUND') {
      logger.error(`User not found for payment: ${telegramId}`);
      return ctx.reply('User not found. Please run /start first.');
    }

    logger.error('Payment processing error:', error);
    await ctx.reply(
      '⚠️ Payment received but system error during processing.\n\n' +
      'Please contact @support with your transaction ID:\n' +
      `<code>${payment.provider_payment_charge_id}</code>`,
      { parse_mode: 'HTML' }
    ).catch(console.error);
  }
};

// export const handleSuccessfulPayment = async (ctx: Context) => {
//   if (!ctx.from || !ctx.message?.successful_payment) return;

//   const payment = ctx.message.successful_payment;
//   const payload = payment.invoice_payload;
//   const telegramId = BigInt(ctx.from.id);

//   const validPayloads = ['sub_1_month', 'sub_6_months', 'sub_1_year'];
//   if (!validPayloads.includes(payload)) {
//     logger.error(`Invalid payload: ${payload}`);
//     return ctx.reply('Invalid subscription payload. Contact support.');
//   }

//   let durationDays = 30;
//   let tierName = '1_MONTH';

//   if (payload === 'sub_6_months') { durationDays = 180; tierName = '6_MONTHS'; }
//   if (payload === 'sub_1_year') { durationDays = 365; tierName = '1_YEAR'; }

//   try {
//     const user = await prisma.user.findUnique({ where: { telegramId } });
//     if (!user) {
//       logger.error(`User not found for payment: ${telegramId}`);
//       return ctx.reply('User not found. Please run /start first.');
//     }

//     // const existingPayment = await prisma.payment.findUnique({
//     //   where: { 
//     //     providerId: payment.provider_payment_charge_id,
//     //     status: 'COMPLETED',
//     //   },
//     // });

//     const recentPayment = await prisma.payment.findFirst({
//       where: {
//         userId: user.id,
//         providerId: payment.provider_payment_charge_id,
//         status: 'COMPLETED',
//       },
//     });

//     if (recentPayment) {
//       logger.warn(`Duplicate payment detected: ${payment.provider_payment_charge_id}`);
//       return ctx.reply('⚠️ This payment has already been processed. Your premium is already active.');
//     }

//     const currentExpiry = user.premiumUntil && user.premiumUntil > new Date()
//       ? user.premiumUntil
//       : new Date();

//     const newExpiry = new Date(currentExpiry);
//     newExpiry.setDate(newExpiry.getDate() + durationDays);

//     const result = await prisma.$transaction( async (tx) => {
//         const existingPayment = await tx.payment.findUnique({
//           where: { providerId: payment.provider_payment_charge_id }
//         });

//         if (existingPayment) {
//           throw new Error('Duplicate payment detected in transaction.');
//         }
        
//         const updatedUser = await tx.user.update({
//           where: { telegramId },
//           data: { isPremium: true, premiumUntil: newExpiry, },
//         });

//         const paymentRecord = await tx.payment.create({
//           data: {
//             userId: user.id,
//             amount: payment.total_amount,
//             currency: payment.currency,
//             providerId: payment.provider_payment_charge_id,
//             tier: tierName,
//             status: 'COMPLETED',
//           },
//         });

//         return { updatedUser, paymentRecord };
//       }
//     );

//     try {
//       await ctx.reply(
//         `✅ <b>Payment Successful!</b>\n\n` +
//         `💎 Tier: <b>${tierName}</b>\n` +
//         `📅 Expires: <b>${newExpiry.toLocaleDateString()}</b>\n\n` +
//         `Go catch those wicks! 🕯️`,
//         { parse_mode: 'HTML' }
//       );

//       logger.info(`Payment processed for user ${telegramId}. New expiry: ${newExpiry.toISOString()}`);
//     } catch (notificationError) {
//       logger.error(`Failed to send payment confirmation to ${telegramId}:`, notificationError);
//     }
//   } catch (error) {
//     logger.error('Payment processing error:', error);
//     await ctx.reply(
//       '⚠️ Payment received but system error during processing.\n\n' +
//       'Please contact @support with your transaction ID:\n' +
//       `<code>${payment.provider_payment_charge_id}</code>`,
//       { parse_mode: 'HTML' }
//     ).catch(console.error);
//   }
// };

// export const handleSuccessfulPayment = async (ctx: Context) => {
//   if (!ctx.from || !ctx.message?.successful_payment) return;

//   const payment = ctx.message.successful_payment;
//   const payload = payment.invoice_payload; 
//   const telegramId = BigInt(ctx.from.id);

//   let durationDays = 30;
//   let tierName = "1_MONTH";
  
//   if (payload === "sub_6_months") { durationDays = 180; tierName = "6_MONTHS"; }
//   if (payload === "sub_1_year") { durationDays = 365; tierName = "1_YEAR"; }


//   const user = await prisma.user.findUnique({ where: { telegramId } });
//   const currentExpiry = user?.premiumUntil && user.premiumUntil > new Date() 
//     ? user.premiumUntil 
//     : new Date();
    
//   const newExpiry = new Date(currentExpiry);
//   newExpiry.setDate(newExpiry.getDate() + durationDays);

//   try {
//     await prisma.$transaction([
//       prisma.user.update({
//         where: { telegramId },
//         data: { 
//           isPremium: true, 
//           premiumUntil: newExpiry 
//         }
//       }),
//       prisma.payment.create({
//         data: {
//           userId: user!.id,
//           amount: payment.total_amount,
//           currency: payment.currency,
//           providerId: payment.provider_payment_charge_id,
//           tier: tierName,
//           status: "COMPLETED"
//         }
//       })
//     ]);

//     await ctx.reply(
//       `✅ <b>Payment Successful!</b>\n\n` +
//       `Your Kairos Pro plan is active until: <b>${newExpiry.toLocaleDateString()}</b>\n` +
//       `Go catch those wicks! 🕯️`,
//       { parse_mode: "HTML" }
//     );
    
//   } catch (error) {
//     console.error("Payment Error:", error);
//     await ctx.reply("⚠️ Payment received but system error. Contact Admin.");
//   }
// };

export const upgradeCommand = async (ctx: Context) => {
  if (!ctx.from) return;
  const telegramId = BigInt(ctx.from.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { isPremium: true, premiumUntil: true }
  });

  if (user?.isPremium) {
    const expiry = user.premiumUntil 
      ? user.premiumUntil.toLocaleDateString() 
      : "Lifetime";

    return ctx.reply(
      `💎 <b>You are already a VIP!</b>\n\n` +
      `✅ Status: <b>Active</b>\n` + 
      `📅 Expires: <b>${expiry}</b>\n\n` + 
      `You can set unlimited traps. Go get 'em!`,
      { parse_mode: "HTML" }
    );
  }

  await sendUpgradeOptions(ctx);
};
