import { createHash } from "node:crypto";

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("字符串包含无效 Unicode 代理项");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("字符串包含无效 Unicode 代理项");
    }
  }
}

function serialize(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON 只接受有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new TypeError("canonical JSON 数组不能包含额外属性");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON 数组不能包含空槽");
    }
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON 只接受普通 JSON 对象");
    }
    return `{${Object.keys(value).sort().map((key) => {
      assertUnicode(key);
      const child = value[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new TypeError("canonical JSON 对象包含非 JSON 值");
      }
      return `${JSON.stringify(key)}:${serialize(child)}`;
    }).join(",")}}`;
  }
  throw new TypeError("canonical JSON 只接受 JSON 值");
}

export function canonicalJson(value) {
  return serialize(value);
}

class StrictJsonParser {
  constructor(source) {
    if (typeof source !== "string") throw new TypeError("JSON 输入必须是字符串");
    this.source = source;
    this.index = 0;
  }

  error(message) {
    throw new SyntaxError(`${message}（位置 ${this.index}）`);
  }

  whitespace() {
    while (/[\u0009\u000a\u000d\u0020]/u.test(this.source[this.index] || "")) this.index += 1;
  }

  parse() {
    this.whitespace();
    const value = this.value();
    this.whitespace();
    if (this.index !== this.source.length) this.error("JSON 尾部包含多余内容");
    return value;
  }

  value() {
    this.whitespace();
    const token = this.source[this.index];
    if (token === "{") return this.object();
    if (token === "[") return this.array();
    if (token === '"') return this.string();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    if (token === "-" || /[0-9]/.test(token || "")) return this.number();
    this.error("JSON 值无效");
  }

  literal(text, value) {
    if (this.source.slice(this.index, this.index + text.length) !== text) this.error("JSON 字面量无效");
    this.index += text.length;
    return value;
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        let value;
        try { value = JSON.parse(this.source.slice(start, this.index)); }
        catch { this.error("JSON 字符串无效"); }
        assertUnicode(value);
        return value;
      }
      if (character === "\\") {
        this.index += 1;
        if (this.source[this.index] === "u") this.index += 4;
      }
      this.index += 1;
    }
    this.error("JSON 字符串未结束");
  }

  number() {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.error("JSON 数字无效");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.error("JSON 数字必须有限");
    return value;
  }

  object() {
    const result = {};
    const keys = new Set();
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "}") { this.index += 1; return result; }
    for (;;) {
      if (this.source[this.index] !== '"') this.error("JSON 对象键必须是字符串");
      const key = this.string();
      if (keys.has(key)) this.error(`JSON 对象包含重复键 ${key}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ":") this.error("JSON 对象键后缺少冒号");
      this.index += 1;
      Object.defineProperty(result, key, {
        value: this.value(), enumerable: true, configurable: true, writable: true,
      });
      this.whitespace();
      if (this.source[this.index] === "}") { this.index += 1; return result; }
      if (this.source[this.index] !== ",") this.error("JSON 对象成员之间缺少逗号");
      this.index += 1;
      this.whitespace();
    }
  }

  array() {
    const result = [];
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "]") { this.index += 1; return result; }
    for (;;) {
      result.push(this.value());
      this.whitespace();
      if (this.source[this.index] === "]") { this.index += 1; return result; }
      if (this.source[this.index] !== ",") this.error("JSON 数组成员之间缺少逗号");
      this.index += 1;
      this.whitespace();
    }
  }
}

export function parseJsonStrict(source) {
  return new StrictJsonParser(source).parse();
}

export function profileHash(spec) {
  return `sha256:${createHash("sha256").update(canonicalJson(spec), "utf8").digest("hex")}`;
}
