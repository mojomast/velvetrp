import type { CSSProperties } from "react";
import "./conversationText.css";

// Stable across reloads, independent of transcript order. All colors are legible
// against the dark play surface; the speaker's name remains the primary cue.

export function speakerColor(identity: string): string {
  let hash = 0;
  for (const char of identity.normalize("NFKC")) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 75% 78%)`;
}
export function SpeakerName({ identity, name }: { identity: string; name: string }) {
  return <strong className="conversation-speaker" style={{ "--speaker-color": speakerColor(identity) } as CSSProperties}>{name}</strong>;
}

/** Presentation only. Never evaluates HTML/Markdown or infers game mechanics. */
export function ConversationText({ text, kind }: { text: string; kind: "action" | "narration" | "dialogue" | "system" }) {
  return <div className={`conversation-text text-${kind}`}><span className="conversation-kind">{kind}</span>
    {text.split(/\n\s*\n/u).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph.split(/("[^"\n]+"|“[^”\n]+”|\*[^*\n]+\*|\b\d*d\d+(?:\s*[+-]\s*\d+)?\b)/u).map((part, partIndex) =>
      /^(?:"[^"\n]+"|“[^”\n]+”)$/u.test(part) ? <q className="conversation-dialogue" key={partIndex}>{part.slice(1, -1)}</q>
        : /^\*[^*]+\*$/u.test(part) ? <em className="conversation-action" key={partIndex}>{part.slice(1, -1)}</em>
          : /^\d*d\d+(?:\s*[+-]\s*\d+)?$/u.test(part) ? <code className="conversation-roll" title="Dice notation (text, not a new roll)" key={partIndex}>{part}</code>
          : part)}</p>)}
  </div>;
}
