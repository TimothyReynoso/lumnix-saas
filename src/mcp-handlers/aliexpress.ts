// AliExpress MCP Handlers — 4 tools

import type { ToolHandler } from './index';
import { searchProducts, getProductDetails } from '../scrapers/aliexpress';

// ---------------------------------------------------------------------------
// 1. aliexpress_search_products
// ---------------------------------------------------------------------------
export const handleAliExpressSearch: ToolHandler = async (params) => {
  const query = params.query as string;
  const min_price = params.min_price as number | undefined;
  const max_price = params.max_price as number | undefined;
  const min_orders = params.min_orders as number | undefined;
  const min_rating = params.min_rating as number | undefined;
  const page = (params.page as number) || 1;
  const limit = (params.limit as number) || 20;
  try {
    const data = await searchProducts({ query, page });
    let results = data.results || [];

    if (min_price !== undefined) results = results.filter(r => parseFloat(r.price) >= min_price);
    if (max_price !== undefined) results = results.filter(r => parseFloat(r.price) <= max_price);
    if (min_orders !== undefined) results = results.filter(r => (r.orders_count || 0) >= min_orders);
    if (min_rating !== undefined) results = results.filter(r => (r.rating || 0) >= min_rating);

    results = results.slice(0, limit);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_returned: results.length, page,
        products: results.map(r => ({
          product_id: r.product_id, title: r.title?.substring(0, 80),
          price: r.price, original_price: r.original_price, discount: r.discount,
          rating: r.rating, reviews: r.reviews_count, orders: r.orders_count,
          store: { name: r.store_info?.name, top_rated: r.store_info?.is_top_rated, rating: r.store_info?.rating },
          image: r.images?.[0],
        })),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 2. aliexpress_get_product_details
// ---------------------------------------------------------------------------
export const handleAliExpressDetails: ToolHandler = async (params) => {
  const product_id = params.product_id as string;
  try {
    const data = await getProductDetails(product_id);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        product_id: data.product_id, title: data.title?.substring(0, 100),
        price: data.sale_price, original_price: data.original_price, orders: data.orders,
        available: data.quantity?.available,
        rating: data.ratings?.average_star, total_reviews: data.ratings?.total_start_count,
        store: {
          name: data.store_info?.name, top_rated: data.store_info?.is_top_rated,
          rating: data.store_info?.rating, positive_feedback: data.store_info?.positive_feedback_rate,
        },
        variants: data.variants?.options?.map(o => ({ name: o.name, values: o.values?.map(v => v.name) })),
        specs: data.specs?.slice(0, 15).map(s => `${s.attr_name}: ${s.attr_value}`),
        shipping: data.shipping?.slice(0, 5).map(s => ({ provider: s.delivery_provider, info: s.delivery_info })),
        top_reviews: data.reviews?.slice(0, 5).map(r => ({
          rating: r.rating, country: r.country, text: r.content?.substring(0, 200),
        })),
        images: data.images?.length || 0,
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 3. aliexpress_analyze_supplier
// ---------------------------------------------------------------------------
export const handleAliExpressSupplierScore: ToolHandler = async (params) => {
  const product_id = params.product_id as string;
  try {
    const data = await getProductDetails(product_id);
    const store = data.store_info;

    let score = 50;
    if (store.is_top_rated) score += 15;
    if (store.has_paypal_account) score += 5;
    if (store.rating >= 4.9) score += 15;
    else if (store.rating >= 4.7) score += 10;
    else if (store.rating >= 4.5) score += 5;
    else if (store.rating < 4.0) score -= 15;
    if (store.positive_feedback_rate) {
      if (store.positive_feedback_rate >= 97) score += 10;
      else if (store.positive_feedback_rate >= 95) score += 5;
      else if (store.positive_feedback_rate < 90) score -= 10;
    }
    if (store.rating_count >= 10000) score += 5;
    score = Math.max(0, Math.min(100, score));

    const riskFlags: string[] = [];
    if (!store.is_top_rated) riskFlags.push('Not Top Rated');
    if (store.positive_feedback_rate && store.positive_feedback_rate < 95) riskFlags.push(`Low feedback: ${store.positive_feedback_rate}%`);
    if (store.rating < 4.5) riskFlags.push(`Store rating ${store.rating}`);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        store: { name: store.name, top_rated: store.is_top_rated, rating: store.rating, positive_feedback_rate: store.positive_feedback_rate },
        overall_score: score, risk_flags: riskFlags,
        recommended: score >= 70,
        recommendation: score >= 85 ? '🟢 Excellent supplier' : score >= 70 ? '🟡 Good supplier' : score >= 50 ? '🟠 Average — verify with sample' : '🔴 Risky — consider alternatives',
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 4. aliexpress_profit_calculator
// ---------------------------------------------------------------------------
export const handleAliExpressProfitCalc: ToolHandler = async (params) => {
  const product_cost = params.product_cost as number;
  const shipping_cost = (params.shipping_cost as number) || 0;
  const selling_price = params.selling_price as number;
  const monthly_sales = params.monthly_sales as number;
  const platform_fee_monthly = (params.platform_fee_monthly as number) || 29;
  const payment_processing_percent = (params.payment_processing_percent as number) || 2.9;
  const ad_spend_percent = (params.ad_spend_percent as number) || 25;
  const refund_rate = (params.refund_rate as number) || 10;
  try {
    const revenue = selling_price * monthly_sales;
    const productTotal = product_cost * monthly_sales;
    const shippingTotal = shipping_cost * monthly_sales;
    const payment = revenue * (payment_processing_percent / 100);
    const ads = revenue * (ad_spend_percent / 100);
    const refunds = revenue * (refund_rate / 100);
    const totalCosts = productTotal + shippingTotal + platform_fee_monthly + payment + ads + refunds;
    const profit = revenue - totalCosts;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const investment = productTotal + shippingTotal + ads;
    const roi = investment > 0 ? (profit / investment) * 100 : 0;

    return {
      content: [{ type: 'text', text: JSON.stringify({
        revenue_monthly: Math.round(revenue * 100) / 100,
        total_costs_monthly: Math.round(totalCosts * 100) / 100,
        profit_monthly: Math.round(profit * 100) / 100,
        margin_percent: Math.round(margin * 10) / 10,
        roi_percent: Math.round(roi * 10) / 10,
        break_even_months: profit > 0 && platform_fee_monthly > 0 ? Math.ceil(platform_fee_monthly / profit) : 0,
        cost_breakdown: {
          product: Math.round(productTotal * 100) / 100,
          shipping: Math.round(shippingTotal * 100) / 100,
          platform: platform_fee_monthly,
          payment: Math.round(payment * 100) / 100,
          ads: Math.round(ads * 100) / 100,
          refunds: Math.round(refunds * 100) / 100,
        },
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
export const aliexpressHandlers: Record<string, ToolHandler> = {
  aliexpress_search_products: handleAliExpressSearch,
  aliexpress_get_product_details: handleAliExpressDetails,
  aliexpress_analyze_supplier: handleAliExpressSupplierScore,
  aliexpress_profit_calculator: handleAliExpressProfitCalc,
};
