import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextStreamingText } from '../shared/stream-text.js';

describe('stream text pacing', () => {
  it('reveals normal chunks in short character-sized steps', () => {
    assert.equal(nextStreamingText('', '流式文字渐显'), '流式文');
  });

  it('reveals a large backlog in faster append-only steps', () => {
    const target = 'A response should catch up quickly while still arriving as a smooth sequence of short phrases.';
    let display = '';
    let steps = 0;
    while (display !== target && steps < 30) {
      const next = nextStreamingText(display, target);
      assert.equal(next.startsWith(display), true);
      assert.equal(target.startsWith(next), true);
      display = next;
      steps += 1;
    }
    assert.equal(display, target);
    assert.ok(steps > 5 && steps < 30);
  });

  it('never cuts through an emoji grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦';
    const target = `${'a'.repeat(20)}${family}${'b'.repeat(20)}`;
    const validEnds = new Set(
      Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(target),
        ({ index, segment }) => index + segment.length,
      ),
    );
    let display = '';
    while (display !== target) {
      display = nextStreamingText(display, target);
      assert.equal(validEnds.has(display.length), true);
    }
  });

  it('falls back to the target for a non-append edit', () => {
    assert.equal(nextStreamingText('Hello world', 'Hello there'), 'Hello there');
  });
});
