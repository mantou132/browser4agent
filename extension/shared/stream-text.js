const graphemeSegmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const graphemeEndOffsets = (text) => {
  if (!graphemeSegmenter) {
    let offset = 0;
    return Array.from(text, (value) => (offset += value.length));
  }
  return Array.from(graphemeSegmenter.segment(text), ({ index, segment }) => index + segment.length);
};

/** Reveal an append-only target in short, overlapping animation steps without
 * splitting emoji or other grapheme clusters. A large backlog catches up
 * faster, but normal streaming stays close to character granularity. */
export function nextStreamingText(displayText, targetText) {
  if (!targetText.startsWith(displayText)) return targetText;

  const pending = targetText.slice(displayText.length);
  if (!pending) return displayText;

  const offsets = graphemeEndOffsets(pending);
  const revealCount = Math.min(
    offsets.length,
    offsets.length > 120 ? 12 : offsets.length > 48 ? 8 : offsets.length > 16 ? 4 : 3,
  );
  let endOffset = offsets[revealCount - 1];

  // Finish a nearby short English word instead of cutting it in half.
  const nearbyBoundary = pending
    .slice(endOffset)
    .match(
      /^[^\s.,!?;:\u3001\u3002\uff01\uff0c\uff1a\uff1b\uff1f]{0,4}[\s.,!?;:\u3001\u3002\uff01\uff0c\uff1a\uff1b\uff1f]/u,
    )?.[0];
  if (nearbyBoundary) endOffset += nearbyBoundary.length;

  return displayText + pending.slice(0, endOffset);
}
