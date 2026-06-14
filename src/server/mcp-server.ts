export const maxDuration = 60;

/**
 * MCP API Endpoint — with API Key Authentication + Per-Platform Rate Limits
 *
 * POST /api/mcp
 *
 * Accepts JSON-RPC 2.0 requests with Bearer token authentication.
 * Rate limits are enforced per-platform (Amazon, Alibaba, AliExpress)
 * to control costs since each platform has different API costs.
 *
 * Platform costs:
 * - Amazon: ~$0.001/call
 * - Alibaba: ~$0.01/call (10x more expensive)
 * - AliExpress: ~$0.005/call (5x more expensive)
 */

import { NextRequest, NextResponse } from 'next/server'
import { hashKey, checkRateLimit, type ApiKeyRecord, type Platform, getSupabaseAdmin } from '@/lib/supabase'
import { getToolPlatform, canAccessTool, config } from '@/lib/config'
import { handlers, toolNames } from '@/mcp-handlers'

// Shared admin client from supabase module
function getAdmin() {
  return getSupabaseAdmin()
}

// MCP Tool definitions with full JSON Schema inputSchemas
const MCP_TOOLS = [
  {
    name: 'amazon_search_products',
    description: 'Search Amazon for products with filters. Returns titles, prices, ratings, ASINs, images.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "blender", "wireless earbuds")' },
        min_price: { type: 'number', description: 'Minimum price filter' },
        max_price: { type: 'number', description: 'Maximum price filter' },
        min_rating: { type: 'number', description: 'Minimum star rating (1-5)' },
        category: { type: 'string', description: 'Amazon category to search in' },
        sort_by: { type: 'string', description: 'Sort order (relevance, price_low, price_high, rating, reviews)' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20)' },
        marketplace: { type: 'string', description: 'Amazon marketplace (default: amazon.com)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'amazon_get_product_details',
    description: 'Get detailed product information by ASIN. Returns title, price, ratings, reviews count, dimensions, weight, images, seller info, and Keepa data.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN (e.g. "B0FHWKYT89")' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_estimate_sales',
    description: 'Estimate monthly sales and revenue for a product based on BSR, reviews, and market data.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_opportunity_score',
    description: 'Calculate opportunity score (0-100) for a product niche. Analyzes demand, competition, margins, and market trends. Higher = better opportunity.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN to score' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_analyze_competition',
    description: 'Analyze competition level for a keyword. Returns seller count, average price, review counts, and market saturation.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Keyword to analyze competition for' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'amazon_best_sellers',
    description: 'Get best-selling products by category with sales estimates, BSR, pricing, and trend data.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category to browse (e.g. "kitchen", "electronics")' },
        limit: { type: 'number', description: 'Number of results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'amazon_keyword_suggestions',
    description: 'Get keyword suggestions for Amazon. Returns related keywords with estimated search volume and competition.',
    inputSchema: {
      type: 'object',
      properties: {
        seed_keyword: { type: 'string', description: 'Seed keyword to generate suggestions from' },
      },
      required: ['seed_keyword'],
    },
  },
  {
    name: 'amazon_price_history',
    description: 'Get price history for a product using Keepa data. Returns price over time, deal detection, and price statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN' },
        days: { type: 'number', description: 'Number of days of history (default 90)' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_bsr_history',
    description: 'Get BSR (Best Sellers Rank) history using Keepa data. Track ranking trends and seasonal patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN' },
        days: { type: 'number', description: 'Number of days of history (default 90)' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_analyze_negative_reviews',
    description: 'Analyze negative reviews for a product. Extracts common complaints, defect patterns, and improvement opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN' },
        max_reviews: { type: 'number', description: 'Max reviews to analyze (default 100)' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'amazon_analyze_listing_quality',
    description: 'Score listing quality (0-100) for click-through rate and conversion rate. Checks title, bullets, images, A+ content.',
    inputSchema: {
      type: 'object',
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'alibaba_search_products',
    description: 'Search Alibaba for suppliers and products. Returns product details, MOQs, prices, and supplier ratings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20)' },
        max_moq: { type: 'number', description: 'Maximum MOQ filter' },
        min_supplier_verification: { type: 'string', description: 'Min supplier level (any, verified, gold)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'alibaba_get_product_details',
    description: 'Get detailed Alibaba product info including pricing tiers, specs, variants, supplier info, and certifications.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Alibaba product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'alibaba_vet_supplier',
    description: 'Vet an Alibaba supplier. Returns trust score, years in business, trade assurance, response rate, and risk flags.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID (extracts supplier from product)' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'alibaba_match_to_amazon',
    description: 'Match Alibaba products to Amazon listings. Finds the same product on Amazon to compare pricing and calculate margins.',
    inputSchema: {
      type: 'object',
      properties: {
        amazon_asin: { type: 'string', description: 'Amazon ASIN to find matching Alibaba products for' },
        target_quantity: { type: 'number', description: 'Target order quantity (default 500)' },
        max_unit_cost: { type: 'number', description: 'Maximum unit cost filter' },
        min_margin_percent: { type: 'number', description: 'Minimum margin percentage (default 25)' },
      },
      required: ['amazon_asin'],
    },
  },
  {
    name: 'aliexpress_search_products',
    description: 'Search AliExpress for products. Returns titles, prices, ratings, orders count, and seller info.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20)' },
        min_price: { type: 'number', description: 'Minimum price filter' },
        max_price: { type: 'number', description: 'Maximum price filter' },
        min_orders: { type: 'number', description: 'Minimum orders filter' },
        min_rating: { type: 'number', description: 'Minimum star rating (1-5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'aliexpress_get_product_details',
    description: 'Get detailed AliExpress product info including variants, pricing tiers, reviews, and shipping options.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'AliExpress product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'aliexpress_analyze_supplier',
    description: 'Score an AliExpress supplier. Returns trust metrics, response rates, dispute rates, and reliability assessment.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product ID (extracts supplier from product)' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'aliexpress_profit_calculator',
    description: 'Calculate full P&L for a product including Amazon fees, shipping, ads, refunds, and ROI. The most comprehensive FBA profit calculator available.',
    inputSchema: {
      type: 'object',
      properties: {
        product_cost: { type: 'number', description: 'Cost per unit from supplier' },
        selling_price: { type: 'number', description: 'Selling price on Amazon' },
        monthly_sales: { type: 'number', description: 'Expected monthly sales volume' },
        shipping_cost: { type: 'number', description: 'Shipping cost per unit (default 0)' },
        platform_fee_monthly: { type: 'number', description: 'Monthly platform fee e.g. $39.99 for Professional Seller (default 29)' },
        payment_processing_percent: { type: 'number', description: 'Payment processing fee % (default 2.9)' },
        ad_spend_percent: { type: 'number', description: 'PPC ad spend as % of revenue (default 25)' },
        refund_rate: { type: 'number', description: 'Expected refund rate % (default 10)' },
      },
      required: ['product_cost', 'selling_price', 'monthly_sales'],
    },
  },
]

/**
 * Validate the API key from the Authorization header
 */
async function validateKey(authHeader: string | null): Promise<{
  valid: boolean
  key?: ApiKeyRecord
  error?: string
  status?: number
}> {
  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header', status: 401 }
  }

  const match = authHeader.match(/^Bearer\s+(lmx_[A-Za-z0-9]+)$/i)
  if (!match) {
    return { valid: false, error: 'Invalid API key format. Use: Bearer lmx_xxx', status: 401 }
  }

  const rawKey = match[1]
  const hashValue = await hashKey(rawKey)
  const admin = getAdmin()

  const { data, error } = await admin
    .from('api_keys')
    .select('*')
    .eq('key_hash', hashValue)
    .eq('active', true)
    .single()

  if (error || !data) {
    return { valid: false, error: 'Invalid or revoked API key', status: 401 }
  }

  // Check expiration
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { valid: false, error: 'API key has expired', status: 401 }
  }

  return { valid: true, key: data as ApiKeyRecord }
}

