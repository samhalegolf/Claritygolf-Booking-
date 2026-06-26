export {};

declare global {
  interface ReadonlyArray<T> {
    includes(searchElement: unknown, fromIndex?: number): boolean;
  }

  interface Array<T> {
    includes(searchElement: unknown, fromIndex?: number): boolean;
  }
}
