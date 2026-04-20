import axios from "axios";
import { logger } from "../utils/logger.js";

export const validSymbol = new Set<string>();

const MAX_FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 5000;

export const fetchValidCryptoSymbols = async () => {
  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      logger.info(`Fetching crypto symbols (attempt ${attempt}/${MAX_FETCH_RETRIES})...`);
      const response = await axios.get("https://api.binance.com/api/v3/exchangeInfo", {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CryptoAlertBot/1.0)",
        },
      });
      
      const symbols = response.data.symbols;
      
      const usdtPairs = symbols.filter((item: any) => {
        return item.quoteAsset === "USDT" && item.status === "TRADING";
      });

      validSymbol.clear();
      usdtPairs.forEach((item: any) => { 
        validSymbol.add(item.symbol.toUpperCase()); 
      });

      logger.info(`Loaded ${validSymbol.size} trading pairs`);
      return;
    } catch (error) {
      logger.error(`Attempt ${attempt} failed:`, error);
      if (attempt < MAX_FETCH_RETRIES) {
        const delay = FETCH_RETRY_DELAY * Math.pow(2, attempt - 1);
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`Failed to fetch crypto symbols after ${MAX_FETCH_RETRIES} attempts. Cannot start without valid symbol list.`);
};
