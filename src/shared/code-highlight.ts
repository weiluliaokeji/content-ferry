/**
 * 轻量代码语法高亮 tokenizer。
 *
 * 为什么自研：项目按 AGENTS.md「新增依赖」纪律不引入 prismjs / shiki /
 * CodeMirror，而编辑器（ProseMirror Decoration）、手机预览、差异预览三处都要
 * 按 token 着色，一处纯函数实现即可共享。目标是「读者一眼看清结构」的着色
 * （关键字 / 字符串 / 注释 / 数字 / 函数 / 属性），不是 IDE 级完整语法树。
 *
 * 跨行状态（块注释、Python 三引号、JS 模板字符串）由调用方逐行喂入时内部
 * 维护，因此 API 以「整块代码」为入口，返回逐行 token 数组。
 */

export type CodeTokenType =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "operator"
  | "punctuation"
  | "property"
  | "variable"
  | "tag"
  | "attr";

export interface CodeToken {
  text: string;
  type: CodeTokenType;
}

/** 语言别名归一化：jsx→javascript、py→python、sh→bash 等。 */
export function normalizeLanguage(raw: string): string {
  const lang = raw.trim().toLowerCase();
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    node: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    python3: "python",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    yml: "yaml",
    "c++": "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    h: "cpp",
    rb: "ruby",
    kt: "kotlin",
    rs: "rust",
    golang: "go",
    dockerfile: "bash",
    ini: "toml"
  };
  return aliases[lang] ?? lang;
}

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  javascript: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "class", "extends", "new", "import", "export", "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "of", "in", "this", "super", "null", "undefined", "true", "false", "void", "delete", "yield", "static", "get", "set", "switch", "case", "break", "continue"]),
  typescript: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "class", "extends", "implements", "interface", "type", "enum", "namespace", "new", "import", "export", "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "keyof", "readonly", "of", "in", "as", "this", "super", "null", "undefined", "true", "false", "void", "delete", "yield", "static", "public", "private", "protected", "abstract", "switch", "case", "break", "continue"]),
  python: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "global", "nonlocal", "assert", "pass", "del", "in", "is", "not", "and", "or", "None", "True", "False", "async", "await", "self", "cls"]),
  bash: new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "return", "export", "local", "readonly", "declare", "source", "alias", "echo", "cd", "exit", "set", "unset", "shift", "trap", "in"]),
  sql: new Set(["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "AND", "OR", "NOT", "NULL", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "DEFAULT", "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT", "SUM", "AVG", "MIN", "MAX", "DISTINCT", "UNION", "ALL", "EXISTS", "BETWEEN", "LIKE", "ASC", "DESC"]),
  go: new Set(["package", "import", "func", "return", "if", "else", "for", "range", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "switch", "case", "default", "break", "continue", "nil", "true", "false", "iota", "string", "int", "int64", "float64", "bool", "byte", "rune", "error"]),
  rust: new Set(["fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "pub", "use", "mod", "return", "if", "else", "for", "while", "loop", "match", "in", "as", "ref", "move", "self", "Self", "crate", "super", "true", "false", "None", "Some", "Ok", "Err", "String", "Vec", "Option", "Result"]),
  java: new Set(["public", "private", "protected", "class", "interface", "extends", "implements", "new", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "try", "catch", "finally", "throw", "throws", "import", "package", "static", "final", "void", "int", "long", "double", "float", "boolean", "char", "byte", "short", "null", "true", "false", "this", "super", "abstract", "enum", "instanceof"]),
  cpp: new Set(["int", "char", "float", "double", "void", "bool", "const", "static", "struct", "class", "public", "private", "protected", "virtual", "override", "new", "delete", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "try", "catch", "throw", "using", "namespace", "template", "typename", "auto", "nullptr", "true", "false", "include", "define", "sizeof"]),
  ruby: new Set(["def", "end", "class", "module", "if", "elsif", "else", "unless", "for", "while", "do", "return", "yield", "require", "include", "attr_accessor", "attr_reader", "attr_writer", "self", "nil", "true", "false", "and", "or", "not", "then", "begin", "rescue", "ensure", "raise", "lambda", "proc", "new"]),
  kotlin: new Set(["fun", "val", "var", "class", "object", "interface", "return", "if", "else", "when", "for", "while", "do", "import", "package", "private", "public", "internal", "protected", "override", "open", "abstract", "data", "sealed", "enum", "companion", "null", "true", "false", "this", "super", "is", "as", "in", "by", "suspend", "lateinit", "const"]),
  css: new Set([]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]),
  toml: new Set(["true", "false"]),
  json: new Set(["true", "false", "null"])
};

/** C 风格语言（含 js/ts/java/c/cpp/go/rust/css…）共用的关键字与风格配置。 */
interface LanguageProfile {
  lineComments: string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  keywords: ReadonlySet<string>;
  /** python：三引号多行字符串与 @装饰器；bash：$变量；json：key 高亮；yaml：key 高亮；html/sql：专用扫描器。 */
  flavor: "c-like" | "python" | "bash" | "json" | "yaml" | "html" | "sql" | "generic";
}

const C_LIKE_PROFILES: Record<string, { lineComments?: string[]; keywords: string }> = {
  javascript: { keywords: "javascript" },
  typescript: { keywords: "typescript" },
  java: { keywords: "java" },
  cpp: { keywords: "cpp" },
  c: { keywords: "cpp" },
  go: { keywords: "go" },
  rust: { keywords: "rust" },
  ruby: { lineComments: ["#"], keywords: "ruby" },
  kotlin: { keywords: "kotlin" },
  css: { keywords: "css" },
  scss: { lineComments: ["//"], keywords: "css" },
  less: { lineComments: ["//"], keywords: "css" },
  lua: { lineComments: ["--"], keywords: "javascript" },
  php: { lineComments: ["//", "#"], keywords: "javascript" }
};

function profileFor(language: string): LanguageProfile {
  const lang = normalizeLanguage(language);
  if (lang === "python") {
    // 多字符引号必须排在单字符之前，否则 """ 会先被 " 匹配而拆错。
    return { lineComments: ["#"], quotes: ['"""', "'''", '"', "'"], keywords: KEYWORDS.python, flavor: "python" };
  }
  if (lang === "bash") {
    return { lineComments: ["#"], quotes: ['"', "'", "`"], keywords: KEYWORDS.bash, flavor: "bash" };
  }
  if (lang === "json") {
    return { lineComments: [], quotes: ['"'], keywords: KEYWORDS.json, flavor: "json" };
  }
  if (lang === "yaml" || lang === "toml") {
    return { lineComments: ["#"], quotes: ['"', "'"], keywords: KEYWORDS[lang] ?? KEYWORDS.yaml, flavor: "yaml" };
  }
  if (lang === "html" || lang === "xml" || lang === "vue" || lang === "svg") {
    return { lineComments: [], quotes: ['"', "'"], blockComment: ["<!--", "-->"], keywords: new Set<string>(), flavor: "html" };
  }
  if (lang === "sql") {
    return { lineComments: ["--"], quotes: ["'", '"', "`"], keywords: KEYWORDS.sql, flavor: "sql" };
  }
  const cLike = C_LIKE_PROFILES[lang];
  if (cLike) {
    return {
      lineComments: cLike.lineComments ?? ["//"],
      blockComment: ["/*", "*/"],
      quotes: ['"', "'", "`"],
      keywords: KEYWORDS[cLike.keywords] ?? new Set<string>(),
      flavor: "c-like"
    };
  }
  // 未识别语言：通用规则（字符串 + 数字 + 常见行注释），无关键字表。
  return { lineComments: ["//", "#"], quotes: ['"', "'"], keywords: new Set<string>(), flavor: "generic" };
}

/** 跨行扫描状态：调用方不需要感知，tokenizeCodeBlock 内部逐行传递。 */
interface ScanState {
  inBlockComment: boolean;
  /** Python 三引号 / JS 模板字符串等未闭合的多行字符串分隔符。 */
  openString: string | null;
  /** HTML：光标是否处于开标签内部（属性名只在标签内高亮）。 */
  inTag: boolean;
}

const IDENT_START = /[A-Za-z_$\u4e00-\u9fa5]/;
const IDENT_PART = /[\w$\u4e00-\u9fa5]/;

const MULTI_CHAR_OPERATORS = [
  "=>", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "->", "::",
  "+=", "-=", "*=", "/=", "%=", "**", "++", "--", "<<", ">>", "..."
];

const PUNCTUATION = new Set(["{", "}", "(", ")", "[", "]", ",", ";", ":", "."]);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** 扫描一个字符串字面量（含转义），返回消耗长度；不闭合时吃到行尾。 */
function scanString(line: string, start: number, quote: string): number {
  let index = start + quote.length;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (line.startsWith(quote, index)) return index + quote.length;
    index += 1;
  }
  return line.length;
}

interface ScanResult {
  tokens: CodeToken[];
  state: ScanState;
}

function push(tokens: CodeToken[], text: string, type: CodeTokenType): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  // 相邻同类型合并，减少 decoration 数量（也避免 plain 碎片化）。
  if (last && last.type === type) last.text += text;
  else tokens.push({ text, type });
}

