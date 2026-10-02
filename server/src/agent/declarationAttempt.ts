/**
 * A lexical match is not permission to act. Keep questions, quoted speech, negation and
 * hypothetical plans with the planner instead of turning a provider hold into mechanics.
 * This deliberately conservative guard is only for deterministic declaration fallbacks.
 */
export function isDirectDeclarationAttempt(declaration: string): boolean {
  const text = declaration.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!text) return false;
  if (/[?"“”]/u.test(text)) return false;
  if (/^(?:where|what|who|whom|whose|why|when|how|which|is|are|was|were|do|does|did|can|could|should|would|will|shall|have|has|had|am|may|might|must)\b/u.test(text)) return false;
  if (/\b(?:not|never|no|if|unless|would|could|might|should|whether|instead|rather)\b|\b\w+n['’]t\b/u.test(text)) return false;
  if (/\b(?:ask|asks|asked|asking|say|says|said|saying|tell|tells|told|telling|explain|describe|discuss|consider|considering|wonder|wondering)\b/u.test(text)) return false;
  if (/^(?:ooc\b|out of character\b)/u.test(text)) return false;
  if (/\b(?:yesterday|previously|earlier|already)\b|\blast\s+(?:night|turn|time|week)\b|^i\s+(?:had|was|used to)\b/u.test(text)) return false;
  return true;
}

/** Narrow receipt-free observation grammar shared by planning and conversation narration. */
export function isRoutineObservationDeclaration(declaration: string): boolean {
  const text = declaration.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!/^(?:i\s+)?(?:look around|look at|(?:take|have) a (?:(?:slow|quick|careful) )?look around|take stock of (?:who(?: and what)?|what(?: and who)?) is here|listen to|watch|observe|glance at)\b/u.test(text)) return false;
  // Explicit mechanics and uncertain targets are adjudicated by the planner, not suppressed.
  if (/\b(?:checks?|rolls?|rolling|perception|dc|d20|advantage|disadvantage|hidden|concealed|faint|distant|ambush|danger|invisible|search(?:es|ing)?|sneak|steal|attack|buy|sell|rest|climb|cast|travel|equip)\b/u.test(text)) return false;
  // The one supported observational conjunction is taking stock of the visible scene.
  // Any other compound action stays outside this narrow deterministic classification.
  const singleObservation = text.replace(/\band\s+(?:i\s+)?take stock of (?:who(?: and what)?|what(?: and who)?) is here\b/u, "")
    .replace(/\btake stock of (?:who and what|what and who) is here\b/u, "take stock of what is here");
  return !/\b(?:and|then|before|after|while|but)\b|[;,]|[.!?]\s+\S/u.test(singleObservation);
}
