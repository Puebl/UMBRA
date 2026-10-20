// One bare mailbox, including Unicode; never interpret lists, display names or header syntax.
export function safeMailbox(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    && !/[\p{Cc}<>,;:()"\\\[\]]/u.test(value);
}