/**
 * Log usage and increment per-platform counters ATOMICALLY
 * Uses SQL increment (col = col + 1) to avoid TOCTOU race conditions
 */
async function logUsage(key: ApiKeyRecord, toolName: string, platform: Platform, responseTimeMs: number) {
  const admin = getAdmin()
  const platformDailyField = `${platform}_requests_today`
  const platformMonthlyField = `${platform}_requests_month`

  // Atomic increment — avoids race condition under concurrent requests
  await admin.rpc('increment_usage_counters', {
    p_key_id: key.id,
    p_platform_daily: platformDailyField,
    p_platform_monthly: platformMonthlyField,
  })

  // Log usage record
  await admin.from('api_usage').insert({
    api_key_id: key.id,
    user_id: key.user_id,
    endpoint: '/api/mcp',
    tool_name: toolName,
    response_time_ms: responseTimeMs,
  })
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()

  // Step 1: Parse JSON-RPC request FIRST (needed for method-based auth routing)
  let body: { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: string | number | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 }
    )
  }

  const { method, params, id } = body

  // Step 2: Handle PUBLIC methods (no auth required)
  // Per MCP spec best practices: initialize, ping, and tools/list are public.
  // Only tools/call requires authentication.
  // This allows MCP registries and directories to discover our server.
  if (method === 'initialize') {
    return NextResponse.json({
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lumnix', version: '0.2.2' },
      },
      id,
    })
  }

  if (method === 'ping') {
    return NextResponse.json({ jsonrpc: '2.0', result: {}, id })
  }

  if (method === 'tools/list') {
    // Return all tools for unauthenticated discovery (registries need this).
    // Plan-based filtering still applies when authenticated (tools/call checks access).
    return NextResponse.json({ jsonrpc: '2.0', result: { tools: MCP_TOOLS }, id })
  }

  // MCP notifications — silently acknowledge
  if (method?.startsWith('notifications/')) {
    return new NextResponse(null, { status: 204 })
  }

  // Step 3: For tools/call and any other method, require auth
  const authHeader = request.headers.get('authorization')
  const validation = await validateKey(authHeader)

  if (!validation.valid || !validation.key) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: validation.error },
        id: id ?? null,
      },
      {
        status: validation.status || 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="Lumnix API"' },
      }
    )
  }

  const key = validation.key

  // Step 4: Route authenticated requests
  let result: unknown
  let toolName = ''
  let platform: Platform | null = null

  // Only tools/call reaches here (all other methods handled above)
  if (method !== 'tools/call') {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id },
      { status: 400 }
    )
  }

  // tools/call handler
  {
      toolName = params?.name as string

      if (!toolName) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32602, message: 'Missing tool name' }, id },
          { status: 400 }
        )
      }

      // Check tool exists
      const tool = MCP_TOOLS.find(t => t.name === toolName)
      if (!tool) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${toolName}` }, id },
          { status: 400 }
        )
      }

      // Check tool access (plan-based)
      if (!canAccessTool(toolName, key.plan)) {
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32003,
              message: `Tool "${toolName}" requires a paid plan. Upgrade at https://lumnix.dev`,
            },
            id,
          },
          { status: 403 }
        )
      }

      // Determine platform for rate limiting
      platform = getToolPlatform(toolName)
      if (!platform) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32601, message: `Unknown platform for tool: ${toolName}` }, id },
          { status: 400 }
        )
      }

      // Check per-platform rate limits
      const rateLimitResult = checkRateLimit(key, platform)
      if (!rateLimitResult.allowed) {
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32002,
              message: rateLimitResult.reason || 'Rate limit exceeded',
              data: {
                platform: rateLimitResult.platform.name,
                limit: rateLimitResult.platform.limit,
                remaining: 0,
              },
            },
            id,
          },
          {
            status: 429,
            headers: {
              'X-RateLimit-Limit': String(rateLimitResult.platform.limit),
              'X-RateLimit-Remaining': '0',
              'Retry-After': '86400',
            },
          }
        )
      }

      // Execute tool — route to the correct handler
      const handler = handlers[toolName]
      if (!handler) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32601, message: `No handler for tool: ${toolName}` }, id },
          { status: 500 }
        )
      }

      const toolParams = (params?.arguments as Record<string, unknown>) || {}

      // Validate required parameters
      const required = tool.inputSchema?.required as string[] | undefined
      if (required && required.length > 0) {
        const missing = required.filter(p => toolParams[p] === undefined || toolParams[p] === null || toolParams[p] === '')
        if (missing.length > 0) {
          return NextResponse.json(
            { jsonrpc: '2.0', error: { code: -32602, message: `Missing required parameter(s): ${missing.join(', ')}` }, id },
            { status: 400 }
          )
        }
      }

      const handlerResult = await handler(toolParams)

      // Wrap handler errors
      result = handlerResult
  }

  // Step 4: Log usage (non-blocking)
  const responseTimeMs = Date.now() - startTime
  if (toolName && platform) {
    logUsage(key, toolName, platform, responseTimeMs).catch(() => {})
  }

  // Step 5: Return with rate limit headers
  const responseHeaders: Record<string, string> = {}
  if (platform) {
    const rateInfo = checkRateLimit(key, platform)
    responseHeaders['X-RateLimit-Limit'] = String(rateInfo.platform.limit)
    responseHeaders['X-RateLimit-Remaining'] = String(Math.max(0, rateInfo.platform.remaining))
  }

  return NextResponse.json(
    { jsonrpc: '2.0', result, id },
    { status: 200, headers: responseHeaders }
  )
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'lumnix-mcp',
    version: '0.2.2',
    auth: 'required (tools/call only — initialize and tools/list are public for registry discovery)',
    plans: { free: '10/mo', pro: '$29/mo · 5K/mo', business: '$99/mo · 25K/mo' },
    docs: 'https://lumnix.dev/docs',
  })
}
