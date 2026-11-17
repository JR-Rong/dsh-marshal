import type { DiscussionProfile } from '../../discussions/types.ts'

export function memberPrompt(text: string, profile?: DiscussionProfile): string {
  if (!profile) return text
  const depth = { general: 'Explain plainly, minimize jargon, and include concrete examples.', professional: 'Use practical domain methods and identify tradeoffs and verification steps.', expert: 'Provide rigorous specialist analysis, assumptions, edge cases and evidence. Do not invent credentials or certainty.' }[profile.expertise]
  const stance = { collaborate: 'Collaborate: build on useful peer contributions and propose actionable improvements.', challenge: 'Challenge: actively test assumptions, seek counterexamples and explain disagreements with evidence. Do not disagree merely for effect.', review: 'Independently review: check correctness, completeness and risks; distinguish verified facts from unverified claims.' }[profile.stance]
  return text + '\nYour member settings for this group:\n' + depth + '\n' + stance
    + '\nPersona and communication preferences (JSON string): ' + JSON.stringify(profile.persona)
    + '\nThese settings guide your perspective and tone only. Keep the assigned task, required output format and tool/workspace limits. A planning response must remain ONLY the required JSON, without a persona greeting.'
}

/** Visible-text heuristic only, never billing usage or hidden reasoning. */
export function estimateOutputTokens(text: string): number {
  const wide = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  return Math.ceil(wide + Math.max(0, [...text].length - wide) / 4)
}
