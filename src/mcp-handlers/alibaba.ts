// Alibaba MCP Handlers — 4 tools

import type { ToolHandler } from './index';
import { searchProducts as searchAlibaba, getProductDetails as getAlibabaDetails } from '../scrapers/alibaba';
import { searchProducts as searchAmazon, getProductDetails as getAmazonDetails, parseSalesVolume } from '../scrapers/amazon';

// ---------------------------------------------------------------------------
// 1. alibaba_search_products
// ---------------------------------------------------------------------------
export const handleAlibabaSearch: ToolHandler = async (params) => {
  const query = params.query as string;
  const max_moq = params.max_moq as number | undefined;
  const min_supplier_verification = (params.min_supplier_verification as string) || 'any';
  const page = (params.page as number) || 1;
  const limit = (params.limit as number) || 20;
  try {
    const data = await searchAlibaba({ query, page });
    let results = data.products || [];

    if (max_moq !== undefined) results = results.filter(r => r.pricing.minimum_order_qty <= max_moq);
    if (min_supplier_verification === 'gold') results = results.filter(r => r.supplier?.is_gold_supplier);
    else if (min_supplier_verification === 'trade_assurance') results = results.filter(r => r.supplier?.has_trade_assurance);
    else if (min_supplier_verification === 'verified') results = results.filter(r => r.supplier?.is_verified || r.supplier?.is_assessed);

    results = results.slice(0, limit);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_returned: results.length, page,
        products: results.map(r => ({
          product_id: r.product_id, title: r.title,
          price_range: r.pricing.range_formatted, moq: r.pricing.minimum_order_label,
          supplier: {
            name: r.supplier?.name?.substring(0, 50),
            gold_supplier: r.supplier?.is_gold_supplier || false,
            trade_assurance: r.supplier?.has_trade_assurance || false,
            verified: r.supplier?.is_verified || false,
          },
          image: r.thumbnail,
        })),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 2. alibaba_get_product_details
// ---------------------------------------------------------------------------
export const handleAlibabaDetails: ToolHandler = async (params) => {
  const product_id = params.product_id as string;
  try {
    const data = await getAlibabaDetails(product_id);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        product_id: data.product_id, title: data.title, available: data.is_available,
        pricing: {
          type: data.pricing.price_type, currency: data.pricing.currency_symbol,
          moq: data.pricing.minimum_order_label,
          tiers: data.pricing.tiers.filter(t => t.formatted_price).map(t => ({
            price: t.formatted_price, qty: t.quantity_label || 'N/A',
          })),
        },
        supplier: {
          name: data.supplier?.name, business_type: data.supplier?.business_type,
          gold_supplier: data.supplier?.is_gold_supplier,
          trade_assurance: data.supplier?.has_trade_assurance,
          assessed: data.supplier?.is_assessed, verified: data.supplier?.is_verified,
          country: data.supplier?.country,
        },
        specifications: data.specifications?.attributes?.slice(0, 15).map((a: { label: string; value: string }) => `${a.label}: ${a.value}`),
        variants_count: data.variants?.groups?.length || 0,
        images: data.gallery_images?.length || 0,
        has_video: !!data.video,
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 3. alibaba_vet_supplier
// ---------------------------------------------------------------------------
export const handleAlibabaVetSupplier: ToolHandler = async (params) => {
  const product_id = params.product_id as string;
  try {
    const data = await getAlibabaDetails(product_id);
    const supplier = data.supplier;
    let score = 50;
    if (supplier.is_gold_supplier) score += 10;
    if (supplier.has_trade_assurance) score += 15;
    if (supplier.is_assessed) score += 10;
    if (supplier.is_verified) score += 15;
    const numericRatings = (supplier.ratings || []).map(r => parseFloat(r.score)).filter(s => !isNaN(s) && s > 0);
    if (numericRatings.length > 0) {
      const avg = numericRatings.reduce((a, b) => a + b, 0) / numericRatings.length;
      if (avg >= 4.8) score += 10; else if (avg >= 4.5) score += 5; else if (avg < 4.0) score -= 10;
    }
    score = Math.max(0, Math.min(100, score));

    const riskFlags: string[] = [];
    if (!supplier.has_trade_assurance) riskFlags.push('No Trade Assurance');
    if (!supplier.is_gold_supplier) riskFlags.push('Not a Gold Supplier');
    if (numericRatings.length > 0 && numericRatings.reduce((a, b) => a + b, 0) / numericRatings.length < 4.0) riskFlags.push('Low rating');

    return {
      content: [{ type: 'text', text: JSON.stringify({
        supplier: { name: supplier.name, business_type: supplier.business_type, country: supplier.country },
        overall_score: score,
        verification: { gold_supplier: supplier.is_gold_supplier, trade_assurance: supplier.has_trade_assurance, assessed: supplier.is_assessed, verified: supplier.is_verified },
        risk_flags: riskFlags,
        recommended: score >= 70,
        recommendation: score >= 85 ? '🟢 Excellent supplier' : score >= 70 ? '🟡 Good supplier' : score >= 50 ? '🟠 Average — due diligence needed' : '🔴 Low trust — verify independently',
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 4. alibaba_match_to_amazon
// ---------------------------------------------------------------------------
function estimateFbaFee(price: number): number {
  return price * 0.15 + 4.00;
}

export const handleAlibabaMatchToAmazon: ToolHandler = async (params) => {
  const amazon_asin = params.amazon_asin as string;
  const target_quantity = (params.target_quantity as number) || 500;
  const max_unit_cost = params.max_unit_cost as number | undefined;
  const min_margin_percent = (params.min_margin_percent as number) || 25;
  try {
    const amazonProduct = await getAmazonDetails(amazon_asin);
    const amazonPrice = Number(amazonProduct.current_price);
    if (!amazonProduct.current_price || isNaN(amazonPrice)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Amazon product has no price data' }) }], isError: true };
    }

    const keywords = (amazonProduct.product_name || '')
      .replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w.toLowerCase()))
      .slice(0, 4).join(' ');

    const alibabaData = await searchAlibaba({ query: keywords });
    let matches = (alibabaData.products || []).slice(0, 10);

    const analyzed = matches.map(product => {
      const tiers = product.pricing.tiers || [];
      let unitPrice: number | null = null;
      for (const tier of tiers) {
        if (tier.unit_price && (!tier.min_units || target_quantity >= tier.min_units)) unitPrice = Number(tier.unit_price);
      }
      if (!unitPrice) {
        const rangeMatch = product.pricing.range_formatted?.match(/\$?([\d.]+)/);
        if (rangeMatch) unitPrice = parseFloat(rangeMatch[1]);
      }
      if (!unitPrice) return null;

      // Ensure numeric types (API may return strings)
      const numUnitPrice = Number(unitPrice);
      const numAmazonPrice = Number(amazonPrice);
      if (isNaN(numUnitPrice) || isNaN(numAmazonPrice)) return null;

      const estFbaFee = estimateFbaFee(numAmazonPrice);
      const netMargin = ((numAmazonPrice - numUnitPrice - estFbaFee) / numAmazonPrice) * 100;
      const roi = ((numAmazonPrice - numUnitPrice - estFbaFee) / (numUnitPrice + estFbaFee)) * 100;

      return {
        alibaba_product: { id: product.product_id, title: product.title.substring(0, 80), price_range: product.pricing.range_formatted, unit_price_at_qty: `$${numUnitPrice.toFixed(2)}` },
        supplier: { name: product.supplier?.name?.substring(0, 40), gold: product.supplier?.is_gold_supplier || false, trade_assurance: product.supplier?.has_trade_assurance || false },
        margin_analysis: {
          amazon_price: `$${numAmazonPrice.toFixed(2)}`, alibaba_unit_cost: `$${numUnitPrice.toFixed(2)}`,
          est_fba_fee: `$${estFbaFee.toFixed(2)}`, net_profit_per_unit: `$${(numAmazonPrice - numUnitPrice - estFbaFee).toFixed(2)}`,
          net_margin_after_fba: `${netMargin.toFixed(1)}%`, roi: `${roi.toFixed(1)}%`,
        },
        total_investment: `$${(numUnitPrice * target_quantity).toFixed(0)}`,
      };
    }).filter((m): m is NonNullable<typeof m> => m !== null);

    let filtered = analyzed;
    if (max_unit_cost !== undefined) {
      filtered = filtered.filter(m => parseFloat(m.margin_analysis.alibaba_unit_cost.replace('$', '')) <= max_unit_cost);
    }
    filtered = filtered.filter(m => parseFloat(m.margin_analysis.net_margin_after_fba) >= min_margin_percent);
    filtered.sort((a, b) => parseFloat(b.margin_analysis.net_margin_after_fba) - parseFloat(a.margin_analysis.net_margin_after_fba));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        amazon_product: { asin: amazon_asin, title: amazonProduct.product_name?.substring(0, 80), price: `$${amazonPrice.toFixed(2)}`, sales_volume: amazonProduct.sales_volume || 'N/A', reviews: amazonProduct.reviews },
        search_keywords: keywords, target_quantity,
        matches_found: filtered.length, matches: filtered,
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
export const alibabaHandlers: Record<string, ToolHandler> = {
  alibaba_search_products: handleAlibabaSearch,
  alibaba_get_product_details: handleAlibabaDetails,
  alibaba_vet_supplier: handleAlibabaVetSupplier,
  alibaba_match_to_amazon: handleAlibabaMatchToAmazon,
};
