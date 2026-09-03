/** 对回答中的常见个人敏感信息做最小化掩码，避免原文进入流式响应和历史记录。 */

const ID_CARD_RE = /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const BANK_CARD_RE = /\b\d{16,19}\b/g;
const MOBILE_RE = /\b1[3-9]\d{9}\b/g;
const EMAIL_RE = /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,30})(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function maskMiddle(value: string, visiblePrefix: number, visibleSuffix: number): string {
  return `${value.slice(0, visiblePrefix)}${'*'.repeat(Math.max(4, value.length - visiblePrefix - visibleSuffix))}${value.slice(-visibleSuffix)}`;
}

/** 脱敏身份证、银行卡、手机号和邮箱；非匹配文本原样返回。 */
export function sanitizeSensitiveText(text: string): string {
  return text
    .replace(ID_CARD_RE, (value) => maskMiddle(value, 6, 4))
    .replace(BANK_CARD_RE, (value) => maskMiddle(value, 4, 4))
    .replace(MOBILE_RE, (value) => maskMiddle(value, 3, 4))
    .replace(EMAIL_RE, (_value, first: string, rest: string, domain: string) => `${first}${'*'.repeat(Math.max(3, Math.min(6, rest.length)))}${domain}`);
}

/** 持有末尾少量字符，防止敏感数字被模型分成多个流式增量后漏检。 */
export class SensitiveTextStream {
  private pending = '';

  push(delta: string): string {
    if (!delta) return '';
    this.pending += delta;
    // 只暂存可能构成敏感实体的尾部，普通文本仍按原增量及时发送。
    const possible = this.pending.match(/(?:\d{1,19}|[A-Za-z0-9._%+-]{1,31}@[A-Za-z0-9.-]{0,64})$/)?.[0];
    if (!possible || (!/^\d+$/.test(possible) && !possible.includes('@'))) {
      const safe = this.pending;
      this.pending = '';
      return sanitizeSensitiveText(safe);
    }
    const cut = this.pending.length - possible.length;
    if (cut <= 0) return '';
    const safe = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return sanitizeSensitiveText(safe);
  }

  finish(): string {
    const safe = sanitizeSensitiveText(this.pending);
    this.pending = '';
    return safe;
  }
}
