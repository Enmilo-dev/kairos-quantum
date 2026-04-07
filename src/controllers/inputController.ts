import { validSymbol } from "../config/cryptoSym.js";

export const SYMBOL_VALIDATION = {
  MAX_LENGTH: 20,
  PATTERN: /^[A-Z0-9]{2,20}$/,
};

//console.log(VALID_SYMBOLS);

export function validateSymbol(input: string): { valid: boolean; error?: string; symbol?: string } {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Symbol must be a non-empty string' };
  }

  const cleaned = input.toUpperCase().trim();

  if (validSymbol.size === 0) {
    return { valid: false, error: 'No valid symbols available for validation.' };
  }

  if (cleaned.length > SYMBOL_VALIDATION.MAX_LENGTH) {
    return { valid: false, error: `Symbol too long. Maximum ${SYMBOL_VALIDATION.MAX_LENGTH} characters.` };
  }

  if (!SYMBOL_VALIDATION.PATTERN.test(cleaned)) {
    return { valid: false, error: 'Symbol can only contain letters and numbers.' };
  }

  const symbol = cleaned.endsWith('USDT') ? cleaned : `${cleaned}USDT`;

  if (!validSymbol.has(symbol)) {
    return {
      valid: false,
      error: `Coin not supported.`
    };
  }

  return { valid: true, symbol };
}
