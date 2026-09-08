import { expect, it } from "vitest";
import { errorMessage } from "../src/renderer/errors";

it.each([
  ["预览已过期，请重新添加来源。", "预览已过期，请重新添加来源。"],
  ["Error invoking remote method 'source:confirm': Error: 预览已过期，请重新添加来源。", "预览已过期，请重新添加来源。"],
  ["Error invoking remote method 'ai:configure': 配置保存失败。", "配置保存失败。"],
  ["Error invoking remote method 'entry:read-content': TypeError: Invalid response", "TypeError: Invalid response"],
  ["正文提到 Error invoking remote method 'source:confirm': Error: 示例", "正文提到 Error invoking remote method 'source:confirm': Error: 示例"],
  ["Error invoking remote method 'source:confirm': Error:   ", "操作失败，请稍后重试。"],
  [" \n ", "操作失败，请稍后重试。"]
])("formats an error without exposing its IPC wrapper: %s", (input, expected) => {
  expect(errorMessage(new Error(input))).toBe(expected);
});

it.each([undefined, "untrusted rejection", { message: "untrusted object" }])("uses the fallback for an untyped rejection", (reason) => {
  expect(errorMessage(reason)).toBe("操作失败，请稍后重试。");
});
