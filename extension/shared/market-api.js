import { initRequest } from '@mantou/gem/helper/request';

export const MARKET_API =
  import.meta.env.MODE === 'development'
    ? 'http://127.0.0.1:8787'
    : 'https://browser4agent-market.709922234.workers.dev';

export const marketApi = initRequest({ origin: MARKET_API });
