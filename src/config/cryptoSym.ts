import axios from "axios";
import { logger } from "../utils/logger.js";

export const validSymbol = new Set<string>();

const MAX_FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 2000;

export const fetchValidCryptoSymbols = async () => {
  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      logger.info(`Fetching crypto symbols (attempt ${attempt}/${MAX_FETCH_RETRIES})...`);
      const response = await axios.get("https://api.binance.com/api/v3/exchangeInfo", {
        timeout: 10000,
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
        logger.info(`Retrying in ${FETCH_RETRY_DELAY}ms...`);
        await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY * attempt));
      }
    }
  }

  throw new Error(`Failed to fetch crypto symbols after ${MAX_FETCH_RETRIES} attempts`);
};
