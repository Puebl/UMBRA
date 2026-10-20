import { describe, expect, it } from 'vitest';
import { nickname } from './nickname';

describe('nicknames', () => {
  it('preserves spelling while comparing trimmed, case-insensitive Unicode keys', () => {
    expect(nickname('  Герой Ada  ')).toEqual({ name: 'Герой Ada', key: 'герой ada' });
    for (const [first, second] of [
      ['Герой', 'ГЕРОЙ'], ['Ada', 'Ａｄａ'], ['Café', 'Café'], ['Ёж', 'Ёж'], ['A B', 'A B'],
    ]) expect(nickname(first)?.key).toBe(nickname(second)?.key);
  });
  it('allows existing punctuation and internal spaces without merging different alphabets', () => {
    expect(nickname('Код-мастер_7')?.name).toBe('Код-мастер_7');
    expect(nickname('Тестовый герой')).not.toBeNull();
    expect(nickname('aa')?.key).not.toBe(nickname('аа')?.key);
  });
  it('validates both display and normalized lengths', () => {
    for (const name of [null, undefined, 42, '', '   ', 'A', 'A'.repeat(33), 'ﬃ'.repeat(11)]) expect(nickname(name)).toBeNull();
    expect(nickname('Ab')).not.toBeNull();
    expect(nickname('A'.repeat(32))).not.toBeNull();
  });
  it('rejects control, formatting and line separator characters even at the edges', () => {
    for (const char of ['\n', '\t', '\u0000', '\u007f', '\u0085', '​', '‮', '⁦', ' ', ' ']) {
      expect(nickname(`Ada${char}`)).toBeNull();
      expect(nickname(`A${char}da`)).toBeNull();
    }
  });
});
