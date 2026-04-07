import { Context, InlineKeyboard } from "grammy";

const ONE_MONTH_PRICE = 2.99;
const HALF_YEAR_PRICE = 16.99;
const ONE_YEAR_PRICE = 31.99;

const PRICE_STARS_MONTH = 195;
const PRICE_STARS_HALF_YEAR = 1120;
const PRICE_STARS_YEAR = 2120;

export const sendUpgradeOptions = async (ctx: Context) => {
  if (!ctx.from) return;

  const keyboard = new InlineKeyboard()
    .text(`⭐️ 1 Month (${PRICE_STARS_MONTH} Stars)`, "buy_stars_1m")
    .text(`⚡️ Crypto ($${ONE_MONTH_PRICE})`, "buy_crypto_1m").row()
    
    .text(`⭐️ 6 Months (${PRICE_STARS_HALF_YEAR} Stars)`, "buy_stars_6m")
    .text(`⚡️ Crypto ($${HALF_YEAR_PRICE})`, "buy_crypto_6m").row()
    
    .text(`⭐️ 1 Year (${PRICE_STARS_YEAR} Stars)`, "buy_stars_1y")
    .text(`⚡️ Crypto ($${ONE_YEAR_PRICE})`, "buy_crypto_1y");

  await ctx.reply(
    `💎 <b>Kairos Pro Upgrade</b>\n\n` +
    `Unlock unlimited alerts, priority speed, and multi-pair tracking.\n` +
    `Choose your plan:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
};

// 2. Handle Star Invoices
export const handleStarsInvoice = async (ctx: Context, tier: '1m' | '6m' | '1y') => {
  let title, description, payload, price;

  switch (tier) {
    case '1m':
      title = "Kairos Pro (1 Month)";
      description = "30 Days of Unlimited Alerts";
      payload = "sub_1_month";
      price = PRICE_STARS_MONTH;
      break;
    case '6m':
      title = "Kairos Pro (6 Months)";
      description = "180 Days of Unlimited Alerts";
      payload = "sub_6_months";
      price = PRICE_STARS_HALF_YEAR;
      break;
    case '1y':
      title = "Kairos Pro (1 Year)";
      description = "365 Days of Unlimited Alerts";
      payload = "sub_1_year";
      price = PRICE_STARS_YEAR;
      break;
  }

  await ctx.api.sendInvoice(
    ctx.from!.id,
    title,
    description,
    payload,
    "XTR", // Currency for Stars
    [{ label: title, amount: price }]
  );
};

export const handleCryptoInstruction = async (ctx: Context, tier: '1m' | '6m' | '1y') => {
  let price;
  if (tier === '1m') price = ONE_MONTH_PRICE;
  if (tier === '6m') price = HALF_YEAR_PRICE;
  if (tier === '1y') price = ONE_YEAR_PRICE;

  await ctx.reply(
    `⚡️ <b>Crypto Payment Instructions</b>\n\n` +
    `Please send <b>$${price} USDT (BEP20)</b> to:\n` +
    `<code>xyz</code>\n\n` +
    `After sending, DM @xyz with the Transaction Hash.`,
    { parse_mode: "HTML" }
  );
};
