// Quotes a string for a POSIX shell: single quotes around it, and each ' inside written as '\''.
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
