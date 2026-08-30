export class FiftyoneCtoChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiftyoneCtoChannelError";
  }
}

/** 配置类错误（凭据缺失/无效），由调用方转为 needs_credentials 状态。 */
export class FiftyoneCtoCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiftyoneCtoCredentialsError";
  }
}