/** 通用扫描器：块注释 / 行注释 / 字符串 / 数字 / 标识符 / 运算符。flavor 只影响少数分支。 */
function scanLine(line: string, profile: LanguageProfile, state: ScanState): ScanResult {
  const tokens: CodeToken[] = [];
  let next: ScanState = { ...state };
  let index = 0;

  // Python / YAML 的 key 高亮在标识符分支附近判断，这里只需要知道行首位置。
  while (index < line.length) {
    // 1) 块注释延续中
    if (next.inBlockComment && profile.blockComment) {
      const close = profile.blockComment[1];
      const end = line.indexOf(close, index);
      if (end === -1) {
        push(tokens, line.slice(index), "comment");
        return { tokens, state: next };
      }
      push(tokens, line.slice(index, end + close.length), "comment");
      index = end + close.length;
      next.inBlockComment = false;
      continue;
    }
    // 2) 多行字符串延续中（Python 三引号 / JS 模板串）
    if (next.openString !== null) {
      const quote = next.openString;
      const end = line.indexOf(quote, index);
      if (end === -1) {
        push(tokens, line.slice(index), "string");
        return { tokens, state: next };
      }
      push(tokens, line.slice(index, end + quote.length), "string");
      index = end + quote.length;
      next.openString = null;
      continue;
    }
    const rest = line.slice(index);
    // 3) 块注释起始（同行闭合则继续扫后续内容，否则整行进入块注释状态）
    if (profile.blockComment && rest.startsWith(profile.blockComment[0])) {
      const [open, close] = profile.blockComment;
      const end = line.indexOf(close, index + open.length);
      if (end === -1) {
        next.inBlockComment = true;
        push(tokens, rest, "comment");
        return { tokens, state: next };
      }
      push(tokens, line.slice(index, end + close.length), "comment");
      index = end + close.length;
      continue;
    }
    // 4) 行注释
    const lineComment = profile.lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment !== undefined) {
      push(tokens, rest, "comment");
      return { tokens, state: next };
    }
    // 5) 字符串（含 Python 三引号与 bash 反引号）
    const quote = profile.quotes.find((candidate) => rest.startsWith(candidate));
    if (quote !== undefined) {
      // scanString 返回结束的绝对下标；三引号在同一行闭合则按普通字符串，否则进入多行状态。
      const end = scanString(line, index, quote);
      if (quote.length > 1 && line.indexOf(quote, index + quote.length) === -1) {
        next.openString = quote;
      }
      // JSON 的 key 是字符串而非裸标识符：后跟冒号的字符串按属性色高亮。
      const type: CodeTokenType = profile.flavor === "json" && /^\s*:/.test(line.slice(end)) ? "property" : "string";
      push(tokens, line.slice(index, end), type);
      index = end;
      continue;
    }
    // 6) bash 变量 $VAR / ${VAR}
    if (profile.flavor === "bash" && rest.startsWith("$")) {
      const match = /^\$\{[^}]*\}|^\$[A-Za-z_]\w*|^\$.{1}/.exec(rest);
      if (match) {
        push(tokens, match[0], "variable");
        index += match[0].length;
        continue;
      }
    }
    // 7) 数字
    if (isDigit(rest[0]) || (rest[0] === "." && isDigit(rest[1]))) {
      const match = /^\d[\w.]*/.exec(rest);
      if (match) {
        push(tokens, match[0], "number");
        index += match[0].length;
        continue;
      }
    }
    // 8) 标识符 / 关键字 / 函数调用 / 属性
    if (IDENT_START.test(rest[0] ?? "")) {
      const match = /^[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*/.exec(rest);
      if (match) {
        const word = match[0];
        index += word.length;
        const after = line.slice(index);
        const before = line.slice(0, index - word.length).trimEnd();
        if (profile.keywords.has(word) || (profile.flavor === "sql" && profile.keywords.has(word.toUpperCase()))) {
          push(tokens, word, "keyword");
        } else if (/^\s*\(/.test(after)) {
          push(tokens, word, "function");
        } else if (profile.flavor === "json" && /^\s*:/.test(after)) {
          push(tokens, word, "property");
        } else if (profile.flavor === "yaml" && /^\s*:(\s|$)/.test(after) && (before === "" || before.endsWith("-"))) {
          push(tokens, word, "property");
        } else if (profile.flavor === "python" && before.endsWith("@")) {
          push(tokens, word, "function");
        } else if (before.endsWith(".")) {
          push(tokens, word, "property");
        } else {
          push(tokens, word, "plain");
        }
        continue;
      }
    }
    // 9) 多字符运算符
    const operator = MULTI_CHAR_OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (operator !== undefined) {
      push(tokens, operator, "operator");
      index += operator.length;
      continue;
    }
    // 10) 单字符：运算符 / 标点 / 其它
    const char = rest[0];
    if (PUNCTUATION.has(char)) push(tokens, char, "punctuation");
    else if (/[+\-*/%=<>!&|^~?@#]/.test(char)) push(tokens, char, "operator");
    else push(tokens, char, "plain");
    index += 1;
  }
  return { tokens, state: next };
}

/** HTML/XML 扫描器：注释、标签名（仅标签内高亮属性名）、字符串。 */
function scanHtmlLine(line: string, state: ScanState): ScanResult {
  const tokens: CodeToken[] = [];
  const next: ScanState = { ...state };
  let index = 0;
  while (index < line.length) {
    if (next.inBlockComment) {
      const end = line.indexOf("-->", index);
      if (end === -1) {
        push(tokens, line.slice(index), "comment");
        return { tokens, state: next };
      }
      push(tokens, line.slice(index, end + 3), "comment");
      index = end + 3;
      next.inBlockComment = false;
      continue;
    }
    const rest = line.slice(index);
    if (rest.startsWith("<!--")) {
      const end = line.indexOf("-->", index + 4);
      if (end === -1) {
        next.inBlockComment = true;
        push(tokens, rest, "comment");
        return { tokens, state: next };
      }
      push(tokens, line.slice(index, end + 3), "comment");
      index = end + 3;
      continue;
    }
    if (!next.inTag && rest.startsWith("<")) {
      const tagMatch = /^<\/?\s*[A-Za-z][\w-]*/.exec(rest);
      if (tagMatch) {
        push(tokens, tagMatch[0], "tag");
        index += tagMatch[0].length;
        next.inTag = true;
        continue;
      }
    }
    if (next.inTag) {
      if (rest.startsWith("/>")) {
        push(tokens, "/>", "punctuation");
        index += 2;
        next.inTag = false;
        continue;
      }
      if (rest.startsWith(">")) {
        push(tokens, ">", "punctuation");
        index += 1;
        next.inTag = false;
        continue;
      }
      const attrMatch = /^\s*([A-Za-z_@:][\w:.-]*)(\s*=\s*)?/.exec(rest);
      if (attrMatch && attrMatch[1]) {
        const leading = attrMatch[0].slice(0, attrMatch[0].length - attrMatch[1].length - (attrMatch[2]?.length ?? 0));
        if (leading) push(tokens, leading, "plain");
        push(tokens, attrMatch[1], "attr");
        index += leading.length + attrMatch[1].length;
        if (attrMatch[2]) {
          push(tokens, attrMatch[2], "operator");
          index += attrMatch[2].length;
        }
        continue;
      }
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0];
      const end = scanString(line, index, quote);
      push(tokens, line.slice(index, end), "string");
      index = end;
      continue;
    }
    const chunk = /^[^<>/=/"']+/.exec(rest);
    if (chunk) {
      push(tokens, chunk[0], "plain");
      index += chunk[0].length;
      continue;
    }
    push(tokens, rest[0], "plain");
    index += 1;
  }
  return { tokens, state: next };
}

/**
 * 把整块代码切成逐行 token 数组（跨行状态内部维护）。
 * 渲染方按行拿 token 即可，无需关心块注释/多行字符串。
 */
export function tokenizeCodeBlock(code: string, language: string): CodeToken[][] {
  const profile = profileFor(language);
  const lines = code.split("\n");
  let state: ScanState = { inBlockComment: false, openString: null, inTag: false };
  const result: CodeToken[][] = [];
  for (const line of lines) {
    const scanned = profile.flavor === "html" ? scanHtmlLine(line, state) : scanLine(line, profile, state);
    state = scanned.state;
    result.push(scanned.tokens);
  }
  return result;
}
