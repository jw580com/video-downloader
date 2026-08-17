function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...args: unknown[]): void => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args: unknown[]): void => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args: unknown[]): void => console.error(`[${ts()}] [ERROR]`, ...args),
};
