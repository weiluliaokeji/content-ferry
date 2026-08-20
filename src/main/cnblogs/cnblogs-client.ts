/**
 * Lightweight MetaWeblog XML-RPC client for Cnblogs.
 *
 * No third-party dependency: the request body is assembled manually and the
 * response is parsed by a minimal XML tree parser that only understands the
 * subset of XML used by XML-RPC (methodCall / methodResponse / params / fault
 * / value / string / int / boolean / base64 / array / struct). Timeouts, HTTP
 * status errors and XML faults are all normalised into {@link CnblogsApiError}.
 */
type FetchLike = typeof fetch;

export class CnblogsApiError extends Error {
  constructor(
    message: string,
    readonly faultCode?: number,
    readonly faultString?: string
  ) {
    super(message);
    this.name = "CnblogsApiError";
  }
}

export interface CnblogsBlogInfo {
  blogId: string;
  blogName: string;
  url: string;
}

export interface CnblogsPostPayload {
  title: string;
  description: string;
  categories: string[];
  mt_keywords: string;
  mt_excerpt: string;
  mt_allow_comments: number;
  wp_slug?: string;
}

export interface CnblogsMediaObject {
  name: string;
  type: string;
  bits: Buffer;
}

export interface CnblogsMediaObjectResult {
  url: string;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class CnblogsClient {
  constructor(
    private readonly endpoint: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async getUsersBlogs(appKey: string, username: string, password: string): Promise<CnblogsBlogInfo[]> {
    const value = await this.call<unknown>("blogger.getUsersBlogs", [appKey, username, password]);
    const list = Array.isArray(value) ? value : [];
    return list.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return {
        blogId: String(record.blogid ?? record.blogId ?? ""),
        blogName: String(record.blogName ?? ""),
        url: String(record.url ?? "")
      };
    });
  }

  async newPost(blogId: string, username: string, password: string, post: CnblogsPostPayload, publish: boolean): Promise<string> {
    const value = await this.call<unknown>("metaWeblog.newPost", [blogId, username, password, this.toStruct(post), publish]);
    return String(value);
  }

  async editPost(postId: string, username: string, password: string, post: CnblogsPostPayload, publish: boolean): Promise<boolean> {
    const value = await this.call<unknown>("metaWeblog.editPost", [postId, username, password, this.toStruct(post), publish]);
    return Boolean(value);
  }

  async newMediaObject(blogId: string, username: string, password: string, mediaObject: CnblogsMediaObject): Promise<CnblogsMediaObjectResult> {
    const value = await this.call<unknown>("metaWeblog.newMediaObject", [
      blogId,
      username,
      password,
      { name: mediaObject.name, type: mediaObject.type, bits: mediaObject.bits }
    ]);
    const record = (value ?? {}) as Record<string, unknown>;
    const url = String(record.url ?? "");
    if (!url) throw new CnblogsApiError("博客园没有返回图片地址。");
    return { url };
  }

  private toStruct(post: CnblogsPostPayload): Record<string, unknown> {
    return {
      title: post.title,
      description: post.description,
      categories: post.categories,
      mt_keywords: post.mt_keywords,
      mt_excerpt: post.mt_excerpt,
      mt_allow_comments: post.mt_allow_comments,
      ...(post.wp_slug ? { wp_slug: post.wp_slug } : {})
    };
  }

