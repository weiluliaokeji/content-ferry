export class FiftyoneCtoChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiftyoneCtoChannelError";
  }
}

/** 配置类错误（凭据缺失/无效、参数错误、字段缺失），由调用方转为 needs_credentials 或整体失败。不可重试。 */
export class FiftyoneCtoCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiftyoneCtoCredentialsError";
  }
}

/**
 * 可重试的临时错误：网络抖动（fetch failed / ECONNRESET / ETIMEDOUT / TLS）、
 * 以及 51CTO / COS 返回的 5xx 瞬时服务端错误。
 * 与 FiftyoneCtoCredentialsError 平级（都继承 FiftyoneCtoChannelError），因此
 * `error instanceof FiftyoneCtoCredentialsError` 不会命中本类——调用方据此区分
 * 「不可重试的凭据/参数错误」与「应有限重试的临时错误」。
 */
export class FiftyoneCtoTransientError extends FiftyoneCtoChannelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "FiftyoneCtoTransientError";
    if (options?.cause !== undefined) {
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
  }
}
