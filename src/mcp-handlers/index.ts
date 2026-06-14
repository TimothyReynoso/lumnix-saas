// MCP Handlers — Registry
// Maps tool names to their handler functions
// Each handler takes params → calls scraper → returns formatted JSON-RPC result

export type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

// Tool parameter schemas for validation
export const TOOL_SCHEMAS: Record<string, string[]> = {
  amazon_search_products: ['query'],
  amazon_get_product_details: ['asin'],
  amazon_estimate_sales: ['asin'],
  amazon_opportunity_score: ['asin'],
  amazon_analyze_competition: ['keyword'],
  amazon_best_sellers: [],
  amazon_keyword_suggestions: ['seed_keyword'],
  amazon_price_history: ['asin'],
  amazon_bsr_history: ['asin'],
  amazon_analyze_negative_reviews: ['asin'],
  amazon_analyze_listing_quality: ['asin'],
  alibaba_search_products: ['query'],
  alibaba_get_product_details: ['product_id'],
  alibaba_vet_supplier: ['product_id'],
  alibaba_match_to_amazon: ['amazon_asin'],
  aliexpress_search_products: ['query'],
  aliexpress_get_product_details: ['product_id'],
  aliexpress_analyze_supplier: ['product_id'],
  aliexpress_profit_calculator: ['product_cost', 'shipping_cost', 'selling_price', 'monthly_sales'],
};

// Import and re-export handlers from platform modules
export { amazonHandlers } from './amazon';
export { alibabaHandlers } from './alibaba';
export { aliexpressHandlers } from './aliexpress';

// Combined handler map — built after imports to avoid circular deps
import { amazonHandlers } from './amazon';
import { alibabaHandlers } from './alibaba';
import { aliexpressHandlers } from './aliexpress';

export const handlers: Record<string, ToolHandler> = {
  ...amazonHandlers,
  ...alibabaHandlers,
  ...aliexpressHandlers,
};

export const toolNames = Object.keys(handlers);
