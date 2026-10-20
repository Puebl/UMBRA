const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function nickname(value: unknown): { name: string; key: string } | null {
  if (typeof value !== 'string' || invisible.test(value)) return null;
  const name = value.trim();
  const key = name.normalize('NFKC').trim().toLowerCase();
  if (name.length < 2 || name.length > 32 || key.length < 2 || key.length > 32 || invisible.test(key)) return null;
  return { name, key };
}
