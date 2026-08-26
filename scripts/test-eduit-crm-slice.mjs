/**
 * Testes focados — fatia EduIT (cliente / adapter / gate / outbound).
 * npm run test:eduit-slice
 */

import {
  EDUIT_DEFAULT_STAGES,
  isEduitCuid,
  pickPreferredDeal,
  pickPreferredContact,
  pickPreferredConversation,
  extractMessageId,
  resolveEduitStages,
  eduitAgentStageIds,
  getDealById,
  contactPhoneDigits,
} from '../server/eduitClient.js'
import {
  getCrmBackend,
  isEduitBackend,
  normalizeCrmLeadId,
  leadMatchesEduitAgentFunnel,
  dealToAgentLead,
  assertLeadInAgentFunnel,
  leadMatchesAgentFunnel,
  persistEduitIds,
} from '../server/crmAdapter.js'
import {
  AGENT_FUNNEL_PIPELINE_ID,
  leadMatchesAgentFunnel as kommoLeadMatches,
} from '../server/kommoAgentFunnelGate.js'

const stats = { passed: 0, failed: 0, total: 0 }

function expect(label, ok) {
  stats.total += 1
  if (ok) {
    stats.passed += 1
    console.log(`  ok ${label}`)
  } else {
    stats.failed += 1
    console.error(`  FAIL ${label}`)
  }
}

// --- defaults / cuid ---
expect('cuid atendimento default', isEduitCuid(EDUIT_DEFAULT_STAGES.atendimento))
expect('cuid inscricao default', isEduitCuid(EDUIT_DEFAULT_STAGES.inscricao))
expect('cuid entrada default', isEduitCuid(EDUIT_DEFAULT_STAGES.entrada))
expect('numero nao e cuid', !isEduitCuid('25'))
expect('vazio nao e cuid', !isEduitCuid(''))

// --- backend default kommo ---
expect('default backend kommo', getCrmBackend({}) === 'kommo')
expect('CRM_BACKEND=eduit', getCrmBackend({ CRM_BACKEND: 'eduit' }) === 'eduit')
expect('isEduitBackend false default', !isEduitBackend({}))
expect('isEduitBackend true', isEduitBackend({ CRM_BACKEND: 'eduit' }))

// --- normalizeCrmLeadId nunca Number() em CUID ---
const cuid = EDUIT_DEFAULT_STAGES.atendimento
const normEduit = normalizeCrmLeadId(cuid, { CRM_BACKEND: 'eduit' })
expect('normalize cuid eduit string', typeof normEduit === 'string' && normEduit === cuid)
expect(
  'normalize cuid sem Number NaN',
  Number(cuid) !== Number(normEduit) || Number.isNaN(Number(cuid)),
)
expect(
  'normalize kommo numerico',
  normalizeCrmLeadId('19884275', { CRM_BACKEND: 'kommo' }) === 19884275,
)
expect('normalize reject 0', normalizeCrmLeadId(0, { CRM_BACKEND: 'kommo' }) == null)

// --- pickPreferredDeal ---
const stages = resolveEduitStages({})
const deals = [
  {
    id: 'cmtolddeal000000000000001',
    stageId: stages.fechamento,
    updatedAt: '2026-01-01T00:00:00.000Z',
    number: 10,
  },
  {
    id: 'cmtatenddeal0000000000002',
    stageId: stages.atendimento,
    updatedAt: '2026-02-01T00:00:00.000Z',
    number: 20,
  },
  {
    id: 'cmtinscdeal00000000000003',
    stageId: stages.inscricao,
    updatedAt: '2026-03-01T00:00:00.000Z',
    number: 30,
  },
]
const pick = pickPreferredDeal(deals, {})
expect('prefer inscricao/atendimento mais recente', pick.deal?.id === 'cmtinscdeal00000000000003')
expect('pick reason preferred_stage', String(pick.reason || '').startsWith('preferred_stage:'))

const onlyOther = pickPreferredDeal(
  [{ id: 'cmtother00000000000000001', stageId: stages.fechamento, updatedAt: '2026-04-01T00:00:00Z', number: 1 }],
  {},
)
expect('fallback most recent', onlyOther.deal?.id === 'cmtother00000000000000001')

// --- gate EduIT ---
const agentStages = eduitAgentStageIds({})
expect('agent stages = 2', agentStages.length === 2)
expect('agent includes atendimento', agentStages.includes(stages.atendimento))
expect('agent includes inscricao', agentStages.includes(stages.inscricao))

const leadAtend = dealToAgentLead({ id: 'cmtleadatend0000000000001', stageId: stages.atendimento }, {})
expect('leadMatches atendimento', leadMatchesEduitAgentFunnel(leadAtend, {}))
expect(
  'leadMatches entrada false',
  !leadMatchesEduitAgentFunnel(
    dealToAgentLead({ id: 'cmtleadent000000000000001', stageId: stages.entrada }, {}),
    {},
  ),
)

// Adapter leadMatches com backend eduit
expect(
  'adapter leadMatches eduit',
  leadMatchesAgentFunnel(leadAtend, { env: { CRM_BACKEND: 'eduit' } }),
)

