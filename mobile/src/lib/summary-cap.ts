import { normalizeDailySummaryCapK } from './config.ts'
import { button, el } from './dom.ts'

/** Lives at app scope, not in the card. The storage writer queues commits in invocation order. */
export function createSummaryCapDraft() {
  let revision = 0
  let draft: number | undefined
  let status: 'idle' | 'saving' | 'saved' | 'error' = 'idle'
  return {
    view: (saved?: number) => ({ value: draft ?? normalizeDailySummaryCapK(saved), status }),
    edit(value: number) {
      revision++
      draft = normalizeDailySummaryCapK(value)
      status = 'idle'
    },
    reset() {
      revision++
      draft = undefined
      status = 'idle'
    },
    async save(value: number, persist: (cap: number) => Promise<unknown>, onError: (error: unknown) => void) {
      const request = ++revision
      const cap = draft = normalizeDailySummaryCapK(value)
      status = 'saving'
      try {
        await persist(cap)
        if (request === revision) status = 'saved'
      } catch (error) {
        if (request === revision) {
          status = 'error'
          onError(error)
        }
      }
      return request === revision
    },
  }
}

export function renderSummaryCap(model: ReturnType<typeof createSummaryCapDraft>, saved: number | undefined,
  onSave: (value: number) => void): HTMLElement {
  const draft = model.view(saved)
  const statusText = {
    idle: '', saving: '正在保存本机配额偏好…', saved: '配额偏好已保存到本机。', error: '未能保存配额偏好，请重试。',
  }
  const output = el('output', { for: 'summary-cap', text: `${draft.value}k tokens/日` })
  const status = el('p', { class: 'node-caption', role: 'status', text: statusText[draft.status] })
  const slider = el('input', { id: 'summary-cap', type: 'range', min: 10, max: 200, step: 1, value: String(draft.value),
    onInput: () => {
      model.edit(slider.valueAsNumber)
      output.value = `${slider.value}k tokens/日`
      status.textContent = ''
    },
    onChange: () => {
      onSave(slider.valueAsNumber)
      status.textContent = statusText.saving
    },
  })
  return el('div', { class: 'node-preference' },
    el('div', { class: 'row-between node-cap-label' }, el('label', { for: 'summary-cap', text: '每日记忆摘要配额' }), output),
    slider, el('p', { class: 'node-caption', text: '范围 10k–200k tokens/日，仅保存本机偏好，不更改电脑或 Hub 配额。' }),
    draft.status === 'error' ? button('重试保存配额', () => { onSave(model.view().value); status.textContent = statusText.saving }) : null,
    status)
}
