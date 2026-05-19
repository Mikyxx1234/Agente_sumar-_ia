/** Reexporta de libShared (código compartilhado browser + Node em produção). */
export {
  DEFAULT_SCOPE_REFUSAL,
  messageLooksEducational,
  messageLooksCareerIncomeOpportunity,
  buildCommercialRedirectSearchQuery,
  isGreetingOnly,
  buildGreetingReply,
  containsSqlLikeContent,
  normalizeMessageForScope,
  matchScopeHeuristic,
} from '../../libShared/scopeHeuristics.js'