// Kommo path intacto via adapter default
expect(
  'adapter kommo leadMatches',
  leadMatchesAgentFunnel(
    { pipeline_id: AGENT_FUNNEL_PIPELINE_ID, status_id: 106140284 },
    { env: { CRM_BACKEND: 'kommo' } },
  ),
)
expect(
  'kommo gate direto intacto',
  kommoLeadMatches({ pipeline_id: 13756724, status_id: 106140284 }),
)

// getDealById rejeita número
{
  const r = await getDealById({ EDUIT_BASE_URL: 'https://example.invalid', EDUIT_API_KEY: 'x' }, '25')
  expect('getDealById rejeita numero', r.ok === false && r.code === 'DEAL_NUMBER_FORBIDDEN')
}

// assertLeadInAgentFunnel kommo skip
{
  const r = await assertLeadInAgentFunnel({ CRM_BACKEND: 'kommo' }, { skip: true })
  expect('assert skip kommo', r.ok === true)
}
{
  const r = await assertLeadInAgentFunnel({ CRM_BACKEND: 'eduit' }, { skip: true })
  expect('assert skip eduit', r.ok === true)
}

{
  const miss = await persistEduitIds({}, '5511999999999', {})
  expect('persistEduitIds MISSING_IDS', miss.ok === false && miss.code === 'MISSING_IDS')
}

// sendText / outbound path — mock fetch
{
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'cmtmsg000000000000000001' }),
    }
  }
  try {
    const { sendText } = await import('../server/whatsappSender.js')
    const env = {
      CRM_BACKEND: 'eduit',
      EDUIT_BASE_URL: 'https://eduit.test',
      EDUIT_API_KEY: 'test-key-not-real',
    }
    const out = await sendText(env, {
      to: '5511999999999',
      text: 'ola',
      conversationId: 'cmtconv00000000000000001',
    })
    expect('sendText eduit ok', out.ok === true && out.via === 'eduit')
    expect('sendText nao chama graph.facebook', !calls.some((c) => /graph\.facebook/.test(c.url)))
    expect(
      'sendText POST conversa',
      calls.some(
        (c) =>
          c.method === 'POST' &&
          /\/api\/conversations\/cmtconv00000000000000001\/messages/.test(c.url),
      ),
    )
    const body = JSON.parse(calls.find((c) => c.method === 'POST')?.body || '{}')
    expect('sendText body type text', body.type === 'text' && body.content === 'ola')
  } finally {
    globalThis.fetch = prevFetch
  }
}

// --- extractMessageId shapes ---
expect('extractMessageId {id}', extractMessageId({ id: 'cmtmsgid0000000000000001' }) === 'cmtmsgid0000000000000001')
expect(
  'extractMessageId {messageId}',
  extractMessageId({ messageId: 'cmtmsgid0000000000000002' }) === 'cmtmsgid0000000000000002',
)
expect(
  'extractMessageId {message:{id}}',
  extractMessageId({ message: { id: 'cmtmsgid0000000000000003' } }) === 'cmtmsgid0000000000000003',
)
expect('extractMessageId null', extractMessageId(null) == null)
expect('extractMessageId {}', extractMessageId({}) == null)

// --- pickPreferredContact ---
{
  const contacts = [
    { id: 'cmtcontactwrong0000000001', phone: '5511888888888' },
    { id: 'cmtcontactexact0000000002', phone: '5511999999999' },
  ]
  const pick = pickPreferredContact(contacts, '5511999999999')
  expect('pick contact exact phone', pick.contact?.id === 'cmtcontactexact0000000002')
  expect('pick contact reason exact', pick.reason === 'exact_phone')
  const fb = pickPreferredContact([{ id: 'cmtcontactonly00000000001', phone: '11977777777' }], '5511999999999')
  expect('pick contact fallback first', fb.contact?.id === 'cmtcontactonly00000000001' && fb.reason === 'first_fallback')
}

// --- pickPreferredConversation ---
{
  const convs = [
    { id: 'cmtconvclosed000000000001', status: 'closed', updatedAt: '2026-08-20T00:00:00Z' },
    { id: 'cmtconvopenold00000000002', status: 'open', updatedAt: '2026-08-21T00:00:00Z' },
    { id: 'cmtconvopennew00000000003', status: 'active', updatedAt: '2026-08-25T00:00:00Z' },
  ]
  const pick = pickPreferredConversation(convs)
  expect('pick conv open most recent', pick.conversation?.id === 'cmtconvopennew00000000003')
  expect('pick conv reason open', String(pick.reason).startsWith('open_most_recent:'))

  const noHints = pickPreferredConversation([
    { id: 'cmtconva00000000000000001', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'cmtconvb00000000000000002', updatedAt: '2026-06-01T00:00:00Z' },
  ])
  expect('pick conv fallback most recent', noHints.conversation?.id === 'cmtconvb00000000000000002')
}

