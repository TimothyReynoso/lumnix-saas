// Amazon MCP Handlers — 11 tools
// Each handler takes params → calls scraper → returns formatted result

import type { ToolHandler } from './index';
import { searchProducts, getProductDetails, parseSalesVolume } from '../scrapers/amazon';

/** Normalize price from Omkar — sometimes returns {value, currency} object instead of number */
function normalizePrice(price: unknown): number | null {
  if (typeof price === 'number') return price;
  if (price === null || price === undefined) return null;
  if (typeof price === 'object' && price !== null) {
    const obj = price as Record<string, unknown>;
    if (typeof obj.value === 'number') return obj.value;
    if (typeof obj.price === 'number') return obj.price;
  }
  if (typeof price === 'string') {
    const num = parseFloat(price.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? null : num;
  }
  return null;
}
import { fetchKeywordSuggestions, fetchDeepKeywordSuggestions, scoreKeywordCompetition } from '../scrapers/amazon-keywords';
import { fetchKeepaProduct } from '../scrapers/keepa';

// ---------------------------------------------------------------------------
// 1. amazon_search_products
// ---------------------------------------------------------------------------
export const handleAmazonSearch: ToolHandler = async (params) => {
  const query = params.query as string;
  const min_price = params.min_price as number | undefined;
  const max_price = params.max_price as number | undefined;
  const min_reviews = params.min_reviews as number | undefined;
  const max_reviews = params.max_reviews as number | undefined;
  const min_rating = params.min_rating as number | undefined;
  const sort_by = (params.sort_by as string) || 'relevance';
  const marketplace = (params.marketplace as string) || 'US';
  const page = (params.page as number) || 1;
  const limit = (params.limit as number) || 20;
  const monthly_revenue_min = params.monthly_revenue_min as number | undefined;
  const monthly_revenue_max = params.monthly_revenue_max as number | undefined;
  const net_margin_min = params.net_margin_min as number | undefined;
  const cost_per_unit = params.cost_per_unit as number | undefined;
  const weight_max = params.weight_max as number | undefined;
  const seller_count_max = params.seller_count_max as number | undefined;
  const has_amazon_choice = params.has_amazon_choice as boolean | undefined;
  const has_best_seller = params.has_best_seller as boolean | undefined;

  try {
    const data = await searchProducts({ query, page, countryCode: marketplace, sortBy: sort_by });
    let results = data.results || [];

    if (min_price !== undefined) results = results.filter(r => r.price !== null && r.price >= min_price);
    if (max_price !== undefined) results = results.filter(r => r.price !== null && r.price <= max_price);
    if (min_reviews !== undefined) results = results.filter(r => r.reviews >= min_reviews);
    if (max_reviews !== undefined) results = results.filter(r => r.reviews <= max_reviews);
    if (min_rating !== undefined) results = results.filter(r => r.rating >= min_rating);
    if (seller_count_max !== undefined) results = results.filter(r => r.number_of_offers === null || r.number_of_offers <= seller_count_max);
    if (has_amazon_choice) results = results.filter(r => r.is_amazon_choice === true);
    if (has_best_seller) results = results.filter(r => r.is_best_seller === true);

    if (monthly_revenue_min !== undefined || monthly_revenue_max !== undefined) {
      results = results.filter(r => {
        const sales = parseSalesVolume(r.sales_volume);
        if (r.price === null || sales === null) return false;
        const revenue = r.price * sales;
        if (monthly_revenue_min !== undefined && revenue < monthly_revenue_min) return false;
        if (monthly_revenue_max !== undefined && revenue > monthly_revenue_max) return false;
        return true;
      });
    }

    if (net_margin_min !== undefined && cost_per_unit !== undefined) {
      results = results.filter(r => {
        if (r.price === null || r.price <= 0) return false;
        const margin = ((r.price - cost_per_unit) / r.price) * 100;
        return margin >= net_margin_min;
      });
    }

    results = results.slice(0, limit);

    const weightFilterNote = weight_max !== undefined
      ? `Note: weight_max=${weight_max}lbs filter was requested but requires individual product detail fetches. Use amazon_get_product_details per ASIN to verify weight.`
      : undefined;

    const formatted = results.map(r => {
      const sales = parseSalesVolume(r.sales_volume);
      const monthly_revenue_est = (r.price !== null && sales !== null) ? Math.round(r.price * sales) : null;
      const net_margin_est = (r.price !== null && cost_per_unit !== undefined && r.price > 0)
        ? Math.round(((r.price - cost_per_unit) / r.price) * 100) : null;
      return {
        asin: r.asin, title: r.title,
        price: r.price ? `$${r.price}` : 'N/A',
        original_price: r.original_price ? `$${r.original_price}` : null,
        rating: r.rating, reviews: r.reviews,
        sales_volume: r.sales_volume || 'N/A',
        monthly_revenue_est: monthly_revenue_est ? `$${monthly_revenue_est.toLocaleString()}` : null,
        net_margin_est: net_margin_est !== null ? `${net_margin_est}%` : null,
        is_best_seller: r.is_best_seller, is_amazon_choice: r.is_amazon_choice,
        is_prime: r.is_prime, number_of_offers: r.number_of_offers,
        has_variations: r.has_variations, image: r.image_url, link: r.link,
      };
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({
        total_returned: formatted.length, page, sort_by,
        products: formatted,
        ...(weightFilterNote ? { note: weightFilterNote } : {}),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 2. amazon_get_product_details
// ---------------------------------------------------------------------------
export const handleAmazonDetails: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const marketplace = (params.marketplace as string) || 'US';

  try {
    const data = await getProductDetails(asin, marketplace);
    const formatted = {
      asin: data.asin, title: data.product_name,
      price: data.current_price ? `$${data.current_price}` : 'Price unavailable',
      original_price: data.original_price ? `$${data.original_price}` : null,
      availability: data.availability, rating: data.rating, reviews: data.reviews,
      detailed_rating: data.detailed_rating, sales_volume: data.sales_volume || 'Unavailable',
      is_bestseller: data.is_bestseller, is_amazon_choice: data.is_amazon_choice,
      is_prime: data.is_prime, has_aplus_content: data.has_aplus_content,
      has_video: data.has_video, number_of_offers: data.number_of_offers,
      category: data.main_category,
      category_hierarchy: data.category_hierarchy?.map(c => c.name),
      key_features: data.key_features, product_details: data.product_details,
      technical_details: data.technical_details, variants: data.variants,
      top_reviews: data.top_reviews?.slice(0, 5).map(r => ({
        rating: r.rating, date: r.review_date, verified: r.is_verified_purchase,
        helpful: r.helpful_votes, text: r.review_text?.substring(0, 200),
      })),
      frequently_bought_together: data.frequently_bought_together?.map(f => f.name),
      delivery: data.delivery_info, estimated_delivery: data.estimated_delivery_date,
      main_image: data.main_image_url,
      total_images: (data.additional_image_urls?.length || 0) + 1,
      total_videos: data.product_videos?.length,
      full_description: data.full_description?.substring(0, 500),
    };
    return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 3. amazon_estimate_sales
// ---------------------------------------------------------------------------
function estimateSalesFromData(data: {
  asin: string; sales_volume: string | null; reviews: number;
  rating: number; current_price: number | null;
}): Record<string, unknown> {
  let monthlySales: number; let methodology: string; let confidencePercent: number;
  const directSales = parseSalesVolume(data.sales_volume);

  if (directSales) {
    monthlySales = directSales;
    methodology = "Direct from Amazon 'bought in past month' badge";
    confidencePercent = 85;
  } else {
    const reviewRate = 0.07;
    const estimatedMonthsActive = Math.max(12, data.reviews / 50);
    const reviewVelocity = data.reviews / estimatedMonthsActive;
    monthlySales = Math.round(reviewVelocity / reviewRate);
    methodology = "Estimated from review count and velocity (no direct sales data available)";
    confidencePercent = 40;
  }

  const price = data.current_price || 0;
  const spread = confidencePercent >= 80 ? 0.15 : confidencePercent >= 50 ? 0.30 : 0.50;

  // If no price data, return null revenue with explanatory note
  if (!data.current_price) {
    return {
      asin: data.asin, monthly_sales_estimate: monthlySales,
      monthly_revenue_estimate: null,
      note: 'Price data unavailable — revenue cannot be estimated. Amazon may have changed page structure or the product is unavailable.',
      confidence_range: { low: Math.round(monthlySales * (1 - spread)), high: Math.round(monthlySales * (1 + spread)) },
      confidence_percent: confidencePercent, methodology,
      source: data.sales_volume ? 'amazon_sales_volume' : 'review_velocity_proxy',
    };
  }

  const monthlyRevenue = monthlySales * price;
  return {
    asin: data.asin, monthly_sales_estimate: monthlySales,
    monthly_revenue_estimate: Math.round(monthlyRevenue),
    confidence_range: { low: Math.round(monthlySales * (1 - spread)), high: Math.round(monthlySales * (1 + spread)) },
    confidence_percent: confidencePercent, methodology,
    source: data.sales_volume ? 'amazon_sales_volume' : 'review_velocity_proxy',
  };
}

export const handleEstimateSales: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const data = await getProductDetails(asin, marketplace);
    const estimate = estimateSalesFromData(data);
    return { content: [{ type: 'text', text: JSON.stringify(estimate, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 4. amazon_opportunity_score
// ---------------------------------------------------------------------------
function scoreDemand(product: { sales_volume: string | null; reviews: number; rating: number }): { score: number; details: string } {
  const sales = parseSalesVolume(product.sales_volume);
  if (sales !== null) {
    if (sales >= 5000) return { score: 95, details: `Very high demand: ${product.sales_volume}` };
    if (sales >= 2000) return { score: 85, details: `High demand: ${product.sales_volume}` };
    if (sales >= 500) return { score: 70, details: `Good demand: ${product.sales_volume}` };
    if (sales >= 200) return { score: 55, details: `Moderate demand: ${product.sales_volume}` };
    if (sales >= 50) return { score: 35, details: `Low demand: ${product.sales_volume}` };
    return { score: 20, details: `Very low demand: ${product.sales_volume}` };
  }
  if (product.reviews >= 10000) return { score: 90, details: `Very high demand (inferred from ${product.reviews} reviews)` };
  if (product.reviews >= 1000) return { score: 70, details: `High demand (inferred from ${product.reviews} reviews)` };
  if (product.reviews >= 200) return { score: 50, details: `Moderate demand (${product.reviews} reviews)` };
  if (product.reviews >= 50) return { score: 35, details: `Low-moderate demand (${product.reviews} reviews)` };
  return { score: 20, details: `Low demand (${product.reviews} reviews)` };
}

function scoreCompetition(product: { number_of_offers: number; reviews: number; is_bestseller: boolean; rating: number }): { score: number; details: string } {
  const offers = product.number_of_offers || 0;
  let score = 70;
  if (offers === 0) score = 90;
  else if (offers <= 3) score = 95;
  else if (offers <= 10) score = 80;
  else if (offers <= 20) score = 60;
  else if (offers <= 50) score = 40;
  else score = 20;
  if (product.reviews > 5000) score -= 15;
  else if (product.reviews > 1000) score -= 10;
  if (product.is_bestseller) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return { score, details: `${offers} sellers | ${product.reviews} reviews | ${product.is_bestseller ? 'Best Seller' : 'No badge'}` };
}

function scoreMargin(product: { current_price: number | null }, targetCost?: number): { score: number; details: string } {
  const price = product.current_price;
  if (!price) return { score: 50, details: 'No price data available' };
  if (!targetCost) {
    if (price >= 50) return { score: 75, details: `$${price} price point — good margin potential` };
    if (price >= 25) return { score: 60, details: `$${price} — moderate margin potential` };
    if (price >= 15) return { score: 40, details: `$${price} — tight margins after FBA fees` };
    return { score: 25, details: `$${price} — very thin margins likely` };
  }
  const margin = ((price - targetCost) / price) * 100;
  if (margin >= 50) return { score: 95, details: `${margin.toFixed(1)}% margin` };
  if (margin >= 35) return { score: 80, details: `${margin.toFixed(1)}% margin` };
  if (margin >= 25) return { score: 60, details: `${margin.toFixed(1)}% margin` };
  if (margin >= 15) return { score: 40, details: `${margin.toFixed(1)}% margin — thin after fees` };
  return { score: 20, details: `${margin.toFixed(1)}% margin — likely unprofitable` };
}

function scoreTrend(product: { sales_volume: string | null; is_amazon_choice: boolean; rating: number }): { score: number; details: string } {
  let score = 50;
  const sales = parseSalesVolume(product.sales_volume);
  if (sales && sales >= 1000) score += 15;
  if (product.is_amazon_choice) score += 10;
  if (product.rating >= 4.0) score += 5;
  return { score: Math.max(0, Math.min(100, score)), details: `Estimated from current signals${product.is_amazon_choice ? '. Amazon Choice badge.' : ''}` };
}

function scoreListingQualityGap(product: { has_aplus_content: boolean; has_video: boolean; has_brand_story: boolean; key_features: string[]; full_description: string | null }): { score: number; details: string } {
  let score = 70;
  const gaps: string[] = [];
  if (!product.has_aplus_content) { score += 10; gaps.push('No A+ content'); }
  if (!product.has_video) { score += 8; gaps.push('No video'); }
  if (!product.has_brand_story) { score += 5; gaps.push('No brand story'); }
  if (!product.key_features || product.key_features.length < 3) { score += 7; gaps.push('Weak bullet points'); }
  if (!product.full_description || product.full_description.length < 100) { score += 5; gaps.push('Short description'); }
  if (product.has_aplus_content && product.has_video && product.has_brand_story) {
    score = 30; gaps.length = 0; gaps.push('Professional listing — hard to outperform');
  }
  return { score: Math.max(0, Math.min(100, score)), details: gaps.length > 0 ? `Gaps: ${gaps.join(', ')}` : 'Well-optimized listing' };
}

export const handleOpportunityScore: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const target_cost = params.target_cost as number | undefined;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const product = await getProductDetails(asin, marketplace);
    const demand = scoreDemand(product);
    const competition = scoreCompetition(product);
    const margin = scoreMargin(product, target_cost);
    const trend = scoreTrend(product);
    const listingGap = scoreListingQualityGap(product);
    const overallScore = Math.round(demand.score * 0.30 + competition.score * 0.25 + margin.score * 0.20 + trend.score * 0.15 + listingGap.score * 0.10);

    type Tier = 'GOLD' | 'STRONG' | 'MODERATE' | 'CAUTION' | 'AVOID';
    const tier: Tier = overallScore >= 90 ? 'GOLD' : overallScore >= 70 ? 'STRONG' : overallScore >= 50 ? 'MODERATE' : overallScore >= 30 ? 'CAUTION' : 'AVOID';

    const risks: string[] = [];
    if (competition.score < 30) risks.push('High competition');
    if (demand.score < 30) risks.push('Low demand');
    if (margin.score < 30) risks.push('Thin margins');
    if (product.number_of_offers > 20) risks.push(`${product.number_of_offers} sellers — price wars likely`);

    const recMap: Record<Tier, string> = {
      GOLD: '🔥 Excellent opportunity. Move fast.',
      STRONG: '⭐ Solid opportunity. Worth pursuing.',
      MODERATE: '📊 Viable with the right approach.',
      CAUTION: '⚠️ Challenging. Only proceed with clear advantage.',
      AVOID: '❌ Not recommended.',
    };

    return {
      content: [{ type: 'text', text: JSON.stringify({
        product: { asin: product.asin, title: product.product_name?.substring(0, 80), price: product.current_price, reviews: product.reviews, offers: product.number_of_offers },
        overall_score: overallScore, tier,
        factors: { demand, competition, margin, trend, listing_quality_gap: listingGap },
        recommendation: recMap[tier], risks,
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 5. amazon_analyze_competition
// ---------------------------------------------------------------------------
export const handleCompetition: ToolHandler = async (params) => {
  const keyword = params.keyword as string;
  const marketplace = (params.marketplace as string) || 'US';
  const depth = Math.min((params.depth as number) || 10, 20);
  try {
    const searchData = await searchProducts({ query: keyword, countryCode: marketplace });
    const products = searchData.results?.slice(0, depth) || [];
    if (products.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `No products found for "${keyword}"` }) }], isError: true };
    }

    const detailedProducts = [];
    for (const product of products.slice(0, Math.min(depth, 5))) {
      try {
        const details = await getProductDetails(product.asin, marketplace);
        detailedProducts.push({ ...product, has_aplus_content: details.has_aplus_content, has_video: details.has_video, sales_volume_num: parseSalesVolume(product.sales_volume) });
      } catch {
        detailedProducts.push({ ...product, has_aplus_content: false, has_video: false, sales_volume_num: parseSalesVolume(product.sales_volume) });
      }
    }
    for (const product of products.slice(5, depth)) {
      detailedProducts.push({ ...product, has_aplus_content: false, has_video: false, sales_volume_num: parseSalesVolume(product.sales_volume) });
    }

    const avgReviews = Math.round(detailedProducts.reduce((s, p) => s + p.reviews, 0) / detailedProducts.length);
    const avgRating = Math.round((detailedProducts.reduce((s, p) => s + p.rating, 0) / detailedProducts.length) * 10) / 10;
    const prices = detailedProducts.map(p => normalizePrice(p.price)).filter((p): p is number => p !== null);
    const avgPrice = prices.length > 0 ? Math.round((prices.reduce((s, p) => s + p, 0) / prices.length) * 100) / 100 : null;

    const topReviews = Math.max(...detailedProducts.map(p => p.reviews));
    let score = 0;
    if (avgReviews > 5000) score += 4; else if (avgReviews > 1000) score += 3; else if (avgReviews > 200) score += 2; else score += 1;
    if (topReviews > 10000) score += 3; else if (topReviews > 5000) score += 2; else if (topReviews > 1000) score += 1;
    if (products.length > 50) score += 2; else if (products.length > 20) score += 1;
    const competitionLevel = score >= 7 ? 'EXTREME' : score >= 5 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';

    const lowReviewProducts = detailedProducts.filter(p => p.reviews < 200).length;

    return {
      content: [{ type: 'text', text: JSON.stringify({
        keyword, competition_level: competitionLevel,
        total_competitors_analyzed: detailedProducts.length,
        avg_reviews: avgReviews, avg_rating: avgRating, avg_price: avgPrice,
        price_range: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
        new_entrant_opportunity: lowReviewProducts > detailedProducts.length * 0.3,
        top_players: detailedProducts.slice(0, 5).map(p => ({
          asin: p.asin, title: p.title?.substring(0, 60), price: normalizePrice(p.price),
          rating: p.rating, reviews: p.reviews,
        })),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 6. amazon_best_sellers
// ---------------------------------------------------------------------------
const CATEGORY_MAP: Record<string, string> = {
  'Kitchen & Dining': 'kitchen dining best sellers', 'Electronics': 'electronics best sellers',
  'Home & Kitchen': 'home kitchen best sellers', 'Beauty & Personal Care': 'beauty personal care best sellers',
  'Health & Household': 'health household best sellers', 'Toys & Games': 'toys games best sellers',
  'Sports & Outdoors': 'sports outdoors best sellers', 'Clothing Shoes & Jewelry': 'clothing shoes jewelry best sellers',
  'Books': 'books best sellers', 'Automotive': 'automotive best sellers',
};

export const handleBestSellers: ToolHandler = async (params) => {
  const category = params.category as string | undefined;
  const limit = (params.limit as number) || 20;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const searchQuery = category && CATEGORY_MAP[category] ? CATEGORY_MAP[category] : category ? `${category} best sellers` : 'best sellers 2024';
    const searchData = await searchProducts({ query: searchQuery, countryCode: marketplace });
    const results = (searchData.results || []).map(r => ({ ...r, sales_estimate: parseSalesVolume(r.sales_volume) }));
    const sorted = results.sort((a, b) => {
      if (a.is_best_seller && !b.is_best_seller) return -1;
      if (!a.is_best_seller && b.is_best_seller) return 1;
      return (b.sales_estimate || 0) - (a.sales_estimate || 0);
    }).slice(0, limit);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        category: category || 'Overall', marketplace,
        total_returned: sorted.length,
        products: sorted.map((r, i) => ({
          rank: i + 1, asin: r.asin, title: r.title?.substring(0, 100),
          price: r.price ? `$${r.price}` : 'N/A', rating: r.rating, reviews: r.reviews,
          sales_volume: r.sales_volume || 'N/A',
          estimated_monthly_sales: r.sales_estimate,
          estimated_monthly_revenue: r.sales_estimate && r.price ? `$${(r.sales_estimate * r.price).toLocaleString()}` : null,
          is_best_seller: r.is_best_seller, is_amazon_choice: r.is_amazon_choice,
        })),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 7. amazon_keyword_suggestions
// ---------------------------------------------------------------------------
export const handleKeywordSuggestions: ToolHandler = async (params) => {
  const seed_keyword = params.seed_keyword as string;
  const depth = (params.depth as string) || 'basic';
  const marketplace = (params.marketplace as string) || 'US';
  const score_competition = (params.score_competition as boolean) || false;
  try {
    let keywords: Map<string, number>;
    if (depth === 'deep') {
      keywords = await fetchDeepKeywordSuggestions(seed_keyword, marketplace);
    } else {
      const suggestions = await fetchKeywordSuggestions(seed_keyword, marketplace);
      keywords = new Map();
      for (const kw of suggestions) keywords.set(kw.toLowerCase(), 1);
    }

    const sorted = Array.from(keywords.entries()).sort((a, b) => b[1] - a[1]);
    const formatted = sorted.map(([keyword, frequency]) => ({
      keyword, frequency,
      popularity: frequency >= 3 ? 'HIGH' : frequency >= 2 ? 'MEDIUM' : 'LOW',
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        seed_keyword, depth, total_suggestions: formatted.length,
        keywords: formatted.slice(0, 100),
      }, null, 2) }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 8. amazon_price_history
// ---------------------------------------------------------------------------
export const handlePriceHistory: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const days = (params.days as number) || 90;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const result = await fetchKeepaProduct(asin, days, marketplace);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        asin, status: 'unavailable', message: result.error,
        alternative: 'Use amazon_search_products and amazon_get_product_details for current pricing data (free, no Keepa needed)',
      }, null, 2) }] };
    }
    const data = result.data!;
    return { content: [{ type: 'text', text: JSON.stringify({
      asin: data.asin, period_days: days,
      current_price: data.current_price ? `$${data.current_price.toFixed(2)}` : null,
      price_trend: data.price_trend, bsr_trend: data.bsr_trend, current_bsr: data.current_bsr,
      amazon_price_history: data.price_history.amazon.filter(p => p.price !== null).slice(-30),
      bsr_history: data.bsr_history.filter(b => b.bsr !== null).slice(-30),
    }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 9. amazon_bsr_history
// ---------------------------------------------------------------------------
export const handleBsrHistory: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const days = (params.days as number) || 30;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const result = await fetchKeepaProduct(asin, days, marketplace);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        asin, status: 'unavailable', message: result.error,
        alternative: 'Use amazon_estimate_sales for current sales estimation (free, no Keepa needed)',
      }, null, 2) }] };
    }
    const data = result.data!;
    const bsrPoints = data.bsr_history.filter(b => b.bsr !== null);
    if (bsrPoints.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ asin, message: 'No BSR data available' }, null, 2) }] };
    }
    const bsrValues = bsrPoints.map(b => b.bsr!);
    return { content: [{ type: 'text', text: JSON.stringify({
      asin: data.asin, period_days: days,
      current_bsr: bsrValues[bsrValues.length - 1],
      trend: { direction: data.bsr_trend, volatility: 'MEDIUM' as const },
      statistics: {
        min_bsr: Math.min(...bsrValues), max_bsr: Math.max(...bsrValues),
        avg_bsr: Math.round(bsrValues.reduce((s, b) => s + b, 0) / bsrValues.length),
        data_points: bsrPoints.length,
      },
      recent_history: bsrPoints.slice(-20),
    }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 10. amazon_analyze_negative_reviews
// ---------------------------------------------------------------------------
const COMPLAINT_KEYWORDS: Record<string, string[]> = {
  build_quality: ['broke', 'cheap', 'flimsy', 'poor quality', 'defective', 'stopped working'],
  size_fit: ['too small', 'too big', "doesn't fit", 'wrong size'],
  performance: ["doesn't work", 'not working', 'weak', 'slow', 'useless'],
  battery_power: ['battery', 'dies quickly', "doesn't last", 'drains fast'],
  value_price: ['overpriced', 'not worth', 'waste of money', 'returning'],
};

function categorizeComplaint(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const [category, keywords] of Object.entries(COMPLAINT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) { matched.push(category); break; }
    }
  }
  return matched.length > 0 ? matched : ['other'];
}

export const handleNegativeReviews: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const product = await getProductDetails(asin, marketplace);
    if (!product.top_reviews || product.top_reviews.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ asin, product_title: product.product_name, error: 'No reviews available' }) }], isError: true };
    }

    const negativeReviews = product.top_reviews.filter(r => r.rating <= 3);
    const allTexts = negativeReviews.map(r => r.review_text || '').filter(t => t.length > 0);

    if (allTexts.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ asin, product_title: product.product_name, message: 'No negative reviews found in sample' }) }] };
    }

    const categoryCounts = new Map<string, string[]>();
    for (const text of allTexts) {
      for (const cat of categorizeComplaint(text)) {
        if (!categoryCounts.has(cat)) categoryCounts.set(cat, []);
        categoryCounts.get(cat)!.push(text.substring(0, 200));
      }
    }

    const complaints = Array.from(categoryCounts.entries()).map(([category, samples]) => ({
      category, frequency: samples.length,
      percentage: Math.round((samples.length / allTexts.length) * 100),
      sample_complaints: samples.slice(0, 3),
    })).sort((a, b) => b.frequency - a.frequency);

    const negPct = Math.round((negativeReviews.length / product.top_reviews.length) * 100);

    return { content: [{ type: 'text', text: JSON.stringify({
      asin, product_title: product.product_name,
      total_reviews: product.reviews, negative_reviews_analyzed: negativeReviews.length,
      negative_review_percentage: negPct,
      overall_sentiment: negPct > 60 ? 'CAUTION' : negPct > 30 ? 'MIXED' : 'ACCEPTABLE',
      complaint_categories: complaints,
      recommendation: negPct > 60
        ? `🟠 HIGH OPPORTUNITY: ${negPct}% negative reviews. #1 issue: "${complaints[0]?.category}".`
        : negPct > 30
        ? `🟡 MODERATE OPPORTUNITY: ${negPct}% negative. Fix "${complaints[0]?.category}" to stand out.`
        : `🟢 Strong product with only ${negPct}% negative reviews.`,
    }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// 11. amazon_analyze_listing_quality
// ---------------------------------------------------------------------------
export const handleListingQuality: ToolHandler = async (params) => {
  const asin = params.asin as string;
  const marketplace = (params.marketplace as string) || 'US';
  try {
    const product = await getProductDetails(asin, marketplace);
    const totalImages = (product.additional_image_urls?.length || 0) + 1;
    const hasVideo = (product.product_videos?.length || 0) > 0;

    // CTR score (title + main image)
    let titleScore = 15;
    if (product.product_name.length < 50) titleScore = 5;
    else if (product.product_name.length > 250) titleScore = 8;

    const ctrPct = Math.round(((titleScore + 10) / 35) * 100);

    // CVR score (bullets + images + description + A+)
    const bulletCount = product.key_features?.length || 0;
    const bulletScore = bulletCount >= 5 ? 18 : bulletCount >= 3 ? 12 : 4;
    const imageScore = totalImages >= 7 ? 14 : totalImages >= 5 ? 10 : 4;
    const descScore = (product.full_description?.length || 0) > 1000 ? 12 : (product.full_description?.length || 0) > 500 ? 8 : 3;
    const aplusScore = product.has_aplus_content ? (product.has_brand_story ? 10 : 7) : 0;
    const cvrPct = Math.round(((bulletScore + imageScore + descScore + aplusScore) / 60) * 100);

    const overallPct = Math.round(ctrPct * 0.35 + cvrPct * 0.55 + (product.rating >= 4.0 ? 100 : product.rating >= 3.5 ? 60 : 30) * 0.10);
    const grade = overallPct >= 90 ? 'A' : overallPct >= 80 ? 'B' : overallPct >= 65 ? 'C' : overallPct >= 50 ? 'D' : 'F';

    return { content: [{ type: 'text', text: JSON.stringify({
      asin, title: product.product_name?.substring(0, 80),
      overall_score: overallPct, overall_grade: grade,
      ctr: { score: ctrPct, grade: ctrPct >= 75 ? 'B+' : ctrPct >= 60 ? 'C' : 'D',
        verdict: ctrPct >= 75 ? '🟢 Strong CTR potential' : '🔴 CTR needs work' },
      cvr: { score: cvrPct, grade: cvrPct >= 75 ? 'B+' : cvrPct >= 60 ? 'C' : 'D',
        verdict: cvrPct >= 75 ? '🟢 Strong CVR potential' : '🔴 CVR needs work' },
      details: {
        images: totalImages, has_video: hasVideo,
        bullets: bulletCount, has_aplus: product.has_aplus_content,
        description_length: product.full_description?.length || 0,
        rating: product.rating, reviews: product.reviews,
      },
      top_improvements: [
        ...(bulletCount < 5 ? ['Add more bullet points (5 recommended)'] : []),
        ...(totalImages < 7 ? [`Add more images (current: ${totalImages}, recommended: 7+)`] : []),
        ...(!hasVideo ? ['Add a product demo video'] : []),
        ...(!product.has_aplus_content ? ['Add A+ Content (requires Brand Registry)'] : []),
        ...((product.full_description?.length || 0) < 1000 ? ['Expand description to 1000+ chars'] : []),
      ].slice(0, 5),
    }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }], isError: true };
  }
};

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------
export const amazonHandlers: Record<string, ToolHandler> = {
  amazon_search_products: handleAmazonSearch,
  amazon_get_product_details: handleAmazonDetails,
  amazon_estimate_sales: handleEstimateSales,
  amazon_opportunity_score: handleOpportunityScore,
  amazon_analyze_competition: handleCompetition,
  amazon_best_sellers: handleBestSellers,
  amazon_keyword_suggestions: handleKeywordSuggestions,
  amazon_price_history: handlePriceHistory,
  amazon_bsr_history: handleBsrHistory,
  amazon_analyze_negative_reviews: handleNegativeReviews,
  amazon_analyze_listing_quality: handleListingQuality,
};
