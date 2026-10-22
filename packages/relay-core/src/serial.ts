export class SerialDispatcher {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.tails.set(key, current);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.tails.get(key) === current) this.tails.delete(key);
      });
  }
}
