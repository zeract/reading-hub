/** Only fixed local diagnostics cross the untrusted conversion boundary. */
export const READER_CONVERSION_ERRORS = [
    "这个同页语言版本已不可用，请重新打开文章后再试。",
    "知乎页面已跳转，无法确认目标回答；请在原文中查看。",
    "未能确认目标知乎回答的身份，已停止提取以避免显示其他回答；请在原文中查看。"
] as const;
export const READER_CONVERSION_FAILURE = "正文转换未能完成，请重新打开文章后重试。";

export class ReaderConversionUnavailableError extends Error {
    constructor(readonly kind:"busy"|"failed"|"timeout"|"input_limit") {
        super(kind==="busy"?"正文转换任务繁忙，请稍后重试。":kind==="timeout"?"正文转换超时，请重新打开文章后重试。":kind==="input_limit"?"正文超过转换大小限制。":READER_CONVERSION_FAILURE);
        this.name="ReaderConversionUnavailableError";
    }
}
