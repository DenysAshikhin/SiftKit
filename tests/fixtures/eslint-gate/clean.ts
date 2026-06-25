const x = { a: 1 } satisfies Record<string, number>;
const y = ['a', 'b'] as const;
export { x, y };
