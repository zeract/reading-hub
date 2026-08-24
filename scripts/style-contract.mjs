import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const css = await readFile(path.join(root, "src/renderer/styles.css"), "utf8");
const failures = [];

let depth = 0;
for (const character of css) {
  if (character === "{") depth += 1;
  if (character === "}") depth -= 1;
  if (depth < 0) failures.push("CSS 存在未匹配的右花括号");
}
if (depth !== 0) failures.push("CSS 存在未匹配的花括号");
if (/!important\b/.test(css)) failures.push("阅读器样式不允许使用 !important 覆盖层级");
if (/\.article-body\s+\*\s*\{/.test(css)) failures.push("正文不允许使用无约束的后代通配选择器");
if (/\.article-body\s+img\s*\{[^}]*\bwidth\s*:\s*\d+px/i.test(css)) failures.push("正文图片不得使用固定像素宽度");
if (!/\.article-body\s+img\s*\{[^}]*max-width:\s*min\(100%,\s*34em\)/s.test(css)) failures.push("正文图片缺少阅读列宽度约束");
if (!/\.reader-scroll\s*\{[^}]*overflow:\s*auto/s.test(css)) failures.push("阅读器必须拥有独立滚动容器");
if (!/@media\s*\(min-width:\s*1380px\)\s*\{[\s\S]*?\.reader-workspace--assistant\s*\{[^}]*grid-template-columns:/s.test(css)) {
  failures.push("宽窗口中的 AI 学习面板必须作为右侧停靠栏，而非覆盖正文");
}
if (!/\.article-body\s+\[data-reader-equation\]\s*>\s*\.reader-equation\s*\{[^}]*display:\s*flex[^}]*width:\s*100%[^}]*min-width:\s*max-content/s.test(css)) {
  failures.push("公式容器必须由阅读器自有布局控制，并保持独立横向滚动能力");
}
if (!/\.article-body\s+\.reader-equation__content\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1\s+0\s+auto/s.test(css)
  || !/\.article-body\s+\.reader-equation__tag\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*margin-left:\s*\.75em[^}]*white-space:\s*nowrap/s.test(css)) {
  failures.push("公式编号必须作为阅读器自有节点位于公式主体之后并保留间距");
}
if (/\.article-body\s+\.katex-display\s*>\s*\.katex\s*>\s*\.katex-html\s*>\s*\.(?:base|tag)/s.test(css)) {
  failures.push("阅读器不得依赖 KaTeX 私有 base/tag DOM 进行公式布局");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Reading Hub style contract passed");
}
