/**
 * Atende leads pendentes na fila inscrição (IA pausada + buffer).
 * node --env-file=.env scripts/attend-inscricao-pending-batch.mjs [--dry-run]
 */
import fs from 'node:fs'
import { getLeadSummary, createLeadAuditNote, createLeadNote } from '../server/kommoClient.js'
import { phoneToWhatsAppSessionId } from '../server/phoneWhatsApp.js'
import { getMessages } from '../server/evolution/messageBuffer.js'
import { fetchDadosClienteByTelefone, updateDadosCliente, ensureDadosClienteRow } from '../server/dadosClienteStore.js'
import { resetKommoInboundPollStateForLead } from '../server/kommoInboundPoll.js'
import { flushSession } from '../server/evolution/webhookEvolution.js'
import { sendText } from '../server/whatsappSender.js'
import { generateExecutionId } from '../server/ai/executionTelemetry.js'

const env = { ...process.env }
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue
  const i = line.indexOf('=')
  env[line.slice(0, i).trim()] ||= line.slice(i + 1)
}

const dryRun = process.argv.includes('--dry-run')
const LEAD_IDS = (process.argv.find((a, i) => process.argv[i - 1] === '--leads') || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0)
const TARGETS = LEAD_IDS.length ? LEAD_IDS : [24069877, 23841073, 24084411]

const DEBOUNCE_MS = 6000
const INTER_LEAD_MS = 3000

async function attendLead(leadId) {
  const summary = await getLeadSummary(env, leadId)
  if (!summary.ok || !summary.phone) {
    return { leadId, ok: false, reason: 'sem_telefone' }
  }

  const phone = summary.phone
  const sid = phoneToWhatsAppSessionId(phone)
  const dc = await fetchDadosClienteByTelefone(env, phone, 'atendimento_ia,inscricao_form_status').catch(() => null)
  const buf = await getMessages(env, sid)

  console.log(
    `\n--- #${leadId} ${summary.name} ia=${dc?.atendimento_ia || '-'} form=${dc?.inscricao_form_status || '-'} buf=${buf?.length || 0} ---`,
  )
  if (buf?.length) console.log('  buffer:', buf.map((m) => String(m).slice(0, 90)))

  if (dryRun) return { leadId, ok: true, dryRun: true, buffer: buf?.length || 0 }

  await ensureDadosClienteRow(env, { telefone: phone, idLead: leadId, fields: { id_lead: leadId } })
  await updateDadosCliente(env, { telefone: phone, fields: { atendimento_ia: null, id_lead: leadId } })

  resetKommoInboundPollStateForLead(leadId)
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS))
  const out = await flushSession(env, sid, { leadIdHint: leadId })
  const reply = String(out?.reply || '').trim()
  console.log(`  flush ok=${out?.ok} reply=${reply.slice(0, 120)}`)

  let sent = false
  if (out?.ok && reply) {
    const needsBypass =
      (out?.sentParts ?? out?.whatsappSent ?? 1) === 0 ||
      /dedupe|similar|held|kommo_similar/i.test(String(out?.error || ''))
    if (needsBypass) {
      const executionId = generateExecutionId()
      const body = `${reply}\n\n - ${executionId}`
      const sendRes = await sendText(env, { to: phone, text: body })
      if (sendRes?.ok) {
        await createLeadNote(env, leadId, body).catch(() => {})
        sent = true
        console.log('  force-send OK')
      } else {
        console.log('  force-send FAIL', sendRes?.error)
      }
    } else {
      sent = true
    }
  }

  const after = await fetchDadosClienteByTelefone(env, phone, 'inscricao_form_status,atendimento_ia,captacao_comprovante_at')
  await createLeadAuditNote(
    env,
    leadId,
    `Atendimento batch inscrição: IA reativada, buffer processado. sent=${sent} reply=${reply.slice(0, 120) || 'n/a'}`,
  ).catch(() => {})

  return { leadId, ok: Boolean(sent && reply), sent, reply: reply.slice(0, 120), status: after?.inscricao_form_status }
}

console.log(`mode=${dryRun ? 'DRY-RUN' : 'APPLY'} targets=${TARGETS.join(',')}`)
const results = []
for (const lid of TARGETS) {
  results.push(await attendLead(lid))
  await new Promise((r) => setTimeout(r, INTER_LEAD_MS))
}
console.log('\n--- resumo ---')
console.log(JSON.stringify(results, null, 2))
process.exit(results.some((r) => !r.ok) ? 1 : 0)
