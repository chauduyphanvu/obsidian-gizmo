/**
 * An event listener that runs async work: the listener itself returns nothing, as the DOM expects,
 * and the work goes on after it returns, as an async listener's would.
 */
export function handler<A extends unknown[]>(work: (...args: A) => Promise<unknown>): (...args: A) => void {
  return (...args) => {
    void work(...args);
  };
}