  private async call<T>(methodName: string, params: unknown[]): Promise<T> {
    const body = `<?xml version="1.0"?><methodCall><methodName>${escapeXml(methodName)}</methodName>` +
      `<params>${params.map((param) => `<param>${this.encodeValue(param)}</param>`).join("")}</params></methodCall>`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/xml",
          "user-agent": "ContentFerry/1.0"
        },
        body,
        signal: controller.signal
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new CnblogsApiError("请求博客园接口超时，请稍后重试。");
      }
      throw new CnblogsApiError(`无法连接博客园接口：${cause instanceof Error ? cause.message : "网络错误"}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new CnblogsApiError(`博客园接口请求失败（HTTP ${response.status}）。`);
    }
    const text = await response.text();
    try {
      return this.parseResponse<T>(text);
    } catch (cause) {
      if (cause instanceof CnblogsApiError) throw cause;
      throw new CnblogsApiError("博客园接口返回的 XML 无法解析。");
    }
  }

  private parseResponse<T>(text: string): T {
    const root = parseXml(text);
    const methodResponse = root.children.find((child) => child.name === "methodResponse") ?? root;

    const fault = methodResponse.children.find((child) => child.name === "fault");
    if (fault) {
      const faultValue = fault.children.find((child) => child.name === "value");
      const struct = (faultValue ? decodeValue(faultValue) : {}) as Record<string, unknown>;
      const faultString = String(struct.faultString ?? "博客园接口返回错误");
      const faultCode = Number(struct.faultCode ?? 0);
      throw new CnblogsApiError(faultString, faultCode, faultString);
    }

    const params = methodResponse.children.find((child) => child.name === "params");
    const param = params?.children.find((child) => child.name === "param");
    const value = param?.children.find((child) => child.name === "value");
    if (!value) throw new CnblogsApiError("博客园接口返回格式异常（缺少响应参数）。");
    return decodeValue(value) as T;
  }

  private encodeValue(value: unknown): string {
    if (value === null || value === undefined) return "<value><string></string></value>";
    if (typeof value === "string") return `<value><string>${escapeXml(value)}</string></value>`;
    if (typeof value === "boolean") return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
    if (typeof value === "number") {
      return Number.isInteger(value)
        ? `<value><int>${Math.round(value)}</int></value>`
        : `<value><double>${value}</double></value>`;
    }
    if (Buffer.isBuffer(value)) return `<value><base64>${value.toString("base64")}</base64></value>`;
    if (value instanceof Date) return `<value><dateTime.iso8601>${value.toISOString()}</dateTime.iso8601></value>`;
    if (Array.isArray(value)) {
      return `<value><array><data>${value.map((item) => this.encodeValue(item)).join("")}</data></array></value>`;
    }
    if (typeof value === "object") {
      const members = Object.entries(value as Record<string, unknown>)
        .map(([name, item]) => `<member><name>${escapeXml(name)}</name>${this.encodeValue(item)}</member>`)
        .join("");
      return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${escapeXml(String(value))}</string></value>`;
  }
}

function decodeValue(node: XmlNode): unknown {
  if (node.children.length > 0) {
    const child = node.children[0];
    switch (child.name) {
      case "string":
        return decodeXmlEntities(child.text);
      case "int":
      case "i4":
      case "i8":
        return Number.parseInt(child.text.trim(), 10);
      case "double":
        return Number.parseFloat(child.text.trim());
      case "boolean":
        return child.text.trim() === "1" || child.text.trim().toLowerCase() === "true";
      case "base64":
        return Buffer.from(child.text.replace(/\s+/g, ""), "base64");
      case "dateTime.iso8601":
        return child.text.trim();
      case "array": {
        const data = child.children.find((item) => item.name === "data");
        return (data?.children ?? []).filter((item) => item.name === "value").map((item) => decodeValue(item));
      }
      case "struct": {
        const out: Record<string, unknown> = {};
        for (const member of child.children.filter((item) => item.name === "member")) {
          const nameNode = member.children.find((item) => item.name === "name");
          const valueNode = member.children.find((item) => item.name === "value");
          if (nameNode && valueNode) out[decodeXmlEntities(nameNode.text).trim()] = decodeValue(valueNode);
        }
        return out;
      }
      default:
        return decodeXmlEntities(child.text);
    }
  }
  return decodeXmlEntities(node.text);
}

function parseTag(text: string): { name: string; attrs: Record<string, string> } {
  const spaceIndex = text.search(/\s/);
  if (spaceIndex === -1) return { name: text, attrs: {} };
  const name = text.slice(0, spaceIndex);
  const attrs: Record<string, string> = {};
  const attrPattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(text)) !== null) {
    attrs[match[1]] = match[2];
  }
  return { name, attrs };
}

function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  let textStart = 0;
  const length = input.length;

  while (i < length) {
    const char = input[i];
    if (char !== "<") {
      i++;
      continue;
    }
    if (i > textStart) {
      const text = input.slice(textStart, i);
      stack[stack.length - 1].text += decodeXmlEntities(text);
    }
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i);
      i = end === -1 ? length : end + 2;
      textStart = i;
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i);
      i = end === -1 ? length : end + 3;
      textStart = i;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i);
      stack[stack.length - 1].text += input.slice(i + 9, end === -1 ? length : end);
      i = end === -1 ? length : end + 3;
      textStart = i;
      continue;
    }
    if (input.startsWith("<!", i)) {
      const end = input.indexOf(">", i);
      i = end === -1 ? length : end + 1;
      textStart = i;
      continue;
    }
    if (input.startsWith("</", i)) {
      const end = input.indexOf(">", i);
      stack.pop();
      i = end === -1 ? length : end + 1;
      textStart = i;
      continue;
    }
    const end = input.indexOf(">", i);
    const tagText = input.slice(i + 1, end === -1 ? length : end).trim();
    if (tagText.endsWith("/")) {
      const { name, attrs } = parseTag(tagText.slice(0, -1).trim());
      stack[stack.length - 1].children.push({ name, attrs, children: [], text: "" });
    } else {
      const { name, attrs } = parseTag(tagText);
      const node: XmlNode = { name, attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    i = end === -1 ? length : end + 1;
    textStart = i;
  }
  return root;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