// sendMessageWithNote EduIT: só /messages — nunca /notes nem Graph/Evolution
{
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: { id: 'cmtmsgnested00000000001' } }),
    }
  }
  try {
    const { sendMessageWithNote } = await import('../server/whatsappSender.js')
    const env = {
      CRM_BACKEND: 'eduit',
      EDUIT_BASE_URL: 'https://eduit.test',
      EDUIT_API_KEY: 'test-key-not-real',
      WHATSAPP_PHONE_NUMBER_ID: 'should-not-use',
      WHATSAPP_ACCESS_TOKEN: 'should-not-use',
      WHATSAPP_OUTBOUND_MODE: 'cloud',
    }
    const out = await sendMessageWithNote(env, {
      telefone: '5511999999999',
      text: 'resposta eduit',
      leadId: 'cmtdeallead0000000000001',
      conversationId: 'cmtconvsend0000000000001',
      executionId: 'ex-test-1',
      freshUserTurn: true,
    })
    expect('sendMessageWithNote eduit ok', out.ok === true && (out.sent || 0) >= 1)
    expect(
      'sendMessageWithNote so /messages',
      calls.every(
        (c) =>
          c.method !== 'POST' ||
          /\/api\/conversations\/[^/]+\/messages/.test(c.url),
      ) && calls.some((c) => c.method === 'POST' && /\/messages/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca /notes',
      !calls.some((c) => /\/notes/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca Graph',
      !calls.some((c) => /graph\.facebook/.test(c.url)),
    )
    expect(
      'sendMessageWithNote nunca Evolution sendText',
      !calls.some((c) => /\/message\/sendText|evolution/i.test(c.url)),
    )
    const noteSteps = (out.steps || []).filter((s) => s.step === 'note')
    expect(
      'sendMessageWithNote note skipped eduit',
      noteSteps.length > 0 && noteSteps.every((s) => s.skipped === true && s.reason === 'eduit_conversation_only'),
    )
  } finally {
    globalThis.fetch = prevFetch
  }
}

// --- backfill batch index helpers ---
{
  const {
    stageIdsForBackfill,
    phoneVariants,
    extractContactIdFromDeal,
    extractPhonesFromDeal,
    buildDealPhoneIndex,
    lookupPreferredDealForPhone,
    dealNeedsDetailEnrichment,
    parseRetryAfterMs,
    isRateLimitResult,
  } = await import('./lib/backfillEduitIndex.mjs')
  const { withThrottleRetry } = await import('./backfill-eduit-ids.mjs')

  const stageIds = stageIdsForBackfill({
    pipelineId: 'cmtpipe000000000000000001',
    entrada: 'cmtstageent0000000000001',
    atendimento: 'cmtstageatend00000000002',
    inscricao: 'cmtstageinsc000000000003',
    atendimentoDup: 'cmtstageatend00000000002',
  })
  expect('stageIds exclude pipeline', !stageIds.includes('cmtpipe000000000000000001'))
  expect('stageIds dedupe', stageIds.filter((id) => id === 'cmtstageatend00000000002').length === 1)
  expect('stageIds has 3', stageIds.length === 3)

  expect('phoneVariants 55', phoneVariants('5511999999999').includes('11999999999'))
  expect(
    'extractContactId aliases',
    extractContactIdFromDeal({ contact: { id: 'cmtcontactaaa00000000001' } }) ===
      'cmtcontactaaa00000000001',
  )
  expect(
    'extractPhones from deal.contact',
    extractPhonesFromDeal({ contact: { phone: '5511888777666' } }).includes('5511888777666'),
  )
  expect(
    'dealNeedsDetail when no phone',
    dealNeedsDetailEnrichment({ id: 'cmtdealneed0000000000001', contactId: 'cmtc1' }, () => []),
  )

  const deals = [
    {
      id: 'cmtdealfech00000000000001',
      stageId: stages.fechamento,
      contactId: 'cmtcfech0000000000000001',
      contact: { phone: '5511999999999' },
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'cmtdealatend0000000000002',
      stageId: stages.atendimento,
      contactId: 'cmtcatend000000000000002',
      contact: { phone: '11999999999' },
      updatedAt: '2026-06-01T00:00:00Z',
    },
  ]
  const idx = buildDealPhoneIndex(deals, contactPhoneDigits)
  const looked = lookupPreferredDealForPhone(idx, '5511999999999', pickPreferredDeal, {})
  expect('batch index prefer atendimento', looked.deal?.id === 'cmtdealatend0000000000002')
  expect('batch index contactId', looked.contactId === 'cmtcatend000000000000002')
  expect('batch index dealsMatched', looked.dealsMatched === 2)

  expect('parseRetryAfter seconds', parseRetryAfterMs('2', 100) === 2000)
  expect('isRateLimit 429', isRateLimitResult({ status: 429 }))
  expect('isRateLimit text', isRateLimitResult({ error: 'Rate limit exceeded' }))

  let calls = 0
  const retried = await withThrottleRetry(
    async () => {
      calls += 1
      if (calls < 3) return { ok: false, status: 429, error: 'rate limit' }
      return { ok: true, status: 200 }
    },
    { delayMs: 0, maxRetries: 5, label: 'test' },
  )
  expect('withThrottleRetry recovers 429', retried.ok === true && calls === 3)
}

console.log(`\n${stats.passed}/${stats.total} passed`)
if (stats.failed > 0) process.exit(1)
